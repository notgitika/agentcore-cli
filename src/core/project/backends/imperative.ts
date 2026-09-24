import { NotImplementedError, ProjectStateError } from "../../../errors";
import type {
  DeployResult,
  DeployableResource,
  Project,
  ProjectEvent,
  ResolvedDeployedResource,
  ResolvedProjectResource,
} from "../../../handlers/project/types";
import { FsReadWriteJson, type ReadWriteJson } from "../../../io";
import type { Logger } from "../../../logging";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type { AwsClients } from "../../types";
import { plan as buildPlan, type PlanBuilder, type Plans } from "./imperative/agentcore/plan";
import type { KindHandlers } from "./imperative/agentcore/notImplemented";
import { createDefaultCredentialResolver } from "./imperative/credentials";
import { declaredResources, stateKey } from "./imperative/inventory";
import { assertDistinctPhysicalNames, parseStepName, type ResourceKind } from "./imperative/naming";
import type { ExecuteOptions, Step } from "./imperative/plan/plan";
import {
  forgetImperativeResource,
  hasCdkBinding,
  imperativeStateOf,
  recordImperativeResource,
} from "./imperative/state";
import { assertImperativelyDeployable, SUPPORTED_KINDS } from "./imperative/support";
import { resolveAwsAccount, type AccountResolver } from "./shared/account";
import {
  createCredentialProvisioner,
  createCredentialRemover,
  orphanedCredentials,
  type CredentialProviderCalls,
  type CredentialProviderRef,
  type CredentialProvisioner,
  type CredentialRemover,
} from "./shared/credentials";
import { readDeployedState, removeTargetState, updateTargetState } from "./shared/deployedState";
import type { AwsCredentialResolver, TransactionSearchEnabler } from "./shared/types";
import type {
  DeployBackendInput,
  ProjectBackend,
  ResolveDeployedResourcesBackendInput,
  ResolveProjectResourcesBackendInput,
} from "./types";

export type ImperativeBackendConfig = {
  logger: Logger;
  clients: AwsClients;
  identity: CredentialProviderCalls;
  resolveCredentials: AwsCredentialResolver;
  enableTransactionSearch: TransactionSearchEnabler;
  json?: ReadWriteJson;
  resolveAccount?: AccountResolver;
  provisionCredentials?: CredentialProvisioner;
  removeCredentials?: CredentialRemover;
  plan?: PlanBuilder;
  handlers?: Partial<Record<ResourceKind, KindHandlers>>;
  supportedKinds?: ReadonlySet<ResourceKind>;
  execute?: Pick<
    ExecuteOptions,
    "concurrency" | "stepTimeoutMs" | "pollDelayMs" | "sleep" | "maxDoAttempts"
  >;
  now?: () => Date;
};

/** Reports "1 resource" / "3 resources". */
function count(n: number, noun = "resource"): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Deploys a project by calling AWS APIs directly: no synthesis, no
 * CloudFormation, no bootstrap. The spec becomes a dependency graph of steps
 * (`agentcore/plan.ts`), the engine (`plan/plan.ts`) runs it with bounded
 * concurrency, and every converged resource is recorded under
 * `resources.imperative` in deployed-state.json.
 */
export class ImperativeBackend implements ProjectBackend {
  private readonly logger: Logger;
  private readonly clients: AwsClients;
  private readonly json: ReadWriteJson;
  private readonly resolveCredentials: AwsCredentialResolver;
  private readonly resolveAccount: AccountResolver;
  private readonly enableTransactionSearch: TransactionSearchEnabler;
  private readonly provisionCredentials: CredentialProvisioner;
  private readonly removeCredentials: CredentialRemover;
  private readonly plan: PlanBuilder;
  private readonly handlers: Partial<Record<ResourceKind, KindHandlers>>;
  private readonly supportedKinds: ReadonlySet<ResourceKind>;
  private readonly execute: ImperativeBackendConfig["execute"];
  private readonly now: () => Date;
  /**
   * Tail of the ledger-write queue. The engine runs several onStepSucceeded
   * hooks at once, and each rewrites deployed-state.json from a fresh read, so
   * unserialized writes would drop each other's records.
   */
  private ledger: Promise<void> = Promise.resolve();

  constructor(config: ImperativeBackendConfig) {
    this.logger = config.logger;
    this.clients = config.clients;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.resolveCredentials = config.resolveCredentials ?? createDefaultCredentialResolver();
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
    this.enableTransactionSearch = config.enableTransactionSearch;
    this.provisionCredentials =
      config.provisionCredentials ?? createCredentialProvisioner(config.identity);
    this.removeCredentials = config.removeCredentials ?? createCredentialRemover(config.identity);
    this.plan = config.plan ?? buildPlan;
    this.handlers = config.handlers ?? {};
    this.supportedKinds = config.supportedKinds ?? SUPPORTED_KINDS;
    this.execute = config.execute;
    this.now = config.now ?? (() => new Date());
  }

