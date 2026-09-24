import { ProjectStateError } from "../../../../errors";
import type { DeployableResource } from "../../../../handlers/project/types";

/**
 * Every resource the imperative backend creates by itself. Credential providers
 * are excluded: the shared provisioner from `backends/shared/credentials.ts`
 * owns them for both backends.
 */
export type ResourceKind = Exclude<DeployableResource, "credential">;

export type NamingScope = { projectName: string; targetName: string };

export const PROJECT_TAG = "agentcore:project-name";
export const TARGET_TAG = "agentcore:target-name";
export const MANAGED_BY_TAG = "agentcore:managed-by";
export const MANAGED_BY_VALUE = "imperative";

/** Kinds whose service-side name pattern allows hyphens but not underscores. */
const HYPHENATED_KINDS: ReadonlySet<ResourceKind> = new Set(["gateway", "gateway-target"]);

/** FNV-1a over UTF-16 code units, hex, six characters: stable across runs and platforms. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * The name a resource carries in AWS: `<project><sep><target><sep><name>`, where
 * `sep` is `_` except for gateway kinds, which use `-`. The other separator is
 * rewritten so the result matches the kind's name pattern. When `maxLength` is
 * given and the full name is longer, the tail is replaced by `<sep><digest>` of
 * the full name, so two long names never collide and the head stays readable.
 */
export function physicalName(
  scope: NamingScope,
  kind: ResourceKind,
  name: string,
  maxLength?: number,
): string {
  const separator = HYPHENATED_KINDS.has(kind) ? "-" : "_";
  const other = separator === "-" ? "_" : "-";
  const full = [scope.projectName, scope.targetName, name]
    .map((part) => part.replaceAll(other, separator))
    .join(separator);
  if (maxLength === undefined || full.length <= maxLength) return full;
  const suffix = `${separator}${digest(full)}`;
  if (maxLength <= suffix.length) {
    throw new Error(
      `physicalName: maxLength ${maxLength} is too short to hold the ${suffix.length}-character digest suffix`,
    );
  }
  return `${full.slice(0, maxLength - suffix.length)}${suffix}`;
}

/**
 * Refuses declared resources of one kind (and one parent) whose physical names
 * coincide, e.g. gateway targets `a_b` and `a-b`: they would silently converge
 * on one AWS resource.
 */
export function assertDistinctPhysicalNames(
  scope: NamingScope,
  resources: readonly { kind: ResourceKind; name: string; parent?: string }[],
): void {
  const seen = new Map<string, string>();
  for (const { kind, name, parent } of resources) {
    const physical = physicalName(scope, kind, name);
    const label = parent === undefined ? name : `${parent}/${name}`;
    const key = `${kind}\0${parent ?? ""}\0${physical}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      throw new ProjectStateError(
        `Project '${scope.projectName}' declares ${kind} '${earlier}' and '${label}', which both ` +
          `deploy as '${physical}' because '-' and '_' are interchangeable in AWS names. ` +
          `Rename one of them.`,
      );
    }
    seen.set(key, label);
  }
}

export function ownershipTags(scope: NamingScope): Record<string, string> {
  return {
    [PROJECT_TAG]: scope.projectName,
    [TARGET_TAG]: scope.targetName,
    [MANAGED_BY_TAG]: MANAGED_BY_VALUE,
  };
}

/** True when a live resource's tags say this project and target created it. */
export function ownsResource(
  scope: NamingScope,
  tags: Record<string, string | undefined> | undefined,
): boolean {
  if (!tags) return false;
  return Object.entries(ownershipTags(scope)).every(([key, value]) => tags[key] === value);
}

/** `kind:name` for top-level resources, `kind:parent/name` for children. */
export function stepName(kind: ResourceKind, name: string, parent?: string): string {
  return parent === undefined ? `${kind}:${name}` : `${kind}:${parent}/${name}`;
}

export function parseStepName(step: string): { kind: ResourceKind; name: string; parent?: string } {
  const colon = step.indexOf(":");
  if (colon <= 0) throw new Error(`'${step}' is not a resource step name`);
  const kind = step.slice(0, colon) as ResourceKind;
  const rest = step.slice(colon + 1);
  const slash = rest.indexOf("/");
  return slash < 0
    ? { kind, name: rest }
    : { kind, name: rest.slice(slash + 1), parent: rest.slice(0, slash) };
}
