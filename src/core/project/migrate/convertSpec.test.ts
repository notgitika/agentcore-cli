import { describe, expect, test } from "bun:test";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { V0AgentCoreProjectSpecSchema, type V0DeployedState } from "../../../projectSchemas/v0";
import { rawFixture, v0Fixture, validV0FixtureNames } from "../legacy/fixtures-test-support";
import { convertSpec, convertTargets, deployedResources, type HarnessFacts } from "./convertSpec";
import { F1_DEPLOYED_STATE, F1_SPEC } from "./migrate-test-support";

type Json = Record<string, unknown>;
const NEVER_DEPLOYED: V0DeployedState = { targets: {} };
const f1 = () => V0AgentCoreProjectSpecSchema.parse(structuredClone(F1_SPEC));
const f1State = () => structuredClone(F1_DEPLOYED_STATE) as V0DeployedState;

/**
 * The audit fixtures v1 validates more strictly than v0 (the schema audit; see the design doc),
 * with the field each one fails on. Every other v0-valid fixture converts cleanly.
 */
const EXPECTED_PROBLEMS: Record<string, string[]> = {
  "configbundle-branch-leading-digit.json": ["configBundles[cb1].branchName"],
  "configbundle-branch-with-dot.json": ["configBundles[cb1].branchName"],
  "credential-env-collision.json": ["credentials[svc_client_secret].name"],
  "credential-hyphen-underscore-collision.json": ["credentials[my_key].name"],
  "credential-name-1-char.json": ["credentials[k].name"],
  "credential-name-2-chars.json": ["credentials[ab].name"],
  "credential-oauth-no-discoveryUrl_import_.json": ["credentials[imported-oauth]"],
  "credential-oauth-vendor-non-custom-no-url.json": ["credentials[github]"],
  "credential-oauth-vendor-non-custom.json": ["credentials[google]"],
  "gateway-target-apigw-empty-toolDefinitions.json": [
    "agentCoreGateways[gw1].targets[apigw].toolDefinitions",
  ],
  "gateway-target-connector-outboundAuth-NONE.json": [
    "agentCoreGateways[gw1].targets[websearch].outboundAuth",
  ],
  "gateway-target-httpRuntime-with-schemaSource.json": [
    "agentCoreGateways[gw2].targets[httprt].schemaSource",
  ],
  "gateway-target-lambda-with-endpoint.json": ["agentCoreGateways[gw1].targets[lambdaTs].endpoint"],
  "gateway-target-mcpServer-empty-configurations.json": [
    "agentCoreGateways[gw1].targets[mcpExt].configurations",
  ],
  "gateway-target-mcpServer-with-passthrough.json": [
    "agentCoreGateways[gw1].targets[mcpExt].passthrough",
  ],
  "gateway-target-openapi-with-httpRuntime.json": [
    "agentCoreGateways[gw1].targets[openapi].httpRuntime",
  ],
  "gateway-target-smithy-outboundAuth-NONE.json": [
    "agentCoreGateways[gw1].targets[smithy].outboundAuth",
  ],
  "online-eval-11-evaluators.json": ["onlineEvalConfigs[oe1].evaluators"],
  "payment-connector-provider-mismatch.json": ["payments[pm1].connectors[stripe1].provider"],
  "payment-description-punctuation.json": ["payments[pm1].description"],
  "payment-duplicate-connector-names.json": ["payments[pm1].connectors[cb_manual].name"],
  "payment-jwt-discovery-not-wellknown.json": [
    "payments[pm2].authorizerConfiguration.customJWTAuthorizer.discoveryUrl",
  ],
  "payment-jwt-empty-arrays.json": [
    "payments[pm2].authorizerConfiguration.customJWTAuthorizer.allowedClients",
  ],
  "payment-jwt-scope-with-space.json": [
    "payments[pm2].authorizerConfiguration.customJWTAuthorizer.allowedScopes[0]",
  ],
  "payment-manager-case-collision.json": ["payments[PM1].name"],
  "payment-spendlimit-nonnumeric.json": ["payments[pm1].defaultSpendLimit"],
  "project-name-crewai.json": ["name"],
  "project-name-tiktoken.json": ["name"],
  "runtime-codezip-no-runtimeVersion.json": ["runtimes[agentD].runtimeVersion"],
  "runtime-container-vpc-no-vpcId.json": ["runtimes[agentB].networkConfig.vpcId"],
};

