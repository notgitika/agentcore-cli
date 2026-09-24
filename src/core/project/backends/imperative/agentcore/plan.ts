import type { Project } from "../../../../../handlers/project/types";
import type { Logger } from "../../../../../logging";
import type { AwsClients, AwsCredentials } from "../../../../types";
import {
  declaredResources,
  PARENT_KIND,
  recordedResources,
  stateKey,
  stepOf,
  type DeclaredResource,
} from "../inventory";
import type { ResourceKind } from "../naming";
import { Plan, type Step } from "../plan/plan";
import type { ImperativeState } from "../state";
import { notImplemented, type KindHandlers } from "./notImplemented";
import { AgentCoreStack, type StackScope } from "./stack";

/** The kind registry. Later phases replace entries with real modules. */
export const HANDLERS: Record<ResourceKind, KindHandlers> = {
  runtime: notImplemented("runtime"),
  "runtime-endpoint": notImplemented("runtime-endpoint"),
  harness: notImplemented("harness"),
  memory: notImplemented("memory"),
  "knowledge-base": notImplemented("knowledge-base"),
  evaluator: notImplemented("evaluator"),
  "online-eval": notImplemented("online-eval"),
  gateway: notImplemented("gateway"),
  "gateway-target": notImplemented("gateway-target"),
  "policy-engine": notImplemented("policy-engine"),
  policy: notImplemented("policy"),
  "config-bundle": notImplemented("config-bundle"),
  "payment-manager": notImplemented("payment-manager"),
  "payment-connector": notImplemented("payment-connector"),
};

export type PlanInput = {
  project: Project;
  scope: StackScope;
  clients: AwsClients;
  credentials: AwsCredentials;
  logger: Logger;
  recorded: ImperativeState;
  /** Overrides for tests and for phases that ship kinds incrementally. */
  handlers?: Partial<Record<ResourceKind, KindHandlers>>;
};

export type Plans = {
  stack: AgentCoreStack;
  apply: Plan;
  remove: Plan;
  declared: DeclaredResource[];
  removed: DeclaredResource[];
};

export type PlanBuilder = typeof plan;

type MutableStep = Omit<Step, "next"> & { next: MutableStep[] };

/**
 * When removing, a kind listed here is removed before every kind in its list:
 * an online eval before the runtime and evaluators it watches, a runtime before
 * the memories and gateways it is wired to, a gateway before its policy engine.
 */
const REMOVE_BEFORE: Partial<Record<ResourceKind, ResourceKind[]>> = {
  "online-eval": ["runtime", "evaluator"],
  runtime: ["memory", "gateway"],
  gateway: ["policy-engine"],
};

/**
 * Turns the spec and the ledger into two plans for the engine, like `Plan(...)`
 * in the prior art. `apply` creates or updates everything declared, in
 * dependency order; `remove` deletes what the ledger holds but the spec no longer
 * declares. Both run against the same stack so identifiers flow between steps.
 */
export function plan(input: PlanInput): Plans {
  const { project, scope, recorded } = input;
  const handlers: Record<ResourceKind, KindHandlers> = { ...HANDLERS, ...input.handlers };
  const stack = new AgentCoreStack(scope, input.clients, input.credentials, input.logger, recorded);
  const spec = project.spec;

  const declared = declaredResources(spec);
  const declaredKeys = new Set(declared.map((r) => `${r.kind}:${stateKey(r)}`));
  const removed = recordedResources(recorded).filter(
    (r) => !declaredKeys.has(`${r.kind}:${stateKey(r)}`),
  );

  // apply: one step per declared resource.
  const applySteps = new Map<string, MutableStep>();
  for (const resource of declared) {
    const handler = handlers[resource.kind];
    applySteps.set(stepOf(resource), {
      name: stepOf(resource),
      do: handler.create(stack, resource, spec),
      status: handler.poll(stack, resource, spec),
      next: [],
    });
  }
  const link = (steps: Map<string, MutableStep>, from: string, to: string) => {
    const a = steps.get(from);
    const b = steps.get(to);
    if (a && b && !a.next.includes(b)) a.next.push(b);
  };
  const applyByKind = (kind: ResourceKind) => declared.filter((r) => r.kind === kind);

  for (const resource of declared) {
    const parentKind = PARENT_KIND[resource.kind];
    if (parentKind && resource.parent !== undefined) {
      link(applySteps, stepOf({ kind: parentKind, name: resource.parent }), stepOf(resource));
    }
  }
  // Every memory and gateway is wired into every runtime through env vars, so
  // they converge first (Phase 2 reads their ids when it creates the runtime).
  for (const runtime of applyByKind("runtime")) {
    for (const memory of applyByKind("memory")) link(applySteps, stepOf(memory), stepOf(runtime));
    for (const gateway of applyByKind("gateway"))
      link(applySteps, stepOf(gateway), stepOf(runtime));
  }
  for (const gateway of spec.agentCoreGateways) {
    const engine = gateway.policyEngineConfiguration?.policyEngineName;
    if (engine) {
      link(
        applySteps,
        stepOf({ kind: "policy-engine", name: engine }),
        stepOf({ kind: "gateway", name: gateway.name }),
      );
    }
  }
  for (const config of spec.onlineEvalConfigs) {
    const target = stepOf({ kind: "online-eval", name: config.name });
    if (config.agent) link(applySteps, stepOf({ kind: "runtime", name: config.agent }), target);
    // Builtin evaluators have no step; link() ignores names it cannot find.
    for (const evaluator of config.evaluators ?? []) {
      link(applySteps, stepOf({ kind: "evaluator", name: evaluator }), target);
    }
  }

  // remove: one step per orphan; edges point from the thing removed first.
  const removeSteps = new Map<string, MutableStep>();
  for (const resource of removed) {
    const handler = handlers[resource.kind];
    removeSteps.set(stepOf(resource), {
      name: stepOf(resource),
      do: handler.remove(stack, resource),
      status: handler.pollGone(stack, resource),
      next: [],
    });
  }
  for (const resource of removed) {
    const parentKind = PARENT_KIND[resource.kind];
    if (parentKind && resource.parent !== undefined) {
      link(removeSteps, stepOf(resource), stepOf({ kind: parentKind, name: resource.parent }));
    }
    for (const laterKind of REMOVE_BEFORE[resource.kind] ?? []) {
      for (const later of removed.filter((r) => r.kind === laterKind)) {
        link(removeSteps, stepOf(resource), stepOf(later));
      }
    }
  }

  const label = `${project.name}/${scope.targetName}`;
  return {
    stack,
    apply: new Plan(`apply ${label}`, [...applySteps.values()]),
    remove: new Plan(`remove ${label}`, [...removeSteps.values()]),
    declared,
    removed,
  };
}
