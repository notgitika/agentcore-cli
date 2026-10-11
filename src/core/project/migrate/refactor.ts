import {
  CreateStackRefactorCommand,
  DescribeStackRefactorCommand,
  ExecuteStackRefactorCommand,
  ListStackRefactorActionsCommand,
  type CloudFormationClient,
  type DescribeStackRefactorCommandOutput,
  type StackRefactorAction,
} from "@aws-sdk/client-cloudformation";
import type { RefactorActionPreview } from "../../../handlers/project/migrate/types";
import { buildBridgeTemplate } from "./bridge";
import { cloudFormationStackReader } from "./stacks";
import type { CfnTemplate } from "./templates";
import { templateLocation, type TemplateStore } from "./templateStore";

/** One deployed stack to refactor onto new logical IDs. */
export type RefactorStack = {
  target: string;
  region: string;
  stackName: string;
  /** Logical ID renames, deployed ID → new ID. */
  renames: ReadonlyMap<string, string>;
  /** The deployed template with the renames applied. */
  template: CfnTemplate;
  /** A CloudFormation client for the stack's account and region. */
  client: CloudFormationClient;
  /** Where a template too big to pass inline is uploaded. */
  templates: () => Promise<TemplateStore>;
};

export type PollOptions = {
  /** Between status reads; defaults to 5 s. */
  intervalMs?: number;
  /** Gives up after this long; defaults to 30 minutes (memory moves take over a minute each). */
  timeoutMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  onStep?: (message: string) => void;
};

/**
 * Why a refactor stopped: it was never created; it failed and left the stack
 * unchanged; it couldn't roll back, leaving the stack part-moved; or its outcome
 * couldn't be read. The last two need a person to look at the stack.
 */
export type RefactorFailureKind =
  "create-failed" | "execute-failed" | "rollback-failed" | "unknown";

/** Whether a failure leaves the stack in a state only a person can sort out. */
export function needsManualRepair(error: unknown): error is StackRefactorError {
  return (
    error instanceof StackRefactorError &&
    (error.details.kind === "rollback-failed" || error.details.kind === "unknown")
  );
}

/** A stack refactor that didn't finish. */
export class StackRefactorError extends Error {
  constructor(
    message: string,
    readonly details: {
      kind: RefactorFailureKind;
      stackName: string;
      region: string;
      refactorId?: string;
      status?: string;
      reason?: string;
    },
  ) {
    super(message);
    this.name = "StackRefactorError";
  }
}

/** A created stack refactor, not yet executed, with what it would do. */
export type CreatedRefactor = {
  stack: RefactorStack;
  refactorId: string;
  actions: RefactorActionPreview[];
};

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Creates the stack refactor that moves `stack`'s resources to their new logical
 * IDs, waits for CloudFormation to validate it, and lists the actions it would
 * take. Nothing in the stack changes until it's executed.
 */
export async function createRefactor(
  stack: RefactorStack,
  options: PollOptions & { description?: string } = {},
): Promise<CreatedRefactor> {
  const { stackName, region, client } = stack;
  const template = await templateLocation(stack.template, stackName, stack.templates);
  let refactorId: string | undefined;
  try {
    const response = await client.send(
      new CreateStackRefactorCommand({
        Description:
          options.description ?? `agentcore migrate: move ${stackName} to v1 logical IDs`,
        EnableStackCreation: false,
        StackDefinitions: [{ StackName: stackName, ...template.location }],
        ResourceMappings: [...stack.renames].map(([from, to]) => ({
          Source: { StackName: stackName, LogicalResourceId: from },
          Destination: { StackName: stackName, LogicalResourceId: to },
        })),
      }),
    );
    refactorId = response.StackRefactorId;
    if (!refactorId) throw new Error("CloudFormation returned no stack refactor ID.");
    const id = refactorId;
    const created = await poll(
      () => describe(client, id),
      (state) => !state.Status?.endsWith("_IN_PROGRESS"),
      options,
    );
    if (created.Status !== "CREATE_COMPLETE") {
      throw new StackRefactorError(
        `CloudFormation rejected the refactor of stack '${stackName}' (${created.Status ?? "UNKNOWN"}): ` +
          `${created.StatusReason ?? "no reason given"}. Nothing was changed.`,
        {
          kind: "create-failed",
          stackName,
          region,
          refactorId: id,
          ...(created.Status && { status: created.Status }),
          ...(created.StatusReason && { reason: created.StatusReason }),
        },
      );
    }
    return { stack, refactorId: id, actions: await listActions(client, id) };
  } catch (error) {
    if (error instanceof StackRefactorError) throw error;
    throw new StackRefactorError(
      `Couldn't create the refactor of stack '${stackName}': ${(error as Error).message}. Nothing was changed.`,
      { kind: "create-failed", stackName, region, ...(refactorId && { refactorId }) },
    );
  } finally {
    await template.release();
  }
}

/**
 * Executes a created refactor and waits for it to finish. A refactor that fails
 * and rolls back leaves the stack as it was; one that can't roll back leaves it
 * part-moved, which only manual work can repair; one whose outcome couldn't be
 * read is `unknown`, and must be checked before anything else is done to it.
 */
