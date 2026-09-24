import { afterAll, describe, expect, test } from "bun:test";
import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import type { IAMClient } from "@aws-sdk/client-iam";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../../../../../handlers/project/types";
import { createSilentLogger } from "../../../../../testing";
import type { AwsClients } from "../../../../types";
import { RUNTIME_POLICY_NAME, runtimeExecutionPolicy } from "../iam";
import { Status, type StepContext } from "../plan/plan";
import { fakeClient, notFound, sdkError } from "../testing";
import {
  runtimeDrift,
  runtimeEntryPoint,
  runtimeEnvironment,
  runtimeHandlers,
  type RuntimeRequest,
} from "./runtime";
import { AgentCoreStack, type StackScope } from "./stack";

const scope: StackScope = {
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
const emptySpec = {
  name: "orders",
  version: 2,
  managedBy: "Imperative",
  runtimes: [],
  memories: [],
  knowledgeBases: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  agentCoreGateways: [],
  policyEngines: [],
  configBundles: [],
  harnesses: [],
};
const runtimeSpec = {
  name: "agent",
  build: "CodeZip" as const,
  entrypoint: "main.py",
  codeLocation: "app/agent",
  runtimeVersion: "PYTHON_3_14" as const,
  envVars: [{ name: "LOG_LEVEL", value: "info" }],
};
const memory = { name: "agentMemory", eventExpiryDuration: 30, strategies: [] };
const specWith = (runtime: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({
    ...emptySpec,
    runtimes: [{ ...runtimeSpec, ...runtime }],
    memories: [memory],
    ...extra,
  }) as unknown as Project["spec"];
const spec = specWith();
const resource = { kind: "runtime" as const, name: "agent" };
const artifact = {
  bucket: "agentcore-cli-111122223333-us-west-2",
  key: "orders/staging/agent/aaaa.zip",
  sha256: "aaaa",
  sizeBytes: 10,
};
const memoryArn = "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/mem-1";
const memoryRecorded = { memory: { agentMemory: { arn: memoryArn, id: "mem-1", updatedAt: "t" } } };
const runtimeArn =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/orders_staging_agent-xyz";
const runtimeRecorded = {
  ...memoryRecorded,
  runtime: { agent: { arn: runtimeArn, id: "orders_staging_agent-xyz", updatedAt: "t" } },
};
const roleArnValue = "arn:aws:iam::111122223333:role/orders_staging_agent_runtime_role";
const ownershipTags = [
  { Key: "agentcore:project-name", Value: "orders" },
  { Key: "agentcore:target-name", Value: "staging" },
  { Key: "agentcore:managed-by", Value: "imperative" },
];
const ownedRole = { Role: { Arn: roleArnValue, Tags: ownershipTags } };
const expectedEnv = {
  LOG_LEVEL: "info",
  AGENTCORE_MEMORY_AGENTMEMORY_ID: "mem-1",
  AGENTCORE_MEMORY_AGENTMEMORY_ARN: memoryArn,
};
const liveRuntime = (overrides: Record<string, unknown> = {}) => ({
  agentRuntimeArn: runtimeArn,
  agentRuntimeId: "orders_staging_agent-xyz",
  agentRuntimeName: "orders_staging_agent",
  agentRuntimeVersion: "1",
  roleArn: roleArnValue,
  status: "READY",
  description: "AgentCore Runtime: orders_agent",
  agentRuntimeArtifact: {
    codeConfiguration: {
      code: { s3: { bucket: artifact.bucket, prefix: artifact.key } },
      runtime: "PYTHON_3_14",
      entryPoint: ["opentelemetry-instrument", "main.py"],
    },
  },
  networkConfiguration: { networkMode: "PUBLIC" },
  environmentVariables: expectedEnv,
  ...overrides,
});
const runtimePolicy = runtimeExecutionPolicy({
  partition: "aws",
  region: "us-west-2",
  account: "111122223333",
  memoryArns: [memoryArn],
});
const inSyncIam = {
  GetRoleCommand: () => ownedRole,
  ListRolePoliciesCommand: () => ({ PolicyNames: [RUNTIME_POLICY_NAME] }),
  GetRolePolicyCommand: () => ({ PolicyDocument: encodeURIComponent(runtimePolicy) }),
  ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
};
const newRoleIam = {
  GetRoleCommand: () => {
    throw sdkError("NoSuchEntityException", 404);
  },
  CreateRoleCommand: () => ({ Role: { Arn: roleArnValue } }),
  PutRolePolicyCommand: () => ({}),
  ListRolePoliciesCommand: () => ({ PolicyNames: [RUNTIME_POLICY_NAME] }),
  ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
  AttachRolePolicyCommand: () => ({}),
};

function harness(
  control: Parameters<typeof fakeClient>[0],
  iam: Parameters<typeof fakeClient>[0] = {},
  recorded = {},
  stackScope: StackScope = scope,
) {
  const controlClient = fakeClient(control);
  const iamClient = fakeClient(iam);
  const clients = {
    control: () => controlClient as unknown as BedrockAgentCoreControlClient,
    iam: () => iamClient as unknown as IAMClient,
  } as unknown as AwsClients;
  const stack = new AgentCoreStack(
    stackScope,
    clients,
    { accessKeyId: "a", secretAccessKey: "b" },
    createSilentLogger(),
    recorded,
  );
  return { stack, control: controlClient.sent, iam: iamClient.sent };
}

const names = (sent: { name: string }[]) => sent.map((c) => c.name);

describe("runtimeEnvironment", () => {
  test("merges envVars with every memory id and arn", () => {
    const { stack } = harness({}, {}, memoryRecorded);
    expect(runtimeEnvironment(stack, spec.runtimes[0]!, spec)).toEqual(expectedEnv);
  });
  test("adds the name of every credential provider", () => {
    const { stack } = harness({}, {}, memoryRecorded);
    const withCredential = specWith({}, { credentials: [{ name: "github-token" }] });
    expect(runtimeEnvironment(stack, withCredential.runtimes[0]!, withCredential)).toEqual({
      ...expectedEnv,
      AGENTCORE_CREDENTIAL_GITHUB_TOKEN_NAME: "github-token",
    });
  });
  test("throws when a memory id is missing from the stack", () => {
    const { stack } = harness({});
    expect(() => runtimeEnvironment(stack, spec.runtimes[0]!, spec)).toThrow(
      /memory 'agentMemory'/,
    );
  });
});

describe("runtimeEntryPoint", () => {
  test("wraps in opentelemetry-instrument by default", () =>
    expect(runtimeEntryPoint(runtimeSpec)).toEqual(["opentelemetry-instrument", "main.py"]));
  test("strips a :handler suffix", () =>
    expect(runtimeEntryPoint({ ...runtimeSpec, entrypoint: "main.py:app" })).toEqual([
      "opentelemetry-instrument",
      "main.py",
    ]));
  test("omits the wrapper when otel is disabled", () =>
    expect(runtimeEntryPoint({ ...runtimeSpec, instrumentation: { enableOtel: false } })).toEqual([
      "main.py",
    ]));
});

describe("runtimeDrift", () => {
  const desired = (overrides: Partial<RuntimeRequest> = {}): RuntimeRequest => ({
    agentRuntimeArtifact: liveRuntime()
      .agentRuntimeArtifact as RuntimeRequest["agentRuntimeArtifact"],
    roleArn: roleArnValue,
    networkConfiguration: { networkMode: "PUBLIC" },
    description: "AgentCore Runtime: orders_agent",
    environmentVariables: expectedEnv,
    ...overrides,
  });
  test("undefined when everything matches, whatever the env key order", () => {
    const reordered = Object.fromEntries(Object.entries(expectedEnv).reverse());
    expect(
      runtimeDrift(liveRuntime({ environmentVariables: reordered }) as never, desired()),
    ).toBeUndefined();
  });
  test("reports a changed role and protocol", () => {
    expect(runtimeDrift(liveRuntime({ roleArn: "other" }) as never, desired())).toMatch(/role/);
    expect(
      runtimeDrift(
        liveRuntime() as never,
        desired({ protocolConfiguration: { serverProtocol: "MCP" } }),
      ),
    ).toMatch(/protocol/);
  });
});

describe("poll", () => {
  test("NotStarted when no runtime carries the physical name", async () => {
    const { stack, control } = harness({ ListAgentRuntimesCommand: () => ({ agentRuntimes: [] }) });
    expect(await runtimeHandlers.poll(stack, resource, spec)(ctx)).toEqual({
      status: Status.NotStarted,
    });
    expect(names(control)).toEqual(["ListAgentRuntimesCommand"]);
  });
  test("adopts by name, records arn and id", async () => {
    const { stack, control } = harness({
      ListAgentRuntimesCommand: () => ({
        agentRuntimes: [
          { agentRuntimeName: "someone_else", agentRuntimeId: "other" },
          {
            agentRuntimeName: "orders_staging_agent",
            agentRuntimeId: "orders_staging_agent-xyz",
            agentRuntimeArn: runtimeArn,
            status: "READY",
          },
        ],
      }),
      GetAgentRuntimeCommand: () => liveRuntime(),
    });
    expect((await runtimeHandlers.poll(stack, resource, spec)(ctx)).status).toBe(Status.Successful);
    expect(control[1]).toEqual({
      name: "GetAgentRuntimeCommand",
      input: { agentRuntimeId: "orders_staging_agent-xyz" },
    });
    expect(stack.outputsOf("runtime:agent")).toEqual({
      arn: runtimeArn,
      id: "orders_staging_agent-xyz",
    });
  });
  test("CREATING is Waiting; CREATE_FAILED carries failureReason", async () => {
    const creating = harness(
      { GetAgentRuntimeCommand: () => liveRuntime({ status: "CREATING" }) },
      {},
      runtimeRecorded,
    );
    expect(await runtimeHandlers.poll(creating.stack, resource, spec)(ctx)).toEqual({
      status: Status.Waiting,
      detail: "CREATING",
    });
    const failed = harness(
      {
        GetAgentRuntimeCommand: () =>
          liveRuntime({ status: "CREATE_FAILED", failureReason: "bad image" }),
      },
      {},
      runtimeRecorded,
    );
    expect(await runtimeHandlers.poll(failed.stack, resource, spec)(ctx)).toEqual({
      status: Status.Failed,
      detail: "CREATE_FAILED: bad image",
    });
  });
  test("a converged runtime with the same artifact is Successful and is not updated", async () => {
    const { stack, control } = harness(
      { GetAgentRuntimeCommand: () => liveRuntime() },
      inSyncIam,
      runtimeRecorded,
    );
    stack.artifacts.set("agent", artifact);
    expect(await runtimeHandlers.poll(stack, resource, spec)(ctx)).toEqual({
      status: Status.Successful,
    });
    expect(names(control)).not.toContain("UpdateAgentRuntimeCommand");
  });
  test("a new artifact marks the runtime Outdated and update sends the new prefix", async () => {
    const { stack, control } = harness(
      {
        GetAgentRuntimeCommand: () => liveRuntime(),
        UpdateAgentRuntimeCommand: () => liveRuntime({ status: "UPDATING" }),
      },
      { ...inSyncIam, PutRolePolicyCommand: () => ({}) },
      runtimeRecorded,
    );
    stack.artifacts.set("agent", {
      ...artifact,
      key: "orders/staging/agent/bbbb.zip",
      sha256: "bbbb",
    });
    const report = await runtimeHandlers.poll(stack, resource, spec)(ctx);
    expect(report.status).toBe(Status.Outdated);
    expect(report.detail).toMatch(/artifact/);
    await runtimeHandlers.create(stack, resource, spec)(ctx);
    const update = control.find((c) => c.name === "UpdateAgentRuntimeCommand")!.input as {
      agentRuntimeId: string;
      agentRuntimeArtifact: { codeConfiguration: { code: { s3: { prefix: string } } } };
    };
    expect(update.agentRuntimeId).toBe("orders_staging_agent-xyz");
    expect(update.agentRuntimeArtifact.codeConfiguration.code.s3.prefix).toBe(
      "orders/staging/agent/bbbb.zip",
    );
    expect(update).not.toHaveProperty("agentRuntimeName");
    expect(update).not.toHaveProperty("tags");
    expect(names(control)).not.toContain("CreateAgentRuntimeCommand");
  });
  test("a changed environment variable is Outdated", async () => {
    const { stack } = harness(
      {
        GetAgentRuntimeCommand: () =>
          liveRuntime({ environmentVariables: { ...expectedEnv, LOG_LEVEL: "debug" } }),
      },
      inSyncIam,
      runtimeRecorded,
    );
    stack.artifacts.set("agent", artifact);
    const report = await runtimeHandlers.poll(stack, resource, spec)(ctx);
    expect(report.status).toBe(Status.Outdated);
    expect(report.detail).toMatch(/environment/);
  });
  test("a changed role policy is Outdated", async () => {
    const { stack } = harness(
      { GetAgentRuntimeCommand: () => liveRuntime() },
      {
        ...inSyncIam,
        GetRolePolicyCommand: () => ({
          PolicyDocument: encodeURIComponent(
            JSON.stringify({ Version: "2012-10-17", Statement: [] }),
          ),
        }),
      },
      runtimeRecorded,
    );
    stack.artifacts.set("agent", artifact);
    const report = await runtimeHandlers.poll(stack, resource, spec)(ctx);
    expect(report.status).toBe(Status.Outdated);
    expect(report.detail).toMatch(/policy/);
  });
  test("READY without a staged artifact skips artifact drift (status/invoke paths)", async () => {
    const { stack, iam } = harness(
      { GetAgentRuntimeCommand: () => liveRuntime({ agentRuntimeArtifact: undefined }) },
      {},
      runtimeRecorded,
    );
    expect(await runtimeHandlers.poll(stack, resource, spec)(ctx)).toEqual({
      status: Status.Successful,
    });
    expect(iam).toEqual([]);
  });
});

describe("create", () => {
  test("creates the role with the runtime policy over every memory, then the runtime", async () => {
    const { stack, control, iam } = harness(
      { CreateAgentRuntimeCommand: () => liveRuntime({ status: "CREATING" }) },
      newRoleIam,
      memoryRecorded,
    );
    stack.artifacts.set("agent", artifact);
    await runtimeHandlers.create(stack, resource, spec)(ctx);
    expect(iam.find((c) => c.name === "CreateRoleCommand")!.input.RoleName).toBe(
      "orders_staging_agent_runtime_role",
    );
    const put = iam.find((c) => c.name === "PutRolePolicyCommand")!.input;
    expect(put.PolicyName).toBe(RUNTIME_POLICY_NAME);
    expect(put.PolicyDocument).toBe(runtimePolicy);
    const create = control.find((c) => c.name === "CreateAgentRuntimeCommand")!.input;
    expect(create).toEqual({
      agentRuntimeName: "orders_staging_agent",
      agentRuntimeArtifact: {
        codeConfiguration: {
          code: { s3: { bucket: artifact.bucket, prefix: artifact.key } },
          runtime: "PYTHON_3_14",
          entryPoint: ["opentelemetry-instrument", "main.py"],
        },
      },
      roleArn: roleArnValue,
      networkConfiguration: { networkMode: "PUBLIC" },
      description: "AgentCore Runtime: orders_agent",
      environmentVariables: expectedEnv,
      tags: {
        "agentcore:project-name": "orders",
        "agentcore:target-name": "staging",
        "agentcore:managed-by": "imperative",
      },
    });
    expect(create).not.toHaveProperty("protocolConfiguration");
    expect(create).not.toHaveProperty("clientToken");
    expect(stack.outputsOf("runtime:agent")).toEqual({
      arn: runtimeArn,
      id: "orders_staging_agent-xyz",
    });
  });
  test("passes protocol, VPC network config, request headers and lifecycle when declared", async () => {
    const declared = specWith({
      protocol: "MCP",
      networkMode: "VPC",
      networkConfig: { subnets: ["subnet-12345678"], securityGroups: ["sg-12345678"] },
      requestHeaderAllowlist: ["X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant"],
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 600, maxLifetime: 3600 },
      description: "orders agent",
      executionRoleArn: "arn:aws:iam::111122223333:role/mine",
    });
    const { stack, control } = harness(
      { CreateAgentRuntimeCommand: () => liveRuntime() },
      {},
      memoryRecorded,
    );
    stack.artifacts.set("agent", artifact);
    await runtimeHandlers.create(stack, resource, declared)(ctx);
    const create = control[0]!.input;
    expect(create.protocolConfiguration).toEqual({ serverProtocol: "MCP" });
    expect(create.networkConfiguration).toEqual({
      networkMode: "VPC",
      networkModeConfig: { subnets: ["subnet-12345678"], securityGroups: ["sg-12345678"] },
    });
    expect(create.requestHeaderConfiguration).toEqual({
      requestHeaderAllowlist: ["X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant"],
    });
    expect(create.lifecycleConfiguration).toEqual({
      idleRuntimeSessionTimeout: 600,
      maxLifetime: 3600,
    });
    expect(create.description).toBe("orders agent");
  });
  test("uses executionRoleArn without touching IAM", async () => {
    const withRole = specWith({ executionRoleArn: "arn:aws:iam::111122223333:role/mine" });
    const { stack, control, iam } = harness(
      { CreateAgentRuntimeCommand: () => liveRuntime() },
      {},
      memoryRecorded,
    );
    stack.artifacts.set("agent", artifact);
    await runtimeHandlers.create(stack, resource, withRole)(ctx);
    expect(iam).toEqual([]);
    expect(control[0]!.input.roleArn).toBe("arn:aws:iam::111122223333:role/mine");
  });
  describe("additionalPolicies", () => {
    const root = mkdtempSync(join(tmpdir(), "imperative-runtime-"));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    test("attaches managed policies and inline files from additionalPolicies", async () => {
      mkdirSync(join(root, "app", "agent"), { recursive: true });
      const extra = JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }],
      });
      writeFileSync(join(root, "app", "agent", "extra.json"), extra);
      const withPolicies = specWith({
        additionalPolicies: ["arn:aws:iam::aws:policy/ReadOnlyAccess", "extra.json"],
      });
      const { stack, iam } = harness(
        { CreateAgentRuntimeCommand: () => liveRuntime() },
        newRoleIam,
        memoryRecorded,
        { ...scope, rootPath: root },
      );
      stack.artifacts.set("agent", artifact);
      await runtimeHandlers.create(stack, resource, withPolicies)(ctx);
      expect(iam.find((c) => c.name === "AttachRolePolicyCommand")!.input.PolicyArn).toBe(
        "arn:aws:iam::aws:policy/ReadOnlyAccess",
      );
      const puts = iam.filter((c) => c.name === "PutRolePolicyCommand").map((c) => c.input);
      expect(puts.map((p) => p.PolicyName)).toEqual([RUNTIME_POLICY_NAME, "Additional1"]);
      expect(JSON.parse(puts[1]!.PolicyDocument as string)).toEqual(JSON.parse(extra));
    });
  });
  test("fails before any AWS call when no artifact is staged", async () => {
    const { stack, control, iam } = harness({}, {}, memoryRecorded);
    await expect(runtimeHandlers.create(stack, resource, spec)(ctx)).rejects.toThrow(
      /no code artifact/,
    );
    expect(control).toEqual([]);
    expect(iam).toEqual([]);
  });
  test("retries CreateAgentRuntime while the role propagates", async () => {
    let attempts = 0;
    const { stack } = harness(
      {
        CreateAgentRuntimeCommand: () => {
          if (++attempts < 2) {
            throw sdkError("ValidationException", 400, "Role validation failed for role arn");
          }
          return liveRuntime();
        },
      },
      newRoleIam,
      memoryRecorded,
    );
    stack.artifacts.set("agent", artifact);
    await runtimeHandlers.create(stack, resource, spec, { sleep: async () => {} })(ctx);
    expect(attempts).toBe(2);
    expect(stack.outputsOf("runtime:agent")?.id).toBe("orders_staging_agent-xyz");
  });
});

