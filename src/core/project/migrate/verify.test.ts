import { describe, expect, test } from "bun:test";
import type { Change } from "@aws-sdk/client-cloudformation";
import { fakeCloudFormation, fakeTemplateStore, type FakeChangeSet } from "./migrate-test-support";
import type { CfnTemplate } from "./templates";
import { verifyStack } from "./verify";

const V1: CfnTemplate = {
  Resources: {
    Harness: {
      Type: "AWS::BedrockAgentCore::Harness",
      Properties: { ExecutionRoleArn: { "Fn::GetAtt": ["HarnessRole", "Arn"] } },
    },
    HarnessRole: { Type: "AWS::IAM::Role", Properties: {} },
  },
};

const change = (
  LogicalResourceId: string,
  ResourceType: string,
  Action: string,
  Replacement?: string,
  Details?: NonNullable<Change["ResourceChange"]>["Details"],
): Change => ({
  Type: "Resource",
  ResourceChange: {
    LogicalResourceId,
    ResourceType,
    Action: Action as never,
    ...(Replacement && { Replacement: Replacement as never }),
    ...(Details && { Details }),
  },
});

/** A create-only property that may change because it reads `causingEntity`, shaped like the details of the live CompatMig change set. */
const dynamic = (name: string, causingEntity: string) => ({
  Target: { Attribute: "Properties" as const, Name: name, RequiresRecreation: "Always" as const },
  Evaluation: "Dynamic" as const,
  ChangeSource: "ResourceAttribute" as const,
  CausingEntity: causingEntity,
});

async function verify(changeSet: FakeChangeSet, current?: CfnTemplate) {
  const cloudFormation = fakeCloudFormation(
    { S: { template: {} } },
    { changeSets: { S: changeSet } },
  );
  const result = await verifyStack(
    {
      target: "default",
      stackName: "S",
      template: V1,
      ...(current && { current }),
      client: cloudFormation.create({ region: "us-east-1" } as never),
      templates: async () => fakeTemplateStore(),
    },
    { intervalMs: 0, sleep: async () => {} },
  );
  return { result, commands: cloudFormation.calls.map((call) => call.command) };
}

describe("verifyStack", () => {
  test("passes in-place updates and harmless removals, and deletes the change set", async () => {
    const { result, commands } = await verify({
      changes: [
        change("Runtime", "AWS::BedrockAgentCore::Runtime", "Modify", "False"),
        change("OldPolicy", "AWS::IAM::Policy", "Remove"),
        change("Permission", "AWS::Lambda::Permission", "Modify", "True"),
      ],
    });
    expect(result.problems).toEqual([]);
    expect(result.changes).toEqual([
      {
        logicalId: "Runtime",
        type: "AWS::BedrockAgentCore::Runtime",
        action: "Modify",
        replacement: "False",
      },
      { logicalId: "OldPolicy", type: "AWS::IAM::Policy", action: "Remove" },
      {
        logicalId: "Permission",
        type: "AWS::Lambda::Permission",
        action: "Modify",
        replacement: "True",
      },
    ]);
    expect(commands).toEqual([
      "CreateChangeSetCommand",
      "DescribeChangeSetCommand",
      "DeleteChangeSetCommand",
    ]);
  });

  test("flags replaced or removed AgentCore resources, ECR repositories, and harness roles", async () => {
    const { result } = await verify({
      changes: [
        change("Memory", "AWS::BedrockAgentCore::Memory", "Modify", "True"),
        change("Gateway", "AWS::BedrockAgentCore::Gateway", "Remove"),
        // Conditional with no explanation: counted as replaced.
        change("Repo", "AWS::ECR::Repository", "Modify", "Conditional"),
        change("HarnessRole", "AWS::IAM::Role", "Modify", "True"),
      ],
    });
    expect(result.problems).toEqual([
      "AWS::BedrockAgentCore::Memory Memory would be replaced, getting a new ID and ARN.",
      "AWS::BedrockAgentCore::Gateway Gateway would be deleted.",
      "AWS::ECR::Repository Repo might be replaced, getting a new ID and ARN.",
      "AWS::IAM::Role HarnessRole would be replaced, getting a new ID and ARN.",
    ]);
  });

  test("a Conditional replacement is real only when what it reads is replaced", async () => {
    const { result } = await verify({
      changes: [
        // Updated in place: its ID doesn't change, so neither does the target's gateway.
        change("Gateway", "AWS::BedrockAgentCore::Gateway", "Modify", "False"),
        change("Target", "AWS::BedrockAgentCore::GatewayTarget", "Modify", "Conditional", [
          dynamic("GatewayIdentifier", "Gateway.GatewayIdentifier"),
        ]),
        // Replaced: the policy reading its ID is replaced too, and so on down.
        change("Engine", "AWS::BedrockAgentCore::PolicyEngine", "Modify", "True"),
        change("Policy", "AWS::BedrockAgentCore::Policy", "Modify", "Conditional", [
          dynamic("PolicyEngineId", "Child.Id"),
        ]),
        change("Child", "AWS::IAM::Role", "Modify", "Conditional", [
          dynamic("RoleName", "Engine.PolicyEngineId"),
        ]),
        // Changed by the template itself: CloudFormation can't rule it out.
        change("Memory", "AWS::BedrockAgentCore::Memory", "Modify", "Conditional", [
          {
            Target: { Attribute: "Properties", Name: "Name", RequiresRecreation: "Conditionally" },
            Evaluation: "Static",
            ChangeSource: "DirectModification",
          },
        ]),
      ],
    });
    expect(result.problems).toEqual([
      "AWS::BedrockAgentCore::PolicyEngine Engine would be replaced, getting a new ID and ARN.",
      "AWS::BedrockAgentCore::Policy Policy might be replaced, getting a new ID and ARN.",
      "AWS::BedrockAgentCore::Memory Memory might be replaced, getting a new ID and ARN.",
    ]);
    expect(result.changes[1]).toEqual({
      logicalId: "Target",
      type: "AWS::BedrockAgentCore::GatewayTarget",
      action: "Modify",
      replacement: "Conditional",
      recreatedBy: [
        {
          property: "GatewayIdentifier",
          evaluation: "Dynamic",
          source: "ResourceAttribute",
          causingEntity: "Gateway.GatewayIdentifier",
        },
      ],
    });
  });

  test("flags the removal of a harness role only the stack's current template names", async () => {
    const current: CfnTemplate = {
      Resources: {
        OldHarness: {
          Type: "AWS::BedrockAgentCore::Harness",
          Properties: { ExecutionRoleArn: { "Fn::GetAtt": ["OldHarnessRole", "Arn"] } },
        },
        OldHarnessRole: { Type: "AWS::IAM::Role", Properties: {} },
      },
    };
    const changes = { changes: [change("OldHarnessRole", "AWS::IAM::Role", "Remove")] };
    expect((await verify(changes)).result.problems).toEqual([]);
    expect((await verify(changes, current)).result.problems).toEqual([
      "AWS::IAM::Role OldHarnessRole would be deleted.",
    ]);
  });

  test("a change set with nothing to do verifies", async () => {
    const { result } = await verify({ changes: [] });
    expect(result).toMatchObject({ changes: [], problems: [] });
  });

  test("a change set CloudFormation can't create is a problem", async () => {
    const { result, commands } = await verify({
      status: "FAILED",
      reason: "Template format error",
    });
    expect(result.error).toBe(
      "CloudFormation couldn't create the change set (FAILED): Template format error",
    );
    expect(result.problems).toEqual([]);
    expect(commands.at(-1)).toBe("DeleteChangeSetCommand");
  });
});
