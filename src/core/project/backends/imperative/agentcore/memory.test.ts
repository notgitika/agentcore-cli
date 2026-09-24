import { describe, expect, test } from "bun:test";
import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import type { IAMClient } from "@aws-sdk/client-iam";
import type { Project } from "../../../../../handlers/project/types";
import { createSilentLogger } from "../../../../../testing";
import type { AwsClients } from "../../../../types";
import { Status, type StepContext } from "../plan/plan";
import { fakeClient, notFound, sdkError } from "../testing";
import { memoryDrift, memoryHandlers, memoryStrategyInputs } from "./memory";
import { AgentCoreStack } from "./stack";

const scope = {
  projectName: "orders",
  targetName: "staging",
  account: "111122223333",
  region: "us-west-2",
  rootPath: "/project",
};
const ctx: StepContext = {
  signal: new AbortController().signal,
  logger: createSilentLogger(),
  report: () => {},
};
const memorySpec = {
  name: "agentMemory",
  eventExpiryDuration: 30,
  strategies: [
    { type: "SEMANTIC" as const, namespaceTemplates: ["/users/{actorId}/facts"] },
    {
      type: "EPISODIC" as const,
      namespaceTemplates: ["/episodes/{actorId}/{sessionId}"],
      reflectionNamespaceTemplates: ["/episodes/{actorId}"],
    },
  ],
};
const spec = {
  name: "orders",
  version: 2,
  managedBy: "Imperative",
  runtimes: [],
  memories: [memorySpec],
  knowledgeBases: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  agentCoreGateways: [],
  policyEngines: [],
  configBundles: [],
  harnesses: [],
} as unknown as Project["spec"];
const resource = { kind: "memory" as const, name: "agentMemory" };
const ownedRoleTags = [
  { Key: "agentcore:project-name", Value: "orders" },
  { Key: "agentcore:target-name", Value: "staging" },
  { Key: "agentcore:managed-by", Value: "imperative" },
];
const liveMemory = (overrides: Record<string, unknown> = {}) => ({
  memory: {
    arn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/orders_staging_agentMemory-abc",
    id: "orders_staging_agentMemory-abc",
    name: "orders_staging_agentMemory",
    eventExpiryDuration: 30,
    status: "ACTIVE",
    strategies: [
      { strategyId: "s1", name: "agentMemory_Semantic", type: "SEMANTIC" },
      { strategyId: "s2", name: "agentMemory_Episodic", type: "EPISODIC" },
    ],
    ...overrides,
  },
});

function harness(
  control: Parameters<typeof fakeClient>[0],
  iam: Parameters<typeof fakeClient>[0] = {},
  recorded = {},
) {
  const controlClient = fakeClient(control);
  const iamClient = fakeClient(iam);
  const clients = {
    control: () => controlClient as unknown as BedrockAgentCoreControlClient,
    iam: () => iamClient as unknown as IAMClient,
  } as unknown as AwsClients;
  const stack = new AgentCoreStack(
    scope,
    clients,
    { accessKeyId: "a", secretAccessKey: "b" },
    createSilentLogger(),
    recorded,
  );
  return { stack, control: controlClient.sent, iam: iamClient.sent };
}