describe("convertSpec on the v0 audit fixtures", () => {
  test.each(validV0FixtureNames())("%s converts or names exactly what v1 rejects", (name) => {
    const result = convertSpec(v0Fixture(name), NEVER_DEPLOYED);
    const expected = EXPECTED_PROBLEMS[name];
    if (expected) {
      expect(result.problems.map((problem) => problem.path)).toEqual(expected);
      for (const problem of result.problems) {
        expect(problem.file).toBe("agentcore/agentcore.json");
        expect(problem.message.length).toBeGreaterThan(0);
      }
      return;
    }
    expect(result.problems).toEqual([]);
    // What gets written is a v1 spec, and reading it back changes nothing.
    const reparsed = ProjectSpecSchema.parse(structuredClone(result.json));
    expect(JSON.parse(JSON.stringify(reparsed))).toEqual(JSON.parse(JSON.stringify(result.json)));
    expect(result.json.version).toBe(2);
    expect(result.json.name).toBe(String(rawFixture(name).name));
  });

  test("every expected problem fixture exists", () => {
    const names = new Set(validV0FixtureNames());
    expect(Object.keys(EXPECTED_PROBLEMS).filter((name) => !names.has(name))).toEqual([]);
  });

  test("warns about the fields v1 drops, naming the resource", () => {
    const { warnings } = convertSpec(v0Fixture("baseline.json"), NEVER_DEPLOYED);
    expect(warnings).toEqual([
      "Dropped fields v1 doesn't use: credentials[my-oauth].usage, credentials[gw1-oauth].usage",
    ]);
  });

  test("warns about dropped unassigned targets and A/B tests", () => {
    expect(
      convertSpec(v0Fixture("top-unassignedTargets.json"), NEVER_DEPLOYED).warnings[0],
    ).toStartWith("Dropped unassigned gateway targets (u1)");
    const { warnings, json } = convertSpec(v0Fixture("top-abTests-nonempty.json"), NEVER_DEPLOYED);
    expect(warnings[0]).toStartWith("Removed abTests (ab1) from agentcore.json");
    expect("abTests" in json).toBe(false);
  });

  test("keeps tool runtimes under their v1 name", () => {
    const { json } = convertSpec(v0Fixture("top-mcpRuntimeTools.json"), NEVER_DEPLOYED);
    expect("mcpRuntimeTools" in json).toBe(false);
    expect((json.toolRuntimes as Json[])[0]?.name).toBe("rtTool");
  });
});

