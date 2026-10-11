import { describe, expect, test } from "bun:test";
import { CredentialSchema } from "./credential";
import { ConfigBundleSchema } from "./config-bundle";
import { EvaluatorSchema } from "./evaluator";
import { HarnessRegistryEntrySchema } from "./harness";
import { MemorySchema } from "./memory";
import { OnlineEvalConfigSchema } from "./online-eval-config";
import { PolicyEngineSchema } from "./policy";
import { CredentialProviderNameSchema, resourceNameSchema } from "./resource-name";
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
