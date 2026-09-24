import { AgentCoreCLIError, ERROR_SOURCE } from "../../../../../errors";
import { AsyncChannel } from "../../../../../io";
import type { Logger } from "../../../../../logging";
import type { ProgressEvent } from "../../../../../tui/progress";

/**
 * The generic plan engine, after AlricheyWPPlayground's plan/plan.go: a plan is
 * a directed acyclic graph of steps; each step has an idempotent `do` and a
 * read-only `status`. Execution is a parallel breadth-first walk: a step starts
 * once every parent has succeeded, polls `status`, runs `do` when the resource
 * is missing or outdated, and polls again until the service reports it ready.
 * Nothing is ever undone: a failed step blocks only its dependents, and a re-run
 * of the same plan resumes from whatever the account already holds.
 */

/**
 * What a step's `status` reports. The prior art's NOT_STARTED / WAITING /
 * SUCCESSFUL / FAILED plus OUTDATED: the resource exists but differs from the
 * spec, so `do` runs as an update.
 */
export const Status = {
  NotStarted: "NOT_STARTED",
  Outdated: "OUTDATED",
  Waiting: "WAITING",
  Successful: "SUCCESSFUL",
  Failed: "FAILED",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export type StatusReport = {
  status: Status;
  /** Shown under the step while it runs, and carried into the failure for FAILED. */
  detail?: string;
};

export type StepContext = {
  /** Aborted when the deploy is cancelled; long polls should honour it. */
  signal: AbortSignal;
  logger: Logger;
  /** Reports one line of progress under this step. */
  report: (line: string) => void;
};

/** An idempotent mutation: create or update the resource toward the spec. */
export type Doer = (ctx: StepContext) => Promise<void>;
/** A read-only observation of the live resource against the spec. */
export type Statuser = (ctx: StepContext) => Promise<StatusReport>;

export type Step = {
  /** Unique within a plan. Convention: `<kind>:<name>`. Doubles as the progress task id. */
  readonly name: string;
  readonly do: Doer;
  readonly status: Statuser;
  /** Steps that may start once this one succeeds. */
  readonly next?: readonly Step[];
};

export type StepOutcome =
  | { name: string; outcome: "succeeded"; polls: number }
  | { name: string; outcome: "failed"; error: Error }
  /** `blockedBy` names the step that stopped this one, or is CANCELLED. */
  | { name: string; outcome: "skipped"; blockedBy: string };

/** `blockedBy` of a step that never started because the plan was cancelled. */
export const CANCELLED = "(cancelled)";

const KNOWN_STATUSES: ReadonlySet<string> = new Set(Object.values(Status));

export type PlanResult = { outcomes: StepOutcome[] };

export type ExecuteOptions = {
  logger: Logger;
  signal?: AbortSignal;
  /** Steps in flight at once (default 4). */
  concurrency?: number;
  /** How many times `do` may run for one step before it is declared not started (default 1). */
  maxDoAttempts?: number;
  /** Wall clock budget per step (default 15 minutes). */
  stepTimeoutMs?: number;
  /** Delay before poll number `poll` (1-based); default 1s doubling to a 10s cap. */
  pollDelayMs?: (poll: number) => number;
  /** Injectable for tests; must reject when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable clock for timeout tests. */
  now?: () => number;
  /**
   * Awaited after each step succeeds and before its dependents start; persist
   * here. A throw is fatal: no further step starts, and the plan fails with it.
   */
  onStepSucceeded?: (step: Step) => Promise<void>;
};

export type ValidatedPlan = {
  steps: Map<string, Step>;
  parents: Map<string, Set<string>>;
  children: Map<string, Set<string>>;
  roots: string[];
};

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_DO_ATTEMPTS = 1;
const DEFAULT_STEP_TIMEOUT_MS = 15 * 60 * 1000;

function defaultPollDelayMs(poll: number): number {
  return Math.min(1000 * 2 ** Math.max(poll - 1, 0), 10_000);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("The deploy was cancelled.");
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The plan's graph is malformed: a bug in the plan factory, never a user or service problem. */
export class PlanValidationError extends AgentCoreCLIError {
  constructor(message: string) {
    super(message, { source: ERROR_SOURCE.INTERNAL });
  }
}

/** The service reported the resource as failed. */
export class StepFailedError extends AgentCoreCLIError {
  constructor(
    readonly stepName: string,
    detail?: string,
  ) {
    super(`${stepName} failed${detail ? `: ${detail}` : ""}`, {
      source: ERROR_SOURCE.SERVICE,
      meta: { stepName },
    });
  }
}

/** `do` ran but `status` still cannot see its effect: the do/status pair disagree. */
export class StepNotStartedError extends AgentCoreCLIError {
  constructor(
    readonly stepName: string,
    status: Status,
  ) {
    super(`${stepName} still reports ${status} after running its action`, {
      source: ERROR_SOURCE.INTERNAL,
      meta: { stepName, status },
    });
  }
}

export class StepTimeoutError extends AgentCoreCLIError {
  constructor(
    readonly stepName: string,
    timeoutMs: number,
  ) {
    super(`${stepName} did not converge within ${Math.round(timeoutMs / 1000)}s`, {
      source: ERROR_SOURCE.SERVICE,
      meta: { stepName, timeoutMs },
    });
  }
}

/** An `onStepSucceeded` hook threw after `stepName` converged. */
export type HookFailure = { stepName: string; error: Error };

/**
 * One or more steps failed, or persisting a converged step failed; `result`
 * lists every outcome, including skipped dependents, and `hookFailure` says
 * which step's hook threw.
 */
export class PlanFailedError extends AgentCoreCLIError {
  constructor(
    readonly planName: string,
    readonly result: PlanResult,
    readonly hookFailure?: HookFailure,
  ) {
    const failed = result.outcomes.filter((o) => o.outcome === "failed");
    const skipped = result.outcomes.filter((o) => o.outcome === "skipped");
    const counts: string[] = [];
    if (failed.length > 0 || !hookFailure) {
      counts.push(`${failed.length} step${failed.length === 1 ? "" : "s"} failed`);
    }
    if (hookFailure) counts.push(`recording ${hookFailure.stepName} failed`);
    if (skipped.length > 0) counts.push(`${skipped.length} skipped`);
    const details = failed.map((o) => `${o.name} (${o.error.message})`);
    if (hookFailure) details.push(`${hookFailure.stepName} (${hookFailure.error.message})`);
    super(`${planName}: ${counts.join(", ")}: ${details.join("; ")}`, {
      source: ERROR_SOURCE.SERVICE,
      cause: hookFailure?.error ?? failed[0]?.error,
      meta: { planName },
    });
  }
}

/** The plan was cancelled; steps that had not started are skipped with CANCELLED. */
export class PlanAbortedError extends AgentCoreCLIError {
  constructor(
    readonly planName: string,
    readonly result: PlanResult,
    reason: Error,
  ) {
    const finished = result.outcomes.filter((o) => o.outcome === "succeeded").length;
    const notStarted = result.outcomes.filter(
      (o) => o.outcome === "skipped" && o.blockedBy === CANCELLED,
    ).length;
    super(
      `${planName} was cancelled (${reason.message}): ${finished} step${finished === 1 ? "" : "s"} ` +
        `finished, ${notStarted} not started. Deploy again to resume.`,
      { source: ERROR_SOURCE.USER, exitCode: 130, cause: reason, meta: { planName } },
    );
  }
}

export class Plan {
  constructor(
    readonly name: string,
    /** Entry points. Steps reachable through `next` need not be listed; listing them is harmless. */
    readonly steps: readonly Step[],
  ) {}

  /**
   * Walks the graph once: every step has a name, `do`, and `status`; names are
   * unique; there are no cycles. Returns the parent/child maps the scheduler
   * needs, with roots being the steps no other step lists in `next`.
   */
  validate(): ValidatedPlan {
    const steps = new Map<string, Step>();
    const parents = new Map<string, Set<string>>();
    const children = new Map<string, Set<string>>();

    const visit = (step: Step, trail: string[]): void => {
      if (typeof step.name !== "string" || step.name.length === 0) {
        throw new PlanValidationError(`${this.name}: a step has no name`);
      }
      if (typeof step.do !== "function" || typeof step.status !== "function") {
        throw new PlanValidationError(`${this.name}: step '${step.name}' is missing do or status`);
      }
      if (trail.includes(step.name)) {
        throw new PlanValidationError(`${this.name}: cycle ${[...trail, step.name].join(" -> ")}`);
      }
      const known = steps.get(step.name);
      if (known !== undefined && known !== step) {
        throw new PlanValidationError(`${this.name}: two different steps are named '${step.name}'`);
      }
      // Already walked through another parent: its edges are registered below by
      // that parent, so only the new edge needs recording.
      if (known === step) return;
      steps.set(step.name, step);
      parents.set(step.name, new Set());
      children.set(step.name, new Set());
      for (const child of step.next ?? []) {
        visit(child, [...trail, step.name]);
        parents.get(child.name)!.add(step.name);
        children.get(step.name)!.add(child.name);
      }
    };
    for (const step of this.steps) visit(step, []);

    const roots = [...steps.keys()].filter((name) => parents.get(name)!.size === 0);
    return { steps, parents, children, roots };
  }

  /**
   * Runs the plan, yielding progress events as steps start, report, finish, or
   * fail, and resolving with every step's outcome. Throws PlanFailedError when
   * any step failed or was skipped, PlanAbortedError when `signal` aborted; the
   * outcomes on either say which steps and why. Closing the generator early
   * aborts the running steps and waits for them to settle.
   */
  async *execute(options: ExecuteOptions): AsyncGenerator<ProgressEvent, PlanResult> {
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new PlanValidationError(
        `${this.name}: concurrency must be a positive integer, got ${concurrency}`,
      );
    }
    const validated = this.validate();

    // Aborted by the caller's signal, or by this generator closing early.
    const controller = new AbortController();
    const forward = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forward();
    else options.signal?.addEventListener("abort", forward, { once: true });

    const events = new AsyncChannel<ProgressEvent>();
    const result: PlanResult = { outcomes: [] };
    const running = this.schedule(
      validated,
      { ...options, concurrency },
      controller.signal,
      events,
      result,
    ).finally(() => events.close());
    // Consumed by the awaits below; this keeps the window between a rejection and
    // the channel draining from surfacing as an unhandled rejection.
    running.catch(() => {});
    let hookFailure: HookFailure | undefined;
    try {
      for await (const event of events) yield event;
      hookFailure = await running;
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`${this.name} was closed before it finished.`));
      }
      await running.catch(() => {});
      options.signal?.removeEventListener("abort", forward);
    }
    if (options.signal?.aborted) {
      throw new PlanAbortedError(this.name, result, abortReason(options.signal));
    }
    if (hookFailure || result.outcomes.some((outcome) => outcome.outcome !== "succeeded")) {
      throw new PlanFailedError(this.name, result, hookFailure);
    }
    return result;
  }

  /**
   * The prior art's parallel BFS: roots start at once; a step with several
   * parents starts when its in-degree reaches zero (join). A failure never
   * decrements its children, so they can never become ready; they are recorded
   * as skipped instead. A persistence-hook failure or an abort stops new steps
   * from starting but still lets in-flight steps settle, so nothing is left
   * half-observed; every step that never started is then recorded as skipped.
   */
  private async schedule(
    plan: ValidatedPlan,
    options: ExecuteOptions & { concurrency: number },
    signal: AbortSignal,
    events: AsyncChannel<ProgressEvent>,
    result: PlanResult,
  ): Promise<HookFailure | undefined> {
    const remaining = new Map([...plan.parents].map(([name, parents]) => [name, parents.size]));
    const ready = [...plan.roots];
    const running = new Map<string, Promise<void>>();
    const decided = new Set<string>();
    let hookFailure: HookFailure | undefined;

    const record = (outcome: StepOutcome) => {
      decided.add(outcome.name);
      result.outcomes.push(outcome);
    };
    const release = (name: string) => {
      for (const child of plan.children.get(name)!) {
        const left = remaining.get(child)! - 1;
        remaining.set(child, left);
        if (left === 0) ready.push(child);
      }
    };
    const skipDependents = (name: string, blockedBy: string) => {
      for (const child of plan.children.get(name)!) {
        if (decided.has(child)) continue;
        record({ name: child, outcome: "skipped", blockedBy });
        skipDependents(child, blockedBy);
      }
    };
    const stopped = () => hookFailure !== undefined || signal.aborted;

    while (ready.length > 0 || running.size > 0) {
      while (ready.length > 0 && running.size < options.concurrency && !stopped()) {
        const name = ready.shift()!;
        const step = plan.steps.get(name)!;
        const settled = this.runStep(step, options, signal, events)
          .then(
            async (polls) => {
              record({ name, outcome: "succeeded", polls });
              try {
                await options.onStepSucceeded?.(step);
              } catch (error) {
                hookFailure ??= { stepName: name, error: toError(error) };
                return;
              }
              release(name);
            },
            (error: unknown) => {
              record({ name, outcome: "failed", error: toError(error) });
              skipDependents(name, name);
            },
          )
          .finally(() => running.delete(name));
        running.set(name, settled);
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }

    const blockedBy = hookFailure?.stepName ?? CANCELLED;
    for (const name of plan.steps.keys()) {
      if (!decided.has(name)) record({ name, outcome: "skipped", blockedBy });
    }
    return hookFailure;
  }

  /**
   * One step's observe → act → poll loop. Returns the number of polls it took.
   * Reports task-start first and task-done or task-failed last, so the progress
   * UI shows the step for exactly as long as it runs. Every `status` and `do`
   * call is bounded by the step's remaining time budget and by the abort signal.
   */
  private async runStep(
    step: Step,
    options: ExecuteOptions,
    signal: AbortSignal,
    events: AsyncChannel<ProgressEvent>,
  ): Promise<number> {
    const logger = options.logger.child({ step: step.name });
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    const pollDelayMs = options.pollDelayMs ?? defaultPollDelayMs;
    const timeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    const maxDoAttempts = options.maxDoAttempts ?? DEFAULT_MAX_DO_ATTEMPTS;

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    const ctx: StepContext = {
      signal: controller.signal,
      logger,
      report: (line) => events.push({ type: "task-output", id: step.name, line }),
    };

    events.push({ type: "task-start", id: step.name, title: step.name });
    const started = now();

    /** Races one call against the step's remaining budget and its signal. */
    const bounded = async <T>(call: (ctx: StepContext) => Promise<T>): Promise<T> => {
      const budget = timeoutMs - (now() - started);
      if (budget <= 0) throw new StepTimeoutError(step.name, timeoutMs);
      if (ctx.signal.aborted) throw abortReason(ctx.signal);
      const work = call(ctx);
      // A call that loses the race may still reject later; that is not unhandled.
      work.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onStop: (() => void) | undefined;
      const stopped = new Promise<never>((_, reject) => {
        onStop = () => reject(abortReason(ctx.signal));
        ctx.signal.addEventListener("abort", onStop, { once: true });
        timer = setTimeout(
          () => controller.abort(new StepTimeoutError(step.name, timeoutMs)),
          budget,
        );
      });
      try {
        return await Promise.race([work, stopped]);
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onStop!);
      }
    };

    let polls = 0;
    let doAttempts = 0;
    try {
      for (;;) {
        if (ctx.signal.aborted) throw abortReason(ctx.signal);
        const report = await bounded(step.status);
        polls += 1;
        logger.child({ status: report.status, detail: report.detail ?? "" }).debug("polled step");

        if (report.status === Status.Successful) {
          events.push({ type: "task-done", id: step.name });
          return polls;
        }
        if (report.status === Status.Failed) throw new StepFailedError(step.name, report.detail);
        if (!KNOWN_STATUSES.has(report.status)) {
          throw new AgentCoreCLIError(
            `${step.name} reported an unrecognized status '${String(report.status)}'`,
            { source: ERROR_SOURCE.INTERNAL, meta: { stepName: step.name } },
          );
        }
        if (report.detail) ctx.report(report.detail);

        if (report.status === Status.NotStarted || report.status === Status.Outdated) {
          if (doAttempts >= maxDoAttempts) throw new StepNotStartedError(step.name, report.status);
          doAttempts += 1;
          await bounded(step.do);
          // Poll again at once: `do` records whatever id `status` needs to find it.
          continue;
        }

        const elapsed = now() - started;
        if (elapsed >= timeoutMs) throw new StepTimeoutError(step.name, timeoutMs);
        await sleep(Math.min(pollDelayMs(polls), timeoutMs - elapsed), ctx.signal);
      }
    } catch (error) {
      const failure = toError(error);
      events.push({ type: "task-failed", id: step.name, message: failure.message });
      throw failure;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
