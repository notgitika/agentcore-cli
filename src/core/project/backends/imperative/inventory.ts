import type { Project } from "../../../../handlers/project/types";
import { stepName, type ResourceKind } from "./naming";
import type { ImperativeState } from "./state";

export type DeclaredResource = { kind: ResourceKind; name: string; parent?: string };

/** Child kinds and the kind that owns them. */
export const PARENT_KIND: Partial<Record<ResourceKind, ResourceKind>> = {
  "runtime-endpoint": "runtime",
  "gateway-target": "gateway",
  policy: "policy-engine",
  "payment-connector": "payment-manager",
};

/** Every resource the spec declares, parents before their children, in report order. */
export function declaredResources(spec: Project["spec"]): DeclaredResource[] {
  const out: DeclaredResource[] = [];
  const add = (kind: ResourceKind, name: string, parent?: string) =>
    out.push(parent === undefined ? { kind, name } : { kind, name, parent });

  for (const runtime of spec.runtimes) {
    add("runtime", runtime.name);
    for (const endpoint of Object.keys(runtime.endpoints ?? {})) {
      add("runtime-endpoint", endpoint, runtime.name);
    }
  }
  for (const { name } of spec.harnesses) add("harness", name);
  for (const { name } of spec.memories) add("memory", name);
  for (const { name } of spec.knowledgeBases) add("knowledge-base", name);
  for (const { name } of spec.evaluators) add("evaluator", name);
  for (const { name } of spec.onlineEvalConfigs) add("online-eval", name);
  for (const gateway of spec.agentCoreGateways) {
    add("gateway", gateway.name);
    for (const { name } of gateway.targets ?? []) add("gateway-target", name, gateway.name);
  }
  for (const engine of spec.policyEngines) {
    add("policy-engine", engine.name);
    for (const { name } of engine.policies ?? []) add("policy", name, engine.name);
  }
  for (const { name } of spec.configBundles) add("config-bundle", name);
  for (const manager of spec.payments ?? []) {
    add("payment-manager", manager.name);
    for (const { name } of manager.connectors ?? []) add("payment-connector", name, manager.name);
  }
  return out;
}

/** Everything the ledger says was created, as declared resources. */
export function recordedResources(state: ImperativeState): DeclaredResource[] {
  const out: DeclaredResource[] = [];
  for (const [kind, byKey] of Object.entries(state) as [ResourceKind, Record<string, unknown>][]) {
    for (const key of Object.keys(byKey)) {
      const slash = key.indexOf("/");
      out.push(
        slash < 0
          ? { kind, name: key }
          : { kind, name: key.slice(slash + 1), parent: key.slice(0, slash) },
      );
    }
  }
  return out;
}

/** The ledger key: the name, or `parent/name` for children. */
export function stateKey(resource: DeclaredResource): string {
  return resource.parent === undefined ? resource.name : `${resource.parent}/${resource.name}`;
}

export function stepOf(resource: DeclaredResource): string {
  return stepName(resource.kind, resource.name, resource.parent);
}
