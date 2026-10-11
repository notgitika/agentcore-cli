import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../../errors";
import { FsReadWriteJson, runProcess, type ProcessRunner, type ReadWriteJson } from "../../../io";
import type { Logger } from "../../../logging";
import { existsSync } from "node:fs";
import type { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import type {
  MigrationCheck,
  MigrationPlan,
  MigrationPlanOptions,
  MigrationProblem,
  PreparedMigration,
  ProjectMigrator,
} from "../../../handlers/project/migrate/types";
import {
  AwsDeploymentTargetsSchema,
  type AwsDeploymentTarget,
} from "../../../projectSchemas/aws-targets";
import type { V0DeployedState } from "../../../projectSchemas/v0";
import { createCloudFormationClient } from "../../factories";
import type { CreateCloudFormationClient } from "../../types";
import { stackArtifactForTarget } from "../backends/cdk/assembly";
import { resolveAwsAccount, type AccountResolver } from "../backends/cdk/environment";
import {
  createCdkCredentialResolver,
  type CdkCredentialProvider,
  type CdkCredentialResolver,
} from "../backends/cdk/toolkit";
import { defaultSource, type AssetSource } from "../source";
import { convertHarness } from "./convertHarness";
import { AWS_TARGETS_RELATIVE_PATH, convertSpec, convertTargets } from "./convertSpec";
import {
  JOURNAL_RELATIVE_PATH,
  MigrationApplier,
  type MigrationJournal,
  type PreparedStack,
} from "./apply";
import { BACKUP_RELATIVE_PATH, type writeMigratedFiles } from "./files";
import { planStack, type PlannedStack } from "./plan";
import type { PollOptions } from "./refactor";
import { preflight } from "./preflight";
import { checkStack, cloudFormationStackReader } from "./stacks";
import {
  CDK_LIBRARY_OVERRIDE_ENV,
  createWorkspaceSynthesizer,
  type WorkspaceSynthesizer,
} from "./synth";
import type { CfnTemplate } from "./templates";
import { bootstrapBucketStore, type TemplateStore } from "./templateStore";
import { buildMigrationWorkspace } from "./workspace";

export { CDK_LIBRARY_OVERRIDE_ENV } from "./synth";

/** Just enough of a synthesized template to know it is one; the rest is read as is. */
const TemplateSchema = z.looseObject({ Resources: z.record(z.string(), z.unknown()).optional() });

export type FsProjectMigratorConfig = {
  logger: Logger;
  /** Runs git (and, through the default synthesizer, npm); injectable so tests never spawn processes. */
  runner?: ProcessRunner;
  /** Where v1's vended CDK app is read from. */
  assetSource?: AssetSource;
  /** Builds the CloudFormation client the deployed stacks are read through. */
  createCloudFormationClient?: CreateCloudFormationClient;
  /** Resolves the AWS credentials a target's stack is read with. */
  resolveCredentials?: CdkCredentialResolver;
  /** The account behind those credentials, checked against the target's. */
  resolveAccount?: AccountResolver;
  /** Installs and synthesizes the v1 CDK app, in the migration workspace and then in the project. */
  synthesize?: WorkspaceSynthesizer;
  /** Where templates too big to pass inline are uploaded; defaults to the CDK bootstrap bucket. */
  createTemplateStore?: (config: {
    cloudFormation: CloudFormationClient;
    credentials: CdkCredentialProvider;
    region: string;
  }) => TemplateStore;
  /** How stack refactors and change sets are waited on; tests poll without sleeping. */
  poll?: PollOptions;
  /** Read for {@link CDK_LIBRARY_OVERRIDE_ENV}, to note it in MIGRATION.md; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Writes the migrated files into the project; tests make it fail. */
  writeFiles?: typeof writeMigratedFiles;
};

/** A deployment target with a deployed stack, and what planning has read about it. */
type DeployedTarget = {
  target: AwsDeploymentTarget;
  stackName: string;
  /** Set once the stack passed its checks and its template was read. */
  template?: CfnTemplate;
  /** The client the stack was read through, for the target's account and region. */
  client?: CloudFormationClient;
  credentials?: CdkCredentialProvider;
};

/**
 * Plans and applies a v0 → v1 migration of the project on disk. Planning reads
 * the project, builds the converted copy in a temporary directory, and
 * synthesizes it; from AWS it only reads the deployed stacks. It never writes to
 * the project or to AWS. Applying (see {@link MigrationApplier}) does both.
 */
export class FsProjectMigrator implements ProjectMigrator {
  private readonly runner: ProcessRunner;
  private readonly assetSource: AssetSource;
  private readonly json: ReadWriteJson;
  private readonly createCloudFormationClient: CreateCloudFormationClient;
  private readonly resolveCredentials: CdkCredentialResolver;
  private readonly resolveAccount: AccountResolver;
  private readonly synthesize: WorkspaceSynthesizer;
  private readonly createTemplateStore: NonNullable<FsProjectMigratorConfig["createTemplateStore"]>;
  private readonly poll: PollOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly writeFiles?: typeof writeMigratedFiles;

  constructor(config: FsProjectMigratorConfig) {
    this.runner = config.runner ?? runProcess;
    this.assetSource = config.assetSource ?? defaultSource();
    this.json = new FsReadWriteJson({ logger: config.logger });
    this.createCloudFormationClient =
      config.createCloudFormationClient ?? createCloudFormationClient;
    this.resolveCredentials =
      config.resolveCredentials ?? createCdkCredentialResolver(config.logger);
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
    this.synthesize = config.synthesize ?? createWorkspaceSynthesizer({ runner: this.runner });
    this.createTemplateStore = config.createTemplateStore ?? bootstrapBucketStore;
    this.poll = config.poll ?? {};
    this.env = config.env ?? process.env;
    if (config.writeFiles) this.writeFiles = config.writeFiles;
  }

  public async plan(rootPath: string, options: MigrationPlanOptions = {}): Promise<MigrationPlan> {
    const prepared = await this.prepare(rootPath, options);
    await prepared.dispose();
    return prepared.plan;
  }

  public async prepare(
    rootPath: string,
    options: MigrationPlanOptions = {},
  ): Promise<PreparedMigration> {
    const { checks, context } = await preflight(rootPath, this.runner);
    if (!context) {
      return unprepared({
        rootPath,
        checks,
        problems: [],
        deployedChanges: [],
        pins: [],
        warnings: [],
        changes: [],
        stacks: [],
        ready: false,
      });
    }
    const { v0Spec, deployedState } = context;

    const harnesses = await Promise.all(
      v0Spec.harnesses.map((entry) => convertHarness(rootPath, entry)),
    );
    const converted = convertSpec(
      v0Spec,
      deployedState,
      Object.fromEntries(
        harnesses.flatMap(({ name, facts }) => (facts ? [[name, facts] as const] : [])),
      ),
    );
    const targets = await this.readTargets(rootPath);
    const problems: MigrationProblem[] = [
      ...converted.problems,
      ...harnesses.flatMap((harness) => harness.problems),
      ...targets.problems,
    ];

    const deployed = deployedTargets(v0Spec.name, targets.targets, deployedState);
    checks.push(...deployed.checks);
    for (const entry of deployed.targets) {
      options.onStep?.(
        `Reading stack ${entry.stackName} (${entry.target.account}/${entry.target.region})`,
      );
      checks.push(await this.readStack(entry));
    }
    const unfinished = await unfinishedMigration(rootPath);
    if (unfinished) checks.push(unfinished);

    const workspace = await buildMigrationWorkspace({
      rootPath,
      spec: converted.json,
      harnesses: harnesses.flatMap(({ directory, yaml }) =>
        yaml === undefined ? [] : [{ directory, yaml }],
      ),
      assetSource: this.assetSource,
    });
    try {
      if (workspace.escapingSymlinks.length > 0) {
        checks.push({
          name: "symlinks",
          ok: false,
          message:
            "Migration installs and synthesizes the v1 CDK app in a copy of the project, and " +
            "these symlinks lead out of it, so the build could change files outside the copy:\n" +
            workspace.escapingSymlinks.map((link) => `  ${link}`).join("\n") +
            "\nReplace each with the files it points to (or, if it points inside the project, " +
            "with a relative link), then try again.",
        });
      }
      // The v1 app only synthesizes from a project that converted cleanly, is only
      // needed when there are stacks to plan, and only worth running once every
      // stack has passed its checks (which is also when its template was read).
      const readyToSynth =
        checks.every((check) => check.ok) &&
        problems.length === 0 &&
        converted.deployedChanges.length === 0;
      const planned =
        readyToSynth && deployed.targets.length > 0
          ? await this.planStacks(workspace.directory, deployed.targets, checks, options)
          : [];
      const plan: MigrationPlan = {
        rootPath,
        projectName: v0Spec.name,
        checks,
        problems,
        deployedChanges: converted.deployedChanges,
        pins: converted.pins,
        warnings: [...converted.warnings, ...harnesses.flatMap((harness) => harness.warnings)],
        changes: workspace.changes,
        stacks: planned.map((stack) => stack.planned.plan),
        ready:
          checks.every((check) => check.ok) &&
          problems.length === 0 &&
          converted.deployedChanges.length === 0 &&
          planned.every((stack) => stack.planned.plan.ready),
      };
      const applier = new MigrationApplier({
        rootPath,
        plan,
        workspace,
        stacks: planned,
        codeDirectories: v0Spec.runtimes.map((runtime) => runtime.codeLocation),
        synthesize: this.synthesize,
        json: this.json,
        poll: this.poll,
        libraryOverride: this.env[CDK_LIBRARY_OVERRIDE_ENV]?.trim() || undefined,
        ...(this.writeFiles && { writeFiles: this.writeFiles }),
      });
      const requireReady = () => {
        if (!plan.ready) {
          throw new ProjectStateError(
            "The project can't be migrated yet; run `agentcore migrate --dry-run` to see why.",
          );
        }
      };
      return {
        plan,
        preview: async (applyOptions) => {
          requireReady();
          return applier.preview(applyOptions);
        },
        apply: async (applyOptions) => {
          requireReady();
          return applier.apply(applyOptions);
        },
        dispose: () => workspace.dispose(),
      };
    } catch (error) {
      await workspace.dispose();
      throw error;
    }
  }

  private async readTargets(
    rootPath: string,
  ): Promise<{ targets: AwsDeploymentTarget[]; problems: MigrationProblem[] }> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(rootPath, AWS_TARGETS_RELATIVE_PATH), "utf8"));
    } catch (error) {
      return {
        targets: [],
        problems: [
          {
            file: AWS_TARGETS_RELATIVE_PATH,
            path: "(file)",
            message: `Couldn't read it: ${(error as Error).message}`,
          },
        ],
      };
    }
    const parsed = AwsDeploymentTargetsSchema.safeParse(raw);
    return { targets: parsed.success ? parsed.data : [], problems: convertTargets(raw) };
  }

  /**
   * Checks one deployed target's stack with the target's credentials, and reads
   * its deployed template when the stack can be refactored. AWS errors become a
   * failed check, so one dry run still reports everything.
   */
  private async readStack(entry: DeployedTarget): Promise<MigrationCheck> {
    const { target, stackName } = entry;
    try {
      const credentials = await this.resolveCredentials(target.region);
      const account = await this.resolveAccount(target.region, credentials);
      if (account !== target.account) {
        return {
          name: `stack (${target.name})`,
          ok: false,
          message:
            `Target '${target.name}' is in AWS account ${target.account}, but the active ` +
            `credentials belong to ${account}. Use credentials for ${target.account}.`,
        };
      }
      const client = this.createCloudFormationClient({ credentials, region: target.region });
      const reader = cloudFormationStackReader(client);
      const check = await checkStack(reader, target.name, stackName);
      if (check.ok) {
        entry.template = await reader.template(stackName);
        entry.client = client;
        entry.credentials = credentials;
      }
      return check;
    } catch (error) {
      return {
        name: `stack (${target.name})`,
        ok: false,
        message: `Couldn't read stack '${stackName}' in ${target.account}/${target.region}: ${(error as Error).message}`,
      };
    }
  }

  private async planStacks(
    workspaceDirectory: string,
    targets: DeployedTarget[],
    checks: MigrationCheck[],
    options: MigrationPlanOptions,
  ): Promise<PreparedStack[]> {
    let assemblyDirectory: string;
    try {
      assemblyDirectory = await this.synthesize(workspaceDirectory, options);
    } catch (error) {
      checks.push({
        name: "v1 synth",
        ok: false,
        message: `The converted project's v1 CDK app didn't synthesize:\n${(error as Error).message}`,
      });
      return [];
    }
    checks.push({ name: "v1 synth", ok: true, message: "the converted project synthesizes" });

    const plans: PreparedStack[] = [];
    for (const { target, stackName, template, client, credentials } of targets) {
      options.onStep?.(`Planning the refactor of ${stackName}`);
      try {
        const artifact = await stackArtifactForTarget(this.json, assemblyDirectory, target.name);
        if (artifact.templateFile === undefined) {
          throw new ProjectStateError(
            `Stack artifact '${artifact.id}' names no template file in the v1 cloud assembly.`,
          );
        }
        const v1 = (await this.json.read(
          join(assemblyDirectory, artifact.templateFile),
          TemplateSchema,
        )) as CfnTemplate;
        // Read by readStack, whose check passing is a precondition of getting here.
        const deployed = template!;
        const planned: PlannedStack = await planStack({
          target,
          stackName,
          deployed,
          v1,
          v1StackName: artifact.stackName,
        });
        const cloudFormation = client!;
        let store: TemplateStore | undefined;
        plans.push({
          target,
          stackName,
          deployed,
          planned,
          client: cloudFormation,
          templates: async () =>
            (store ??= this.createTemplateStore({
              cloudFormation,
              credentials: credentials!,
              region: target.region,
            })),
        });
      } catch (error) {
        // One target that can't be planned still leaves the rest of the report.
        checks.push({
          name: `plan (${target.name})`,
          ok: false,
          message: `Couldn't plan the refactor of '${stackName}': ${(error as Error).message}`,
        });
      }
    }
    return plans;
  }
}

