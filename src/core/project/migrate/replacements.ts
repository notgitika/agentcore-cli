import type {
  StackChangeSeverity,
  StackResource,
  StackResourceChange,
} from "../../../handlers/project/migrate/types";
import {
  CDK_METADATA_TYPE,
  isCustomResource,
  referencesIn,
  resourcesOf,
  substituteReferences,
  type CfnResource,
  type CfnTemplate,
} from "./templates";

/** What the first v1 deploy after the refactor does to the stack's resources. */
export type DeployImpact = {
  added: StackResource[];
  removed: StackResourceChange[];
  replaced: StackResourceChange[];
};

const AGENTCORE_TYPE_PREFIX = "AWS::BedrockAgentCore::";

/**
 * Types whose replacement loses something the migration promises to keep, beyond
 * AgentCore resources: a container runtime's ECR repository holds its images and
 * its pinned name.
 */
const KEPT_TYPES = new Set(["AWS::ECR::Repository"]);

/**
 * Custom resources whose provider does nothing worth keeping on delete: CDK's
 * JSON helper, and the container build trigger, whose recreation just rebuilds
 * the image.
 */
function isHarmlessCustomResource(logicalId: string, type: string): boolean {
  return type === "Custom::AWSCDKCfnJson" || /ContainerBuildTrigger/.test(logicalId);
}

type Diff = typeof import("@aws-cdk/cloudformation-diff");

/**
 * Compares the bridge template (the deployed stack once the refactor has moved
 * it) with the v1 template, the way `cdk diff` does, and reports what the first
 * v1 deploy would create, delete, and replace. Replacement comes from the AWS
 * resource specification: a change to a create-only property replaces the
 * resource. A replaced resource gets a new physical ID, so a resource that reads
 * that ID in a create-only property is replaced too; those are found by diffing
 * each referencing resource against itself with the reference changed.
 */
export async function deployImpact(bridge: CfnTemplate, v1: CfnTemplate): Promise<DeployImpact> {
  // Loaded on first use: the diff library reads a large resource database.
  const diff = await import("@aws-cdk/cloudformation-diff");
  const { ResourceImpact } = diff;
  const impact: DeployImpact = { added: [], removed: [], replaced: [] };
  const harnessRoles = rolesUsedByHarnesses(bridge, v1);
  const replacedIds = new Set<string>();

  diff.fullDiff(bridge, v1).resources.forEachDifference((logicalId, change) => {
    const oldType = change.oldResourceType;
    const newType = change.newResourceType;
    if ((oldType ?? newType) === CDK_METADATA_TYPE) return;
    if (oldType !== undefined && newType !== undefined && oldType !== newType) {
      // v1 reuses the logical ID for another kind of resource: the deployed one is
      // deleted and a new one created, whatever the diff calls it.
      impact.removed.push(removal(logicalId, oldType, false));
      impact.added.push({ logicalId, type: newType });
    } else if (change.isAddition) {
      impact.added.push({ logicalId, type: newType! });
    } else if (change.isRemoval) {
      impact.removed.push(
        removal(logicalId, oldType!, change.changeImpact === ResourceImpact.WILL_ORPHAN),
      );
    } else if (isReplacement(diff, change.changeImpact)) {
      const properties = Object.entries(change.propertyUpdates)
        .filter(([, update]) => isReplacement(diff, update.changeImpact))
        .map(([name]) => name);
      replacedIds.add(logicalId);
      impact.replaced.push(
        replacement(logicalId, newType!, {
          because: properties.length === 0 ? "" : ` because ${changes(properties)}`,
          conditional: change.changeImpact === ResourceImpact.MAY_REPLACE,
          harnessRole: harnessRoles.has(logicalId),
        }),
      );
    }
  });

  // Follow replacements through references until nothing more is replaced.
  const v1Resources = resourcesOf(v1);
  const bridgeIds = new Set(Object.keys(resourcesOf(bridge)));
  for (let progress = true; progress;) {
    progress = false;
    for (const [logicalId, resource] of Object.entries(v1Resources)) {
      if (replacedIds.has(logicalId) || !bridgeIds.has(logicalId)) continue;
      const cause = referencesIn(resource.Properties ?? {}, (id) => replacedIds.has(id))[0];
      if (!cause) continue;
      const probe = cascadeProbe(diff, logicalId, resource, replacedIds);
      if (!probe) continue;
      replacedIds.add(logicalId);
      impact.replaced.push(
        replacement(logicalId, resource.Type, {
          because: ` because it references ${cause.target}, which is replaced`,
          conditional: probe === "may",
          harnessRole: harnessRoles.has(logicalId),
        }),
      );
      progress = true;
    }
  }
  return impact;
}

