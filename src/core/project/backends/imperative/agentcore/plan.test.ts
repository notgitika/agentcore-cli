import { describe, expect, test } from "bun:test";
import type { Project } from "../../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../../projectSchemas/project";
import { createSilentLogger } from "../../../../../testing";
import type { AwsClients } from "../../../../types";
import type { ImperativeState } from "../state";
import type { KindHandlers } from "./notImplemented";
import { plan, type PlanInput } from "./plan";

function project(overrides: Record<string, unknown>): Project {
  return {
    name: "Shop",
    rootPath: "/tmp/shop",
    spec: {
      ...ProjectSpecSchema.parse({ name: "Shop", version: 2 }),
      ...overrides,
    } as Project["spec"],
  };
}

const noop: KindHandlers = {
  create: () => async () => {},
  poll: () => async () => ({ status: "SUCCESSFUL" }),
  remove: () => async () => {},
  pollGone: () => async () => ({ status: "SUCCESSFUL" }),
};

function input(spec: Record<string, unknown>, recorded: ImperativeState = {}): PlanInput {
  return {
    project: project(spec),
    scope: { projectName: "Shop", targetName: "dev", account: "111122223333", region: "us-east-1" },
    clients: {} as AwsClients,
    credentials: { accessKeyId: "a", secretAccessKey: "b" },
    logger: createSilentLogger(),
    recorded,
    handlers: Object.fromEntries(
      [
        "runtime",
        "runtime-endpoint",
        "harness",
        "memory",
        "knowledge-base",
        "evaluator",
        "online-eval",
        "gateway",
        "gateway-target",
        "policy-engine",
        "policy",
        "config-bundle",
        "payment-manager",
        "payment-connector",
      ].map((kind) => [kind, noop]),
    ),
  };
}

/** `child -> [parents]` from a validated plan, for readable edge assertions. Roots are omitted. */
function parentsOf(p: ReturnType<typeof plan>["apply"]) {
  const validated = p.validate();
  return Object.fromEntries(
    [...validated.parents].filter(([, v]) => v.size > 0).map(([k, v]) => [k, [...v].sort()]),
  );
}

describe("plan", () => {
  test("names the plans after project and target and lists declared resources", () => {
    const plans = plan(input({ memories: [{ name: "m" }] }));
    expect(plans.apply.name).toBe("apply Shop/dev");
    expect(plans.remove.name).toBe("remove Shop/dev");
    expect(plans.declared).toEqual([{ kind: "memory", name: "m" }]);
    expect(plans.removed).toEqual([]);
  });

  test("wires the apply graph: parents before children, memories and gateways before runtimes, policy engine before its gateway, runtime and evaluators before online eval", () => {
    const plans = plan(
      input({
        runtimes: [{ name: "agent", endpoints: { live: { version: 1 } } }],
        memories: [{ name: "m" }],
        evaluators: [{ name: "tone" }],
        onlineEvalConfigs: [
          { name: "oe", agent: "agent", evaluators: ["tone", "Builtin.Helpfulness"] },
        ],
        agentCoreGateways: [
          {
            name: "gw",
            targets: [{ name: "t" }],
            policyEngineConfiguration: { policyEngineName: "pe" },
          },
        ],
        policyEngines: [{ name: "pe", policies: [{ name: "p" }] }],
      }),
    );
    expect(parentsOf(plans.apply)).toEqual({
      "runtime-endpoint:agent/live": ["runtime:agent"],
      "runtime:agent": ["gateway:gw", "memory:m"],
      "gateway-target:gw/t": ["gateway:gw"],
      "gateway:gw": ["policy-engine:pe"],
      "policy:pe/p": ["policy-engine:pe"],
      "online-eval:oe": ["evaluator:tone", "runtime:agent"],
    });
    expect(plans.apply.validate().roots.sort()).toEqual([
      "evaluator:tone",
      "memory:m",
      "policy-engine:pe",
    ]);
  });

  test("the remove plan holds recorded resources the spec dropped, children before parents, dependents before dependencies", () => {
    const plans = plan(
      input(
        { memories: [{ name: "keep" }] },
        {
          memory: { keep: { arn: "k", updatedAt: "t" }, gone: { arn: "g", updatedAt: "t" } },
          runtime: { old: { arn: "r", updatedAt: "t" } },
          gateway: { gw: { arn: "gw", updatedAt: "t" } },
          "gateway-target": { "gw/t": { id: "t", updatedAt: "t" } },
          "online-eval": { oe: { arn: "oe", updatedAt: "t" } },
        },
      ),
    );
    expect(
      plans.removed.map((r) => `${r.kind}:${r.parent ? `${r.parent}/` : ""}${r.name}`).sort(),
    ).toEqual([
      "gateway-target:gw/t",
      "gateway:gw",
      "memory:gone",
      "online-eval:oe",
      "runtime:old",
    ]);
    expect(parentsOf(plans.remove)).toEqual({
      "gateway:gw": ["gateway-target:gw/t", "runtime:old"],
      "memory:gone": ["runtime:old"],
      "runtime:old": ["online-eval:oe"],
    });
  });

  test("the stack is seeded with recorded identifiers", () => {
    const plans = plan(input({}, { memory: { m: { arn: "arn:m", id: "m-1", updatedAt: "t" } } }));
    expect(plans.stack.outputsOf("memory:m")).toEqual({ arn: "arn:m", id: "m-1" });
  });

  test("every declared kind has a handler in the default registry", () => {
    const base = input({ memories: [{ name: "m" }] });
    delete base.handlers;
    expect(() => plan(base)).not.toThrow();
  });
});