describe("memoryStrategyInputs", () => {
  test("maps each type to its SDK member with default names and templates", () => {
    const inputs = memoryStrategyInputs({
      ...memorySpec,
      strategies: [
        { type: "SEMANTIC" },
        { type: "SUMMARIZATION" },
        { type: "USER_PREFERENCE" },
        { type: "EPISODIC", reflectionNamespaceTemplates: ["/episodes/{actorId}"] },
      ],
    });
    expect(inputs).toEqual([
      {
        semanticMemoryStrategy: {
          name: "agentMemory_Semantic",
          namespaceTemplates: ["/users/{actorId}/facts"],
        },
      },
      {
        summaryMemoryStrategy: {
          name: "agentMemory_Summarization",
          namespaceTemplates: ["/summaries/{actorId}/{sessionId}"],
        },
      },
      {
        userPreferenceMemoryStrategy: {
          name: "agentMemory_Userpreference",
          namespaceTemplates: ["/users/{actorId}/preferences"],
        },
      },
      {
        episodicMemoryStrategy: {
          name: "agentMemory_Episodic",
          namespaceTemplates: ["/episodes/{actorId}/{sessionId}"],
          reflectionConfiguration: { namespaceTemplates: ["/episodes/{actorId}"] },
        },
      },
    ]);
  });
  test("keeps explicit names, descriptions and deprecated namespaces", () => {
    const [input] = memoryStrategyInputs({
      ...memorySpec,
      strategies: [{ type: "SEMANTIC", name: "facts", description: "d", namespaces: ["/x"] }],
    });
    expect(input).toEqual({
      semanticMemoryStrategy: { name: "facts", description: "d", namespaceTemplates: ["/x"] },
    });
  });
  test("truncates a default name to 48 characters", () => {
    const [input] = memoryStrategyInputs({
      ...memorySpec,
      name: "m".repeat(48),
      strategies: [{ type: "USER_PREFERENCE" }],
    });
    const name = (input as { userPreferenceMemoryStrategy: { name: string } })
      .userPreferenceMemoryStrategy.name;
    expect(name.length).toBe(48);
    expect(name.endsWith("_Userpreference")).toBe(true);
  });
});

describe("memoryDrift", () => {
  test("undefined when description, expiry and strategy types match", () => {
    expect(memoryDrift(liveMemory().memory as never, memorySpec)).toBeUndefined();
  });
  test("reports a changed expiry", () => {
    expect(memoryDrift(liveMemory({ eventExpiryDuration: 7 }).memory as never, memorySpec)).toMatch(
      /eventExpiryDuration/,
    );
  });
  test("reports a strategy type set change", () => {
    expect(
      memoryDrift(
        liveMemory({ strategies: [{ strategyId: "s1", type: "SEMANTIC" }] }).memory as never,
        memorySpec,
      ),
    ).toMatch(/strateg/);
  });
});

describe("poll", () => {
  test("NotStarted when nothing is recorded and no memory has the physical name", async () => {
    const { stack, control } = harness({ ListMemoriesCommand: () => ({ memories: [] }) });
    expect(await memoryHandlers.poll(stack, resource, spec)(ctx)).toEqual({
      status: Status.NotStarted,
    });
    expect(control.map((c) => c.name)).toEqual(["ListMemoriesCommand"]);
  });
  test("adopts a memory found by physical name and records it", async () => {
    const { stack } = harness({
      ListMemoriesCommand: () => ({
        memories: [{ id: "other" }, { id: "orders_staging_agentMemory-abc" }],
      }),
      GetMemoryCommand: ({ memoryId }) =>
        memoryId === "other"
          ? { memory: { id: "other", name: "someone_else", status: "ACTIVE" } }
          : liveMemory(),
    });
    expect((await memoryHandlers.poll(stack, resource, spec)(ctx)).status).toBe(Status.Successful);
    expect(stack.outputsOf("memory:agentMemory")).toEqual({
      arn: liveMemory().memory.arn,
      id: "orders_staging_agentMemory-abc",
    });
  });
  test("uses the recorded id and maps CREATING to Waiting", async () => {
    const { stack, control } = harness(
      { GetMemoryCommand: () => liveMemory({ status: "CREATING" }) },
      {},
      { memory: { agentMemory: { id: "orders_staging_agentMemory-abc", updatedAt: "t" } } },
    );
    expect(await memoryHandlers.poll(stack, resource, spec)(ctx)).toEqual({
      status: Status.Waiting,
      detail: "CREATING",
    });
    expect(control[0]!.input).toEqual({ memoryId: "orders_staging_agentMemory-abc" });
  });
  test("a recorded id that no longer exists is NotStarted", async () => {
    const { stack } = harness(
      {
        GetMemoryCommand: () => {
          throw notFound();
        },
        ListMemoriesCommand: () => ({ memories: [] }),
      },
      {},
      { memory: { agentMemory: { id: "gone", updatedAt: "t" } } },
    );
    expect((await memoryHandlers.poll(stack, resource, spec)(ctx)).status).toBe(Status.NotStarted);
  });
  test("FAILED carries the failure reason", async () => {
    const { stack } = harness(
      { GetMemoryCommand: () => liveMemory({ status: "FAILED", failureReason: "quota" }) },
      {},
      { memory: { agentMemory: { id: "x", updatedAt: "t" } } },
    );
    expect(await memoryHandlers.poll(stack, resource, spec)(ctx)).toEqual({
      status: Status.Failed,
      detail: "FAILED: quota",
    });
  });
  test("ACTIVE with drift is Outdated", async () => {
    const { stack } = harness(
      { GetMemoryCommand: () => liveMemory({ eventExpiryDuration: 7 }) },
      {},
      { memory: { agentMemory: { id: "x", updatedAt: "t" } } },
    );
    expect((await memoryHandlers.poll(stack, resource, spec)(ctx)).status).toBe(Status.Outdated);
  });
});

