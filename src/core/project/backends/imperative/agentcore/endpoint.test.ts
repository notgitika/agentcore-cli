import { describe, expect, test } from "bun:test";
import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import type { Project } from "../../../../../handlers/project/types";
import { createSilentLogger } from "../../../../../testing";
import type { AwsClients } from "../../../../types";
import { Status, type StepContext } from "../plan/plan";
import { fakeClient, notFound } from "../testing";
import { endpointHandlers } from "./endpoint";
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
const spec = {
  name: "orders",
  version: 2,
  managedBy: "Imperative",
  runtimes: [
    {
      name: "agent",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/agent",
      runtimeVersion: "PYTHON_3_14",
      endpoints: { prod: { version: 2, description: "prod" } },
    },
  ],
  memories: [],
  knowledgeBases: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  agentCoreGateways: [],
  policyEngines: [],
  configBundles: [],
  harnesses: [],
} as unknown as Project["spec"];
const resource = { kind: "runtime-endpoint" as const, name: "prod", parent: "agent" };
const runtimeArn = "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/rt-1";
const endpointArn = `${runtimeArn}/runtime-endpoint/prod`;
const recorded = { runtime: { agent: { id: "rt-1", arn: runtimeArn, updatedAt: "t" } } };
const withEndpoint = {
  ...recorded,
  "runtime-endpoint": { "agent/prod": { id: "ep-1", arn: endpointArn, updatedAt: "t" } },
};
const liveEndpoint = (overrides: Record<string, unknown> = {}) => ({
  agentRuntimeEndpointArn: endpointArn,
  agentRuntimeArn: runtimeArn,
  id: "ep-1",
  name: "prod",
  status: "READY",
  liveVersion: "2",
  description: "prod",
  ...overrides,
});
const endpointKey = { agentRuntimeId: "rt-1", endpointName: "prod" };

function harness(
  control: Parameters<typeof fakeClient>[0],
  state: Record<string, unknown> = recorded,
) {
  const controlClient = fakeClient(control);
  const clients = {
    control: () => controlClient as unknown as BedrockAgentCoreControlClient,
  } as unknown as AwsClients;
  const stack = new AgentCoreStack(
    scope,
    clients,
    { accessKeyId: "a", secretAccessKey: "b" },
    createSilentLogger(),
    state,
  );
  return { stack, control: controlClient.sent };
}

describe("poll", () => {
  test("throws when the parent runtime has no id", async () => {
    const { stack, control } = harness({}, {});
    await expect(endpointHandlers.poll(stack, resource, spec)(ctx)).rejects.toThrow(
      /runtime 'agent'/,
    );
    expect(control).toEqual([]);
  });
  test("NotStarted when GetAgentRuntimeEndpoint is not found", async () => {
    const { stack, control } = harness({
      GetAgentRuntimeEndpointCommand: () => {
        throw notFound();
      },
    });
    expect(await endpointHandlers.poll(stack, resource, spec)(ctx)).toEqual({
      status: Status.NotStarted,
    });
    expect(control).toEqual([{ name: "GetAgentRuntimeEndpointCommand", input: endpointKey }]);
  });
  test("records arn and id, maps CREATING to Waiting", async () => {
    const { stack } = harness({
      GetAgentRuntimeEndpointCommand: () => liveEndpoint({ status: "CREATING" }),
    });
    expect(await endpointHandlers.poll(stack, resource, spec)(ctx)).toEqual({
      status: Status.Waiting,
      detail: "CREATING",
    });
    expect(stack.outputsOf("runtime-endpoint:agent/prod")).toEqual({
      arn: endpointArn,
      id: "ep-1",
    });
  });
  test("READY on the declared version is Successful", async () => {
    const { stack } = harness({ GetAgentRuntimeEndpointCommand: () => liveEndpoint() });
    expect(await endpointHandlers.poll(stack, resource, spec)(ctx)).toEqual({
      status: Status.Successful,
    });
  });
  test("READY on another version is Outdated", async () => {
    const { stack } = harness({
      GetAgentRuntimeEndpointCommand: () => liveEndpoint({ targetVersion: "1" }),
    });
    const report = await endpointHandlers.poll(stack, resource, spec)(ctx);
    expect(report.status).toBe(Status.Outdated);
    expect(report.detail).toMatch(/version 1, want 2/);
  });
  test("a different description is Outdated", async () => {
    const { stack } = harness({
      GetAgentRuntimeEndpointCommand: () => liveEndpoint({ description: "old" }),
    });
    const report = await endpointHandlers.poll(stack, resource, spec)(ctx);
    expect(report).toEqual({ status: Status.Outdated, detail: "description differs" });
  });
  test("UPDATE_FAILED is Outdated so the next deploy retries, and carries the reason", async () => {
    const { stack } = harness({
      GetAgentRuntimeEndpointCommand: () =>
        liveEndpoint({ status: "UPDATE_FAILED", failureReason: "no such version" }),
    });
    expect(await endpointHandlers.poll(stack, resource, spec)(ctx)).toEqual({
      status: Status.Outdated,
      detail: "UPDATE_FAILED: no such version",
    });
  });
});

