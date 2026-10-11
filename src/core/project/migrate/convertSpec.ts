import type {
  MigrationProblem,
  PinnedName,
  PinnedResourceType,
} from "../../../handlers/project/migrate/types";
import { AwsDeploymentTargetsSchema } from "../../../projectSchemas/aws-targets";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import type { V0DeployedState, V0ProjectSpec } from "../../../projectSchemas/v0";
import { PROJECT_SPEC_RELATIVE_PATH } from "../fsUtils";
import { translateV0Spec } from "../legacy/translate";
import { describePath, droppedPaths, problemsFromZodError } from "./issues";

type Json = Record<string, unknown>;

export const AWS_TARGETS_RELATIVE_PATH = "agentcore/aws-targets.json";

export type ConvertedSpec = {
  /** The v1 agentcore.json content: the parsed v1 spec, or the unparsed candidate when it has problems. */
  json: Json;
  pins: PinnedName[];
  warnings: string[];
  /** Why the converted spec doesn't parse as v1 (or a pin can't be trusted); empty when it does. */
  problems: MigrationProblem[];
};

/** The deployed resources a v0 deployed state records, by kind, across every target. */
type DeployedResources = {
  runtimes: Map<string, string[]>;
  memories: Map<string, string[]>;
  evaluators: Map<string, string[]>;
  onlineEvalConfigs: Map<string, string[]>;
  policyEngines: Map<string, string[]>;
  /** Keyed `engine/policy`, as v0 records them. */
  policies: Map<string, string[]>;
  configBundles: Map<string, string[]>;
  harnesses: Map<string, string[]>;
  gateways: Map<string, string[]>;
  /** Credential provider ARNs. */
  credentials: Map<string, string[]>;
};

/**
 * Collects, for every resource any target deployed, the IDs (or ARNs, for
 * credentials) each target recorded. The IDs start with the resource's AWS name,
 * which is how pins are checked against what was actually deployed.
 */
export function deployedResources(state: V0DeployedState): DeployedResources {
  const deployed: DeployedResources = {
    runtimes: new Map(),
    memories: new Map(),
    evaluators: new Map(),
    onlineEvalConfigs: new Map(),
    policyEngines: new Map(),
    policies: new Map(),
    configBundles: new Map(),
    harnesses: new Map(),
    gateways: new Map(),
    credentials: new Map(),
  };
  const add = <T>(
    into: Map<string, string[]>,
    entries: Record<string, T> | undefined,
    id: (entry: T) => string,
  ) => {
    for (const [name, entry] of Object.entries(entries ?? {})) {
      into.set(name, [...(into.get(name) ?? []), id(entry)]);
    }
  };
  for (const { resources } of Object.values(state.targets)) {
    if (!resources) continue;
    add(deployed.runtimes, resources.runtimes, (r) => r.runtimeId);
    add(deployed.memories, resources.memories, (m) => m.memoryId);
    add(deployed.evaluators, resources.evaluators, (e) => e.evaluatorId);
    add(deployed.onlineEvalConfigs, resources.onlineEvalConfigs, (o) => o.onlineEvaluationConfigId);
    add(deployed.policyEngines, resources.policyEngines, (p) => p.policyEngineId);
    add(deployed.policies, resources.policies, (p) => p.policyId);
    add(deployed.configBundles, resources.configBundles, (b) => b.bundleId);
    add(deployed.harnesses, resources.harnesses, (h) => h.harnessId);
    add(deployed.gateways, resources.gateways, (g) => g.gatewayId);
    add(deployed.gateways, resources.mcp?.gateways, (g) => g.gatewayId);
    add(deployed.credentials, resources.credentials, (c) => c.credentialProviderArn);
  }
  return deployed;
}

/**
 * Converts a parsed v0 spec into v1's agentcore.json and pins the AWS names of
 * everything already deployed, so v1 updates those resources in place instead of
 * replacing them. Never throws for a project v0 accepted: anything v1 rejects is
 * returned as a problem with its field path.
 */
export function convertSpec(v0: V0ProjectSpec, state: V0DeployedState): ConvertedSpec {
  const { spec, extras } = translateV0Spec(v0);
  const candidate = spec as unknown as Json;
  const warnings: string[] = [];

  if (extras.unassignedTargets?.length) {
    warnings.push(
      `Dropped unassigned gateway targets (${extras.unassignedTargets.map((t) => t.name).join(", ")}): ` +
        "v1 has no unassigned targets. Add them to a gateway with 'agentcore add gateway-target' if you still need them.",
    );
  }
  if (extras.abTests?.length) {
    warnings.push(
      `Removed abTests (${extras.abTests.map((t) => t.name).join(", ")}) from agentcore.json: ` +
        "v1 doesn't track A/B tests there. They stay in AgentCore; manage them with 'agentcore eval ab-test'.",
    );
  }

  const deployed = deployedResources(state);
  const { pins, problems } = pinDeployedNames(v0.name, candidate, deployed);

  const everDeployed = Object.values(state.targets).some(
    ({ resources }) => resources !== undefined,
  );
  const unrecorded = v0.credentials
    .map((credential) => credential.name)
    .filter((name) => !deployed.credentials.has(name));
  if (everDeployed && unrecorded.length > 0) {
    warnings.push(
      `No deployed provider is recorded for credentials ${unrecorded.join(", ")}, so their names ` +
        "aren't kept: v1 creates a new provider for each target on the next deploy. If v0 did " +
        "create one, set providerName on the credential to its name before deploying.",
    );
  }

  const parsed = ProjectSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      json: candidate,
      pins,
      warnings,
      problems: [
        ...problems,
        ...problemsFromZodError(PROJECT_SPEC_RELATIVE_PATH, candidate, parsed.error),
      ],
    };
  }

  const dropped = droppedPaths(candidate, parsed.data).map((path) => describePath(candidate, path));
  if (dropped.length > 0) {
    warnings.push(`Dropped fields v1 doesn't use: ${dropped.join(", ")}`);
  }
  return { json: parsed.data as unknown as Json, pins, warnings, problems };
}

