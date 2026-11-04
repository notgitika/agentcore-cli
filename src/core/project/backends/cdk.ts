import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { GetTemplateCommand, type Stack } from "@aws-sdk/client-cloudformation";
import { parse as parseYaml } from "yaml";
import { MalformedServiceResponseError, ProjectStateError } from "../../../errors/errors";
import type {
  DeployResult,
  Project,
  ProjectEvent,
  DeployableResource,
  ResolvedDeployedResource,
  ResolvedProjectResource,
} from "../../../handlers/project/types";
import { assertCdkLocalContainerSupport, cdkCompatibilityWarning } from "./cdk/compatibility";
import {
  assertRetainedContainerImages,
  buildArgumentRedactor,
  checkLocalContainerBuilder,
  containerBuildSettings,
  redactBuildError,
  type ContainerTemplate,
} from "./cdk/localContainers";
import {
  createLineSplitter,
  FsReadWriteJson,
  ProcessFailedError,
  requireTool,
  runProcess,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../../io";
import { withOutputEvents } from "../events";
import type { Logger } from "../../../logging";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type {
  DeployBackendInput,
  ProjectBackend,
  ResolveDeployedResourcesBackendInput,
  ResolveProjectResourcesBackendInput,
} from "./types";
import { createCloudFormationClient } from "../../factories";
import type { AwsCredentials, CreateCloudFormationClient } from "../../types";
import {
  createCredentialProvisioner,
  createCredentialRemover,
  orphanedCredentials,
  type CredentialProviderCalls,
  type CredentialProviderRef,
  type CredentialProvisioner,
  type CredentialRemover,
} from "./cdk/credentials";
import {
  countDeployableResources,
  stackArtifactForTarget,
  synthCommand,
  type StackArtifact,
} from "./cdk/assembly";
import {
  readDeployedState,
  removeTargetState,
  stackReferenceOf,
  updateTargetState,
} from "./cdk/deployedState";
import {
  bootstrapStackReader,
  createCloudFormationStackReader,
  probeBootstrap,
  resolveAwsAccount,
  type AccountResolver,
  type BootstrapProbe,
} from "./cdk/environment";
import {
  createCdkCredentialResolver,
  createCdkRunner,
  loadBootstrapTemplate,
  type BootstrapTemplateLoader,
  type CdkCredentialResolver,
  type CdkOperation,
  type CdkRunner,
  type CdkRunOptions,
  type CdkRunResult,
} from "./cdk/toolkit";
import {
  createPaymentConnectorAuthorizationUrlReporter,
  type PaymentConnectorAuthorizationUrlReporter,
} from "./cdk/paymentConnectorAuthorizationUrls";
import { describeStack } from "./cdk/stackReader";

type StackDescriber = typeof describeStack;

/**
 * How many trailing Toolkit lines an operation keeps for error context. Matches
 * the cap streamProcess uses for a failed subprocess's captured output.
 */
const MAX_ERROR_OUTPUT_LINES = 20;

function unresolvedCredentialName(error: unknown): string | undefined {
  if (!(error instanceof ProcessFailedError)) return undefined;

  return (
    error.message.match(
      /Credential "([^"]+)" (?:not found|has no clientSecretArn) in deployed state/,
    )?.[1] ??
    error.message.match(
      /references credential "([^"]+)", but no deployed credential provider(?: ARN)? was found/,
    )?.[1]
  );
}

// Payment output keys drop underscores the same way AgentCorePayments' toCdkId does.
function cdkId(name: string): string {
  return name.replace(/_/g, "");
}

function stackExportName(stackName: string, ...parts: string[]): string {
  return [stackName, ...parts]
    .map((part) => part.replace(/_/g, "-").replace(/[^a-zA-Z0-9:-]/g, ""))
    .join("-");
}

function findDeployedResourceId(
  stack: Stack,
  input: Pick<ResolvedDeployedResource, "resourceType" | "name">,
): string | undefined {
  if (!stack.StackName) return undefined;
  const exportResourceName = input.name.replaceAll("_", "-");
  const exportName = {
    runtime: `${stack.StackName}-${exportResourceName}-RuntimeId`,
    harness: `${stack.StackName}-Harness-${exportResourceName}-Id`,
    gateway: `${stack.StackName}-Gateway-${exportResourceName}-Id`,
  }[input.resourceType];
  return stack.Outputs?.find((output) => output.ExportName === exportName)?.OutputValue;
}