describe("create", () => {
  test("creates with runtime id, name, version string, description and tags", async () => {
    const { stack, control } = harness({
      GetAgentRuntimeEndpointCommand: () => {
        throw notFound();
      },
      CreateAgentRuntimeEndpointCommand: () => ({
        agentRuntimeEndpointArn: endpointArn,
        agentRuntimeArn: runtimeArn,
        status: "CREATING",
      }),
    });
    await endpointHandlers.create(stack, resource, spec)(ctx);
    const create = control.find((c) => c.name === "CreateAgentRuntimeEndpointCommand")!.input;
    expect(create).toEqual({
      agentRuntimeId: "rt-1",
      name: "prod",
      agentRuntimeVersion: "2",
      description: "prod",
      tags: {
        "agentcore:project-name": "orders",
        "agentcore:target-name": "staging",
        "agentcore:managed-by": "imperative",
      },
    });
    expect(create).not.toHaveProperty("clientToken");
    expect(stack.outputsOf("runtime-endpoint:agent/prod")).toEqual({ arn: endpointArn });
  });
  test("updates when the endpoint is already recorded", async () => {
    const { stack, control } = harness(
      {
        GetAgentRuntimeEndpointCommand: () => liveEndpoint({ liveVersion: "1" }),
        UpdateAgentRuntimeEndpointCommand: () => ({ status: "UPDATING" }),
      },
      withEndpoint,
    );
    await endpointHandlers.create(stack, resource, spec)(ctx);
    expect(control.map((c) => c.name)).toEqual([
      "GetAgentRuntimeEndpointCommand",
      "UpdateAgentRuntimeEndpointCommand",
    ]);
    expect(control[1]!.input).toEqual({
      agentRuntimeId: "rt-1",
      endpointName: "prod",
      agentRuntimeVersion: "2",
      description: "prod",
    });
  });
  test("throws when the parent runtime has no id", async () => {
    const { stack, control } = harness({}, {});
    await expect(endpointHandlers.create(stack, resource, spec)(ctx)).rejects.toThrow(
      /runtime 'agent' has no deployed id/,
    );
    expect(control).toEqual([]);
  });
});

describe("remove and pollGone", () => {
  test("remove deletes by runtime id and endpoint name, tolerating not found", async () => {
    const { stack, control } = harness(
      {
        DeleteAgentRuntimeEndpointCommand: () => {
          throw notFound();
        },
      },
      withEndpoint,
    );
    await endpointHandlers.remove(stack, resource)(ctx);
    expect(control).toEqual([{ name: "DeleteAgentRuntimeEndpointCommand", input: endpointKey }]);
  });
  test("pollGone is NotStarted while READY, Waiting while DELETING, Successful when gone", async () => {
    const ready = harness({ GetAgentRuntimeEndpointCommand: () => liveEndpoint() }, withEndpoint);
    expect((await endpointHandlers.pollGone(ready.stack, resource)(ctx)).status).toBe(
      Status.NotStarted,
    );
    const deleting = harness(
      { GetAgentRuntimeEndpointCommand: () => liveEndpoint({ status: "DELETING" }) },
      withEndpoint,
    );
    expect(await endpointHandlers.pollGone(deleting.stack, resource)(ctx)).toEqual({
      status: Status.Waiting,
      detail: "DELETING",
    });
    const gone = harness(
      {
        GetAgentRuntimeEndpointCommand: () => {
          throw notFound();
        },
      },
      withEndpoint,
    );
    expect(await endpointHandlers.pollGone(gone.stack, resource)(ctx)).toEqual({
      status: Status.Successful,
    });
    expect(gone.stack.outputsOf("runtime-endpoint:agent/prod")).toBeUndefined();
  });
  test("pollGone is Successful when the parent runtime is already gone", async () => {
    const { stack, control } = harness(
      {},
      {
        "runtime-endpoint": withEndpoint["runtime-endpoint"],
      },
    );
    expect(await endpointHandlers.pollGone(stack, resource)(ctx)).toEqual({
      status: Status.Successful,
    });
    expect(control).toEqual([]);
    expect(stack.outputsOf("runtime-endpoint:agent/prod")).toBeUndefined();
  });
});