/**
 * Writes the v0 physical name of every deployed resource into `spec` (mutating it)
 * and checks each against the IDs the targets recorded. A name that doesn't match
 * means v0 named the resource some other way; pinning it would replace the
 * resource, so it is reported as a problem.
 */
function pinDeployedNames(
  project: string,
  spec: Json,
  deployed: DeployedResources,
): { pins: PinnedName[]; problems: MigrationProblem[] } {
  const pins: PinnedName[] = [];
  const problems: MigrationProblem[] = [];
  const list = (key: string) => (spec[key] as Json[] | undefined) ?? [];

  const pin = (
    resourceType: PinnedResourceType,
    name: string,
    target: Json,
    field: string,
    value: string,
    ids: string[] | undefined,
    matches: (id: string) => boolean = (id) => id.startsWith(`${value}-`),
  ): boolean => {
    if (!ids) return false;
    const mismatched = ids.filter((id) => !matches(id));
    if (mismatched.length > 0) {
      problems.push({
        file: PROJECT_SPEC_RELATIVE_PATH,
        path: `${resourceType} ${name}`,
        message:
          `deployed as '${mismatched.join("', '")}', which doesn't match the name ` +
          `'${value}' v0 would have given it, so its name can't be kept safely`,
      });
      return false;
    }
    target[field] = value;
    pins.push({ resourceType, name, field, value });
    return true;
  };

  for (const runtime of list("runtimes")) {
    const name = String(runtime.name);
    pin(
      "runtime",
      name,
      runtime,
      "resourceName",
      `${project}_${name}`,
      deployed.runtimes.get(name),
    );
  }
  for (const memory of list("memories")) {
    const name = String(memory.name);
    pin("memory", name, memory, "resourceName", `${project}_${name}`, deployed.memories.get(name));
  }
  for (const evaluator of list("evaluators")) {
    const name = String(evaluator.name);
    const pinned = pin(
      "evaluator",
      name,
      evaluator,
      "resourceName",
      `${project}_${name}`,
      deployed.evaluators.get(name),
    );
    const managed = (evaluator.config as { codeBased?: { managed?: Json } } | undefined)?.codeBased
      ?.managed;
    // Deployed state records no ID for the function, so it rides on the evaluator's own check.
    if (managed && pinned) {
      const functionName = `${project}-eval-${name}`;
      managed.functionName = functionName;
      pins.push({
        resourceType: "evaluator-function",
        name,
        field: "config.codeBased.managed.functionName",
        value: functionName,
      });
    }
  }
  for (const config of list("onlineEvalConfigs")) {
    const name = String(config.name);
    pin(
      "online-eval",
      name,
      config,
      "resourceName",
      `${project}_${name}`,
      deployed.onlineEvalConfigs.get(name),
    );
  }
  for (const engine of list("policyEngines")) {
    const engineName = String(engine.name);
    pin(
      "policy-engine",
      engineName,
      engine,
      "resourceName",
      `${project}_${engineName}`,
      deployed.policyEngines.get(engineName),
    );
    for (const policy of (engine.policies as Json[] | undefined) ?? []) {
      const name = String(policy.name);
      const key = `${engineName}/${name}`;
      pin("policy", key, policy, "resourceName", name, deployed.policies.get(key));
    }
  }
  for (const bundle of list("configBundles")) {
    const name = String(bundle.name);
    pin(
      "config-bundle",
      name,
      bundle,
      "resourceName",
      `${project}${name}`,
      deployed.configBundles.get(name),
    );
  }
  for (const harness of list("harnesses")) {
    const name = String(harness.name);
    pin(
      "harness",
      name,
      harness,
      "resourceName",
      `${project}_${name}`,
      deployed.harnesses.get(name),
    );
  }
  for (const gateway of list("agentCoreGateways")) {
    const name = String(gateway.name);
    const value =
      typeof gateway.resourceName === "string" ? gateway.resourceName : `${project}-${name}`;
    // Gateway IDs are the lowercased name plus a suffix.
    pin("gateway", name, gateway, "resourceName", value, deployed.gateways.get(name), (id) =>
      id.startsWith(`${value.toLowerCase()}-`),
    );
  }
  for (const credential of list("credentials")) {
    const name = String(credential.name);
    pin(
      "credential",
      name,
      credential,
      "providerName",
      name,
      deployed.credentials.get(name),
      (arn) => arn.endsWith(`/${name}`),
    );
  }
  return { pins, problems };
}

/**
 * v1 validates deployment targets more strictly than v0 (no hyphens in names, no
 * names differing only by case). Target names are part of each target's stack
 * name, so they can't simply be renamed.
 */
export function convertTargets(raw: unknown): MigrationProblem[] {
  const parsed = AwsDeploymentTargetsSchema.safeParse(raw);
  if (parsed.success) return [];
  return problemsFromZodError(AWS_TARGETS_RELATIVE_PATH, raw, parsed.error).map((problem) =>
    /name/i.test(problem.path) || /target name/i.test(problem.message)
      ? {
          ...problem,
          message: `${problem.message}. Renaming a target deploys a new stack, so this project can't be migrated as is.`,
        }
      : problem,
  );
}