describe("create", () => {
  const iamOk = {
    GetRoleCommand: () => {
      throw sdkError("NoSuchEntityException", 404);
    },
    CreateRoleCommand: () => ({
      Role: { Arn: "arn:aws:iam::111122223333:role/orders_staging_agentMemory_memory_role" },
    }),
    ListRolePoliciesCommand: () => ({ PolicyNames: [] }),
    ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
  };
  test("creates the role and the memory with physical name, strategies and tags, then records ids", async () => {
    const { stack, control, iam } = harness(
      { CreateMemoryCommand: () => liveMemory({ status: "CREATING" }) },
      iamOk,
    );
    await memoryHandlers.create(stack, resource, spec)(ctx);
    expect(iam.find((c) => c.name === "CreateRoleCommand")!.input.RoleName).toBe(
      "orders_staging_agentMemory_memory_role",
    );
    const create = control.find((c) => c.name === "CreateMemoryCommand")!.input;
    expect(create.name).toBe("orders_staging_agentMemory");
    expect(create.eventExpiryDuration).toBe(30);
    expect(create.memoryExecutionRoleArn).toBe(
      "arn:aws:iam::111122223333:role/orders_staging_agentMemory_memory_role",
    );
    expect(create.memoryStrategies).toEqual(memoryStrategyInputs(memorySpec));
    expect(create.tags).toEqual({
      "agentcore:project-name": "orders",
      "agentcore:target-name": "staging",
      "agentcore:managed-by": "imperative",
    });
    expect(create.clientToken).toBeUndefined();
    expect(stack.outputsOf("memory:agentMemory")).toEqual({
      arn: liveMemory().memory.arn,
      id: "orders_staging_agentMemory-abc",
    });
  });
  test("uses executionRoleArn from the spec instead of creating a role", async () => {
    const withRole = {
      ...spec,
      memories: [{ ...memorySpec, executionRoleArn: "arn:aws:iam::111122223333:role/mine" }],
    } as Project["spec"];
    const { control, iam, stack } = harness({ CreateMemoryCommand: () => liveMemory() });
    await memoryHandlers.create(stack, resource, withRole)(ctx);
    expect(iam).toEqual([]);
    expect(control[0]!.input.memoryExecutionRoleArn).toBe("arn:aws:iam::111122223333:role/mine");
  });
  test("updates an existing memory: expiry plus added and deleted strategies", async () => {
    const recorded = {
      memory: {
        agentMemory: {
          id: "orders_staging_agentMemory-abc",
          arn: liveMemory().memory.arn,
          updatedAt: "t",
        },
      },
    };
    const { stack, control } = harness(
      {
        GetMemoryCommand: () =>
          liveMemory({
            eventExpiryDuration: 7,
            strategies: [
              { strategyId: "s1", type: "SEMANTIC" },
              { strategyId: "s9", type: "SUMMARIZATION" },
            ],
          }),
        UpdateMemoryCommand: () => liveMemory({ status: "UPDATING" }),
      },
      {
        ...iamOk,
        GetRoleCommand: () => ({
          Role: {
            Arn: "arn:aws:iam::111122223333:role/orders_staging_agentMemory_memory_role",
            Tags: ownedRoleTags,
          },
        }),
      },
      recorded,
    );
    await memoryHandlers.create(stack, resource, spec)(ctx);
    const update = control.find((c) => c.name === "UpdateMemoryCommand")!.input;
    expect(update.memoryId).toBe("orders_staging_agentMemory-abc");
    expect(update.eventExpiryDuration).toBe(30);
    expect(
      (update.memoryStrategies as { addMemoryStrategies: unknown[] }).addMemoryStrategies,
    ).toEqual([memoryStrategyInputs(memorySpec)[1]]);
    expect(
      (update.memoryStrategies as { deleteMemoryStrategies: unknown[] }).deleteMemoryStrategies,
    ).toEqual([{ memoryStrategyId: "s9" }]);
  });
  test("retries CreateMemory while the new role propagates", async () => {
    let attempts = 0;
    const { stack } = harness(
      {
        CreateMemoryCommand: () => {
          if (++attempts < 2) throw sdkError("ValidationException", 400, "role cannot be assumed");
          return liveMemory();
        },
      },
      iamOk,
    );
    await memoryHandlers.create(stack, resource, spec, { sleep: async () => {} })(ctx);
    expect(attempts).toBe(2);
  });
});