describe("convertSpec pins", () => {
  test("pins every deployed resource to its v0 name", () => {
    const { pins, problems, json } = convertSpec(f1(), f1State());
    expect(problems).toEqual([]);
    expect(pins).toEqual([
      {
        resourceType: "runtime",
        name: "CompatAAgent",
        field: "resourceName",
        value: "CompatA_CompatAAgent",
      },
      {
        resourceType: "memory",
        name: "CompatAAgentMemory",
        field: "resourceName",
        value: "CompatA_CompatAAgentMemory",
      },
      {
        resourceType: "evaluator",
        name: "CompatAJudge",
        field: "resourceName",
        value: "CompatA_CompatAJudge",
      },
      {
        resourceType: "online-eval",
        name: "CompatAOnline",
        field: "resourceName",
        value: "CompatA_CompatAOnline",
      },
      {
        resourceType: "policy-engine",
        name: "CompatAPE",
        field: "resourceName",
        value: "CompatA_CompatAPE",
      },
      {
        resourceType: "policy",
        name: "CompatAPE/CompatAPolicy",
        field: "resourceName",
        value: "CompatAPolicy",
      },
      {
        resourceType: "config-bundle",
        name: "CompatABundle",
        field: "resourceName",
        value: "CompatACompatABundle",
      },
      {
        resourceType: "harness",
        name: "CompatAHarness",
        field: "resourceName",
        value: "CompatA_CompatAHarness",
      },
      {
        resourceType: "gateway",
        name: "CompatAGw",
        field: "resourceName",
        value: "CompatA-CompatAGw",
      },
      {
        resourceType: "credential",
        name: "compatA-key",
        field: "providerName",
        value: "compatA-key",
      },
      {
        resourceType: "credential",
        name: "compatA-oauth",
        field: "providerName",
        value: "compatA-oauth",
      },
    ]);
    const spec = ProjectSpecSchema.parse(json);
    expect(spec.runtimes[0]?.resourceName).toBe("CompatA_CompatAAgent");
    expect(spec.policyEngines[0]?.policies[0]?.resourceName).toBe("CompatAPolicy");
    expect(spec.configBundles[0]?.resourceName).toBe("CompatACompatABundle");
    expect(spec.harnesses[0]?.resourceName).toBe("CompatA_CompatAHarness");
    expect(spec.credentials.map((credential) => credential.providerName)).toEqual([
      "compatA-key",
      "compatA-oauth",
    ]);
  });

  test("leaves never-deployed resources unpinned", () => {
    const { pins, json } = convertSpec(f1(), NEVER_DEPLOYED);
    expect(pins).toEqual([]);
    const spec = ProjectSpecSchema.parse(json);
    expect(spec.runtimes[0]?.resourceName).toBeUndefined();
    expect(spec.credentials[0]?.providerName).toBeUndefined();
  });

  test("pins what any target deployed, including gateways recorded under mcp", () => {
    const state: V0DeployedState = {
      targets: {
        dev: { resources: { memories: f1State().targets.default!.resources!.memories } },
        prod: {
          resources: {
            mcp: {
              gateways: {
                CompatAGw: { gatewayId: "compata-compatagw-abcde12345", gatewayArn: "arn:gw" },
              },
            },
          },
        },
      },
    };
    const { pins } = convertSpec(f1(), state);
    expect(pins.map((pin) => `${pin.resourceType}:${pin.value}`)).toEqual([
      "memory:CompatA_CompatAAgentMemory",
      "gateway:CompatA-CompatAGw",
    ]);
  });

  test("keeps a gateway's explicit v0 resourceName", () => {
    const v0 = f1();
    v0.agentCoreGateways[0]!.resourceName = "custom-gw";
    const state = f1State();
    state.targets.default!.resources!.gateways!.CompatAGw!.gatewayId = "custom-gw-xyzab12345";
    const pin = convertSpec(v0, state).pins.find((p) => p.resourceType === "gateway");
    expect(pin?.value).toBe("custom-gw");
  });

  test("reports a deployed ID that doesn't match the derived name instead of pinning it", () => {
    const state = f1State();
    state.targets.default!.resources!.runtimes!.CompatAAgent!.runtimeId = "Renamed_Agent-abc";
    const { pins, problems, json } = convertSpec(f1(), state);
    expect(pins.some((pin) => pin.resourceType === "runtime")).toBe(false);
    expect(problems).toEqual([
      {
        file: "agentcore/agentcore.json",
        path: "runtime CompatAAgent",
        message:
          "deployed as 'Renamed_Agent-abc', which doesn't match the name 'CompatA_CompatAAgent' " +
          "v0 would have given it, so its name can't be kept safely",
      },
    ]);
    expect((json.runtimes as Json[])[0]?.resourceName).toBeUndefined();
  });

  test("pins a deployed managed code-based evaluator's Lambda function name", () => {
    const v0 = V0AgentCoreProjectSpecSchema.parse({
      ...structuredClone(F1_SPEC),
      onlineEvalConfigs: [],
      evaluators: [
        {
          name: "CodeJudge",
          level: "TRACE",
          config: { codeBased: { managed: { codeLocation: "app/evaluators/CodeJudge" } } },
        },
      ],
    });
    const state: V0DeployedState = {
      targets: {
        default: {
          resources: {
            evaluators: {
              CodeJudge: { evaluatorId: "CompatA_CodeJudge-abcde12345", evaluatorArn: "arn:e" },
            },
          },
        },
      },
    };
    const { pins, json, problems } = convertSpec(v0, state);
    expect(problems).toEqual([]);
    expect(pins).toContainEqual({
      resourceType: "evaluator-function",
      name: "CodeJudge",
      field: "config.codeBased.managed.functionName",
      value: "CompatA-eval-CodeJudge",
    });
    const spec = ProjectSpecSchema.parse(json);
    expect(spec.evaluators[0]?.config.codeBased?.managed?.functionName).toBe(
      "CompatA-eval-CodeJudge",
    );
  });

  test("does not pin the function of an evaluator whose own name can't be kept", () => {
    const v0 = V0AgentCoreProjectSpecSchema.parse({
      ...structuredClone(F1_SPEC),
      onlineEvalConfigs: [],
      evaluators: [
        {
          name: "CodeJudge",
          level: "TRACE",
          config: { codeBased: { managed: { codeLocation: "app/evaluators/CodeJudge" } } },
        },
      ],
    });
    const state: V0DeployedState = {
      targets: {
        default: {
          resources: {
            evaluators: {
              CodeJudge: { evaluatorId: "Other_CodeJudge-abcde12345", evaluatorArn: "arn:e" },
            },
          },
        },
      },
    };
    const { pins, problems } = convertSpec(v0, state);
    expect(pins).toEqual([]);
    expect(problems.map((problem) => problem.path)).toEqual(["evaluator CodeJudge"]);
  });

  test("warns about credentials a deployed project has no provider recorded for", () => {
    const state = f1State();
    delete state.targets.default!.resources!.credentials!["compatA-oauth"];
    const { pins, warnings } = convertSpec(f1(), state);
    expect(pins.filter((pin) => pin.resourceType === "credential").map((pin) => pin.name)).toEqual([
      "compatA-key",
    ]);
    expect(warnings).toContain(
      "No deployed provider is recorded for credentials compatA-oauth, so their names aren't kept: " +
        "v1 creates a new provider for each target on the next deploy. If v0 did create one, set " +
        "providerName on the credential to its name before deploying.",
    );
    expect(
      convertSpec(f1(), NEVER_DEPLOYED).warnings.some((w) => w.startsWith("No deployed")),
    ).toBe(false);
  });

  test("does not pin an evaluator function that was never deployed", () => {
    const v0 = V0AgentCoreProjectSpecSchema.parse({
      ...structuredClone(F1_SPEC),
      onlineEvalConfigs: [],
      evaluators: [
        {
          name: "CodeJudge",
          level: "TRACE",
          config: { codeBased: { managed: { codeLocation: "app/evaluators/CodeJudge" } } },
        },
      ],
    });
    expect(convertSpec(v0, NEVER_DEPLOYED).pins).toEqual([]);
  });

  test("does not mutate the v0 spec", () => {
    const v0 = f1();
    const before = JSON.stringify(v0);
    convertSpec(v0, f1State());
    expect(JSON.stringify(v0)).toBe(before);
  });
});

