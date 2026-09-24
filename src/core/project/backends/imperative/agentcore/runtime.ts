import {
  CreateAgentRuntimeCommand,
  DeleteAgentRuntimeCommand,
  GetAgentRuntimeCommand,
  ListAgentRuntimesCommand,
  UpdateAgentRuntimeCommand,
  type AgentManagedRuntimeType,
  type CreateAgentRuntimeRequest,
  type GetAgentRuntimeResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { join } from "node:path";
import { ProjectStateError } from "../../../../../errors";
import type { Project } from "../../../../../handlers/project/types";
import { memoryEnvVarName } from "../../../../../projectSchemas/memory";
import {
  deleteRole,
  ensureRole,
  executionRoleName,
  loadAdditionalPolicies,
  partitionFor,
  roleArn as roleArnOf,
  roleDrift,
  runtimeExecutionPolicy,
  withRolePropagationRetry,
  RUNTIME_POLICY_NAME,
  type RoleSpec,
} from "../iam";
import { stepOf, type DeclaredResource } from "../inventory";
import { stepName } from "../naming";
import { Status, type Doer, type Statuser } from "../plan/plan";
import { fromServiceStatus } from "../status";
import type { KindHandlerOptions, KindHandlers } from "./notImplemented";
import type { AgentCoreStack } from "./stack";

type RuntimeSpec = Project["spec"]["runtimes"][number];
/** The fields CreateAgentRuntime and UpdateAgentRuntime share. */
export type RuntimeRequest = Omit<
  CreateAgentRuntimeRequest,
  "agentRuntimeName" | "tags" | "clientToken"
>;
const RUNTIME_NAME_MAX = 48;

const isNotFound = (error: unknown) =>
  (error as { name?: string } | undefined)?.name === "ResourceNotFoundException" ||
  (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode ===
    404;

function runtimeSpec(spec: Project["spec"], name: string): RuntimeSpec {
  const runtime = spec.runtimes.find((r) => r.name === name);
  if (!runtime) throw new ProjectStateError(`runtime '${name}' is not declared in agentcore.json`);
  return runtime;
}

/**
 * The entry point L3 gives a CodeZip runtime: the file part of `entrypoint`
 * (a `:handler` suffix dropped), wrapped in `opentelemetry-instrument` unless
 * otel is disabled or the runtime is Node.
 */
export function runtimeEntryPoint(
  runtime: Pick<RuntimeSpec, "entrypoint" | "instrumentation" | "runtimeVersion">,
): string[] {
  const path = runtime.entrypoint.split(":")[0]!;
  const isNode = runtime.runtimeVersion?.startsWith("NODE") ?? false;
  return runtime.instrumentation?.enableOtel === false || isNode
    ? [path]
    : ["opentelemetry-instrument", path];
}

/** L3 `discoveryPrefix`'s token: uppercased, anything outside [A-Z0-9] replaced by `_`. */
const envToken = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/**
 * The runtime's environment as L3 binds it: the spec's envVars, then
 * `AGENTCORE_MEMORY_<NAME>_ID`/`_ARN` for every memory and
 * `AGENTCORE_CREDENTIAL_<NAME>_NAME` for every credential provider.
 */
export function runtimeEnvironment(
  stack: AgentCoreStack,
  runtime: RuntimeSpec,
  spec: Project["spec"],
): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    (runtime.envVars ?? []).map((v) => [v.name, v.value]),
  );
  for (const memory of spec.memories) {
    const outputs = stack.outputsOf(stepName("memory", memory.name));
    if (!outputs?.id) {
      throw new ProjectStateError(
        `memory '${memory.name}' has no deployed id yet; the runtime '${runtime.name}' cannot be wired to it`,
      );
    }
    const idVar = memoryEnvVarName(memory.name);
    env[idVar] = outputs.id;
    if (outputs.arn) env[`${idVar.slice(0, -"_ID".length)}_ARN`] = outputs.arn;
  }
  for (const credential of spec.credentials) {
    env[`AGENTCORE_CREDENTIAL_${envToken(credential.name)}_NAME`] = credential.name;
  }
  return env;
}

function memoryArns(stack: AgentCoreStack, spec: Project["spec"]): string[] {
  return spec.memories.flatMap((m) => {
    const arn = stack.outputsOf(stepName("memory", m.name))?.arn;
    return arn ? [arn] : [];
  });
}

function stagedArtifact(stack: AgentCoreStack, runtime: RuntimeSpec) {
  const artifact = stack.artifacts.get(runtime.name);
  if (!artifact) {
    throw new ProjectStateError(
      `no code artifact was staged for runtime '${runtime.name}'; this is a bug in the deploy sequence`,
    );
  }
  return artifact;
}