describe("remove and pollGone", () => {
  const recorded = {
    memory: { agentMemory: { id: "orders_staging_agentMemory-abc", updatedAt: "t" } },
  };
  test("remove deletes by recorded id and tolerates not found", async () => {
    const { stack, control } = harness(
      {
        DeleteMemoryCommand: () => {
          throw notFound();
        },
      },
      {},
      recorded,
    );
    await memoryHandlers.remove(stack, resource)(ctx);
    expect(control[0]).toEqual({
      name: "DeleteMemoryCommand",
      input: { memoryId: "orders_staging_agentMemory-abc" },
    });
  });
  test("pollGone is NotStarted while the memory is ACTIVE", async () => {
    const { stack } = harness({ GetMemoryCommand: () => liveMemory() }, {}, recorded);
    expect((await memoryHandlers.pollGone(stack, resource)(ctx)).status).toBe(Status.NotStarted);
  });
  test("pollGone is Waiting while DELETING", async () => {
    const { stack } = harness(
      { GetMemoryCommand: () => liveMemory({ status: "DELETING" }) },
      {},
      recorded,
    );
    expect((await memoryHandlers.pollGone(stack, resource)(ctx)).status).toBe(Status.Waiting);
  });
  test("pollGone deletes the owned role and forgets the step once the memory is gone", async () => {
    const { stack, iam } = harness(
      {
        GetMemoryCommand: () => {
          throw notFound();
        },
      },
      {
        GetRoleCommand: () => ({ Role: { Arn: "arn", Tags: ownedRoleTags } }),
        ListRolePoliciesCommand: () => ({ PolicyNames: [] }),
        ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
        DeleteRoleCommand: () => ({}),
      },
      recorded,
    );
    expect(await memoryHandlers.pollGone(stack, resource)(ctx)).toEqual({
      status: Status.Successful,
    });
    expect(iam.map((c) => c.name)).toContain("DeleteRoleCommand");
    expect(stack.outputsOf("memory:agentMemory")).toBeUndefined();
  });
  test("pollGone with nothing recorded is Successful without calls", async () => {
    const { stack, control } = harness({});
    expect(await memoryHandlers.pollGone(stack, resource)(ctx)).toEqual({
      status: Status.Successful,
    });
    expect(control).toEqual([]);
  });
});
