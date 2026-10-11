import type { StackMigrationPlan } from "../../../handlers/project/migrate/types";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { buildBridgeTemplate, verifyBridge } from "./bridge";
import { mapLogicalIds, renamesOf, type LogicalIdMapping } from "./mapping";
import { deployImpact } from "./replacements";
import { CDK_METADATA_TYPE, type CfnTemplate } from "./templates";

export type StackPlanInput = {
  target: AwsDeploymentTarget;
  /** The deployed stack's name. */
  stackName: string;
  /** The template the stack was last deployed with. */
  deployed: CfnTemplate;
  /** The v1 app's template for the same target. */
  v1: CfnTemplate;
  /** The stack name the v1 app synthesized for the target. */
  v1StackName: string;
};

/** A stack's plan, with what applying it needs. */
export type PlannedStack = {
  plan: StackMigrationPlan;
  mapping: LogicalIdMapping;
  /** Logical ID renames the refactor applies. */
  renames: Map<string, string>;
  /** The template the refactor moves the stack to; absent when it couldn't be built. */
  bridge?: CfnTemplate;
};

/**
 * Plans how one stack moves from its deployed v0 template to the v1 template:
 * which resources a stack refactor moves to new logical IDs, the bridge template
 * the refactor applies (verified to change nothing but logical IDs), and what
 * the first v1 deploy after it creates, deletes, and replaces. Reads nothing
 * from AWS; the templates are passed in.
 */
export async function planStack(input: StackPlanInput): Promise<PlannedStack> {
  const { target, stackName, deployed, v1 } = input;
  const mapping = mapLogicalIds(deployed, v1);
  const renames = renamesOf(mapping);
  const plan: StackMigrationPlan = {
    target: target.name,
    account: target.account,
    region: target.region,
    stackName,
    moves: mapping.matches
      .filter((match) => renames.has(match.from))
      .map(({ type, from, to }) => ({ type, from, to })),
    unchanged: mapping.matches.filter(
      (match) => match.from === match.to && match.type !== CDK_METADATA_TYPE,
    ).length,
    added: [],
    removed: [],
    replaced: [],
    blockers: [],
    ready: false,
  };

  if (input.v1StackName !== stackName) {
    plan.blockers.push(
      `The v1 app names this target's stack '${input.v1StackName}', not '${stackName}', so a v1 ` +
        "deploy would create a new stack instead of updating this one.",
    );
  }

  let bridge: CfnTemplate | undefined;
  try {
    bridge = buildBridgeTemplate(deployed, renames);
  } catch (error) {
    plan.blockers.push(`Couldn't build the refactor template: ${(error as Error).message}`);
  }
  if (bridge) {
    plan.blockers.push(
      ...verifyBridge(deployed, bridge, renames).map(
        (problem) => `The refactor template would change more than logical IDs: ${problem}`,
      ),
    );
    const impact = await deployImpact(bridge, v1);
    plan.added = impact.added;
    plan.removed = impact.removed;
    plan.replaced = impact.replaced;
  }

  plan.ready =
    bridge !== undefined &&
    plan.blockers.length === 0 &&
    [...plan.removed, ...plan.replaced].every((change) => change.severity !== "blocker");
  return { plan, mapping, renames, ...(bridge && { bridge }) };
}
