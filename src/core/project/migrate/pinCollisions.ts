import type { MigrationProblem } from "../../../handlers/project/migrate/types";
import { PROJECT_SPEC_RELATIVE_PATH } from "../fsUtils";
import { describePath } from "./issues";

type Json = Record<string, unknown>;

/** One resource that takes an AWS physical name, pinned or composed. */
type NameEntry = {
  label: string;
  path: (string | number)[];
  pinned?: string;
  /** The segment a composed name ends with. */
  suffix: string;
  /** The composed-name separator; absent when nothing composes a name to collide with. */
  separator?: "_" | "-" | "/";
  /** The resource is named `suffix` verbatim (Cedar policies). */
  verbatim?: boolean;
  /** The service lowercases the name (ECR repositories). */
  lowercase?: boolean;
};

const list = (spec: Json, key: string) => (spec[key] as Json[] | undefined) ?? [];
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * Groups every named resource by the AWS namespace its name lives in. Mirrors the
 * groups the `@aws/agentcore-cdk` library validates pins in, so a pin migrate writes
 * never trips the library's uniqueness check at synth.
 */
function nameGroups(spec: Json): Map<string, NameEntry[]> {
  const named = (kind: string, collection: string, separator: "_" | "-") =>
    list(spec, collection).map((item, i) => ({
      label: `${kind} "${String(item.name)}"`,
      path: [collection, i, "resourceName"],
      pinned: str(item.resourceName),
      suffix: String(item.name),
      separator,
    }));

  const runtimes: NameEntry[] = named("runtime", "runtimes", "_");
  for (const [i, tool] of list(spec, "toolRuntimes").entries()) {
    const runtime = (tool.compute as Json | undefined)?.runtime as Json | undefined;
    if (!runtime) continue;
    runtimes.push({
      label: `tool runtime "${String(tool.name)}"`,
      path: ["toolRuntimes", i, "compute", "runtime", "resourceName"],
      pinned: str(runtime.resourceName),
      suffix: String(runtime.name),
      separator: "_",
    });
  }
  const lambdas: NameEntry[] = [];
  for (const [i, evaluator] of list(spec, "evaluators").entries()) {
    const managed = (evaluator.config as { codeBased?: { managed?: Json } } | undefined)?.codeBased
      ?.managed;
    if (!managed) continue;
    lambdas.push({
      label: `evaluator "${String(evaluator.name)}" Lambda function`,
      path: ["evaluators", i, "config", "codeBased", "managed", "functionName"],
      pinned: str(managed.functionName),
      suffix: `eval-${String(evaluator.name)}`,
      separator: "-",
    });
  }
  for (const [g, gateway] of list(spec, "agentCoreGateways").entries()) {
    for (const [t, target] of ((gateway.targets as Json[] | undefined) ?? []).entries()) {
      const compute = target.compute as Json | undefined;
      const runtime = compute?.runtime as Json | undefined;
      if (compute?.host === "Lambda") {
        lambdas.push({
          label: `gateway target "${String(target.name)}" Lambda function`,
          path: ["agentCoreGateways", g, "targets", t, "compute", "functionName"],
          pinned: str(compute.functionName),
          suffix: String(target.name),
          separator: "-",
        });
      } else if (runtime) {
        runtimes.push({
          label: `gateway target "${String(target.name)}" runtime`,
          path: ["agentCoreGateways", g, "targets", t, "compute", "runtime", "resourceName"],
          pinned: str(runtime.resourceName),
          suffix: String(runtime.name),
          separator: "_",
        });
      }
    }
  }
  const policies: NameEntry[] = list(spec, "policyEngines").flatMap((engine, e) =>
    ((engine.policies as Json[] | undefined) ?? []).map((policy, i) => ({
      label: `policy "${String(policy.name)}" in policy engine "${String(engine.name)}"`,
      path: ["policyEngines", e, "policies", i, "resourceName"],
      pinned: str(policy.resourceName),
      suffix: String(policy.name),
      verbatim: true,
    })),
  );
  const repositories: NameEntry[] = [
    ...list(spec, "runtimes").flatMap((runtime, i) =>
      runtime.build === "Container"
        ? [
            {
              label: `runtime "${String(runtime.name)}" ECR repository`,
              path: ["runtimes", i, "repositoryName"],
              pinned: str(runtime.repositoryName),
              suffix: String(runtime.name),
              separator: "/" as const,
              lowercase: true,
            },
          ]
        : [],
    ),
    ...list(spec, "harnesses").map((harness, i) => ({
      label: `harness "${String(harness.name)}" ECR repository`,
      path: ["harnesses", i, "repositoryName"],
      pinned: str(harness.repositoryName),
      suffix: `harness-${String(harness.name)}`,
      separator: "/" as const,
      lowercase: true,
    })),
  ];
  const roles: NameEntry[] = list(spec, "harnesses").map((harness, i) => ({
    label: `harness "${String(harness.name)}" execution role`,
    path: ["harnesses", i, "roleName"],
    pinned: str(harness.roleName),
    suffix: String(harness.name),
  }));

  return new Map([
    ["runtime", runtimes],
    ["memory", named("memory", "memories", "_")],
    ["evaluator", named("evaluator", "evaluators", "_")],
    ["online eval config", named("online eval config", "onlineEvalConfigs", "_")],
    ["policy engine", named("policy engine", "policyEngines", "_")],
    ["policy", policies],
    ["gateway", named("gateway", "agentCoreGateways", "-")],
    ["harness", named("harness", "harnesses", "_")],
    ["Lambda function", lambdas],
    ["ECR repository", repositories],
    ["IAM role", roles],
  ]);
}

/** Whether `pinned` is a name `entry` composes to, without a target or with any target. */
function isComposedName(pinned: string, project: string, entry: NameEntry): boolean {
  if (entry.verbatim) return pinned === entry.suffix;
  if (entry.separator === undefined) return false;
  const fold = (value: string) => (entry.lowercase ? value.toLowerCase() : value);
  const prefix = fold(`${project}${entry.separator}`);
  const tail = `${entry.separator}${fold(entry.suffix)}`;
  if (pinned === `${prefix}${fold(entry.suffix)}`) return true;
  // Target names are letters and digits.
  return (
    pinned.startsWith(prefix) &&
    pinned.endsWith(tail) &&
    /^[A-Za-z0-9]+$/.test(pinned.slice(prefix.length, pinned.length - tail.length))
  );
}

/**
 * Pins that another pin of the same kind already claims, or that another unpinned
 * resource of that kind composes to on some target. The library rejects both, since
 * two resources would claim one AWS name.
 */
export function pinCollisions(project: string, spec: Json): MigrationProblem[] {
  const problems: MigrationProblem[] = [];
  for (const [kind, entries] of nameGroups(spec)) {
    const pinnedBy = new Map<string, NameEntry>();
    for (const entry of entries) {
      if (entry.pinned === undefined) continue;
      const other =
        pinnedBy.get(entry.pinned) ??
        entries.find(
          (candidate) =>
            candidate !== entry &&
            candidate.pinned === undefined &&
            isComposedName(entry.pinned!, project, candidate),
        );
      if (other) {
        problems.push({
          file: PROJECT_SPEC_RELATIVE_PATH,
          path: describePath(spec, entry.path),
          message:
            `the ${kind} name '${entry.pinned}' kept for ${entry.label} is also the name of ` +
            `${other.label}; rename ${other.label} before migrating`,
        });
      } else {
        pinnedBy.set(entry.pinned, entry);
      }
    }
  }
  return problems;
}