export async function executeRefactor(
  created: CreatedRefactor,
  options: PollOptions = {},
): Promise<void> {
  const { stack, refactorId } = created;
  const { client, stackName, region } = stack;
  const details = (state?: DescribeStackRefactorCommandOutput, fallbackReason?: string) => {
    const status = state?.ExecutionStatus;
    const reason = state?.ExecutionStatusReason ?? state?.StatusReason ?? fallbackReason;
    return { stackName, region, refactorId, ...(status && { status }), ...(reason && { reason }) };
  };
  const lost = (error: Error): never => {
    throw new StackRefactorError(
      `Lost track of the refactor of stack '${stackName}' (${error.message}), so whether it ` +
        "finished isn't known.",
      { kind: "unknown", ...details(undefined, error.message) },
    );
  };

  try {
    await client.send(new ExecuteStackRefactorCommand({ StackRefactorId: refactorId }));
  } catch (error) {
    // The request may have reached CloudFormation even though the response
    // didn't come back; only a refactor still waiting to run wasn't started.
    let state: DescribeStackRefactorCommandOutput | undefined;
    try {
      state = await describe(client, refactorId);
    } catch {
      lost(error as Error);
    }
    if (state?.ExecutionStatus === "AVAILABLE") {
      throw new StackRefactorError(
        `CloudFormation didn't start the refactor of stack '${stackName}': ` +
          `${(error as Error).message}. The stack is unchanged.`,
        { kind: "execute-failed", ...details(state, (error as Error).message) },
      );
    }
  }
  options.onStep?.(`Refactoring stack ${stackName}`);
  let state: DescribeStackRefactorCommandOutput;
  try {
    state = await poll(
      () => describe(client, refactorId),
      // Until the execution is picked up the refactor can still read AVAILABLE.
      (current) =>
        current.ExecutionStatus !== "AVAILABLE" &&
        !current.ExecutionStatus?.endsWith("_IN_PROGRESS"),
      options,
    );
    if (state.ExecutionStatus === "EXECUTE_FAILED") {
      // A failed execution may still be about to roll back: give it a few more
      // reads to show ROLLBACK_IN_PROGRESS, and follow the rollback if it does.
      let reads = 0;
      state = await poll(
        () => describe(client, refactorId),
        (current) =>
          (current.ExecutionStatus === "EXECUTE_FAILED" && ++reads > EXECUTE_FAILED_GRACE_READS) ||
          (current.ExecutionStatus !== "EXECUTE_FAILED" &&
            !current.ExecutionStatus?.endsWith("_IN_PROGRESS")),
        options,
      );
    }
  } catch (error) {
    lost(error as Error);
  }
  const status = state!.ExecutionStatus;
  if (status === "EXECUTE_COMPLETE") return;
  const reason = details(state!).reason ?? "no reason given";
  if (status === "ROLLBACK_FAILED") {
    throw new StackRefactorError(
      `The refactor of stack '${stackName}' failed and CloudFormation couldn't roll it back ` +
        `(${reason}). Some resources may be under their old logical IDs and some under their new ones.`,
      { kind: "rollback-failed", ...details(state!) },
    );
  }
  if (status === "EXECUTE_FAILED" || status === "ROLLBACK_COMPLETE") {
    throw new StackRefactorError(
      `The refactor of stack '${stackName}' failed (${status}): ${reason}. CloudFormation ` +
        "rolled it back, so the stack is unchanged.",
      { kind: "execute-failed", ...details(state!) },
    );
  }
  // OBSOLETE, UNAVAILABLE, or a status this code doesn't know.
  throw new StackRefactorError(
    `The refactor of stack '${stackName}' ended ${status ?? "with no status"} (${reason}), so ` +
      "whether it moved anything isn't known.",
    { kind: "unknown", ...details(state!) },
  );
}

/** Reads after EXECUTE_FAILED in which a rollback may still start. */
const EXECUTE_FAILED_GRACE_READS = 3;

/**
 * The refactor that undoes an executed one: the stack's current template (the
 * bridge it was moved to) with the renames reversed, moving every resource back to
 * its old logical ID.
 */
export async function inverseRefactorStack(stack: RefactorStack): Promise<RefactorStack> {
  const current = await cloudFormationStackReader(stack.client).template(stack.stackName);
  const inverse = new Map([...stack.renames].map(([from, to]) => [to, from] as const));
  return { ...stack, renames: inverse, template: buildBridgeTemplate(current, inverse) };
}

/** Moves an executed refactor's resources back to their old logical IDs. */
export async function undoRefactor(stack: RefactorStack, options: PollOptions = {}): Promise<void> {
  options.onStep?.(`Undoing the refactor of stack ${stack.stackName}`);
  const inverse = await inverseRefactorStack(stack);
  const created = await createRefactor(inverse, {
    ...options,
    description: `agentcore migrate: undo the move of ${stack.stackName} to v1 logical IDs`,
  });
  await executeRefactor(created, options);
}