/**
 * A failing check when an earlier `agentcore migrate` was stopped part-way (a
 * second Ctrl-C, a crash): it leaves its journal, and its backup of the v0 files
 * if it got as far as writing them. Says what it may have done and where the
 * originals are, so nothing is deleted by accident.
 */
async function unfinishedMigration(rootPath: string): Promise<MigrationCheck | undefined> {
  const journalPath = join(rootPath, JOURNAL_RELATIVE_PATH);
  const backupPath = join(rootPath, BACKUP_RELATIVE_PATH);
  const hasBackup = existsSync(backupPath);
  if (!existsSync(journalPath) && !hasBackup) return undefined;
  let journal: Partial<MigrationJournal> = {};
  try {
    journal = JSON.parse(await readFile(journalPath, "utf8")) as MigrationJournal;
  } catch {
    // No journal (or an unreadable one): the backup alone still says enough.
  }
  const lines = [
    `An earlier \`agentcore migrate\`${journal.startedAt ? ` (started ${journal.startedAt})` : ""} ` +
      "was stopped before it finished.",
  ];
  for (const refactor of journal.refactors ?? []) {
    lines.push(
      `Stack ${refactor.stackName} may be refactored to the v1 logical IDs: check with ` +
        `\`aws cloudformation describe-stack-refactor --stack-refactor-id ${refactor.refactorId} ` +
        `--region ${refactor.region}\` (EXECUTE_COMPLETE means it was; running \`agentcore ` +
        "migrate` again then finds nothing to move in it). Don't deploy it with the v0 CLI " +
        "until you know.",
    );
  }
  if (hasBackup) {
    lines.push(
      `The v0 files it replaced are in ${BACKUP_RELATIVE_PATH}: agentcore/cdk in its cdk ` +
        "directory, everything else under files/ at its project path. Copy back any that are " +
        "missing or already converted (or restore them from git).",
    );
  }
  lines.push(
    `Once the project is a v0 project again, delete ${hasBackup ? `${BACKUP_RELATIVE_PATH} and ` : ""}` +
      `${JOURNAL_RELATIVE_PATH}, then try again.`,
  );
  return { name: "unfinished migration", ok: false, message: lines.join("\n") };
}