function desiredRequest(
  stack: AgentCoreStack,
  runtime: RuntimeSpec,
  spec: Project["spec"],
  roleArn: string,
): RuntimeRequest {
  const artifact = stagedArtifact(stack, runtime);
  const networkMode = runtime.networkMode ?? "PUBLIC";
  const vpc = networkMode === "VPC" ? runtime.networkConfig : undefined;
  return {
    agentRuntimeArtifact: {
      codeConfiguration: {
        code: { s3: { bucket: artifact.bucket, prefix: artifact.key } },
        runtime: runtime.runtimeVersion as AgentManagedRuntimeType,
        entryPoint: runtimeEntryPoint(runtime),
      },
    },
    roleArn,
    networkConfiguration: {
      networkMode,
      ...(vpc && {
        networkModeConfig: { subnets: vpc.subnets, securityGroups: vpc.securityGroups },
      }),
    },
    // L3: the default names the runtime `<project>_<name>`, as its CFN runtime name.
    description:
      runtime.description ?? `AgentCore Runtime: ${stack.scope.projectName}_${runtime.name}`,
    ...(runtime.protocol &&
      runtime.protocol !== "HTTP" && {
        protocolConfiguration: { serverProtocol: runtime.protocol },
      }),
    ...(runtime.requestHeaderAllowlist?.length && {
      requestHeaderConfiguration: { requestHeaderAllowlist: runtime.requestHeaderAllowlist },
    }),
    ...(runtime.lifecycleConfiguration && {
      lifecycleConfiguration: {
        ...(runtime.lifecycleConfiguration.idleRuntimeSessionTimeout !== undefined && {
          idleRuntimeSessionTimeout: runtime.lifecycleConfiguration.idleRuntimeSessionTimeout,
        }),
        ...(runtime.lifecycleConfiguration.maxLifetime !== undefined && {
          maxLifetime: runtime.lifecycleConfiguration.maxLifetime,
        }),
      },
    }),
    environmentVariables: runtimeEnvironment(stack, runtime, spec),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sortKeys = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** undefined when the live runtime matches `desired`; otherwise one line saying what differs. */
export function runtimeDrift(
  live: GetAgentRuntimeResponse,
  desired: RuntimeRequest,
): string | undefined {
  const liveCode = live.agentRuntimeArtifact?.codeConfiguration;
  const wantCode = desired.agentRuntimeArtifact?.codeConfiguration;
  if (!same(liveCode?.code?.s3, wantCode?.code?.s3)) return "code artifact differs";
  if (!same(liveCode?.entryPoint, wantCode?.entryPoint)) return "entry point differs";
  if (liveCode?.runtime !== wantCode?.runtime) return "runtime version differs";
  if (live.roleArn !== desired.roleArn) return "execution role differs";
  if (live.networkConfiguration?.networkMode !== desired.networkConfiguration?.networkMode) {
    return "network mode differs";
  }
  if (
    (live.protocolConfiguration?.serverProtocol ?? "HTTP") !==
    (desired.protocolConfiguration?.serverProtocol ?? "HTTP")
  ) {
    return "protocol differs";
  }
  if ((live.description ?? "") !== (desired.description ?? "")) return "description differs";
  if (
    !same(sortKeys(live.environmentVariables ?? {}), sortKeys(desired.environmentVariables ?? {}))
  ) {
    return "environment variables differ";
  }
  return undefined;
}

async function getRuntime(
  stack: AgentCoreStack,
  agentRuntimeId: string,
): Promise<GetAgentRuntimeResponse | undefined> {
  try {
    return await stack.clients
      .control(stack.options())
      .send(new GetAgentRuntimeCommand({ agentRuntimeId }));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function findRuntimeByName(
  stack: AgentCoreStack,
  physical: string,
): Promise<GetAgentRuntimeResponse | undefined> {
  const control = stack.clients.control(stack.options());
  let nextToken: string | undefined;
  do {
    const page = await control.send(new ListAgentRuntimesCommand({ nextToken, maxResults: 100 }));
    const hit = (page.agentRuntimes ?? []).find((r) => r.agentRuntimeName === physical);
    if (hit?.agentRuntimeId) return getRuntime(stack, hit.agentRuntimeId);
    nextToken = page.nextToken;
  } while (nextToken);
  return undefined;
}

function recordRuntime(
  stack: AgentCoreStack,
  resource: DeclaredResource,
  live?: { agentRuntimeArn?: string; agentRuntimeId?: string },
) {
  if (live?.agentRuntimeArn && live.agentRuntimeId) {
    stack.record(stepOf(resource), { arn: live.agentRuntimeArn, id: live.agentRuntimeId });
  }
}

/** The recorded runtime, or one carrying this resource's physical name (adopted and recorded). */
async function locate(stack: AgentCoreStack, resource: DeclaredResource) {
  const recorded = stack.outputsOf(stepOf(resource))?.id;
  const live =
    (recorded ? await getRuntime(stack, recorded) : undefined) ??
    (await findRuntimeByName(stack, stack.name("runtime", resource.name, RUNTIME_NAME_MAX)));
  recordRuntime(stack, resource, live);
  return live;
}

async function roleSpecFor(
  stack: AgentCoreStack,
  runtime: RuntimeSpec,
  spec: Project["spec"],
): Promise<RoleSpec> {
  const partition = partitionFor(stack.scope.region);
  const additional = await loadAdditionalPolicies(
    runtime.additionalPolicies,
    join(stack.scope.rootPath, runtime.codeLocation),
  );
  return {
    roleName: executionRoleName(stack.scope, "runtime", runtime.name),
    description: `Execution role for AgentCore runtime ${runtime.name} (project ${stack.scope.projectName}, target ${stack.scope.targetName})`,
    tags: stack.tags(),
    inlinePolicies: {
      [RUNTIME_POLICY_NAME]: runtimeExecutionPolicy({
        partition,
        region: stack.scope.region,
        account: stack.scope.account,
        memoryArns: memoryArns(stack, spec),
      }),
      ...additional.inlinePolicies,
    },
    managedPolicyArns: additional.managedPolicyArns,
  };
}

export const runtimeHandlers: KindHandlers = {
  poll(stack, resource, spec): Statuser {
    return async () => {
      const runtime = runtimeSpec(spec, resource.name);
      const live = await locate(stack, resource);
      if (!live) return { status: Status.NotStarted };
      const report = fromServiceStatus(live.status, { statusReason: live.failureReason });
      if (report.status !== Status.Successful) return report;
      // Without a staged artifact (status/invoke paths) READY is as far as we can see.
      if (!stack.artifacts.has(runtime.name)) return { status: Status.Successful };
      const expectedRole =
        runtime.executionRoleArn ??
        roleArnOf(
          partitionFor(stack.scope.region),
          stack.scope.account,
          executionRoleName(stack.scope, "runtime", runtime.name),
        );
      const drift = runtimeDrift(live, desiredRequest(stack, runtime, spec, expectedRole));
      if (drift) return { status: Status.Outdated, detail: drift };
      if (!runtime.executionRoleArn) {
        const policyDrift = await roleDrift(
          stack.clients.iam(stack.options()),
          stack.scope,
          await roleSpecFor(stack, runtime, spec),
        );
        if (policyDrift)
          return { status: Status.Outdated, detail: `execution role: ${policyDrift}` };
      }
      return { status: Status.Successful };
    };
  },
  create(stack, resource, spec, options?: KindHandlerOptions): Doer {
    return async (ctx) => {
      const runtime = runtimeSpec(spec, resource.name);
      stagedArtifact(stack, runtime);
      const control = stack.clients.control(stack.options());
      const roleArn =
        runtime.executionRoleArn ??
        (
          await ensureRole(
            stack.clients.iam(stack.options()),
            stack.scope,
            await roleSpecFor(stack, runtime, spec),
          )
        ).arn;
      const request = desiredRequest(stack, runtime, spec, roleArn);
      // poll ran first and recorded any runtime it found or adopted, so the record is enough.
      const recordedId = stack.outputsOf(stepOf(resource))?.id;
      const existing = recordedId ? await getRuntime(stack, recordedId) : undefined;
      if (existing?.agentRuntimeId) {
        const agentRuntimeId = existing.agentRuntimeId;
        ctx.report(`Updating runtime ${agentRuntimeId}`);
        await withRolePropagationRetry(
          () => control.send(new UpdateAgentRuntimeCommand({ agentRuntimeId, ...request })),
          { sleep: options?.sleep },
        );
        return;
      }
      const name = stack.name("runtime", runtime.name, RUNTIME_NAME_MAX);
      ctx.report(`Creating runtime ${name}`);
      const created = await withRolePropagationRetry(
        () =>
          control.send(
            new CreateAgentRuntimeCommand({
              agentRuntimeName: name,
              ...request,
              tags: stack.tags(runtime.tags),
            }),
          ),
        { sleep: options?.sleep },
      );
      recordRuntime(stack, resource, created);
    };
  },
  remove(stack, resource): Doer {
    return async (ctx) => {
      const id = stack.outputsOf(stepOf(resource))?.id;
      if (!id) return;
      ctx.report(`Deleting runtime ${id}`);
      try {
        await stack.clients
          .control(stack.options())
          .send(new DeleteAgentRuntimeCommand({ agentRuntimeId: id }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    };
  },
  pollGone(stack, resource): Statuser {
    return async () => {
      const id = stack.outputsOf(stepOf(resource))?.id;
      if (!id) return { status: Status.Successful };
      const live = await getRuntime(stack, id);
      if (live) {
        if (live.status === "DELETING") return { status: Status.Waiting, detail: "DELETING" };
        return { status: Status.NotStarted };
      }
      await deleteRole(
        stack.clients.iam(stack.options()),
        stack.scope,
        executionRoleName(stack.scope, "runtime", resource.name),
      );
      stack.forget(stepOf(resource));
      return { status: Status.Successful };
    };
  },
};
