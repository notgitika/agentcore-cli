import {
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  type Change,
  type CloudFormationClient,
  type DescribeChangeSetCommandOutput,
} from "@aws-sdk/client-cloudformation";
import type {
  ChangeSetResourceChange,
  StackVerification,
} from "../../../handlers/project/migrate/types";
import { poll, type PollOptions } from "./refactor";
import { rolesUsedByHarnesses } from "./replacements";
import type { CfnTemplate } from "./templates";
import { templateLocation, type TemplateStore } from "./templateStore";

/** What a change set for a stack is created from. */
export type VerifyStack = {
  target: string;
  stackName: string;
  /** The template the project now synthesizes for the stack. */
  template: CfnTemplate;
  client: CloudFormationClient;
  templates: () => Promise<TemplateStore>;
};

/** CloudFormation's answer for a change set with nothing to do: success for this check. */
const NO_CHANGES = /didn't contain changes|No updates are to be performed/i;

/**
 * Creates (and never executes) a change set that updates `stack` to the template
 * the migrated project synthesizes, and checks that the v1 deploy it previews
 * neither replaces nor removes an AgentCore resource, an ECR repository, or a
 * harness's role. The change set is deleted afterwards either way.
 */
export async function verifyStack(
  stack: VerifyStack,
  options: PollOptions = {},
): Promise<StackVerification> {
  const { client, stackName } = stack;
  const changeSetName = `agentcore-migrate-verify-${Date.now()}`;
  const template = await templateLocation(stack.template, `${stackName}-v1`, stack.templates);
  options.onStep?.(`Previewing the first v1 deploy of ${stackName} (change set)`);
  try {
    await client.send(
      new CreateChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        ChangeSetType: "UPDATE",
        Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"],
        Description: "agentcore migrate: preview of the first v1 deploy; never executed",
        ...template.location,
      }),
    );
    const created = await poll(
      () =>
        client.send(
          new DescribeChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }),
        ),
      (state) => !["CREATE_PENDING", "CREATE_IN_PROGRESS"].includes(state.Status ?? ""),
      { ...options, intervalMs: options.intervalMs ?? 3_000 },
    );
    if (created.Status !== "CREATE_COMPLETE") {
      if (NO_CHANGES.test(created.StatusReason ?? "")) {
        return { target: stack.target, stackName, changeSetName, changes: [], problems: [] };
      }
      return {
        target: stack.target,
        stackName,
        changeSetName,
        changes: [],
        problems: [
          `CloudFormation couldn't create the change set (${created.Status ?? "UNKNOWN"}): ` +
            `${created.StatusReason ?? "no reason given"}`,
        ],
      };
    }
    const changes = await allChanges(client, stackName, changeSetName, created);
    const harnessRoles = rolesUsedByHarnesses(stack.template);
    const replaced = replacedIds(changes);
    return {
      target: stack.target,
      stackName,
      changeSetName,
      changes,
      problems: changes.flatMap((change) => problemWith(change, harnessRoles, replaced)),
    };
  } finally {
    await client
      .send(new DeleteChangeSetCommand({ StackName: stackName, ChangeSetName: changeSetName }))
      .catch(() => {
        // Never created, or already gone; an unexecuted change set changes nothing anyway.
      });
    await template.release();
  }
}

async function allChanges(
  client: CloudFormationClient,
  stackName: string,
  changeSetName: string,
  first: DescribeChangeSetCommandOutput,
): Promise<ChangeSetResourceChange[]> {
  const changes: Change[] = [...(first.Changes ?? [])];
  let token = first.NextToken;
  while (token) {
    const page = await client.send(
      new DescribeChangeSetCommand({
        StackName: stackName,
        ChangeSetName: changeSetName,
        NextToken: token,
      }),
    );
    changes.push(...(page.Changes ?? []));
    token = page.NextToken;
  }
  return changes.flatMap(({ ResourceChange: change }) =>
    change?.LogicalResourceId && change.Action
      ? [
          {
            logicalId: change.LogicalResourceId,
            type: change.ResourceType ?? "UNKNOWN",
            action: change.Action,
            ...(change.Replacement && { replacement: change.Replacement }),
            ...(change.Replacement === "Conditional" && {
              recreatedBy: (change.Details ?? []).flatMap((detail) =>
                detail.Target?.RequiresRecreation && detail.Target.RequiresRecreation !== "Never"
                  ? [
                      {
                        property: detail.Target.Name ?? detail.Target.Path ?? "",
                        evaluation: detail.Evaluation ?? "",
                        source: detail.ChangeSource ?? "",
                        ...(detail.CausingEntity && { causingEntity: detail.CausingEntity }),
                      },
                    ]
                  : [],
              ),
            }),
          },
        ]
      : [],
  );
}

/**
 * The logical IDs a change set replaces. CloudFormation calls a replacement
 * Conditional when a create-only property may change; it's real when the
 * property is changed directly (a static evaluation), or when it reads an
 * attribute of a resource that is itself replaced. One that reads a resource
 * updated in place is not: in-place updates keep IDs and ARNs, which is all these
 * references read. Anything else CloudFormation can't decide counts as replaced.
 */
export function replacedIds(changes: ChangeSetResourceChange[]): Set<string> {
  const replaced = new Set(
    changes.filter((change) => change.replacement === "True").map((change) => change.logicalId),
  );
  const conditional = changes.filter((change) => change.replacement === "Conditional");
  for (let progress = true; progress;) {
    progress = false;
    for (const change of conditional) {
      if (replaced.has(change.logicalId)) continue;
      const causes = change.recreatedBy ?? [];
      const real =
        causes.length === 0 ||
        causes.some((cause) => {
          if (cause.evaluation !== "Dynamic") return true;
          if (cause.source !== "ResourceReference" && cause.source !== "ResourceAttribute") {
            return true;
          }
          const source = cause.causingEntity?.split(".")[0];
          return source === undefined || replaced.has(source);
        });
      if (real) {
        replaced.add(change.logicalId);
        progress = true;
      }
    }
  }
  return replaced;
}

/** Resources whose replacement or removal loses an ID, an ARN, data, or images. */
function isKept(change: ChangeSetResourceChange, harnessRoles: ReadonlySet<string>): boolean {
  return (
    change.type.startsWith("AWS::BedrockAgentCore::") ||
    change.type === "AWS::ECR::Repository" ||
    harnessRoles.has(change.logicalId)
  );
}

function problemWith(
  change: ChangeSetResourceChange,
  harnessRoles: ReadonlySet<string>,
  replaced: ReadonlySet<string>,
): string[] {
  if (!isKept(change, harnessRoles)) return [];
  if (change.action === "Remove") {
    return [`${change.type} ${change.logicalId} would be deleted.`];
  }
  if (replaced.has(change.logicalId)) {
    const verb = change.replacement === "True" ? "would" : "might";
    return [`${change.type} ${change.logicalId} ${verb} be replaced, getting a new ID and ARN.`];
  }
  return [];
}
