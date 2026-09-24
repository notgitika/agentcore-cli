import {
  CreateAgentRuntimeEndpointCommand,
  DeleteAgentRuntimeEndpointCommand,
  GetAgentRuntimeEndpointCommand,
  UpdateAgentRuntimeEndpointCommand,
  type GetAgentRuntimeEndpointResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { ProjectStateError } from "../../../../../errors";
import type { Project } from "../../../../../handlers/project/types";
import { stepOf, type DeclaredResource } from "../inventory";
import { stepName } from "../naming";
import { Status, type Doer, type Statuser } from "../plan/plan";
import { fromServiceStatus } from "../status";
import type { KindHandlers } from "./notImplemented";
import type { AgentCoreStack } from "./stack";

const isNotFound = (error: unknown) =>
  (error as { name?: string } | undefined)?.name === "ResourceNotFoundException" ||
  (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode ===
    404;

function endpointSpec(spec: Project["spec"], resource: DeclaredResource) {
  const runtime = spec.runtimes.find((r) => r.name === resource.parent);
  const endpoint = runtime?.endpoints?.[resource.name];
  if (!runtime || !endpoint) {
    throw new ProjectStateError(
      `endpoint '${resource.name}' of runtime '${resource.parent}' is not declared in agentcore.json`,
    );
  }
  return endpoint;
}

/** The deployed id of the endpoint's runtime, read from the stack's ledger. */
function parentRuntimeId(
  stack: AgentCoreStack,
  resource: DeclaredResource,
  { required }: { required: boolean },
): string | undefined {
  const id =
    resource.parent === undefined
      ? undefined
      : stack.outputsOf(stepName("runtime", resource.parent))?.id;
  if (!id && required) {
    throw new ProjectStateError(
      `runtime '${resource.parent}' has no deployed id yet; endpoint '${resource.name}' cannot be created`,
    );
  }
  return id;
}

async function getEndpoint(
  stack: AgentCoreStack,
  agentRuntimeId: string,
  endpointName: string,
): Promise<GetAgentRuntimeEndpointResponse | undefined> {
  try {
    return await stack.clients
      .control(stack.options())
      .send(new GetAgentRuntimeEndpointCommand({ agentRuntimeId, endpointName }));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function requiredRuntimeId(stack: AgentCoreStack, resource: DeclaredResource): string {
  return parentRuntimeId(stack, resource, { required: true }) as string;
}

export const endpointHandlers: KindHandlers = {
  poll(stack, resource, spec): Statuser {
    return async () => {
      const desired = endpointSpec(spec, resource);
      const runtimeId = requiredRuntimeId(stack, resource);
      const live = await getEndpoint(stack, runtimeId, resource.name);
      if (!live) return { status: Status.NotStarted };
      if (live.agentRuntimeEndpointArn && live.id) {
        stack.record(stepOf(resource), { arn: live.agentRuntimeEndpointArn, id: live.id });
      }
      const report = fromServiceStatus(live.status, { statusReason: live.failureReason });
      if (report.status !== Status.Successful) return report;
      const version = live.targetVersion ?? live.liveVersion;
      if (version !== String(desired.version)) {
        return {
          status: Status.Outdated,
          detail: `points at version ${version}, want ${desired.version}`,
        };
      }
      if ((live.description ?? undefined) !== (desired.description ?? undefined)) {
        return { status: Status.Outdated, detail: "description differs" };
      }
      return { status: Status.Successful };
    };
  },
  create(stack, resource, spec): Doer {
    return async (ctx) => {
      const desired = endpointSpec(spec, resource);
      const runtimeId = requiredRuntimeId(stack, resource);
      const control = stack.clients.control(stack.options());
      const common = {
        agentRuntimeId: runtimeId,
        agentRuntimeVersion: String(desired.version),
        ...(desired.description !== undefined && { description: desired.description }),
      };
      if (await getEndpoint(stack, runtimeId, resource.name)) {
        ctx.report(`Updating endpoint ${resource.name} of runtime ${runtimeId}`);
        await control.send(
          new UpdateAgentRuntimeEndpointCommand({ ...common, endpointName: resource.name }),
        );
        return;
      }
      ctx.report(`Creating endpoint ${resource.name} of runtime ${runtimeId}`);
      const created = await control.send(
        new CreateAgentRuntimeEndpointCommand({
          ...common,
          name: resource.name,
          tags: stack.tags(),
        }),
      );
      // CreateAgentRuntimeEndpoint returns no id; the poll that follows records it.
      if (created.agentRuntimeEndpointArn) {
        stack.record(stepOf(resource), { arn: created.agentRuntimeEndpointArn });
      }
    };
  },
  remove(stack, resource): Doer {
    return async (ctx) => {
      const runtimeId = parentRuntimeId(stack, resource, { required: false });
      if (!runtimeId) return;
      ctx.report(`Deleting endpoint ${resource.name} of runtime ${runtimeId}`);
      try {
        await stack.clients.control(stack.options()).send(
          new DeleteAgentRuntimeEndpointCommand({
            agentRuntimeId: runtimeId,
            endpointName: resource.name,
          }),
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    };
  },
  pollGone(stack, resource): Statuser {
    return async () => {
      const runtimeId = parentRuntimeId(stack, resource, { required: false });
      if (!runtimeId) {
        stack.forget(stepOf(resource));
        return { status: Status.Successful };
      }
      const live = await getEndpoint(stack, runtimeId, resource.name);
      if (live) {
        if (live.status === "DELETING") return { status: Status.Waiting, detail: "DELETING" };
        return { status: Status.NotStarted };
      }
      stack.forget(stepOf(resource));
      return { status: Status.Successful };
    };
  },
};
