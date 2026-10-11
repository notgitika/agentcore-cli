import { describe, expect, test } from "bun:test";
import { templateFixture } from "./migrate-test-support";
import { planStack } from "./plan";
import { deployImpact } from "./replacements";
import type { CfnTemplate } from "./templates";

const target = { name: "default", account: "123456789012", region: "us-east-1" as const };
const STACK = "AgentCore-CompatMig-default";

const plan = async (deployed: string, v1: string, v1StackName = STACK) =>
  planStack({
    target,
    stackName: STACK,
    v1StackName,
    deployed: templateFixture(deployed),
    v1: templateFixture(v1),
  });

describe("planStack", () => {
  test("the live CompatMig stack with pinned names: 10 moves and 0 replacements", async () => {
    const { plan: stack, bridge, renames } = await plan("pinned.v0", "pinned.v1");
    expect(stack).toMatchObject({
      target: "default",
      account: "123456789012",
      region: "us-east-1",
      stackName: STACK,
      unchanged: 5,
      added: [],
      replaced: [],
      blockers: [],
      ready: true,
    });
    expect(stack.moves).toContainEqual({
      type: "AWS::BedrockAgentCore::Memory",
      from: "ApplicationMemoryMigagentMemoryCA18A787",
      to: "ApplicationMemoryMigagentMemoryMemoryA587350B",
    });
    expect(stack.moves).toHaveLength(10);
    // v1's gateway role has no DefaultPolicy; the deploy deletes v0's.
    expect(stack.removed).toEqual([
      {
        logicalId: "McpGatewayMiggwRoleDefaultPolicy403FA543",
        type: "AWS::IAM::Policy",
        severity: "warning",
        reason: "the v1 template has no counterpart, so the v1 deploy deletes it",
      },
    ]);
    expect(renames.size).toBe(10);
    expect(Object.keys(bridge!.Resources!)).toContain("ApplicationRuntimeMigagentRuntime93E3CAC2");
  });

  test("a library without pinned names replaces the config bundle: a blocker", async () => {
    const { plan: stack } = await plan("codezip.v0", "codezip.v1-rc3");
    expect(stack.ready).toBe(false);
    expect(stack.blockers).toEqual([]);
    expect(stack.replaced).toEqual([
      {
        logicalId: "ApplicationEvaluatorRefcodeFunctionBedrockAgentCoreEvaluatorInvokeE8AA0D2E",
        type: "AWS::Lambda::Permission",
        severity: "warning",
        reason:
          "the v1 deploy replaces it because SourceAccount, SourceArn change; resources that use it are updated to the new one",
      },
      {
        logicalId: "ApplicationConfigBundleRefcb9FCFB8E4",
        type: "AWS::BedrockAgentCore::ConfigurationBundle",
        severity: "blocker",
        reason:
          "the v1 deploy replaces it because BundleName changes; its ID, ARN, and data would be lost",
      },
    ]);
  });

  test("container project: AgentCore and ECR repository renames are blockers", async () => {
    const { plan: stack } = await plan("container.v0", "container.v1-v1names");
    const bySeverity = (severity: string) =>
      stack.replaced.filter((change) => change.severity === severity).map((change) => change.type);
    expect(bySeverity("warning")).toEqual([]);
    expect(bySeverity("blocker")).toEqual([
      "AWS::BedrockAgentCore::Memory",
      "AWS::BedrockAgentCore::Evaluator",
      "AWS::BedrockAgentCore::PolicyEngine",
      "AWS::BedrockAgentCore::Policy",
      "AWS::ECR::Repository",
      "AWS::BedrockAgentCore::Runtime",
      "AWS::BedrockAgentCore::ConfigurationBundle",
      "AWS::BedrockAgentCore::OnlineEvaluationConfig",
    ]);
    // The build trigger can't move, so it's recreated: expected, not a warning.
    expect(stack.removed.find((change) => change.type.includes("CustomResource"))).toMatchObject({
      severity: "info",
    });
    expect(stack.added).toEqual([
      {
        logicalId: "ApplicationRuntimeMyagentContainerImageBuilderContainerBuildTriggerC9AB9871",
        type: "AWS::CloudFormation::CustomResource",
      },
    ]);
  });

  test("a v1 stack name that differs from the deployed one is a blocker", async () => {
    const { plan: stack } = await plan("pinned.v0", "pinned.v1", "AgentCore-Other-default");
    expect(stack.ready).toBe(false);
    expect(stack.blockers).toEqual([
      `The v1 app names this target's stack 'AgentCore-Other-default', not '${STACK}', so a v1 deploy would create a new stack instead of updating this one.`,
    ]);
  });

  test("a bridge that can't be built is a blocker", async () => {
    // v1 moves the role to an ID the deployed template keeps for a topic v1 drops.
    const deployed: CfnTemplate = {
      Resources: {
        Role: { Type: "AWS::IAM::Role", Properties: { RoleName: "r" } },
        Taken: { Type: "AWS::SNS::Topic", Properties: {} },
      },
    };
    const v1: CfnTemplate = {
      Resources: { Taken: { Type: "AWS::IAM::Role", Properties: { RoleName: "r" } } },
    };
    const { plan: stack, bridge } = await planStack({
      target,
      stackName: STACK,
      v1StackName: STACK,
      deployed,
      v1,
    });
    expect(bridge).toBeUndefined();
    expect(stack.ready).toBe(false);
    expect(stack.blockers).toEqual([
      "Couldn't build the refactor template: Can't rename 'Role' to 'Taken': the deployed AWS::SNS::Topic 'Taken' keeps that logical ID.",
    ]);
  });
});