/** What happened to each stack when refactors ran in turn. */
export type RefactorRun = {
  /** Stacks whose refactor completed and is still in place. */
  refactored: RefactorStack[];
  /** Absent when every refactor completed. */
  failure?: {
    error: StackRefactorError;
    /** Earlier stacks moved back after the failure. */
    undone: RefactorStack[];
    /** Earlier stacks that couldn't be moved back, with why. */
    undoFailed: { stack: RefactorStack; error: Error }[];
  };
};

/**
 * Executes created refactors one stack at a time. When one fails, the ones before
 * it are undone, so the stacks end up either all refactored or all as they were.
 * A refactor that couldn't roll back (or whose outcome is unknown) stops
 * everything at once: it needs manual repair, and changing more stacks would only
 * add to what has to be repaired. `stop` is asked before each stack; when it says
 * so (the user pressed Ctrl-C), the run stops and undoes what it did.
 */
export async function executeRefactors(
  created: CreatedRefactor[],
  options: PollOptions & { stop?: () => string | undefined } = {},
): Promise<RefactorRun> {
  const refactored: RefactorStack[] = [];
  for (const refactor of created) {
    let failure: StackRefactorError | undefined;
    const stopped = options.stop?.();
    if (stopped) {
      failure = new StackRefactorError(stopped, {
        kind: "execute-failed",
        stackName: refactor.stack.stackName,
        region: refactor.stack.region,
      });
    } else {
      try {
        await executeRefactor(refactor, options);
        refactored.push(refactor.stack);
        continue;
      } catch (error) {
        failure = asRefactorError(error, refactor.stack);
      }
    }
    if (needsManualRepair(failure)) {
      return { refactored, failure: { error: failure, undone: [], undoFailed: [] } };
    }
    const undo = await undoRefactors(refactored, options);
    return {
      refactored: undo.undoFailed.map(({ stack }) => stack),
      failure: { error: failure, ...undo },
    };
  }
  return { refactored };
}

/** Undoes executed refactors, last first; reports the ones that couldn't be undone. */
export async function undoRefactors(
  stacks: RefactorStack[],
  options: PollOptions = {},
): Promise<{ undone: RefactorStack[]; undoFailed: { stack: RefactorStack; error: Error }[] }> {
  const undone: RefactorStack[] = [];
  const undoFailed: { stack: RefactorStack; error: Error }[] = [];
  for (const stack of [...stacks].reverse()) {
    try {
      await undoRefactor(stack, options);
      undone.push(stack);
    } catch (error) {
      undoFailed.push({ stack, error: error as Error });
    }
  }
  return { undone, undoFailed };
}

function asRefactorError(error: unknown, stack: RefactorStack): StackRefactorError {
  if (error instanceof StackRefactorError) return error;
  return new StackRefactorError((error as Error).message, {
    kind: "execute-failed",
    stackName: stack.stackName,
    region: stack.region,
  });
}

async function describe(
  client: CloudFormationClient,
  refactorId: string,
): Promise<DescribeStackRefactorCommandOutput> {
  return client.send(new DescribeStackRefactorCommand({ StackRefactorId: refactorId }));
}

async function listActions(
  client: CloudFormationClient,
  refactorId: string,
): Promise<RefactorActionPreview[]> {
  const actions: StackRefactorAction[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListStackRefactorActionsCommand({
        StackRefactorId: refactorId,
        ...(token && { NextToken: token }),
      }),
    );
    actions.push(...(page.StackRefactorActions ?? []));
    token = page.NextToken;
  } while (token);
  return actions.map((action) => ({
    action: action.Action ?? "UNKNOWN",
    entity: action.Entity ?? "UNKNOWN",
    from: action.ResourceMapping?.Source?.LogicalResourceId ?? "",
    to: action.ResourceMapping?.Destination?.LogicalResourceId ?? "",
    ...(action.PhysicalResourceId && { physicalResourceId: action.PhysicalResourceId }),
    ...(action.Description && { description: action.Description }),
  }));
}

/** Consecutive failed reads a poll rides out before failing. */
const MAX_FAILED_READS = 3;

/** Reads until `done` holds, sleeping between reads, failing after the timeout. */
export async function poll<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: PollOptions = {},
): Promise<T> {
  const interval = options.intervalMs ?? 5_000;
  const timeout = options.timeoutMs ?? 30 * 60_000;
  const sleep = options.sleep ?? sleepFor;
  const deadline = Date.now() + timeout;
  let failedReads = 0;
  for (;;) {
    let value: T;
    try {
      value = await read();
      failedReads = 0;
    } catch (error) {
      // The SDK has already retried; a few more reads ride out a longer blip.
      if (++failedReads > MAX_FAILED_READS || Date.now() >= deadline) throw error;
      await sleep(interval);
      continue;
    }
    if (done(value)) return value;
    if (Date.now() >= deadline) {
      throw new Error(`still not finished after ${Math.round(timeout / 1000)} s`);
    }
    await sleep(interval);
  }
}
