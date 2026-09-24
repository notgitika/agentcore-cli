import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAMClient } from "@aws-sdk/client-iam";
import {
  deleteRole,
  ensureRole,
  executionRoleName,
  loadAdditionalPolicies,
  partitionFor,
  roleArn,
  roleDrift,
  runtimeExecutionPolicy,
  trustPolicy,
  withRolePropagationRetry,
  RUNTIME_POLICY_NAME,
} from "./iam";
import { ownershipTags } from "./naming";
import { fakeClient, sdkError } from "./testing";

const scope = { projectName: "orders", targetName: "staging" };
const tags = ownershipTags(scope);
const iamTags = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
const iam = (handlers: Parameters<typeof fakeClient>[0]) => {
  const client = fakeClient(handlers);
  return { client: client as unknown as IAMClient, sent: client.sent };
};
const noSuchEntity = () => {
  throw sdkError("NoSuchEntityException", 404);
};
const spec = {
  roleName: "orders_staging_agent_runtime_role",
  description: "Execution role for runtime agent",
  tags,
  inlinePolicies: { [RUNTIME_POLICY_NAME]: '{"Version":"2012-10-17","Statement":[]}' },
  managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
};
const liveRole = {
  Role: {
    Arn: "arn:aws:iam::111122223333:role/orders_staging_agent_runtime_role",
    RoleName: spec.roleName,
    Tags: iamTags,
  },
};

describe("names", () => {
  test("partitionFor", () => {
    expect(partitionFor("us-west-2")).toBe("aws");
    expect(partitionFor("us-gov-west-1")).toBe("aws-us-gov");
    expect(partitionFor("cn-north-1")).toBe("aws-cn");
  });
  test("executionRoleName keeps the kind suffix and fits 64 chars", () => {
    expect(executionRoleName(scope, "runtime", "agent")).toBe("orders_staging_agent_runtime_role");
    const long = executionRoleName(
      { projectName: "p".repeat(40), targetName: "t".repeat(20) },
      "memory",
      "m".repeat(30),
    );
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("_memory_role")).toBe(true);
  });
  test("roleArn", () => {
    expect(roleArn("aws", "111122223333", "r")).toBe("arn:aws:iam::111122223333:role/r");
  });
  test("trust policy names the AgentCore service", () => {
    expect(JSON.parse(trustPolicy()).Statement[0].Principal.Service).toBe(
      "bedrock-agentcore.amazonaws.com",
    );
  });
});

describe("ensureRole", () => {
  test("creates a missing role with tags, then puts inline and attaches managed policies", async () => {
    const { client, sent } = iam({
      GetRoleCommand: noSuchEntity,
      CreateRoleCommand: (input) => ({
        Role: { Arn: liveRole.Role.Arn, RoleName: input.RoleName },
      }),
      PutRolePolicyCommand: () => ({}),
      ListRolePoliciesCommand: () => ({ PolicyNames: [] }),
      ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
      AttachRolePolicyCommand: () => ({}),
    });
    expect(await ensureRole(client, scope, spec)).toEqual({
      arn: liveRole.Role.Arn,
      created: true,
    });
    const create = sent.find((c) => c.name === "CreateRoleCommand")!.input;
    expect(create.RoleName).toBe(spec.roleName);
    expect(create.Tags).toEqual(iamTags);
    expect(
      JSON.parse(create.AssumeRolePolicyDocument as string).Statement[0].Principal.Service,
    ).toBe("bedrock-agentcore.amazonaws.com");
    expect(sent.find((c) => c.name === "PutRolePolicyCommand")!.input).toEqual({
      RoleName: spec.roleName,
      PolicyName: RUNTIME_POLICY_NAME,
      PolicyDocument: spec.inlinePolicies[RUNTIME_POLICY_NAME],
    });
    expect(sent.find((c) => c.name === "AttachRolePolicyCommand")!.input).toEqual({
      RoleName: spec.roleName,
      PolicyArn: spec.managedPolicyArns[0],
    });
  });

  test("reconciles an owned role: rewrites inline policies, drops extras, detaches stale managed policies", async () => {
    const { client, sent } = iam({
      GetRoleCommand: () => liveRole,
      PutRolePolicyCommand: () => ({}),
      ListRolePoliciesCommand: () => ({ PolicyNames: [RUNTIME_POLICY_NAME, "Stale"] }),
      DeleteRolePolicyCommand: () => ({}),
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }],
      }),
      AttachRolePolicyCommand: () => ({}),
      DetachRolePolicyCommand: () => ({}),
    });
    expect(await ensureRole(client, scope, spec)).toEqual({
      arn: liveRole.Role.Arn,
      created: false,
    });
    expect(sent.map((c) => c.name)).not.toContain("CreateRoleCommand");
    expect(sent.find((c) => c.name === "DeleteRolePolicyCommand")!.input).toEqual({
      RoleName: spec.roleName,
      PolicyName: "Stale",
    });
    expect(sent.find((c) => c.name === "DetachRolePolicyCommand")!.input.PolicyArn).toBe(
      "arn:aws:iam::aws:policy/AdministratorAccess",
    );
    expect(sent.find((c) => c.name === "AttachRolePolicyCommand")!.input.PolicyArn).toBe(
      spec.managedPolicyArns[0],
    );
  });

  test("refuses a role that carries no ownership tags", async () => {
    const { client, sent } = iam({
      GetRoleCommand: () => ({ Role: { ...liveRole.Role, Tags: [] } }),
    });
    await expect(ensureRole(client, scope, spec)).rejects.toThrow(
      /orders_staging_agent_runtime_role.*not created by project 'orders'/,
    );
    expect(sent.map((c) => c.name)).toEqual(["GetRoleCommand"]);
  });
});