describe("deployedResources", () => {
  test("collects each target's recorded IDs per resource", () => {
    const state = f1State();
    state.targets.prod = structuredClone(state.targets.default!);
    const deployed = deployedResources(state);
    expect(deployed.runtimes.get("CompatAAgent")).toEqual([
      "CompatA_CompatAAgent-5ITOUFEJg5",
      "CompatA_CompatAAgent-5ITOUFEJg5",
    ]);
    expect([...deployed.policies.keys()]).toEqual(["CompatAPE/CompatAPolicy"]);
  });
});

describe("convertTargets", () => {
  test("accepts targets v1 can read", () => {
    expect(convertTargets(rawFixture("aws-targets_default.json"))).toEqual([]);
  });

  test("blocks hyphenated target names, explaining why they can't be renamed", () => {
    const problems = convertTargets(rawFixture("aws-targets_hyphen-name.json"));
    expect(problems).toHaveLength(1);
    expect(problems[0]?.file).toBe("agentcore/aws-targets.json");
    expect(problems[0]?.path).toMatch(/^\[.+\]\.name$/);
    expect(problems[0]?.message).toContain("Renaming a target deploys a new stack");
  });

  test("blocks target names that differ only by case", () => {
    const problems = convertTargets(rawFixture("aws-targets_case-dup.json"));
    expect(problems[0]?.message).toContain("Duplicate deployment target name");
  });
});

