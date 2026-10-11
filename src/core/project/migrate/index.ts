import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../../errors";
import { FsReadWriteJson, runProcess, type ProcessRunner, type ReadWriteJson } from "../../../io";
import type { Logger } from "../../../logging";
import type {
  MigrationCheck,
  MigrationPlan,
  MigrationPlanOptions,
  MigrationProblem,
  ProjectMigrator,
  StackMigrationPlan,
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
import { createCdkCredentialResolver, type CdkCredentialResolver } from "../backends/cdk/toolkit";
import { defaultSource, type AssetSource } from "../source";
import { convertHarness } from "./convertHarness";
import { AWS_TARGETS_RELATIVE_PATH, convertSpec, convertTargets } from "./convertSpec";
import { planStack } from "./plan";
import { preflight } from "./preflight";
import { checkStack, cloudFormationStackReader } from "./stacks";
import { createWorkspaceSynthesizer, type WorkspaceSynthesizer } from "./synth";
import type { CfnTemplate } from "./templates";
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
  /** Installs and synthesizes the v1 CDK app in the migration workspace. */
  synthesize?: WorkspaceSynthesizer;
};

/** A deployment target with a deployed stack, and what planning has read about it. */
type DeployedTarget = {
  target: AwsDeploymentTarget;
  stackName: string;
  /** Set once the stack passed its checks and its template was read. */
  template?: CfnTemplate;
};

/**
 * Plans a v0 → v1 migration from the project on disk. Planning reads the project,
 * builds the converted copy in a temporary directory, and synthesizes it; from
 * AWS it only reads the deployed stacks. It never writes to the project or to AWS.
 */
export class FsProjectMigrator implements ProjectMigrator {
  private readonly runner: ProcessRunner;
  private readonly assetSource: AssetSource;
  private readonly json: ReadWriteJson;
  private readonly createCloudFormationClient: CreateCloudFormationClient;
  private readonly resolveCredentials: CdkCredentialResolver;
  private readonly resolveAccount: AccountResolver;
  private readonly synthesize: WorkspaceSynthesizer;

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
  }

  public async plan(rootPath: string, options: MigrationPlanOptions = {}): Promise<MigrationPlan> {
    const { checks, context } = await preflight(rootPath, this.runner);
    if (!context) {
      return {
        rootPath,
        checks,
        problems: [],
        deployedChanges: [],
        pins: [],
        warnings: [],
        changes: [],
        stacks: [],
        ready: false,
      };
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

    const workspace = await buildMigrationWorkspace({
      rootPath,
      spec: converted.json,
      harnesses: harnesses.flatMap(({ directory, yaml }) =>
        yaml === undefined ? [] : [{ directory, yaml }],
      ),
      assetSource: this.assetSource,
    });
    try {
      // The v1 app only synthesizes from a project that converted cleanly, is only
      // needed when there are stacks to plan, and only worth running once every
      // stack has passed its checks (which is also when its template was read).
      const readyToSynth =
        checks.every((check) => check.ok) &&
        problems.length === 0 &&
        converted.deployedChanges.length === 0;
      const stacks =
        readyToSynth && deployed.targets.length > 0
          ? await this.planStacks(workspace.directory, deployed.targets, checks, options)
          : [];
      return {
        rootPath,
        projectName: v0Spec.name,
        checks,
        problems,
        deployedChanges: converted.deployedChanges,
        pins: converted.pins,
        warnings: [...converted.warnings, ...harnesses.flatMap((harness) => harness.warnings)],
        changes: workspace.changes,
        stacks,
        ready:
          checks.every((check) => check.ok) &&
          problems.length === 0 &&
          converted.deployedChanges.length === 0 &&
          stacks.every((stack) => stack.ready),
      };
    } finally {
      await workspace.dispose();
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
      const reader = cloudFormationStackReader(
        this.createCloudFormationClient({ credentials, region: target.region }),
      );
      const check = await checkStack(reader, target.name, stackName);
      if (check.ok) entry.template = await reader.template(stackName);
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
  ): Promise<StackMigrationPlan[]> {
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

    const plans: StackMigrationPlan[] = [];
    for (const { target, stackName, template } of targets) {
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
        const { plan } = await planStack({
          target,
          stackName,
          // Read by readStack, whose check passing is a precondition of getting here.
          deployed: template!,
          v1,
          v1StackName: artifact.stackName,
        });
        plans.push(plan);
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
