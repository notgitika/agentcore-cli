import { describe, expect, test } from "bun:test";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import type { Project } from "../../../../handlers/project/types";
import { declaredResources, recordedResources, stateKey, stepOf } from "./inventory";

/** A parsed spec with the defaults filled in, overlaid with partial collections. */
function spec(overrides: Record<string, unknown>): Project["spec"] {
  return {
    ...ProjectSpecSchema.parse({ name: "Shop", version: 2 }),
    ...overrides,
  } as Project["spec"];
}

describe("declaredResources", () => {
  test("an empty spec declares nothing", () => {
    expect(declaredResources(spec({}))).toEqual([]);
  });

  test("flattens every collection, parents before children, in report order", () => {
    const declared = declaredResources(
      spec({
        runtimes: [{ name: "checkout", endpoints: { live: { version: 1 } } }],
        harnesses: [{ name: "support" }],
        memories: [{ name: "orders" }],
        knowledgeBases: [{ name: "faq" }],
        evaluators: [{ name: "tone" }],
        onlineEvalConfigs: [{ name: "prod_eval" }],
        agentCoreGateways: [{ name: "tools", targets: [{ name: "get_order" }] }],
        policyEngines: [{ name: "guard", policies: [{ name: "no_pii" }] }],
        configBundles: [{ name: "cfg" }],
        payments: [{ name: "pay", connectors: [{ name: "stripe" }] }],
      }),
    );
    expect(declared).toEqual([
      { kind: "runtime", name: "checkout" },
      { kind: "runtime-endpoint", name: "live", parent: "checkout" },
      { kind: "harness", name: "support" },
      { kind: "memory", name: "orders" },
      { kind: "knowledge-base", name: "faq" },
      { kind: "evaluator", name: "tone" },
      { kind: "online-eval", name: "prod_eval" },
      { kind: "gateway", name: "tools" },
      { kind: "gateway-target", name: "get_order", parent: "tools" },
      { kind: "policy-engine", name: "guard" },
      { kind: "policy", name: "no_pii", parent: "guard" },
      { kind: "config-bundle", name: "cfg" },
      { kind: "payment-manager", name: "pay" },
      { kind: "payment-connector", name: "stripe", parent: "pay" },
    ]);
  });
});

describe("recordedResources", () => {
  test("reads kinds and keys back, splitting parent/child keys", () => {
    expect(
      recordedResources({
        memory: { orders: { arn: "a", updatedAt: "t" } },
        "gateway-target": { "tools/get_order": { id: "x", updatedAt: "t" } },
      }),
    ).toEqual([
      { kind: "memory", name: "orders" },
      { kind: "gateway-target", name: "get_order", parent: "tools" },
    ]);
  });
});

describe("keys", () => {
  test("stateKey and stepOf agree with naming.stepName", () => {
    expect(stateKey({ kind: "memory", name: "orders" })).toBe("orders");
    expect(stateKey({ kind: "policy", name: "no_pii", parent: "guard" })).toBe("guard/no_pii");
    expect(stepOf({ kind: "policy", name: "no_pii", parent: "guard" })).toBe("policy:guard/no_pii");
  });
});
