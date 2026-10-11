import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { z } from "zod";
import { ProjectStateError } from "../../../errors";
import type { ReadWriteJson } from "../../../io";
import type {
  MigrationApplyOptions,
  MigrationPlan,
  MigrationResult,
  StackRefactorPreview,
  StackRefactorResult,
  StackVerification,
} from "../../../handlers/project/migrate/types";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { stackArtifactForTarget } from "../backends/cdk/assembly";
import { writeMigratedFiles, type ProjectFilesBackup } from "./files";
import type { PlannedStack } from "./plan";
import {
  createRefactor,
  executeRefactors,
  StackRefactorError,
  undoRefactors,
  type CreatedRefactor,
  type PollOptions,
  type RefactorStack,
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
};

/** Where the details of a refactor that needs manual repair are saved, relative to the project root. */
export const RECOVERY_RELATIVE_PATH = join("agentcore", ".cli", "migrate-recovery");

const TemplateSchema = z.looseObject({ Resources: z.record(z.string(), z.unknown()).optional() });

/**
 * Applies a ready migration plan. The stacks are refactored first, while the
 * project is still v0, because after a refactor only the v1 files match the
 * stacks: if a refactor fails, the earlier ones are undone and no file has been
 * touched. Then the files are written (backed up first), the v1 CDK app is
 * installed and synthesized in place, and a change set per stack confirms the
 * first v1 deploy keeps every AgentCore resource. A failure after the refactors
 * undoes them and restores the files, so the migration either completes or
 * leaves the project and its stacks as they were.
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
    const { rootPath, plan } = this.config;
    if (!this.created) await this.preview(options);
    const created = this.created!;
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

    // 1. Refactor every stack, or none.
    const run = await executeRefactors(created, poll);
    for (const stack of run.refactored) set(stack.stackName, { outcome: "refactored" });
    if (run.failure) {
      const { error, undone, undoFailed } = run.failure;
      set(error.details.stackName, { outcome: "failed", message: error.message });
      for (const stack of undone) set(stack.stackName, { outcome: "undone" });
      for (const { stack, error: undoError } of undoFailed) {
        set(stack.stackName, { outcome: "undo-failed", message: undoError.message });
      }
      const recovery = await this.recoveryFor(error, undoFailed);
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
    try {
      options.onStep?.("Writing the v1 project files");
      backup = await writeMigratedFiles({
        rootPath,
        workspaceDirectory: this.config.workspace.directory,
        changes: plan.changes,
      });
      const assembly = await this.config.synthesize(rootPath, options);
      for (const stack of this.config.stacks) {
        verification.push(
          await verifyStack(
            {
              target: stack.target.name,
              stackName: stack.stackName,
              template: await this.readTemplate(assembly, stack.target.name),
              client: stack.client,
              templates: stack.templates,
            },
            poll,
          ),
        );
      }
      const problems = verification.flatMap((entry) =>
        entry.problems.map((problem) => `${entry.stackName}: ${problem}`),
      );
      if (problems.length > 0) {
        throw new Error(
          `The first v1 deploy wouldn't keep every AgentCore resource:\n${problems.map((problem) => `  ${problem}`).join("\n")}`,
        );
      }
    } catch (error) {
      return this.putBack(error as Error, run.refactored, backup, verification, stacks, set, poll);
    }

    // 3. Report.
    const codeNotes = await scanAgentCode(rootPath, this.config.codeDirectories);
    await writeFile(
      join(rootPath, REPORT_FILE),
      migrationReport({
        plan,
        stacks: stacks(),
        verification,
        files: plan.changes,
        codeNotes,
        ...(this.config.libraryOverride && { libraryOverride: this.config.libraryOverride }),
        date: (this.config.now ?? (() => new Date()))(),
      }),
    );
    await backup.discard();
    return {
      migrated: true,
      stacks: stacks(),
      files: [...plan.changes, { path: REPORT_FILE, kind: "added" }],
      verification,
      report: REPORT_FILE,
      recovery: [],
    };
  }

  /** After a failure past the refactors: moves the stacks back and restores the files. */
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
    let filesRestored = backup === undefined;
    const recovery: string[] = [];
    try {
      await backup?.restore();
      filesRestored = true;
    } catch (restoreError) {
      recovery.push(
        `Couldn't restore the project's v0 files (${(restoreError as Error).message}). The ` +
          `originals are in ${join("agentcore", ".cli", "migrate-backup")}; copy them back ` +
          "(agentcore/cdk from its cdk directory, everything else from its files directory), or " +
          "restore them from git with `git checkout -- .` and `git clean -fd`.",
      );
    }
    const undo = await undoRefactors(refactored, poll);
    for (const stack of undo.undone) set(stack.stackName, { outcome: "undone" });
    for (const { stack, error: undoError } of undo.undoFailed) {
      set(stack.stackName, { outcome: "undo-failed", message: undoError.message });
    }
    recovery.push(...(await this.recoveryFor(undefined, undo.undoFailed)));
    return {
      migrated: false,
      stacks: stacks(),
      files: [],
      verification,
      error: error.message,
      restored: filesRestored && recovery.length === 0,
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

  /**
   * What the user has to do by hand: for a refactor CloudFormation couldn't roll
   * back, the commands to find and repair the stack, with the planned moves and a
   * ready-made reverse refactor saved under agentcore/.cli; for a refactor that
   * completed but couldn't be undone, what that leaves.
   */
  private async recoveryFor(
    failure: StackRefactorError | undefined,
    undoFailed: { stack: RefactorStack; error: Error }[],
  ): Promise<string[]> {
    const steps: string[] = [];
    const broken = [
      ...(failure?.details.kind === "rollback-failed" ? [failure] : []),
      ...undoFailed.flatMap(({ error }) =>
        error instanceof StackRefactorError && error.details.kind === "rollback-failed"
          ? [error]
          : [],
      ),
    ];
    for (const error of broken) steps.push(...(await this.manualRepair(error)));
    for (const { stack, error } of undoFailed) {
      if (error instanceof StackRefactorError && error.details.kind === "rollback-failed") continue;
      steps.push(
        `Stack ${stack.stackName} is still refactored to the v1 logical IDs (its resources are ` +
          `intact), because moving it back failed: ${error.message}. Run \`agentcore migrate\` ` +
          "again once the cause is fixed; it finds nothing to move in this stack. Don't deploy " +
          "it with the v0 CLI in the meantime: that deploy would delete and recreate the moved " +
          "resources.",
      );
    }
    return steps;
  }

  private async manualRepair(error: StackRefactorError): Promise<string[]> {
    const { stackName, region, refactorId } = error.details;
    const stack = this.config.stacks.find((entry) => entry.stackName === stackName);
    const directory = join(this.config.rootPath, RECOVERY_RELATIVE_PATH);
    const movesFile = join(RECOVERY_RELATIVE_PATH, `${stackName}.moves.json`);
    const undoFile = join(RECOVERY_RELATIVE_PATH, `${stackName}.undo-refactor.json`);
    let saved = true;
    if (stack) {
      const moves = [...stack.planned.renames].map(([from, to]) => ({ from, to }));
      const templateBody = JSON.stringify(stack.deployed);
      try {
        await mkdir(directory, { recursive: true });
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
              StackDefinitions: [{ StackName: stackName, TemplateBody: templateBody }],
              ResourceMappings: moves.map(({ from, to }) => ({
                Source: { StackName: stackName, LogicalResourceId: to },
                Destination: { StackName: stackName, LogicalResourceId: from },
              })),
            },
            null,
            2,
          )}\n`,
        );
      } catch {
        saved = false;
      }
    }
    const tooBig =
      stack !== undefined &&
      Buffer.byteLength(JSON.stringify(stack.deployed)) > MAX_TEMPLATE_BODY_BYTES;
    const id = refactorId ?? "<refactor ID>";
    return [
      `Stack ${stackName} (${region}) is part-way through stack refactor ${id}: CloudFormation ` +
        "couldn't roll it back. No AWS resource was deleted or replaced (a refactor only moves " +
        "resources between logical IDs), and no project file was changed.",
      `Don't deploy ${stackName} with either CLI until it's repaired: a deploy would delete and ` +
        "recreate every resource that isn't under the logical ID its template expects.",
      `See why: \`aws cloudformation describe-stack-refactor --stack-refactor-id ${id} --region ${region}\` ` +
        `and \`aws cloudformation describe-stack-events --stack-name ${stackName} --region ${region}\`.`,
      `See which logical ID each resource is under now: \`aws cloudformation list-stack-resources ` +
        `--stack-name ${stackName} --region ${region}\`` +
        (saved && stack ? `, and compare with the planned moves (v0 → v1) in ${movesFile}.` : "."),
      ...(saved && stack
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