export type TransactionSearchEnabler = (
  target: AwsDeploymentTarget,
  credentials: AwsCredentials,
) => Promise<void>;

export type CdkBackendConfig = {
  logger: Logger;
  runner?: ProcessRunner;
  checkTool?: typeof requireTool;
  json?: ReadWriteJson;
  createCloudFormationClient?: CreateCloudFormationClient;
  /** Identity client used to provision the project's credential providers. */
  identity: CredentialProviderCalls;
  cdk?: CdkRunner;
  resolveCredentials?: CdkCredentialResolver;
  bootstrap?: BootstrapProbe;
  enableTransactionSearch: TransactionSearchEnabler;
  resolveAccount?: AccountResolver;
  loadBootstrapTemplate?: BootstrapTemplateLoader;
  provisionCredentials?: CredentialProvisioner;
  removeCredentials?: CredentialRemover;
  describeStack?: StackDescriber;
  reportPaymentConnectorAuthorizationUrls?: PaymentConnectorAuthorizationUrlReporter;
  checkLocalBuilder?: typeof checkLocalContainerBuilder;
  assertLocalCdkSupport?: typeof assertCdkLocalContainerSupport;
};

/** Builds and deploys projects through the scaffolded CDK app. */
export class CdkBackend implements ProjectBackend {
  private readonly logger: Logger;
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;
  private readonly json: ReadWriteJson;
  private readonly cdk: CdkRunner;
  private readonly resolveCredentials: CdkCredentialResolver;
  private readonly bootstrap: BootstrapProbe;
  private readonly enableTransactionSearch: TransactionSearchEnabler;
  private readonly resolveAccount: AccountResolver;
  private readonly loadBootstrapTemplate: BootstrapTemplateLoader;
  private readonly provisionCredentials: CredentialProvisioner;
  private readonly removeCredentials: CredentialRemover;
  private readonly describeStack: StackDescriber;
  private readonly reportPaymentConnectorAuthorizationUrls: PaymentConnectorAuthorizationUrlReporter;
  private readonly checkLocalBuilder: typeof checkLocalContainerBuilder;
  private readonly assertLocalCdkSupport: typeof assertCdkLocalContainerSupport;
  private readonly createCloudFormationClient: CreateCloudFormationClient;

  constructor(config: CdkBackendConfig) {
    this.logger = config.logger;
    this.runner = config.runner ?? runProcess;
    this.checkLocalBuilder = config.checkLocalBuilder ?? checkLocalContainerBuilder;
    this.assertLocalCdkSupport = config.assertLocalCdkSupport ?? assertCdkLocalContainerSupport;
    this.createCloudFormationClient =
      config.createCloudFormationClient ?? createCloudFormationClient;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.cdk = config.cdk ?? createCdkRunner(config.logger);
    this.resolveCredentials =
      config.resolveCredentials ?? createCdkCredentialResolver(config.logger);
    const readStack = createCloudFormationStackReader(
      config.createCloudFormationClient ?? createCloudFormationClient,
    );
    const readBootstrapStack = bootstrapStackReader(readStack);
    this.bootstrap =
      config.bootstrap ??
      ((region, credentials) => probeBootstrap(region, credentials, readBootstrapStack));
    this.enableTransactionSearch = config.enableTransactionSearch;
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
    this.loadBootstrapTemplate = config.loadBootstrapTemplate ?? loadBootstrapTemplate;
    this.provisionCredentials =
      config.provisionCredentials ?? createCredentialProvisioner(config.identity);
    this.removeCredentials = config.removeCredentials ?? createCredentialRemover(config.identity);
    this.describeStack =
      config.describeStack ??
      ((region, credentials, stackName) =>
        describeStack(region, credentials, stackName, (name) =>
          readStack(name, region, credentials),
        ));
    this.reportPaymentConnectorAuthorizationUrls =
      config.reportPaymentConnectorAuthorizationUrls ??
      createPaymentConnectorAuthorizationUrlReporter(config.createCloudFormationClient);
  }