describe("convertSpec pins for tool runtimes, gateway-target compute, and containers", () => {
  const recorded = (resources: Record<string, unknown>): V0DeployedState =>
    ({ targets: { default: { resources } } }) as V0DeployedState;

  test("pins deployed tool runtimes, target Lambdas, and Container runtime repositories", () => {
    const state = recorded({
      runtimes: {
        agentB: {
          runtimeId: "maxproj_agentB-abcde12345",
          runtimeArn: "arn:r",
          roleArn: "arn:role",
        },
      },
      mcp: {
        runtimes: {
          rtTool: {
            runtimeId: "maxproj_rtToolRuntime-abcde12345",
            runtimeArn: "arn:rt",
            runtimeEndpoint: "https://rt",
          },
        },
        lambdas: {
          lambdaTs: { functionName: "maxproj-lambdaTs", functionArn: "arn:fn" },
        },
      },
    });
    const { pins, problems, json } = convertSpec(v0Fixture("top-mcpRuntimeTools.json"), state);
    expect(problems).toEqual([]);
    expect(pins).toEqual([
      { resourceType: "runtime", name: "agentB", field: "resourceName", value: "maxproj_agentB" },
      {
        resourceType: "runtime-repository",
        name: "agentB",
        field: "repositoryName",
        value: "maxproj/agentb",
      },
      {
        resourceType: "gateway-target-function",
        name: "lambdaTs",
        field: "compute.functionName",
        value: "maxproj-lambdaTs",
      },
      {
        resourceType: "tool-runtime",
        name: "rtTool",
        field: "compute.runtime.resourceName",
        value: "maxproj_rtToolRuntime",
      },
    ]);
    const spec = ProjectSpecSchema.parse(json);
    expect(spec.runtimes.find((r) => r.name === "agentB")?.repositoryName).toBe("maxproj/agentb");
    expect(spec.toolRuntimes?.[0]?.compute.runtime?.resourceName).toBe("maxproj_rtToolRuntime");
    const lambdaTs = spec.agentCoreGateways
      .flatMap((g) => g.targets)
      .find((t) => t.name === "lambdaTs")?.compute;
    expect(lambdaTs?.host === "Lambda" && lambdaTs.functionName).toBe("maxproj-lambdaTs");
  });

  test("pins a deployed gateway target's AgentCore Runtime", () => {
    const state = recorded({
      mcp: {
        runtimes: {
          mcpRt: {
            runtimeId: "maxproj_rtToolRuntime-abcde12345",
            runtimeArn: "arn:rt",
            runtimeEndpoint: "https://rt",
          },
        },
      },
    });
    const { pins, problems } = convertSpec(
      v0Fixture("gateway-target-mcpServer-agentcoreRuntime-compute.json"),
      state,
    );
    expect(problems).toEqual([]);
    expect(pins).toEqual([
      {
        resourceType: "gateway-target-runtime",
        name: "mcpRt",
        field: "compute.runtime.resourceName",
        value: "maxproj_rtToolRuntime",
      },
    ]);
  });

  test("refuses one Lambda name when targets recorded different ones", () => {
    const state: V0DeployedState = {
      targets: {
        dev: {
          resources: { mcp: { lambdas: { lambdaTs: { functionName: "a", functionArn: "x" } } } },
        },
        prod: {
          resources: { mcp: { lambdas: { lambdaTs: { functionName: "b", functionArn: "y" } } } },
        },
      },
    };
    const { problems } = convertSpec(v0Fixture("top-mcpRuntimeTools.json"), state);
    expect(problems.map((problem) => problem.path)).toEqual(["gateway-target-function lambdaTs"]);
  });

  test("checks the whole recorded ID shape, not just its prefix", () => {
    const state = f1State();
    state.targets.default!.resources!.runtimes!.CompatAAgent!.runtimeId =
      "CompatA_CompatAAgent-short";
    const { problems } = convertSpec(f1(), state);
    expect(problems.map((problem) => problem.path)).toEqual(["runtime CompatAAgent"]);
  });
});