describe("roleDrift", () => {
  const inSync = {
    GetRoleCommand: () => liveRole,
    GetRolePolicyCommand: () => ({
      PolicyDocument: encodeURIComponent('{"Version":"2012-10-17","Statement":[]}'),
    }),
    ListRolePoliciesCommand: () => ({ PolicyNames: [RUNTIME_POLICY_NAME] }),
    ListAttachedRolePoliciesCommand: () => ({
      AttachedPolicies: [{ PolicyArn: spec.managedPolicyArns[0] }],
    }),
  };
  test("is undefined when the role matches", async () => {
    expect(await roleDrift(iam(inSync).client, scope, spec)).toBeUndefined();
  });
  test("reports a missing role", async () => {
    expect(
      await roleDrift(iam({ ...inSync, GetRoleCommand: noSuchEntity }).client, scope, spec),
    ).toMatch(/does not exist/);
  });
  test("reports a changed inline policy, ignoring key order and encoding", async () => {
    const drift = await roleDrift(
      iam({
        ...inSync,
        GetRolePolicyCommand: () => ({
          PolicyDocument: encodeURIComponent(
            '{"Statement":[{"Effect":"Deny"}],"Version":"2012-10-17"}',
          ),
        }),
      }).client,
      scope,
      spec,
    );
    expect(drift).toMatch(new RegExp(`${RUNTIME_POLICY_NAME}.*differs`));
  });
  test("a reordered but equal inline policy is not drift", async () => {
    const drift = await roleDrift(
      iam({
        ...inSync,
        GetRolePolicyCommand: () => ({
          PolicyDocument: encodeURIComponent('{"Statement":[],"Version":"2012-10-17"}'),
        }),
      }).client,
      scope,
      spec,
    );
    expect(drift).toBeUndefined();
  });
  test("reports a managed policy set change", async () => {
    const drift = await roleDrift(
      iam({ ...inSync, ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }) }).client,
      scope,
      spec,
    );
    expect(drift).toMatch(/managed polic/);
  });
});

describe("deleteRole", () => {
  test("deletes an owned role after removing its policies", async () => {
    const { client, sent } = iam({
      GetRoleCommand: () => liveRole,
      ListRolePoliciesCommand: () => ({ PolicyNames: [RUNTIME_POLICY_NAME] }),
      DeleteRolePolicyCommand: () => ({}),
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: spec.managedPolicyArns[0] }],
      }),
      DetachRolePolicyCommand: () => ({}),
      DeleteRoleCommand: () => ({}),
    });
    await deleteRole(client, scope, spec.roleName);
    expect(sent.map((c) => c.name)).toEqual([
      "GetRoleCommand",
      "ListRolePoliciesCommand",
      "DeleteRolePolicyCommand",
      "ListAttachedRolePoliciesCommand",
      "DetachRolePolicyCommand",
      "DeleteRoleCommand",
    ]);
  });
  test("leaves a role it does not own", async () => {
    const { client, sent } = iam({
      GetRoleCommand: () => ({ Role: { ...liveRole.Role, Tags: [] } }),
    });
    await deleteRole(client, scope, spec.roleName);
    expect(sent.map((c) => c.name)).toEqual(["GetRoleCommand"]);
  });
  test("a missing role is a no-op", async () => {
    const { client, sent } = iam({ GetRoleCommand: noSuchEntity });
    await deleteRole(client, scope, spec.roleName);
    expect(sent.map((c) => c.name)).toEqual(["GetRoleCommand"]);
  });
});