  // eslint-disable-next-line require-yield
  public async *build(_project: Project): AsyncGenerator<ProjectEvent, void> {
    throw new NotImplementedError(
      "imperative deploy does not package code yet; 'project build' arrives with CodeZip support",
    );
  }

  public async *deploy(
    project: Project,
    input: DeployBackendInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    yield { type: "step", message: `Verifying AWS account ${target.account}` };
    const credentials = await this.credentialsForTarget(target);

    // Everything that can be decided from the spec and the state file fails here,
    // before credentials are provisioned or anything is created.
    assertImperativelyDeployable(project, this.supportedKinds);
    // Two declared names that rewrite to one AWS name would converge on one
    // resource; refuse here rather than after credential providers exist.
    assertDistinctPhysicalNames(
      { projectName: project.name, targetName: target.name },
      declaredResources(project.spec),
    );
    const targetState = (await readDeployedState(this.json, project.rootPath)).targets[target.name];
    if (hasCdkBinding(targetState)) {
      throw new ProjectStateError(
        `Target '${target.name}' of project '${project.name}' is managed by CloudFormation stack ` +
          `'${targetState?.stackArn ?? targetState?.resources?.stackName}'. The imperative backend ` +
          `does not adopt or delete CDK resources. To migrate, set managedBy back to "CDK", remove ` +
          `the resources from agentcore.json and deploy once (this deletes the stack), then set ` +
          `managedBy to "Imperative" and deploy again.`,
      );
    }
    const recordedCredentials = targetState?.resources?.credentials ?? {};
    const orphaned = orphanedCredentials(recordedCredentials, project.spec.credentials);
    const recorded = imperativeStateOf(targetState);

    // Same contract as the CDK backend: providers are recorded every deploy, even
    // when empty, so dropping the last credential clears the stale entry.
    const provisioned = yield* this.provisionCredentials(project, {
      credentials,
      region: target.region,
      targetName: target.name,
    });
    await updateTargetState(this.json, project.rootPath, target.name, {
      resources: { credentials: provisioned },
    });

    const plans = this.plan({
      project,
      scope: {
        projectName: project.name,
        targetName: target.name,
        account: target.account,
        region: target.region,
        rootPath: project.rootPath,
      },
      clients: this.clients,
      credentials,
      logger: this.logger,
      recorded,
      handlers: this.handlers,
    });

    if (plans.declared.length === 0) {
      if (plans.removed.length === 0) {
        if (project.spec.credentials.length > 0) return { outputs: {} };
        throw new ProjectStateError(
          `Project '${project.name}' declares no resources to deploy, and nothing is recorded for ` +
            `target '${target.name}' to remove. Add a resource — for example ` +
            `'agentcore project add runtime' — before deploying.`,
        );
      }
      return yield* this.teardown({ project, input, plans, orphaned });
    }

    if (input.transactionSearch !== false) {
      yield { type: "step", message: "Enabling CloudWatch Transaction Search" };
      try {
        await this.enableTransactionSearch(target, credentials);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        yield { type: "step", message: `Skipping Transaction Search: ${detail}` };
      }
    }

    yield { type: "step", message: `Deploying ${count(plans.declared.length)}` };
    // No AbortSignal is threaded to the engine yet: DeployBackendInput carries
    // none, so Ctrl+C is not a graceful cancel here (follow-up).
    yield* plans.apply.execute({
      ...this.execute,
      logger: this.logger,
      onStepSucceeded: (step) =>
        this.serialized(() => this.recordStep(project, target, plans, step)),
    });

    if (plans.removed.length > 0) {
      yield {
        type: "step",
        message: `Removing ${count(plans.removed.length)} no longer declared`,
      };
      yield* plans.remove.execute({
        ...this.execute,
        logger: this.logger,
        onStepSucceeded: (step) =>
          this.serialized(() => this.forgetStep(project, target, plans, step)),
      });
    }

    yield* this.removeCredentials(project, {
      credentials,
      region: target.region,
      targetName: target.name,
      providers: orphaned,
    });

    return { outputs: plans.stack.outputs() };
  }

