import { existsSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { z } from "zod";
import { ProjectStateError } from "../../../errors";
import type { ReadWriteJson } from "../../../io";
import type {
  FileChange,
  MigrationApplyOptions,
  MigrationPlan,
  MigrationResult,
  StackRefactorPreview,
  StackRefactorResult,
  StackVerification,
} from "../../../handlers/project/migrate/types";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { stackArtifactForTarget } from "../backends/cdk/assembly";
import {
  BACKUP_RELATIVE_PATH,
  FilesRestoreError,
  writeMigratedFiles,
  type ProjectFilesBackup,
} from "./files";
import type { PlannedStack } from "./plan";
import {
  createRefactor,
  executeRefactors,
  needsManualRepair,
  undoRefactors,
  type CreatedRefactor,
  type PollOptions,
  type RefactorStack,
  type StackRefactorError,
} from "./refactor";
import { migrationReport, REPORT_FILE, scanAgentCode } from "./report";
import type { WorkspaceSynthesizer } from "./synth";
import type { CfnTemplate } from "./templates";
import { MAX_TEMPLATE_BODY_BYTES, type TemplateStore } from "./templateStore";
import { verifyStack } from "./verify";
import type { MigrationWorkspace } from "./workspace";

/** A deployed stack, planned, with the client its refactor and change set go through. */
export type PreparedStack = {
  target: AwsDeploymentTarget;
  stackName: string;
  /** The template the stack was deployed with, as read when planning. */
  deployed: CfnTemplate;
  planned: PlannedStack;
  client: CloudFormationClient;
  templates: () => Promise<TemplateStore>;
};

export type ApplierConfig = {
  rootPath: string;
  /** A ready plan. */
  plan: MigrationPlan;
  /** The converted copy the plan was made from. */
  workspace: MigrationWorkspace;
  stacks: PreparedStack[];
  /** Agent code directories, scanned for variables v1 renamed. */
  codeDirectories: string[];
  synthesize: WorkspaceSynthesizer;
  json: ReadWriteJson;
  poll: PollOptions;
  /** The CDK library override in effect, if any; MIGRATION.md notes it. */
  libraryOverride?: string;
  now?: () => Date;
  /** Writes the migrated files; injectable so tests can make writing (and restoring) fail. */
  writeFiles?: typeof writeMigratedFiles;
};

/** Where the details of a refactor that needs manual repair are saved, relative to the project root. */
export const RECOVERY_RELATIVE_PATH = join("agentcore", ".cli", "migrate-recovery");

/**
 * What a migration in progress has done, kept until it ends, so a migration
 * killed part-way (a second Ctrl-C, a crash) leaves a record. Relative to the
 * project root.
 */
export const JOURNAL_RELATIVE_PATH = join("agentcore", ".cli", "migrate-in-progress.json");

export type MigrationJournal = {
  startedAt: string;
  /** The refactors about to run, in order. */
  refactors: { stackName: string; region: string; refactorId: string }[];
  /** How far the file changes got. */
  files: "untouched" | "writing";
};

/** What became of the project files after a failure. */
type FilesState = "untouched" | "restored" | "restore-failed";

const TemplateSchema = z.looseObject({ Resources: z.record(z.string(), z.unknown()).optional() });

const INTERRUPTED = "Interrupted (Ctrl-C).";

/**
 * Applies a ready migration plan. The stacks are refactored first, while the
 * project is still v0, because after a refactor only the v1 files match the
 * stacks: if a refactor fails, the earlier ones are undone and no file has been
 * touched. Then the files are written (backed up first), the v1 CDK app is
 * installed and synthesized in place, and a change set per stack confirms the
 * first v1 deploy keeps every AgentCore resource. A failure after the refactors
 * undoes them and restores the files, so the migration either completes or
 * leaves the project and its stacks as they were. Ctrl-C counts as a failure
 * once the step it interrupts has finished.
 */
export class MigrationApplier {
  private created?: CreatedRefactor[];

  constructor(private readonly config: ApplierConfig) {}

  /** Creates (without executing) the refactor of each stack that has resources to move. */
  async preview(options: MigrationApplyOptions = {}): Promise<StackRefactorPreview[]> {
    const created: CreatedRefactor[] = [];
    for (const stack of this.config.stacks) {
      const refactor = refactorStack(stack);
      if (!refactor) continue;
      options.onStep?.(`Creating the refactor of stack ${stack.stackName}`);
      try {
        created.push(await createRefactor(refactor, { ...this.config.poll, ...options }));
      } catch (error) {
        // Created refactors that are never executed change nothing and expire.
        throw new ProjectStateError((error as Error).message);
      }
    }
    this.created = created;
    return this.config.stacks.map((stack) => {
      const refactor = created.find((entry) => entry.stack.stackName === stack.stackName);
      return {
        target: stack.target.name,
        stackName: stack.stackName,
        region: stack.target.region,
        ...(refactor && { refactorId: refactor.refactorId }),
        actions: refactor?.actions ?? [],
      };
    });
  }

  async apply(options: MigrationApplyOptions = {}): Promise<MigrationResult> {
    if (!this.created) await this.preview(options);
    const guard = guardInterrupts(options.onStep, () =>
      rmSync(this.config.workspace.directory, { recursive: true, force: true }),
    );
    const resume = this.config.workspace.pauseInterruptCleanup();
    try {
      return await this.run(this.created!, guard.stop, options);
    } finally {
      resume();
      guard.release();
    }
  }

  private async run(
    created: CreatedRefactor[],
    stop: () => string | undefined,
    options: MigrationApplyOptions,
  ): Promise<MigrationResult> {
    const { rootPath, plan } = this.config;
    const poll = { ...this.config.poll, ...options };
    const results = new Map<string, StackRefactorResult>(
      this.config.stacks.map((stack) => [
        stack.stackName,
        {
          target: stack.target.name,
          stackName: stack.stackName,
          region: stack.target.region,
          outcome: created.some((entry) => entry.stack.stackName === stack.stackName)
            ? "not-started"
            : "unchanged",
        },
      ]),
    );
    const set = (stackName: string, update: Partial<StackRefactorResult>) =>
      results.set(stackName, { ...results.get(stackName)!, ...update });
    for (const refactor of created) {
      set(refactor.stack.stackName, { refactorId: refactor.refactorId });
    }
    const stacks = () => [...results.values()];

    const journal: MigrationJournal = {
      startedAt: (this.config.now ?? (() => new Date()))().toISOString(),
      refactors: created.map(({ stack, refactorId }) => ({
        stackName: stack.stackName,
        region: stack.region,
        refactorId,
      })),
      files: "untouched",
    };
    await this.writeJournal(journal);

    // 1. Refactor every stack, or none.
    const run = await executeRefactors(created, { ...poll, stop });
    for (const stack of run.refactored) set(stack.stackName, { outcome: "refactored" });
    if (run.failure) {
      const { error, undone, undoFailed, stopped } = run.failure;
      set(error.details.stackName, {
        outcome: stopped ? "not-started" : "failed",
        message: error.message,
      });
      for (const stack of undone) set(stack.stackName, { outcome: "undone" });
      for (const { stack, error: undoError } of undoFailed) {
        set(stack.stackName, { outcome: "undo-failed", message: undoError.message });
      }
      // After a failure that needs manual repair, the stacks refactored before it
      // weren't undone; they're still refactored.
      const stillRefactored = needsManualRepair(error) ? run.refactored : [];
      const recovery = await this.recoveryFor(error, undoFailed, stillRefactored, "untouched");
      // A stack that needs repair keeps the record, so the next run says so too.
      if (!needsManualRepair(error)) await this.removeJournal();
      return {
        migrated: false,
        stacks: stacks(),
        files: [],
        verification: [],
        error: error.message,
        restored: recovery.length === 0,
        recovery,
      };
    }

    // 2. Write the files, install and synthesize in place, and verify.
    let backup: ProjectFilesBackup | undefined;
    const verification: StackVerification[] = [];
    const checkpoint = () => {
      const stopped = stop();
      if (stopped) throw new Error(stopped);
    };
    try {
      checkpoint();
      options.onStep?.("Writing the v1 project files");
      await this.writeJournal({ ...journal, files: "writing" });
      backup = await (this.config.writeFiles ?? writeMigratedFiles)({
        rootPath,
        workspaceDirectory: this.config.workspace.directory,
        changes: plan.changes,
      });
      checkpoint();
      const assembly = await this.config.synthesize(rootPath, options);
      for (const stack of this.config.stacks) {
        checkpoint();
        verification.push(
          await verifyStack(
            {
              target: stack.target.name,
              stackName: stack.stackName,
              template: await this.readTemplate(assembly, stack.target.name),
              current: stack.planned.bridge ?? stack.deployed,
              client: stack.client,
              templates: stack.templates,
            },
            poll,
          ),
        );
      }
      const problems = verification.flatMap((entry) => [
        ...(entry.error ? [`${entry.stackName}: ${entry.error}`] : []),
        ...entry.problems.map((problem) => `${entry.stackName}: ${problem}`),
      ]);
      if (problems.length > 0) {
        throw new Error(
          `Couldn't confirm the first v1 deploy keeps every AgentCore resource:\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
        );
      }
      checkpoint();
    } catch (error) {
      return this.putBack(error as Error, run.refactored, backup, verification, stacks, set, poll);
    }

    // 3. Report. The migration is done; nothing here can undo it.
    const warnings: string[] = [];
    const reportExisted = existsSync(join(rootPath, REPORT_FILE));
    const files = filesAsWritten(rootPath, plan.changes);
    try {
      const codeNotes = await scanAgentCode(rootPath, this.codeDirectories());
      await writeFile(
        join(rootPath, REPORT_FILE),
        migrationReport({
          plan,
          stacks: stacks(),
          verification,
          files,
          codeNotes,
          ...(this.config.libraryOverride && { libraryOverride: this.config.libraryOverride }),
          date: (this.config.now ?? (() => new Date()))(),
        }),
      );
    } catch (error) {
      warnings.push(`Couldn't write ${REPORT_FILE}: ${(error as Error).message}`);
    }
    for (const [what, cleanup] of [
      [BACKUP_RELATIVE_PATH, () => backup.discard()],
      [
        RECOVERY_RELATIVE_PATH,
        () => rm(join(rootPath, RECOVERY_RELATIVE_PATH), { recursive: true, force: true }),
      ],
      [JOURNAL_RELATIVE_PATH, () => this.removeJournal()],
    ] as const) {
      try {
        await cleanup();
      } catch (error) {
        warnings.push(`Couldn't delete ${what}: ${(error as Error).message}; delete it by hand.`);
      }
    }
    const reportWritten = !warnings.some((warning) =>
      warning.startsWith(`Couldn't write ${REPORT_FILE}`),
    );
    return {
      migrated: true,
      stacks: stacks(),
      files: [
        ...files,
        ...(reportWritten
          ? [
              {
                path: REPORT_FILE,
                kind: reportExisted ? ("modified" as const) : ("added" as const),
              },
            ]
          : []),
      ],
      verification,
      ...(reportWritten && { report: REPORT_FILE }),
      recovery: [],
      ...(warnings.length > 0 && { warnings }),
    };
  }

  /** After a failure past the refactors: restores the files and moves the stacks back. */
  private async putBack(
    error: Error,
    refactored: RefactorStack[],
    backup: ProjectFilesBackup | undefined,
    verification: StackVerification[],
    stacks: () => StackRefactorResult[],
    set: (stackName: string, update: Partial<StackRefactorResult>) => void,
    poll: PollOptions,
  ): Promise<MigrationResult> {
    // Files first: whether or not the stacks move back, a v0 project lets
    // `agentcore migrate` run again (a stack left refactored then needs no moves).
    let files: FilesState = backup === undefined ? "untouched" : "restored";
    const recovery: string[] = [];
    try {
      // Writing them failed part-way and putting them back failed too.
      if (error instanceof FilesRestoreError) throw error.restoreError;
      await backup?.restore();
    } catch (restoreError) {
      files = "restore-failed";
      recovery.push(
        `Couldn't restore all of the project's v0 files (${(restoreError as Error).message}). ` +
          `The originals are in ${BACKUP_RELATIVE_PATH}: copy agentcore/cdk back from its cdk ` +
          "directory and everything else from its files directory. Or restore them from git: " +
          "`git checkout -- .`, then `git clean -fdn -- agentcore app` to list the files the " +
          "migration added, and delete those.",
      );
    }
    const undo = await undoRefactors(refactored, poll);
    for (const stack of undo.undone) set(stack.stackName, { outcome: "undone" });
    for (const { stack, error: undoError } of undo.undoFailed) {
      set(stack.stackName, { outcome: "undo-failed", message: undoError.message });
    }
    recovery.push(...(await this.recoveryFor(undefined, undo.undoFailed, [], files)));
    // A failed restore, or a stack left to repair, keeps the record of what was going on.
    if (recovery.length === 0) await this.removeJournal();
    return {
      migrated: false,
      stacks: stacks(),
      files: [],
      verification,
      error: error instanceof FilesRestoreError ? error.original.message : error.message,
      restored: files !== "restore-failed" && recovery.length === 0,
      recovery,
    };
  }

  private async readTemplate(assembly: string, target: string): Promise<CfnTemplate> {
    const artifact = await stackArtifactForTarget(this.config.json, assembly, target);
    if (artifact.templateFile === undefined) {
      throw new ProjectStateError(`Stack artifact '${artifact.id}' names no template file.`);
    }
    return (await this.config.json.read(
      join(assembly, artifact.templateFile),
      TemplateSchema,
    )) as CfnTemplate;
  }

  /** The agent code directories inside the project; a code location outside it isn't scanned. */
  private codeDirectories(): string[] {
    const root = resolve(this.config.rootPath);
    return this.config.codeDirectories.filter((directory) => {
      const fromRoot = relative(root, resolve(root, directory));
      return !isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
    });
  }

  private async writeJournal(journal: MigrationJournal): Promise<void> {
    const path = join(this.config.rootPath, JOURNAL_RELATIVE_PATH);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${JSON.stringify(journal, null, 2)}\n`);
  }

  private async removeJournal(): Promise<void> {
    await rm(join(this.config.rootPath, JOURNAL_RELATIVE_PATH), { force: true });
  }

  /**
   * What the user has to do by hand: for a refactor that couldn't roll back or
   * whose outcome is unknown, the commands to find and repair the stack, with the
   * planned moves and a ready-made reverse refactor saved under agentcore/.cli;
   * for stacks left refactored (because undoing them failed, or because a
   * failure that needs repair stopped everything), what that leaves.
   */
  private async recoveryFor(
    failure: StackRefactorError | undefined,
    undoFailed: { stack: RefactorStack; error: Error }[],
    stillRefactored: RefactorStack[],
    files: FilesState,
  ): Promise<string[]> {
    const steps: string[] = [];
    const broken = [
      ...(failure && needsManualRepair(failure) ? [failure] : []),
      ...undoFailed.flatMap(({ error }) => (needsManualRepair(error) ? [error] : [])),
    ];
    for (const error of broken) steps.push(...(await this.manualRepair(error, files)));
    const leftRefactored = [
      ...stillRefactored.map((stack) => ({ stack, why: "it was refactored before that failure" })),
      ...undoFailed.flatMap(({ stack, error }) =>
        needsManualRepair(error) ? [] : [{ stack, why: `moving it back failed: ${error.message}` }],
      ),
    ];
    for (const { stack, why } of leftRefactored) {
      steps.push(
        `Stack ${stack.stackName} is still refactored to the v1 logical IDs (its resources are ` +
          `intact), because ${why}. Run \`agentcore migrate\` again once the cause is fixed; ` +
          "it finds nothing to move in this stack. Don't deploy it with the v0 CLI in the " +
          "meantime: that deploy would delete and recreate the moved resources.",
      );
    }
    return steps;
  }

  private async manualRepair(error: StackRefactorError, files: FilesState): Promise<string[]> {
    const { stackName, region, refactorId, kind } = error.details;
    const stack = this.config.stacks.find((entry) => entry.stackName === stackName);
    const movesFile = join(RECOVERY_RELATIVE_PATH, `${stackName}.moves.json`);
    const undoFile = join(RECOVERY_RELATIVE_PATH, `${stackName}.undo-refactor.json`);
    let saved = false;
    if (stack) {
      const moves = [...stack.planned.renames].map(([from, to]) => ({ from, to }));
      try {
        await mkdir(join(this.config.rootPath, RECOVERY_RELATIVE_PATH), { recursive: true });
        await writeFile(
          join(this.config.rootPath, movesFile),
          `${JSON.stringify({ stackName, region, refactorId, moves }, null, 2)}\n`,
        );
        await writeFile(
          join(this.config.rootPath, undoFile),
          `${JSON.stringify(
            {
              Description: `Move ${stackName}'s resources back to their v0 logical IDs`,
              EnableStackCreation: false,
              StackDefinitions: [
                { StackName: stackName, TemplateBody: JSON.stringify(stack.deployed) },
              ],
              ResourceMappings: moves.map(({ from, to }) => ({
                Source: { StackName: stackName, LogicalResourceId: to },
                Destination: { StackName: stackName, LogicalResourceId: from },
              })),
            },
            null,
            2,
          )}\n`,
        );
        saved = true;
      } catch {
        // The steps below still say what to do, just without the saved files.
      }
    }
    const tooBig =
      stack !== undefined &&
      Buffer.byteLength(JSON.stringify(stack.deployed)) > MAX_TEMPLATE_BODY_BYTES;
    const id = refactorId ?? "<refactor ID>";
    const filesNote = {
      untouched: "no project file was changed",
      restored: "the project files were put back as they were",
      "restore-failed": "the project files couldn't all be put back (see above)",
    }[files];
    const describe = `\`aws cloudformation describe-stack-refactor --stack-refactor-id ${id} --region ${region}\``;
    return [
      kind === "unknown"
        ? `The outcome of stack refactor ${id} on ${stackName} (${region}) isn't known. Check it ` +
          `first with ${describe}: EXECUTE_COMPLETE means the stack is refactored to the v1 ` +
          "logical IDs; EXECUTE_FAILED or ROLLBACK_COMPLETE means it's unchanged; " +
          `ROLLBACK_FAILED means it needs the repair below. No AWS resource was deleted or ` +
          `replaced either way, and ${filesNote}.`
        : `Stack ${stackName} (${region}) is part-way through stack refactor ${id}: CloudFormation ` +
          "couldn't roll it back. No AWS resource was deleted or replaced (a refactor only " +
          `moves resources between logical IDs), and ${filesNote}.`,
      `Don't deploy ${stackName} with either CLI until it's sorted out: a deploy would delete and ` +
        "recreate every resource that isn't under the logical ID its template expects.",
      `See why: ${describe} and \`aws cloudformation describe-stack-events --stack-name ` +
        `${stackName} --region ${region}\`.`,
      `See which logical ID each resource is under now: \`aws cloudformation list-stack-resources ` +
        `--stack-name ${stackName} --region ${region}\`` +
        (saved ? `, and compare with the planned moves (v0 → v1) in ${movesFile}.` : "."),
      ...(saved
        ? [
            `Move the resources that are under their v1 logical IDs back: edit ResourceMappings in ` +
              `${undoFile} down to those resources` +
              (tooBig
                ? " (its template is over CloudFormation's inline limit: upload it to S3 and replace TemplateBody with TemplateURL)"
                : "") +
              `, run \`aws cloudformation create-stack-refactor --cli-input-json file://${undoFile} ` +
              `--region ${region}\`, wait for \`describe-stack-refactor\` to show CREATE_COMPLETE, ` +
              "then run `aws cloudformation execute-stack-refactor --stack-refactor-id <its ID> " +
              `--region ${region}\`.`,
          ]
        : []),
      "Once every resource is back under its v0 logical ID, run `agentcore migrate` again.",
    ];
  }
}

/**
 * Turns Ctrl-C during apply into a request to stop: the step running finishes,
 * then the migration undoes what it did. A second Ctrl-C exits at once.
 */
function guardInterrupts(
  onStep: ((message: string) => void) | undefined,
  removeWorkspace: () => void,
): {
  stop: () => string | undefined;
  release: () => void;
} {
  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) {
      release();
      // Exiting by signal skips the 'exit' handlers that would delete it.
      removeWorkspace();
      // Nothing else is listening any more, so this exits the way Ctrl-C does.
      process.kill(process.pid, "SIGINT");
      return;
    }
    interrupted = true;
    onStep?.(
      "Stopping: once the current step ends (an install or synth in progress stops too), the " +
        "stacks and files are put back. Press " +
        `Ctrl-C again to exit at once (that can leave stacks refactored; ${JOURNAL_RELATIVE_PATH} ` +
        "records what was done)",
    );
  };
  const release = () => process.off("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);
  return { stop: () => (interrupted ? INTERRUPTED : undefined), release };
}

/**
 * The plan's file changes as they ended up on disk. The plan was made before the
 * v1 app's dependencies were installed, so a file the install recreates (the
 * CDK app's package-lock.json) is modified rather than removed.
 */
function filesAsWritten(rootPath: string, changes: FileChange[]): FileChange[] {
  return changes.flatMap((change): FileChange[] => {
    const exists = existsSync(join(rootPath, change.path));
    if (change.kind === "removed" && exists) return [{ ...change, kind: "modified" }];
    if (change.kind !== "removed" && !exists) return [];
    return [change];
  });
}

/** The refactor a planned stack needs, or undefined when nothing in it moves. */
function refactorStack(stack: PreparedStack): RefactorStack | undefined {
  const { planned } = stack;
  if (planned.renames.size === 0) return undefined;
  if (!planned.bridge) {
    // A ready plan always has its bridge; this would be a planning bug.
    throw new ProjectStateError(`No refactor template was planned for stack '${stack.stackName}'.`);
  }
  return {
    target: stack.target.name,
    region: stack.target.region,
    stackName: stack.stackName,
    renames: planned.renames,
    template: planned.bridge,
    client: stack.client,
    templates: stack.templates,
  };
}