describe("remove and pollGone", () => {
  test("remove deletes by recorded id", async () => {
    const { stack, control } = harness(
      { DeleteAgentRuntimeCommand: () => ({}) },
      {},
      runtimeRecorded,
    );
    await runtimeHandlers.remove(stack, resource)(ctx);
    expect(control).toEqual([
      { name: "DeleteAgentRuntimeCommand", input: { agentRuntimeId: "orders_staging_agent-xyz" } },
    ]);
  });
  test("remove tolerates a runtime that is already gone", async () => {
    const { stack } = harness(
      {
        DeleteAgentRuntimeCommand: () => {
          throw notFound();
        },
      },
      {},
      runtimeRecorded,
    );
    await runtimeHandlers.remove(stack, resource)(ctx);
  });
  test("pollGone is NotStarted while READY, Waiting while DELETING", async () => {
    const ready = harness({ GetAgentRuntimeCommand: () => liveRuntime() }, {}, runtimeRecorded);
    expect((await runtimeHandlers.pollGone(ready.stack, resource)(ctx)).status).toBe(
      Status.NotStarted,
    );
    const deleting = harness(
      { GetAgentRuntimeCommand: () => liveRuntime({ status: "DELETING" }) },
      {},
      runtimeRecorded,
    );
    expect(await runtimeHandlers.pollGone(deleting.stack, resource)(ctx)).toEqual({
      status: Status.Waiting,
      detail: "DELETING",
    });
  });
  test("pollGone deletes the owned role and forgets the step when the runtime is gone", async () => {
    const { stack, iam } = harness(
      {
        GetAgentRuntimeCommand: () => {
          throw notFound();
        },
      },
      {
        GetRoleCommand: () => ownedRole,
        ListRolePoliciesCommand: () => ({ PolicyNames: [RUNTIME_POLICY_NAME] }),
        DeleteRolePolicyCommand: () => ({}),
        ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
        DeleteRoleCommand: () => ({}),
      },
      runtimeRecorded,
    );
    expect(await runtimeHandlers.pollGone(stack, resource)(ctx)).toEqual({
      status: Status.Successful,
    });
    expect(iam.find((c) => c.name === "DeleteRoleCommand")!.input.RoleName).toBe(
      "orders_staging_agent_runtime_role",
    );
    expect(stack.outputsOf("runtime:agent")).toBeUndefined();
  });
  test("pollGone with nothing recorded is Successful", async () => {
    const { stack, control } = harness({});
    expect(await runtimeHandlers.pollGone(stack, resource)(ctx)).toEqual({
      status: Status.Successful,
    });
    expect(control).toEqual([]);
  });
});