function isReplacement(diff: Diff, impact: string | undefined): boolean {
  return impact === diff.ResourceImpact.WILL_REPLACE || impact === diff.ResourceImpact.MAY_REPLACE;
}

/**
 * Whether a new physical ID for any of `replacedIds` replaces `resource`: diffs
 * the resource against itself with those references changed from one stand-in
 * value to another, so the resource specification decides.
 */
function cascadeProbe(
  diff: Diff,
  logicalId: string,
  resource: CfnResource,
  replacedIds: ReadonlySet<string>,
): "will" | "may" | undefined {
  const isReplaced = (id: string) => replacedIds.has(id);
  const before = substituteReferences(resource, isReplaced, "physical-id-before");
  const after = substituteReferences(resource, isReplaced, "physical-id-after");
  const change = diff
    .fullDiff({ Resources: { [logicalId]: before } }, { Resources: { [logicalId]: after } })
    .resources.get(logicalId);
  if (change?.changeImpact === diff.ResourceImpact.WILL_REPLACE) return "will";
  if (change?.changeImpact === diff.ResourceImpact.MAY_REPLACE) return "may";
  return undefined;
}

/** IAM roles a harness runs as, in either template; a harness role keeps its pinned name. */
export function rolesUsedByHarnesses(...templates: CfnTemplate[]): Set<string> {
  const roles = new Set<string>();
  for (const template of templates) {
    const resources = resourcesOf(template);
    for (const resource of Object.values(resources)) {
      if (resource.Type !== "AWS::BedrockAgentCore::Harness") continue;
      const isRole = (id: string) => resources[id]?.Type === "AWS::IAM::Role";
      for (const ref of referencesIn(resource.Properties ?? {}, isRole)) roles.add(ref.target);
    }
  }
  return roles;
}

function changes(properties: string[]): string {
  return `${properties.join(", ")} ${properties.length === 1 ? "changes" : "change"}`;
}

function removal(logicalId: string, type: string, retained: boolean): StackResourceChange {
  const change = (severity: StackChangeSeverity, reason: string) => ({
    logicalId,
    type,
    severity,
    reason,
  });
  if (type.startsWith(AGENTCORE_TYPE_PREFIX) || KEPT_TYPES.has(type)) {
    return change(
      "blocker",
      retained
        ? "the v1 template has no counterpart; it's retained, so the v1 deploy leaves it in the account outside the stack, where v1 no longer manages it"
        : "the v1 template has no counterpart, so the v1 deploy would delete it",
    );
  }
  if (retained) {
    return change(
      "info",
      "the v1 template no longer declares it; it's retained, so it stays in the account outside the stack",
    );
  }
  if (isCustomResource(type)) {
    return isHarmlessCustomResource(logicalId, type)
      ? change(
          "info",
          "custom resources can't be moved; the v1 deploy recreates it under its v1 logical ID",
        )
      : change(
          "warning",
          "custom resources can't be moved; the v1 deploy deletes it (running its provider's delete) and creates its v1 counterpart",
        );
  }
  return change("warning", "the v1 template has no counterpart, so the v1 deploy deletes it");
}

function replacement(
  logicalId: string,
  type: string,
  details: { because: string; conditional: boolean; harnessRole: boolean },
): StackResourceChange {
  const verb = details.conditional ? "may replace" : "replaces";
  const change = (severity: StackChangeSeverity, consequence: string) => ({
    logicalId,
    type,
    severity,
    reason: `the v1 deploy ${verb} it${details.because}; ${consequence}`,
  });
  if (type.startsWith(AGENTCORE_TYPE_PREFIX)) {
    return change("blocker", "its ID, ARN, and data would be lost");
  }
  if (type === "AWS::ECR::Repository") {
    return change("blocker", "its images and repository URI would be lost");
  }
  if (details.harnessRole) {
    return change("blocker", "the harness's role would get a new name and ARN");
  }
  if (isCustomResource(type)) {
    return change("warning", "its provider runs again");
  }
  return change("warning", "resources that use it are updated to the new one");
}
