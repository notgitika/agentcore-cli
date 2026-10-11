import { describe, expect, test } from "bun:test";
import { CredentialSchema } from "./credential";
import { ConfigBundleSchema } from "./config-bundle";
import { EvaluatorSchema } from "./evaluator";
import { HarnessRegistryEntrySchema } from "./harness";
import { MemorySchema } from "./memory";
import { OnlineEvalConfigSchema } from "./online-eval-config";
import { PolicyEngineSchema } from "./policy";
import {
  CredentialProviderNameSchema,
  EcrRepositoryNameSchema,
  IamRoleNameSchema,
  LambdaFunctionNameSchema,
  resourceNameSchema,
} from "./resource-name";
import { AgentCoreGatewaySchema, ToolRuntimeSchema } from "./gateway";
import { ProjectRuntimeSchema } from "./runtime";

describe("resourceNameSchema", () => {
  test.each(["CompatA_CompatAAgent", "a", "A_1"])("accepts AWS-style name %s", (name) => {
    expect(resourceNameSchema(48).safeParse(name).success).toBe(true);
  });

  test.each(["", "1abc", "_abc", "has-hyphen", "has space"])("rejects %p", (name) => {
    expect(resourceNameSchema(48).safeParse(name).success).toBe(false);
  });

  test("enforces the resource type's maximum length", () => {
    expect(resourceNameSchema(40).safeParse(`a${"b".repeat(39)}`).success).toBe(true);
    expect(resourceNameSchema(40).safeParse(`a${"b".repeat(40)}`).success).toBe(false);
  });
});