describe("runtimeExecutionPolicy", () => {
  const doc = JSON.parse(
    runtimeExecutionPolicy({
      partition: "aws",
      region: "us-west-2",
      account: "111122223333",
      memoryArns: ["arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/m-1"],
    }),
  );
  const bySid = (sid: string) => doc.Statement.find((s: { Sid: string }) => s.Sid === sid);
  test("grants model invocation on foundation models and inference profiles", () => {
    expect(bySid("BedrockModelInvocation").Resource).toEqual([
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:*:111122223333:inference-profile/*",
    ]);
    expect(bySid("BedrockModelInvocation").Action).toContain(
      "bedrock:InvokeModelWithResponseStream",
    );
  });
  test("grants logs on the runtime log groups", () => {
    expect(bySid("CloudWatchLogs").Resource).toEqual([
      "arn:aws:logs:us-west-2:111122223333:log-group:/aws/bedrock-agentcore/runtimes/*",
    ]);
  });
  test("grants X-Ray and DescribeLogGroups on *", () => {
    expect(bySid("XRay").Resource).toBe("*");
    expect(bySid("DescribeLogGroups").Resource).toBe("*");
  });
  test("grants the configuration bundle actions the L3 construct grants", () => {
    expect(bySid("ConfigurationBundles").Action).toHaveLength(7);
    expect(bySid("ConfigurationBundles").Resource).toEqual([
      "arn:aws:bedrock-agentcore:*:*:configuration-bundle/*",
    ]);
  });
  test("grants memory read, write and retrieval on each memory", () => {
    expect(bySid("MemoryAccess").Resource).toEqual([
      "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/m-1",
    ]);
    expect(bySid("MemoryAccess").Action).toEqual(
      expect.arrayContaining([
        "bedrock-agentcore:CreateEvent",
        "bedrock-agentcore:GetMemory",
        "bedrock-agentcore:RetrieveMemoryRecords",
        "bedrock-agentcore:ListMemoryRecords",
      ]),
    );
  });
  test("omits the memory statement when there are no memories", () => {
    const none = JSON.parse(
      runtimeExecutionPolicy({
        partition: "aws",
        region: "us-west-2",
        account: "111122223333",
        memoryArns: [],
      }),
    );
    expect(none.Statement.find((s: { Sid: string }) => s.Sid === "MemoryAccess")).toBeUndefined();
  });
});

describe("loadAdditionalPolicies", () => {
  test("splits ARNs from JSON files relative to the code directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "policies-"));
    await writeFile(join(dir, "extra.json"), '{"Version":"2012-10-17","Statement":[]}');
    const result = await loadAdditionalPolicies(
      ["arn:aws:iam::aws:policy/ReadOnlyAccess", "extra.json"],
      dir,
    );
    expect(result.managedPolicyArns).toEqual(["arn:aws:iam::aws:policy/ReadOnlyAccess"]);
    expect(result.inlinePolicies).toEqual({
      Additional1: '{"Version":"2012-10-17","Statement":[]}',
    });
  });
  test("a missing file is a ProjectStateError naming the path", async () => {
    await expect(loadAdditionalPolicies(["nope.json"], "/tmp")).rejects.toThrow(/nope.json/);
  });
  test("undefined is empty", async () => {
    expect(await loadAdditionalPolicies(undefined, "/tmp")).toEqual({
      managedPolicyArns: [],
      inlinePolicies: {},
    });
  });
});

describe("withRolePropagationRetry", () => {
  test("retries a role-assumption validation error, then succeeds", async () => {
    let calls = 0;
    const slept: number[] = [];
    const result = await withRolePropagationRetry(
      async () => {
        calls++;
        if (calls < 3)
          throw sdkError(
            "ValidationException",
            400,
            "Role arn:aws:iam::1:role/x cannot be assumed by bedrock-agentcore",
          );
        return "ok";
      },
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
        delayMs: 5000,
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(slept).toEqual([5000, 5000]);
  });
  test("does not retry other errors", async () => {
    let calls = 0;
    await expect(
      withRolePropagationRetry(
        async () => {
          calls++;
          throw sdkError("ConflictException", 409);
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/ConflictException/);
    expect(calls).toBe(1);
  });
  test("gives up after the attempt budget", async () => {
    let calls = 0;
    await expect(
      withRolePropagationRetry(
        async () => {
          calls++;
          throw sdkError("AccessDeniedException", 403, "not authorized to assume role");
        },
        { attempts: 3, sleep: async () => {} },
      ),
    ).rejects.toThrow(/assume role/);
    expect(calls).toBe(3);
  });
});