describe("deployImpact", () => {
  const resource = (Type: string, Properties: Record<string, unknown> = {}, extra = {}) => ({
    Type,
    Properties,
    ...extra,
  });

  test("classifies deletions: AgentCore blocks, retained is info, the rest warn", async () => {
    const impact = await deployImpact(
      {
        Resources: {
          Memory: resource("AWS::BedrockAgentCore::Memory", { Name: "m", EventExpiryDuration: 30 }),
          Logs: resource("AWS::Logs::LogGroup", {}, { DeletionPolicy: "Retain" }),
          Topic: resource("AWS::SNS::Topic"),
          Keep: resource("AWS::SNS::Topic"),
        },
      },
      { Resources: { Keep: resource("AWS::SNS::Topic"), New: resource("AWS::SNS::Topic") } },
    );
    expect(impact.added).toEqual([{ logicalId: "New", type: "AWS::SNS::Topic" }]);
    expect(impact.removed.map((change) => [change.logicalId, change.severity])).toEqual([
      ["Memory", "blocker"],
      ["Logs", "info"],
      ["Topic", "warning"],
    ]);
    expect(impact.replaced).toEqual([]);
  });

  test("names the properties that force a replacement, and ignores in-place updates", async () => {
    const impact = await deployImpact(
      {
        Resources: {
          Runtime: resource("AWS::BedrockAgentCore::Runtime", {
            AgentRuntimeName: "a",
            Description: "x",
          }),
          Repo: resource("AWS::ECR::Repository", { RepositoryName: "p/a" }),
        },
      },
      {
        Resources: {
          Runtime: resource("AWS::BedrockAgentCore::Runtime", {
            AgentRuntimeName: "a",
            Description: "y",
          }),
          Repo: resource("AWS::ECR::Repository", { RepositoryName: "p/default/a" }),
        },
      },
    );
    expect(impact.replaced).toEqual([
      {
        logicalId: "Repo",
        type: "AWS::ECR::Repository",
        severity: "blocker",
        reason:
          "the v1 deploy replaces it because RepositoryName changes; its images and repository URI would be lost",
      },
    ]);
  });

  test("follows a replacement to what reads the replaced resource's ID in a create-only property", async () => {
    const before: CfnTemplate = {
      Resources: {
        Fn: resource("AWS::Lambda::Function", { FunctionName: "eval-a", Role: "r" }),
        Invoke: resource("AWS::Lambda::Permission", {
          Action: "lambda:InvokeFunction",
          Principal: "bedrock-agentcore.amazonaws.com",
          FunctionName: { "Fn::GetAtt": ["Fn", "Arn"] },
        }),
        Logs: resource("AWS::Logs::LogGroup", { LogGroupName: { "Fn::Sub": "/aws/lambda/${Fn}" } }),
        // Reads the function's name in a property that updates in place.
        Topic: resource("AWS::SNS::Topic", { DisplayName: { Ref: "Fn" } }),
      },
    };
    const after = structuredClone(before);
    after.Resources!.Fn!.Properties!.FunctionName = "eval-b";
    const impact = await deployImpact(before, after);
    expect(impact.replaced.map((change) => change.logicalId)).toEqual(["Fn", "Invoke", "Logs"]);
    // The diff itself follows Fn::GetAtt to a replaced resource; the Fn::Sub
    // reference is found by probing the log group with Fn's ID changed.
    expect(impact.replaced[1]?.reason).toBe(
      "the v1 deploy replaces it because FunctionName changes; resources that use it are updated to the new one",
    );
    expect(impact.replaced[2]?.reason).toBe(
      "the v1 deploy replaces it because it references Fn, which is replaced; resources that use it are updated to the new one",
    );
  });

  test("a logical ID v1 reuses for another type deletes the deployed resource", async () => {
    const impact = await deployImpact(
      { Resources: { X: resource("AWS::BedrockAgentCore::Runtime", { AgentRuntimeName: "a" }) } },
      { Resources: { X: resource("AWS::IAM::Role", { AssumeRolePolicyDocument: {} }) } },
    );
    expect(impact.removed).toMatchObject([
      { logicalId: "X", type: "AWS::BedrockAgentCore::Runtime", severity: "blocker" },
    ]);
    expect(impact.added).toEqual([{ logicalId: "X", type: "AWS::IAM::Role" }]);
    expect(impact.replaced).toEqual([]);
  });

  test("a retained AgentCore resource, a harness role, and an unknown custom resource", async () => {
    const harness = (role: string) =>
      resource("AWS::BedrockAgentCore::Harness", {
        HarnessName: "h",
        ExecutionRoleArn: { "Fn::GetAtt": [role, "Arn"] },
      });
    const impact = await deployImpact(
      {
        Resources: {
          Memory: resource(
            "AWS::BedrockAgentCore::Memory",
            { Name: "m" },
            { DeletionPolicy: "Retain" },
          ),
          Role: resource("AWS::IAM::Role", { RoleName: "P_h", AssumeRolePolicyDocument: {} }),
          Harness: harness("Role"),
          Hook: resource("Custom::Something", { ServiceToken: "arn" }),
        },
      },
      {
        Resources: {
          Role: resource("AWS::IAM::Role", {
            RoleName: "P_default_h",
            AssumeRolePolicyDocument: {},
          }),
          Harness: harness("Role"),
        },
      },
    );
    expect(impact.removed.map((change) => [change.logicalId, change.severity])).toEqual([
      ["Memory", "blocker"],
      ["Hook", "warning"],
    ]);
    expect(impact.replaced.find((change) => change.logicalId === "Role")).toMatchObject({
      severity: "blocker",
      reason:
        "the v1 deploy replaces it because RoleName changes; the harness's role would get a new name and ARN",
    });
  });
});