describe("CredentialProviderNameSchema", () => {
  test.each(["compatA-key", "my_key", "1key", "a"])("accepts Identity-style name %s", (name) => {
    expect(CredentialProviderNameSchema.safeParse(name).success).toBe(true);
  });

  test.each(["", "has space", "dot.name", "x".repeat(129)])("rejects %p", (name) => {
    expect(CredentialProviderNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("LambdaFunctionNameSchema", () => {
  test.each(["proj-eval-judge", "a_b", "1fn"])("accepts Lambda-style name %s", (name) => {
    expect(LambdaFunctionNameSchema.safeParse(name).success).toBe(true);
  });

  test.each(["", "has space", "colon:name", "x".repeat(65)])("rejects %p", (name) => {
    expect(LambdaFunctionNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("EcrRepositoryNameSchema", () => {
  test.each(["proj/agent", "proj/harness-h", "a1", "a.b_c-d/e"])("accepts %s", (name) => {
    expect(EcrRepositoryNameSchema.safeParse(name).success).toBe(true);
  });

  test.each(["Proj/agent", "a", "/a", "a//b", "a/"])("rejects %p", (name) => {
    expect(EcrRepositoryNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("IamRoleNameSchema", () => {
  test.each(["Proj_harness", "a+b=c,d.e@f-g"])("accepts %s", (name) => {
    expect(IamRoleNameSchema.safeParse(name).success).toBe(true);
  });

  test.each(["", "has space", "x".repeat(65)])("rejects %p", (name) => {
    expect(IamRoleNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("pinned names on resources", () => {
  const runtime = {
    name: "agent",
    build: "CodeZip",
    entrypoint: "main.py",
    codeLocation: "app/agent",
    runtimeVersion: "PYTHON_3_13",
  };
  const memory = { name: "mem", eventExpiryDuration: 30 };
  const evaluator = {
    name: "judge",
    level: "TRACE",
    config: { llmAsAJudge: { model: "m", instructions: "i", ratingScale: { numerical: [] } } },
  };
  const onlineEval = { name: "online", agent: "agent", evaluators: ["judge"], samplingRate: 10 };
  const engine = {
    name: "pe",
    policies: [{ name: "pol", statement: "permit(principal, action, resource);" }],
  };
  const bundle = { name: "cb", components: {} };
  const harness = { name: "h", path: "app/h" };

  test.each([
    ["runtime", ProjectRuntimeSchema, runtime, 48],
    ["memory", MemorySchema, memory, 48],
    ["online eval config", OnlineEvalConfigSchema, onlineEval, 48],
    ["config bundle", ConfigBundleSchema, bundle, 100],
    ["harness", HarnessRegistryEntrySchema, harness, 40],
  ] as const)(
    "%s accepts a resourceName within the service maximum",
    (_label, schema, base, max) => {
      expect(schema.safeParse({ ...base, resourceName: `P_${"x".repeat(max - 2)}` }).success).toBe(
        true,
      );
      expect(schema.safeParse({ ...base, resourceName: `P_${"x".repeat(max - 1)}` }).success).toBe(
        false,
      );
      expect(schema.safeParse({ ...base, resourceName: "bad-name" }).success).toBe(false);
    },
  );

  test("evaluator keeps a valid resourceName and rejects an invalid one", () => {
    const parsed = EvaluatorSchema.safeParse({ ...evaluator, resourceName: "Proj_judge" });
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.resourceName).toBe("Proj_judge");
    expect(EvaluatorSchema.safeParse({ ...evaluator, resourceName: "Proj-judge" }).success).toBe(
      false,
    );
  });

  test("managed code-based evaluators take a pinned Lambda functionName", () => {
    const codeBased = {
      ...evaluator,
      config: {
        codeBased: { managed: { codeLocation: "app/eval", functionName: "Proj-eval-judge" } },
      },
    };
    const parsed = EvaluatorSchema.parse(codeBased);
    expect(parsed.config.codeBased?.managed?.functionName).toBe("Proj-eval-judge");
    const invalid = structuredClone(codeBased);
    invalid.config.codeBased.managed.functionName = "Proj eval";
    expect(EvaluatorSchema.safeParse(invalid).success).toBe(false);
  });

  test("Container runtimes take a repositoryName; CodeZip runtimes don't", () => {
    const container = {
      ...runtime,
      build: "Container",
      runtimeVersion: undefined,
      repositoryName: "proj/agent",
    };
    expect(ProjectRuntimeSchema.safeParse(container).success).toBe(true);
    const codeZip = ProjectRuntimeSchema.safeParse({ ...runtime, repositoryName: "proj/agent" });
    expect(codeZip.success).toBe(false);
    expect(codeZip.error?.issues[0]?.message).toBe(
      "repositoryName is only allowed for Container builds",
    );
  });

  test("harness registry entries take a roleName and a repositoryName", () => {
    const parsed = HarnessRegistryEntrySchema.parse({
      ...harness,
      roleName: "Proj_h",
      repositoryName: "proj/harness-h",
    });
    expect(parsed).toMatchObject({ roleName: "Proj_h", repositoryName: "proj/harness-h" });
    expect(
      HarnessRegistryEntrySchema.safeParse({ ...harness, repositoryName: "Proj/H" }).success,
    ).toBe(false);
  });

  test("tool runtimes and gateway-target runtimes take a resourceName; target Lambdas a functionName", () => {
    const codeZip = {
      build: "CodeZip",
      pythonVersion: "PYTHON_3_12",
      name: "toolRuntime",
      entrypoint: "server.py:app",
      codeLocation: "tools/rt",
      resourceName: "Proj_toolRuntime",
    };
    const tool = ToolRuntimeSchema.parse({
      name: "tool",
      toolDefinition: { name: "tool", description: "d", inputSchema: { type: "object" } },
      compute: {
        host: "AgentCoreRuntime",
        implementation: { language: "Python", path: "tools/rt", handler: "server.py:app" },
        runtime: codeZip,
      },
    });
    expect(tool.compute.runtime?.resourceName).toBe("Proj_toolRuntime");
    const gateway = AgentCoreGatewaySchema.parse({
      name: "gw",
      targets: [
        {
          name: "fn",
          targetType: "lambda",
          toolDefinitions: [{ name: "fn", description: "d", inputSchema: { type: "object" } }],
          compute: {
            host: "Lambda",
            implementation: { language: "Python", path: "tools/fn", handler: "handler.main" },
            pythonVersion: "PYTHON_3_12",
            functionName: "Proj-fn",
          },
        },
      ],
    });
    const compute = gateway.targets[0]?.compute;
    expect(compute?.host === "Lambda" && compute.functionName).toBe("Proj-fn");
  });

  test("policy engines and policies take a resourceName", () => {
    const parsed = PolicyEngineSchema.parse({
      ...engine,
      resourceName: "Proj_pe",
      policies: [{ ...engine.policies[0], resourceName: "pol" }],
    });
    expect(parsed.resourceName).toBe("Proj_pe");
    expect(parsed.policies[0]?.resourceName).toBe("pol");
  });

  test.each([
    { authorizerType: "ApiKeyCredentialProvider", name: "key" },
    {
      authorizerType: "OAuthCredentialProvider",
      name: "oauth",
      discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
    },
    { authorizerType: "PaymentCredentialProvider", name: "pay", provider: "CoinbaseCDP" },
  ])("$authorizerType credentials take a providerName", (credential) => {
    const parsed = CredentialSchema.parse({ ...credential, providerName: "bare-name" });
    expect(parsed.providerName).toBe("bare-name");
    expect(CredentialSchema.safeParse({ ...credential, providerName: "bad name" }).success).toBe(
      false,
    );
  });
});