  /**
   * Removes everything the ledger holds, for a deploy of a project that declares
   * nothing. Mirrors the CDK backend's teardown: confirm, remove, drop providers,
   * forget the target.
   */
  private async *teardown({
    project,
    input,
    plans,
    orphaned,
  }: {
    project: Project;
    input: DeployBackendInput;
    plans: Plans;
    orphaned: CredentialProviderRef[];
  }): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    const names = plans.removed.map((r) => `${r.kind}:${stateKey(r)}`);
    const description = `${count(names.length)} (${names.join(", ")})`;
    const confirmed = await input.confirmTeardown({
      projectName: project.name,
      targetName: target.name,
      resourceDescription: description,
      account: target.account,
      region: target.region,
    });
    if (!confirmed) {
      throw new ProjectStateError(
        `Project '${project.name}' declares no resources to deploy, so deploying to target ` +
          `'${target.name}' would delete ${description}. Re-run with --yes to confirm, or restore ` +
          `the resources the project should have.`,
      );
    }

    yield { type: "step", message: `Removing ${count(names.length)}` };
    yield* plans.remove.execute({
      ...this.execute,
      logger: this.logger,
      onStepSucceeded: (step) =>
        this.serialized(() => this.forgetStep(project, target, plans, step)),
    });

    // After the resources, since one of them may still have been using a provider.
    const credentials = plans.stack.credentials;
    yield* this.removeCredentials(project, {
      credentials,
      region: target.region,
      targetName: target.name,
      providers: [...orphaned, ...project.spec.credentials],
    });
    await removeTargetState(this.json, project.rootPath, target.name);
    return { outputs: {}, tornDown: true };
  }

  /** Runs one ledger mutation after every earlier one has settled. */
  private serialized(fn: () => Promise<void>): Promise<void> {
    const next = this.ledger.then(fn, fn);
    this.ledger = next.catch(() => {});
    return next;
  }

  private async recordStep(
    project: Project,
    target: AwsDeploymentTarget,
    plans: Plans,
    step: Step,
  ): Promise<void> {
    const { kind, name, parent } = parseStepName(step.name);
    const outputs = plans.stack.outputsOf(step.name) ?? {};
    await recordImperativeResource(
      this.json,
      project.rootPath,
      target.name,
      kind,
      stateKey({ kind, name, parent }),
      outputs,
      this.now,
    );
  }

  private async forgetStep(
    project: Project,
    target: AwsDeploymentTarget,
    plans: Plans,
    step: Step,
  ): Promise<void> {
    // The resource is gone, so its identifiers must not reach DeployResult.outputs.
    plans.stack.forget(step.name);
    const { kind, name, parent } = parseStepName(step.name);
    await forgetImperativeResource(
      this.json,
      project.rootPath,
      target.name,
      kind,
      stateKey({ kind, name, parent }),
    );
  }

  public async resolveDeployedResources(
    project: Project,
    input: ResolveDeployedResourcesBackendInput,
  ): Promise<ResolvedDeployedResource[]> {
    const { target } = input;
    const targetState = (await readDeployedState(this.json, project.rootPath)).targets[target.name];
    const recorded = imperativeStateOf(targetState);
    if (Object.keys(recorded).length === 0) {
      throw new ProjectStateError(
        `Project '${project.name}' is not deployed to target '${target.name}'. ` +
          `Run 'agentcore project deploy --target ${target.name}' first.`,
      );
    }
    const credentials = await this.credentialsForTarget(target);
    const candidates = [
      ...project.spec.runtimes.map(({ name }) => ({ resourceType: "runtime" as const, name })),
      ...project.spec.harnesses.map(({ name }) => ({ resourceType: "harness" as const, name })),
    ];
    return candidates.flatMap((resource) => {
      const id = recorded[resource.resourceType]?.[resource.name]?.id;
      return id ? [{ ...resource, id, target, credentialProvider: credentials }] : [];
    });
  }

  public async resolveProjectResources(
    project: Project,
    input: ResolveProjectResourcesBackendInput,
  ): Promise<ResolvedProjectResource[]> {
    const { spec } = project;
    const targetState = (await readDeployedState(this.json, project.rootPath)).targets[
      input.target.name
    ];
    const recorded = imperativeStateOf(targetState);

    const identifierOf = (
      resourceType: DeployableResource,
      name: string,
      owner?: string,
    ): { arn: string } | { id: string } | undefined => {
      if (resourceType === "credential") {
        const arn = targetState?.resources?.credentials?.[name]?.credentialProviderArn;
        return arn ? { arn } : undefined;
      }
      const record =
        recorded[resourceType]?.[stateKey({ kind: resourceType, name, parent: owner })];
      if (record?.arn) return { arn: record.arn };
      if (record?.id) return { id: record.id };
      return undefined;
    };

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
          children: Object.keys(runtime.endpoints ?? {}).map((endpoint) =>
            resolve("runtime-endpoint", endpoint, { owner: runtime.name }),
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
}