/** A migration that can't go ahead: there is only the plan saying why. */
function unprepared(plan: MigrationPlan): PreparedMigration {
  const refuse = async (): Promise<never> => {
    throw new ProjectStateError(
      "The project can't be migrated; run `agentcore migrate --dry-run` to see why.",
    );
  };
  return { plan, preview: refuse, apply: refuse, dispose: async () => {} };
}

/**
 * The deployment targets that have a deployed stack: those the deployed state
 * records resources for. A deployed target missing from aws-targets.json can't be
 * planned (its account and region are unknown, and the v1 app wouldn't
 * synthesize its stack), so it fails a check.
 */
export function deployedTargets(
  projectName: string,
  targets: AwsDeploymentTarget[],
  state: V0DeployedState,
): { targets: DeployedTarget[]; checks: MigrationCheck[] } {
  const checks: MigrationCheck[] = [];
  const deployed: DeployedTarget[] = [];
  for (const [name, recorded] of Object.entries(state.targets)) {
    if (recorded.resources === undefined) continue;
    const target = targets.find((candidate) => candidate.name === name);
    if (!target) {
      checks.push({
        name: `stack (${name})`,
        ok: false,
        message:
          `The deployed state records a deployment to target '${name}', which isn't in ` +
          `${AWS_TARGETS_RELATIVE_PATH}. Add the target back, or tear its stack down with the ` +
          "v0 CLI first.",
      });
      continue;
    }
    deployed.push({
      target,
      // v0 records the stack name; older deploys derive it the same way v1 does.
      stackName:
        recorded.resources.stackName ??
        `AgentCore-${projectName.replace(/_/g, "-")}-${name.replace(/_/g, "-")}`,
    });
  }
  return { targets: deployed, checks };
}