describe("convertSpec harness pins", () => {
  test("blocks a harness v0 created outside CloudFormation", () => {
    const state = f1State();
    delete state.targets.default!.resources!.harnesses!.CompatAHarness!.provisioner;
    const { pins, problems } = convertSpec(f1(), state);
    expect(pins.some((pin) => pin.resourceType === "harness")).toBe(false);
    expect(problems).toEqual([
      {
        file: "agentcore/agentcore.json",
        path: "harness CompatAHarness",
        message:
          "was created outside CloudFormation; remove it with " +
          "'npx @aws/agentcore@0 remove harness CompatAHarness --keep' (or delete it) before migrating",
      },
    ]);
  });

  test("pins the execution role v0 created, checked against the recorded role ARN", () => {
    const { pins, problems } = convertSpec(f1(), f1State(), { CompatAHarness: {} });
    expect(problems).toEqual([]);
    expect(pins).toContainEqual({
      resourceType: "harness-role",
      name: "CompatAHarness",
      field: "roleName",
      value: "CompatA_CompatAHarness",
    });

    const state = f1State();
    state.targets.default!.resources!.harnesses!.CompatAHarness!.roleArn =
      "arn:aws:iam::998846730471:role/Other";
    const mismatched = convertSpec(f1(), state, { CompatAHarness: {} });
    expect(mismatched.problems.map((problem) => problem.path)).toEqual([
      "harness-role CompatAHarness",
    ]);
  });

  test("pins no role for a harness with its own execution role", () => {
    const { pins } = convertSpec(f1(), f1State(), {
      CompatAHarness: { executionRoleArn: "arn:aws:iam::998846730471:role/Mine" },
    });
    expect(pins.some((pin) => pin.resourceType === "harness-role")).toBe(false);
  });

  test("pins the ECR repository of a Dockerfile harness, but not of a prebuilt image", () => {
    const repository = (facts: HarnessFacts) =>
      convertSpec(f1(), f1State(), { CompatAHarness: facts }).pins.find(
        (pin) => pin.resourceType === "harness-repository",
      );
    expect(repository({ dockerfile: "Dockerfile" })).toEqual({
      resourceType: "harness-repository",
      name: "CompatAHarness",
      field: "repositoryName",
      value: "compata/harness-compataharness",
    });
    expect(
      repository({ dockerfile: "Dockerfile", containerUri: "public.ecr.aws/x/y" }),
    ).toBeUndefined();
  });
});

describe("convertSpec dropped fields", () => {
  test("blocks a field v1 drops from a deployed resource, and only warns otherwise", () => {
    // v1 drops a runtime's capacityProviderConfiguration (preflight also blocks it).
    const v0 = v0Fixture("runtime-capacityProviderArn-only.json");
    const deployed: V0DeployedState = {
      targets: {
        default: {
          resources: {
            runtimes: {
              agentB: { runtimeId: "maxproj_agentB-abcde12345", runtimeArn: "a", roleArn: "r" },
            },
          },
        },
      },
    };
    const result = convertSpec(v0, deployed);
    expect(result.deployedChanges).toEqual([
      {
        file: "agentcore/agentcore.json",
        path: "runtimes[agentB].capacityProviderConfiguration",
        message: "v1 drops this field, which changes the deployed resource on the next deploy",
      },
    ]);
    // A credential's usage label never reached AWS, so it only warns.
    expect(result.warnings).toContain(
      "Dropped fields v1 doesn't use: credentials[my-oauth].usage, credentials[gw1-oauth].usage",
    );

    const undeployed = convertSpec(v0, NEVER_DEPLOYED);
    expect(undeployed.deployedChanges).toEqual([]);
    expect(undeployed.warnings[0]).toContain("runtimes[agentB].capacityProviderConfiguration");
  });
});