  // Local prerequisites for synth. Checked before any AWS mutation so a missing
  // toolchain or dependencies fails without having provisioned credentials.
  private async ensureCdkDependencies(project: Project): Promise<void> {
    const cdkDir = this.cdkDirectory(project);
    if (!existsSync(join(cdkDir, "node_modules"))) {
      throw new ProjectStateError(
        `CDK dependencies are missing for project '${project.name}'. ` +
          `Run 'npm install' in ${cdkDir}.`,
      );
    }
    await this.checkTool("npm", "Install Node.js: https://nodejs.org/");
  }

  private async *synthesize(
    project: Project,
    explainUndeployedCredentials: boolean,
  ): AsyncGenerator<ProjectEvent, void> {
    await this.ensureCdkDependencies(project);

    const compatibilityWarning = await cdkCompatibilityWarning(this.cdkDirectory(project));
    if (compatibilityWarning) {
      yield { type: "warning", message: compatibilityWarning };
    }

    const settings = containerBuildSettings(project);
    if (settings.localRuntimes.length || settings.localHarnesses.length) {
      this.assertLocalCdkSupport(this.cdkDirectory(project));
    }
    const redact = buildArgumentRedactor(settings.buildArgumentValues);
    yield { type: "step", message: "synthesizing CloudFormation templates" };
    try {
      yield* withOutputEvents((emit) => {
        // Reassemble chunks before redaction so an argument split between chunks
        // cannot reach the debug log or live progress tail.
        const lines = createLineSplitter((line) => {
          const safe = redact(line);
          this.logger.debug(safe);
          emit(safe);
        });
        return this.runner(synthCommand(this.assemblyDirectory(project)), {
          cwd: this.cdkDirectory(project),
          onOutput: (chunk) => {
            lines.push(chunk);
          },
        }).finally(() => lines.flush());
      });
    } catch (error) {
      redactBuildError(error, redact);
      const credentialName = explainUndeployedCredentials
        ? unresolvedCredentialName(error)
        : undefined;
      if (credentialName) {
        throw new ProjectStateError(
          `Project build cannot resolve credential "${credentialName}" before its first deployment. ` +
            `Run 'agentcore deploy' to provision the credential and build the project.`,
          { cause: error, meta: { credentialName } },
        );
      }
      throw error;
    }
  }

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    yield* this.synthesize(project, true);
  }

  public async *deploy(
    project: Project,
    input: DeployBackendInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    yield { type: "step", message: `verifying AWS account ${target.account}` };
    const credentials = await this.credentialsForTarget(target);

    // Fail on local setup errors (missing toolchain/deps) and malformed state
    // before any AWS mutation, so a local problem never leaves credentials
    // provisioned or the stack ARN unrecorded.
    await this.ensureCdkDependencies(project);
    const settings = containerBuildSettings(project);
    const hasLocalImages = settings.localRuntimes.length > 0 || settings.localHarnesses.length > 0;
    if (hasLocalImages) {
      this.assertLocalCdkSupport(this.cdkDirectory(project));
      yield { type: "step", message: "checking the local builder for Linux ARM64 support" };
      await this.checkLocalBuilder(this.runner, project.rootPath);
    }

    // Read before provisioning rewrites the credentials map: it is the only record
    // of what this target provisioned, so it is the only way to find a provider whose
    // credential has since left the spec.
    const recorded =
      (await readDeployedState(this.json, project.rootPath)).targets[target.name]?.resources
        ?.credentials ?? {};
    const orphaned = orphanedCredentials(recorded, project.spec.credentials);

    // Credential providers aren't stack resources; the synthesized app reads their
    // ARNs from deployed-state.json, so they must exist and be recorded before synth.
    const provisioned = yield* this.provisionCredentials(project, {
      credentials,
      region: target.region,
      targetName: target.name,
    });
    // Recorded every deploy (even when empty) so dropping the last credential
    // from the spec clears the stale entry instead of leaving it advertised.
    await updateTargetState(this.json, project.rootPath, target.name, {
      resources: { credentials: provisioned },
    });

    yield* this.synthesize(project, false);
    const assemblyDirectory = this.assemblyDirectory(project);
    const artifact = await stackArtifactForTarget(this.json, assemblyDirectory, target.name);
    const options = {
      assemblyDirectory,
      credentials,
      region: target.region,
      ...(settings.buildArgumentValues.length > 0 && {
        redactOutput: buildArgumentRedactor(settings.buildArgumentValues),
      }),
    };
    if (hasLocalImages && artifact.templateFile) {
      const names = [
        ...settings.localRuntimes.map((runtime) => runtime.name),
        ...settings.localHarnesses.map((harness) => `harness-${harness.name}`),
      ].map((name) =>
        [project.name, ...(project.spec.migratedFrom ? [] : [target.name]), name]
          .join("/")
          .toLowerCase(),
      );
      const stack = await this.describeStack(target.region, credentials, artifact.stackName);
      if (stack) {
        const client = this.createCloudFormationClient({ region: target.region, credentials });
        const previous = await client.send(
          new GetTemplateCommand({
            StackName: stack.StackId ?? artifact.stackName,
            TemplateStage: "Original",
          }),
        );
        if (!previous.TemplateBody) {
          throw new ProjectStateError(
            "Cannot verify image retention: the deployed stack template is unavailable.",
          );
        }
        assertRetainedContainerImages(
          parseYaml(previous.TemplateBody) as ContainerTemplate,
          JSON.parse(
            await readFile(join(assemblyDirectory, artifact.templateFile), "utf8"),
          ) as ContainerTemplate,
          names,
        );
      }
    }

    // Decided before the Toolkit is handed the assembly: it reads a template
    // with nothing in it as an instruction to delete the stack, and reports that
    // as an ordinary successful deploy.
    if ((await countDeployableResources(this.json, assemblyDirectory, artifact)) === 0) {
      return yield* this.teardown({ project, artifact, input, options, orphaned });
    }

    // Only after a real deploy is confirmed: a teardown (empty assembly) returns
    // above, so a destroy is never blocked by Transaction Search. Never fail the
    // deploy on it either — spans are best-effort, so any setup error just skips.
    // Opt out entirely via the spec.
    if (input.transactionSearch !== false) {
      yield { type: "step", message: "enabling CloudWatch Transaction Search" };
      try {
        await this.enableTransactionSearch(target, credentials);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        yield { type: "step", message: `skipping Transaction Search: ${detail}` };
      }
    }

    const bootstrap = await this.bootstrap(target.region, credentials);
    this.logger
      .child({
        account: target.account,
        region: target.region,
        bootstrapState: bootstrap.kind,
        ...("version" in bootstrap && { bootstrapVersion: bootstrap.version }),
      })
      .debug("checked CDK bootstrap stack");

    if (bootstrap.kind !== "current") {
      const environment = `aws://${target.account}/${target.region}`;
      yield { type: "step", message: `bootstrapping ${environment}` };
      const template = await this.loadBootstrapTemplate();
      try {
        yield* this.runCdk(
          {
            kind: "bootstrap",
            environments: [environment],
            ...(template && { templateFile: template.path }),
          },
          options,
        );
      } finally {
        await template?.cleanup();
      }
    }

    yield { type: "step", message: `deploying ${artifact.id} (usually takes a few minutes)` };
    const { outputs, stackArn } = yield* this.runCdk(
      { kind: "deploy", stackArtifactId: artifact.id },
      options,
    );

    // A successful deploy always has a stack ARN (CDK's DeployedStack requires
    // it). Its absence means a malformed result; fail loudly rather than return
    // success without recording the binding later commands need.
    if (!stackArn) {
      throw new MalformedServiceResponseError(
        `The CDK Toolkit reported a successful deploy of '${artifact.id}' without a stack ARN.`,
      );
    }

    // Persist the deployed stack's ARN so later commands read live resource state
    // from CloudFormation. Merged per target, so deploying one target never drops
    // another's recorded state.
    await updateTargetState(this.json, project.rootPath, target.name, {
      stackArn,
      resources: { bmaSession: undefined },
    });

    const bmaRuntimes = project.spec.runtimes.filter(
      (runtime) => runtime.bedrockManagedAgents === true,
    );
    if (bmaRuntimes.length > 0) {
      const stack = await this.describeStack(target.region, credentials, stackArn);
      const output = (...parts: string[]) =>
        stack?.Outputs?.find(
          (entry) => entry.ExportName === stackExportName(stack.StackName ?? "", ...parts),
        )?.OutputValue;
      const roleArn = output("BmaSessionRoleArn");
      const runtimeArns: string[] = [];
      for (const runtime of bmaRuntimes) {
        const arn = output(runtime.name, "RuntimeArn");
        if (arn) runtimeArns.push(arn);
      }
      if (!roleArn || runtimeArns.length !== bmaRuntimes.length) {
        throw new MalformedServiceResponseError(
          `The deployed stack '${stack?.StackName ?? artifact.stackName}' is missing BMA session role or runtime ARN outputs. ` +
            "Update @aws/agentcore-cdk in agentcore/cdk/package.json to a version with BMA session role support and deploy again.",
        );
      }
      await updateTargetState(this.json, project.rootPath, target.name, {
        resources: { bmaSession: { roleArn, runtimeArns } },
      });
    }

    // After the stack update, since a resource in it may have been using the provider
    // until this deploy removed the reference.
    yield* this.removeCredentials(project, {
      credentials,
      region: target.region,
      targetName: target.name,
      providers: orphaned,
    });

    // Reported after the stack is up and its ARN recorded: a Quick Create
    // connector is deployed but unusable until someone follows its authorization
    // link, and that link expires minutes after the connector is created.
    yield* this.reportPaymentConnectorAuthorizationUrls(project, {
      stackName: artifact.stackName,
      region: target.region,
      credentials,
    });

    return { outputs };
  }

  /**
   * Removes the target's stack, for a deploy of a project that declares nothing
   * to deploy.
   *
   * Destroying explicitly rather than letting the Toolkit infer it from an empty
   * template is what makes this reportable: `destroy` fails loudly if the stack
   * cannot be removed, where a deploy of an empty template succeeds either way.
   */
  private async *teardown({
    project,
    artifact,
    input,
    options,
    orphaned,
  }: {
    project: Project;
    artifact: StackArtifact;
    input: DeployBackendInput;
    options: CdkRunOptions;
    /** Providers recorded for this target before the deploy that the spec no longer declares. */
    orphaned: CredentialProviderRef[];
  }): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    if (!(await this.describeStack(target.region, options.credentials, artifact.stackName))) {
      throw new ProjectStateError(
        `Project '${project.name}' declares no resources to deploy, and no stack ` +
          `'${artifact.stackName}' exists in ${target.account}/${target.region} to remove. ` +
          `Add a resource — for example 'agentcore add runtime' — before deploying.`,
      );
    }

    const confirmed = await input.confirmTeardown({
      projectName: project.name,
      targetName: target.name,
      resourceDescription: `stack '${artifact.stackName}' and every resource in it`,
      account: target.account,
      region: target.region,
    });
    if (!confirmed) {
      throw new ProjectStateError(
        `Project '${project.name}' declares no resources to deploy, so deploying to target ` +
          `'${target.name}' would delete stack '${artifact.stackName}' and every resource in ` +
          `it. Re-run with --yes to confirm, or restore the resources the project should have.`,
      );
    }

    yield { type: "step", message: `removing stack ${artifact.stackName}` };
    yield* this.runCdk({ kind: "destroy", stackArtifactId: artifact.id }, options);
    // After the stack, since a resource in it may still be using the provider. The
    // declared credentials are included because `agentcore remove all` empties the spec
    // before the deploy that gets here, so what it recorded is all that names them.
    yield* this.removeCredentials(project, {
      credentials: options.credentials,
      region: target.region,
      targetName: target.name,
      providers: [...orphaned, ...project.spec.credentials],
    });
    await removeTargetState(this.json, project.rootPath, target.name);
    return { outputs: {}, tornDown: true };
  }

  /**
   * Runs one Toolkit operation with its progress streamed as `output` events.
   * The trailing lines are also kept so a failure can carry them: the Toolkit's
   * errors are often terse ("Access Denied"), and the resource events it
   * reported just before failing are what make the error debuggable from the
   * terminal alone.
   */
  private async *runCdk(
    operation: CdkOperation,
    options: CdkRunOptions,
  ): AsyncGenerator<ProjectEvent, CdkRunResult> {
    const recent: string[] = [];
    try {
      return yield* withOutputEvents((emit) =>
        this.cdk(operation, {
          ...options,
          onOutput: (line) => {
            const safe = options.redactOutput?.(line) ?? line;
            recent.push(safe);
            if (recent.length > MAX_ERROR_OUTPUT_LINES) recent.shift();
            emit(safe);
          },
        }),
      );
    } catch (error) {
      if (options.redactOutput) redactBuildError(error, options.redactOutput);
      if (error instanceof Error && recent.length > 0) {
        error.message += `\n\nRecent output:\n${recent.join("\n")}`;
      }
      throw error;
    }
  }

  public async resolveDeployedResources(
    project: Project,
    input: ResolveDeployedResourcesBackendInput,
  ): Promise<ResolvedDeployedResource[]> {
    const { target } = input;
    const deployedState = await readDeployedState(this.json, project.rootPath);
    const recorded = deployedState.targets[target.name];
    const stackReference = stackReferenceOf(recorded);
    if (!stackReference) {
      throw new ProjectStateError(
        `Project '${project.name}' is not deployed to target '${target.name}'. ` +
          `Run 'agentcore deploy --target ${target.name}' first.`,
      );
    }

    const credentials = await this.credentialsForTarget(target);
    const stack = await this.describeStack(target.region, credentials, stackReference);
    if (!stack) {
      throw new ProjectStateError(
        `Project '${project.name}' is not deployed to target '${target.name}'. ` +
          `Run 'agentcore deploy --target ${target.name}' first.`,
      );
    }

    const resources = [
      ...project.spec.runtimes.map(({ name }) => ({ resourceType: "runtime" as const, name })),
      ...project.spec.harnesses.map(({ name }) => ({ resourceType: "harness" as const, name })),
      ...project.spec.agentCoreGateways.map(({ name }) => ({
        resourceType: "gateway" as const,
        name,
      })),
    ];
    return resources.flatMap((resource) => {
      const id = findDeployedResourceId(stack, resource);
      return id ? [{ ...resource, id, target, credentialProvider: credentials }] : [];
    });
  }

  public async resolveProjectResources(
    project: Project,
    input: ResolveProjectResourcesBackendInput,
  ): Promise<ResolvedProjectResource[]> {
    const { target } = input;
    const { spec } = project;
    const deployedState = await readDeployedState(this.json, project.rootPath);
    const recorded = deployedState.targets[target.name];
    const stackReference = stackReferenceOf(recorded);

    // No recorded stack means nothing was ever deployed to this target, which
    // every resource below reports as local-only.
    const stack = stackReference
      ? await this.describeStack(
          target.region,
          await this.credentialsForTarget(target),
          stackReference,
        )
      : undefined;

    const byExportName = (...parts: string[]) => {
      if (!stack?.StackName) return undefined;
      // The CDK library builds every ExportName through this shared helper
      // https://github.com/aws/agentcore-l3-cdk-constructs/blob/main/src/cdk/logical-ids.ts#L84
      const want = stackExportName(stack.StackName, ...parts);
      return stack.Outputs?.find((output) => output.ExportName === want)?.OutputValue;
    };

    const byOutputKey = (key: string) =>
      stack?.Outputs?.find((output) => output.OutputKey === key)?.OutputValue;

    const asArn = (value: string | undefined) => (value ? { arn: value } : undefined);
    const asId = (value: string | undefined) => (value ? { id: value } : undefined);

    const identifierOf = (
      resourceType: DeployableResource,
      name: string,
      owner?: string,
    ): { arn: string } | { id: string } | undefined => {
      switch (resourceType) {
        case "runtime":
          return asArn(byExportName(name, "RuntimeArn"));
        case "harness":
          return asArn(byExportName("Harness", name, "Arn"));
        case "memory":
          return asArn(byExportName("Memory", name, "Arn"));
        case "knowledge-base":
          return asArn(byExportName("KnowledgeBase", name, "Arn"));
        case "evaluator":
          return asArn(byExportName("Evaluator", name, "Arn"));
        case "online-eval":
          return asArn(byExportName("OnlineEval", name, "Arn"));
        case "gateway":
          return asArn(byExportName("Gateway", name, "Arn"));
        case "gateway-target":
          // The L3 exports an id for targets and never an ARN
          return asId(byExportName("GatewayTarget", name, "Id"));
        case "policy":
          // ExportName: <StackName>-Policy-<engineName>-<policyName>-Arn
          return asArn(byExportName("Policy", owner ?? "", name, "Arn"));
        case "policy-engine":
          return asArn(byExportName("PolicyEngine", name, "Arn"));
        case "config-bundle":
          return asArn(byExportName("ConfigBundle", name, "Arn"));
        case "payment-manager":
          // @aws/agentcore-cdk's AgentCorePayments construct writes the payment
          // outputs at stack scope without an exportName, under keys built from
          // the manager name with underscores removed (its toCdkId). Therefore
          // match on the OutputKey.
          return asArn(byOutputKey(`Payment${cdkId(name)}ManagerArn`));
        case "payment-connector":
          // The same construct writes only a connector id, never an ARN, again
          // without an exportName. Therefore match on the OutputKey.
          return asId(byOutputKey(`Payment${cdkId(owner ?? "")}${cdkId(name)}ConnectorId`));
        case "runtime-endpoint":
          // ExportName: <StackName>-Endpoint-<runtimeName>-<endpointName>-Arn
          return asArn(byExportName("Endpoint", owner ?? "", name, "Arn"));
        case "credential":
          // The CLI creates credential providers imperatively. The stack does not
          // contain them. Therefore read the ARN from the deployed state file.
          return asArn(recorded?.resources?.credentials?.[name]?.credentialProviderArn);
        default: {
          const unhandled: never = resourceType;
          return unhandled;
        }
      }
    };

    // Resolves one declared resource, and keeps its children with it. The spec
    // already says which resource owns which, so status never has to pair them
    // up again by name. `owner` only builds the export name, so it is not
    // reported.
    const resolve = (
      resourceType: DeployableResource,
      name: string,
      options: { owner?: string; children?: ResolvedProjectResource[] } = {},
    ): ResolvedProjectResource => {
      const identifier = identifierOf(resourceType, name, options.owner);
      return {
        resourceType,
        name,
        ...(options.children?.length ? { children: options.children } : {}),
        ...(identifier
          ? { deploymentState: "deployed", ...identifier }
          : { deploymentState: "local-only" }),
      };
    };

    return [
      ...spec.runtimes.map((runtime) =>
        resolve("runtime", runtime.name, {
          children: Object.keys(runtime.endpoints ?? {}).map((endpointName) =>
            resolve("runtime-endpoint", endpointName, { owner: runtime.name }),
          ),
        }),
      ),
      ...spec.harnesses.map(({ name }) => resolve("harness", name)),
      ...spec.memories.map(({ name }) => resolve("memory", name)),
      ...spec.knowledgeBases.map(({ name }) => resolve("knowledge-base", name)),
      ...spec.credentials.map(({ name }) => resolve("credential", name)),
      ...spec.evaluators.map(({ name }) => resolve("evaluator", name)),
      ...spec.onlineEvalConfigs.map(({ name }) => resolve("online-eval", name)),
      ...spec.agentCoreGateways.map((gateway) =>
        resolve("gateway", gateway.name, {
          children: (gateway.targets ?? []).map(({ name }) =>
            resolve("gateway-target", name, { owner: gateway.name }),
          ),
        }),
      ),
      ...spec.policyEngines.map((engine) =>
        resolve("policy-engine", engine.name, {
          children: (engine.policies ?? []).map(({ name }) =>
            resolve("policy", name, { owner: engine.name }),
          ),
        }),
      ),
      ...spec.configBundles.map(({ name }) => resolve("config-bundle", name)),
      ...(spec.payments ?? []).map((manager) =>
        resolve("payment-manager", manager.name, {
          children: (manager.connectors ?? []).map(({ name }) =>
            resolve("payment-connector", name, { owner: manager.name }),
          ),
        }),
      ),
    ];
  }

  private async credentialsForTarget(target: AwsDeploymentTarget) {
    const credentials = await this.resolveCredentials(target.region);
    const account = await this.resolveAccount(target.region, credentials);
    if (account !== target.account) {
      throw new ProjectStateError(
        `Deployment target '${target.name}' expects AWS account ${target.account}, ` +
          `but the active credentials belong to ${account}.`,
      );
    }
    return credentials;
  }

  private cdkDirectory(project: Project): string {
    return join(project.rootPath, "agentcore", "cdk");
  }

  private assemblyDirectory(project: Project): string {
    return join(this.cdkDirectory(project), "cdk.out");
  }
}
