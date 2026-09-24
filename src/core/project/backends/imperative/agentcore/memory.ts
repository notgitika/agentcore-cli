import {
  CreateMemoryCommand,
  DeleteMemoryCommand,
  GetMemoryCommand,
  ListMemoriesCommand,
  UpdateMemoryCommand,
  type Memory as LiveMemory,
  type MemoryStrategyInput,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { NotImplementedError, ProjectStateError } from "../../../../../errors";
import type { Project } from "../../../../../handlers/project/types";
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  MEMORY_NAME_MAX_LENGTH,
  type Memory,
  type MemoryStrategy,
  type MemoryStrategyType,
} from "../../../../../projectSchemas/memory";
import { deleteRole, ensureRole, executionRoleName, withRolePropagationRetry } from "../iam";
import { stepOf, type DeclaredResource } from "../inventory";
import { Status, type Doer, type Statuser, type StatusReport } from "../plan/plan";
import { fromServiceStatus } from "../status";
import type { KindHandlerOptions, KindHandlers } from "./notImplemented";
import type { AgentCoreStack } from "./stack";

const isNotFound = (error: unknown) =>
  (error as { name?: string } | undefined)?.name === "ResourceNotFoundException" ||
  (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode ===
    404;

function memorySpec(spec: Project["spec"], name: string): Memory {
  const memory = spec.memories.find((m) => m.name === name);
  if (!memory) throw new ProjectStateError(`memory '${name}' is not declared in agentcore.json`);
  if (memory.streamDeliveryResources) {
    throw new NotImplementedError(
      `memory '${name}' declares streamDeliveryResources, which imperative deploy does not support yet`,
    );
  }
  return memory;
}

const STRATEGY_MEMBER: Record<MemoryStrategyType, string> = {
  SEMANTIC: "semanticMemoryStrategy",
  SUMMARIZATION: "summaryMemoryStrategy",
  USER_PREFERENCE: "userPreferenceMemoryStrategy",
  EPISODIC: "episodicMemoryStrategy",
};

/** `<memory>_<Type>`, e.g. `agentMemory_Userpreference`, cut to fit the 48-character limit. */
function defaultStrategyName(memoryName: string, type: MemoryStrategyType): string {
  const suffix = `_${type.charAt(0)}${type.slice(1).toLowerCase().replaceAll("_", "")}`;
  return `${memoryName.slice(0, MEMORY_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function strategyInput(memory: Memory, strategy: MemoryStrategy): MemoryStrategyInput {
  const base = {
    name: strategy.name ?? defaultStrategyName(memory.name, strategy.type),
    ...(strategy.description && { description: strategy.description }),
    namespaceTemplates:
      strategy.namespaceTemplates ??
      strategy.namespaces ??
      DEFAULT_STRATEGY_NAMESPACE_TEMPLATES[strategy.type] ??
      [],
  };
  if (strategy.type === "EPISODIC") {
    return {
      episodicMemoryStrategy: {
        ...base,
        reflectionConfiguration: {
          namespaceTemplates:
            strategy.reflectionNamespaceTemplates ??
            strategy.reflectionNamespaces ??
            DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
        },
      },
    };
  }
  return { [STRATEGY_MEMBER[strategy.type]]: base } as unknown as MemoryStrategyInput;
}

export function memoryStrategyInputs(memory: Memory): MemoryStrategyInput[] {
  return memory.strategies.map((strategy) => strategyInput(memory, strategy));
}

/** undefined when the live memory matches; otherwise one line saying what differs. */
export function memoryDrift(live: LiveMemory, desired: Memory): string | undefined {
  if ((live.description ?? undefined) !== (desired.description ?? undefined)) {
    return "description differs";
  }
  if (live.eventExpiryDuration !== desired.eventExpiryDuration) {
    return `eventExpiryDuration is ${live.eventExpiryDuration}, want ${desired.eventExpiryDuration}`;
  }
  const liveTypes = [...new Set((live.strategies ?? []).map((s) => s.type))].sort();
  const wantTypes = [...new Set(desired.strategies.map((s) => s.type))].sort();
  if (JSON.stringify(liveTypes) !== JSON.stringify(wantTypes)) {
    return `strategies are [${liveTypes.join(", ")}], want [${wantTypes.join(", ")}]`;
  }
  return undefined;
}

async function getMemory(stack: AgentCoreStack, memoryId: string): Promise<LiveMemory | undefined> {
  try {
    return (await stack.clients.control(stack.options()).send(new GetMemoryCommand({ memoryId })))
      .memory;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** ListMemories summaries carry no name, so each candidate is fetched until one matches. */
async function findMemoryByName(
  stack: AgentCoreStack,
  physical: string,
): Promise<LiveMemory | undefined> {
  const control = stack.clients.control(stack.options());
  let nextToken: string | undefined;
  do {
    const page = await control.send(new ListMemoriesCommand({ nextToken, maxResults: 100 }));
    for (const summary of page.memories ?? []) {
      if (!summary.id) continue;
      const memory = await getMemory(stack, summary.id);
      if (memory?.name === physical) return memory;
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return undefined;
}

function recordMemory(stack: AgentCoreStack, resource: DeclaredResource, memory?: LiveMemory) {
  if (memory?.arn && memory.id) stack.record(stepOf(resource), { arn: memory.arn, id: memory.id });
}

/** The recorded memory, or one carrying this resource's physical name (adopted and recorded). */
async function locate(
  stack: AgentCoreStack,
  resource: DeclaredResource,
): Promise<LiveMemory | undefined> {
  const recorded = stack.outputsOf(stepOf(resource))?.id;
  const memory =
    (recorded ? await getMemory(stack, recorded) : undefined) ??
    (await findMemoryByName(stack, stack.name("memory", resource.name, MEMORY_NAME_MAX_LENGTH)));
  recordMemory(stack, resource, memory);
  return memory;
}

async function roleArnFor(stack: AgentCoreStack, memory: Memory): Promise<string> {
  if (memory.executionRoleArn) return memory.executionRoleArn;
  const { arn } = await ensureRole(stack.clients.iam(stack.options()), stack.scope, {
    roleName: executionRoleName(stack.scope, "memory", memory.name),
    description: `Execution role for AgentCore memory ${memory.name} (project ${stack.scope.projectName}, target ${stack.scope.targetName})`,
    tags: stack.tags(),
    inlinePolicies: {},
    managedPolicyArns: [],
  });
  return arn;
}

export const memoryHandlers: KindHandlers = {
  poll(stack, resource, spec): Statuser {
    return async () => {
      const desired = memorySpec(spec, resource.name);
      const live = await locate(stack, resource);
      if (!live) return { status: Status.NotStarted };
      const report = fromServiceStatus(live.status, { statusReason: live.failureReason });
      if (report.status !== Status.Successful) return report;
      const drift = memoryDrift(live, desired);
      return drift ? { status: Status.Outdated, detail: drift } : { status: Status.Successful };
    };
  },
  create(stack, resource, spec, options?: KindHandlerOptions): Doer {
    return async (ctx) => {
      const desired = memorySpec(spec, resource.name);
      const control = stack.clients.control(stack.options());
      const roleArn = await roleArnFor(stack, desired);
      // poll ran first and recorded any memory it found or adopted, so the record is enough.
      const recordedId = stack.outputsOf(stepOf(resource))?.id;
      const existing = recordedId ? await getMemory(stack, recordedId) : undefined;
      if (existing?.id) {
        ctx.report(`Updating memory ${existing.id}`);
        const liveByType = new Map((existing.strategies ?? []).map((s) => [s.type, s]));
        const wantTypes = new Set<string>(desired.strategies.map((s) => s.type));
        const add = desired.strategies
          .filter((s) => !liveByType.has(s.type))
          .map((s) => strategyInput(desired, s));
        const remove = [...liveByType.values()]
          .filter((s) => !wantTypes.has(s.type ?? "") && s.strategyId)
          .map((s) => ({ memoryStrategyId: s.strategyId! }));
        await control.send(
          new UpdateMemoryCommand({
            memoryId: existing.id,
            ...(desired.description !== undefined && { description: desired.description }),
            eventExpiryDuration: desired.eventExpiryDuration,
            memoryExecutionRoleArn: roleArn,
            ...((add.length > 0 || remove.length > 0) && {
              memoryStrategies: {
                ...(add.length > 0 && { addMemoryStrategies: add }),
                ...(remove.length > 0 && { deleteMemoryStrategies: remove }),
              },
            }),
          }),
        );
        return;
      }
      const name = stack.name("memory", desired.name, MEMORY_NAME_MAX_LENGTH);
      ctx.report(`Creating memory ${name}`);
      const created = await withRolePropagationRetry(
        () =>
          control.send(
            new CreateMemoryCommand({
              name,
              ...(desired.description !== undefined && { description: desired.description }),
              eventExpiryDuration: desired.eventExpiryDuration,
              memoryExecutionRoleArn: roleArn,
              ...(desired.encryptionKeyArn && { encryptionKeyArn: desired.encryptionKeyArn }),
              ...(desired.strategies.length > 0 && {
                memoryStrategies: memoryStrategyInputs(desired),
              }),
              ...(desired.indexedKeys && { indexedKeys: desired.indexedKeys }),
              tags: stack.tags(desired.tags),
            }),
          ),
        { sleep: options?.sleep },
      );
      recordMemory(stack, resource, created.memory);
    };
  },
  remove(stack, resource): Doer {
    return async (ctx) => {
      const id = stack.outputsOf(stepOf(resource))?.id;
      if (!id) return;
      ctx.report(`Deleting memory ${id}`);
      try {
        await stack.clients
          .control(stack.options())
          .send(new DeleteMemoryCommand({ memoryId: id }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    };
  },
  pollGone(stack, resource): Statuser {
    return async (): Promise<StatusReport> => {
      const id = stack.outputsOf(stepOf(resource))?.id;
      if (!id) return { status: Status.Successful };
      const live = await getMemory(stack, id);
      if (live) {
        if (live.status === "DELETING") return { status: Status.Waiting, detail: "DELETING" };
        if (live.status === "FAILED") {
          return { status: Status.Failed, detail: live.failureReason ?? "FAILED" };
        }
        return { status: Status.NotStarted };
      }
      await deleteRole(
        stack.clients.iam(stack.options()),
        stack.scope,
        executionRoleName(stack.scope, "memory", resource.name),
      );
      stack.forget(stepOf(resource));
      return { status: Status.Successful };
    };
  },
};
