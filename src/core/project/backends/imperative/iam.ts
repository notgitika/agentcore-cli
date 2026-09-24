import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  AttachRolePolicyCommand,
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type IAMClient,
  type Role,
  type Tag,
} from "@aws-sdk/client-iam";
import { ProjectStateError } from "../../../../errors";
import { ownsResource, physicalName, type NamingScope, type ResourceKind } from "./naming";

export const RUNTIME_POLICY_NAME = "AgentCoreRuntimeExecutionPolicy";
const SERVICE_PRINCIPAL = "bedrock-agentcore.amazonaws.com";
const ROLE_NAME_MAX = 64;

export function partitionFor(region: string): string {
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("cn-")) return "aws-cn";
  return "aws";
}

/** `<physical name>_<kind>_role`, truncated (with a digest) so the whole name fits IAM's 64. */
export function executionRoleName(scope: NamingScope, kind: ResourceKind, name: string): string {
  const suffix = `_${kind}_role`;
  return `${physicalName(scope, kind, name, ROLE_NAME_MAX - suffix.length)}${suffix}`;
}

export function roleArn(partition: string, account: string, roleName: string): string {
  return `arn:${partition}:iam::${account}:role/${roleName}`;
}

export function trustPolicy(): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Principal: { Service: SERVICE_PRINCIPAL }, Action: "sts:AssumeRole" },
    ],
  });
}

export type RoleSpec = {
  roleName: string;
  description: string;
  tags: Record<string, string>;
  /** Inline policy name → JSON document. */
  inlinePolicies: Record<string, string>;
  managedPolicyArns: string[];
};

const nameOf = (error: unknown) => (error as { name?: string } | undefined)?.name;
const isNoSuchEntity = (error: unknown) => nameOf(error) === "NoSuchEntityException";
const tagsOf = (tags: Tag[] | undefined) =>
  Object.fromEntries((tags ?? []).map((t) => [t.Key ?? "", t.Value]));

async function getRole(iam: IAMClient, roleName: string): Promise<Role | undefined> {
  try {
    return (await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role;
  } catch (error) {
    if (isNoSuchEntity(error)) return undefined;
    throw error;
  }
}

async function listInline(iam: IAMClient, roleName: string): Promise<string[]> {
  const names: string[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.send(
      new ListRolePoliciesCommand({ RoleName: roleName, Marker: marker }),
    );
    names.push(...(page.PolicyNames ?? []));
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return names;
}

async function listAttached(iam: IAMClient, roleName: string): Promise<string[]> {
  const arns: string[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.send(
      new ListAttachedRolePoliciesCommand({ RoleName: roleName, Marker: marker }),
    );
    for (const policy of page.AttachedPolicies ?? []) {
      if (policy.PolicyArn) arns.push(policy.PolicyArn);
    }
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return arns;
}

function assertOwned(scope: NamingScope, roleName: string, tags: Tag[] | undefined): void {
  if (ownsResource(scope, tagsOf(tags))) return;
  throw new ProjectStateError(
    `IAM role '${roleName}' already exists but was not created by project '${scope.projectName}' ` +
      `for target '${scope.targetName}' (its tags do not match). Delete or rename it, or set ` +
      `executionRoleArn in agentcore.json to use it as is.`,
  );
}

/**
 * Creates the role if missing, otherwise checks this scope owns it, then makes
 * its inline and managed policies exactly the spec's. A role without this
 * deploy's ownership tags is never modified.
 */
export async function ensureRole(
  iam: IAMClient,
  scope: NamingScope,
  spec: RoleSpec,
): Promise<{ arn: string; created: boolean }> {
  let role = await getRole(iam, spec.roleName);
  let created = false;
  if (role) {
    assertOwned(scope, spec.roleName, role.Tags);
  } else {
    role = (
      await iam.send(
        new CreateRoleCommand({
          RoleName: spec.roleName,
          AssumeRolePolicyDocument: trustPolicy(),
          Description: spec.description,
          Tags: Object.entries(spec.tags).map(([Key, Value]) => ({ Key, Value })),
        }),
      )
    ).Role;
    created = true;
  }
  for (const [PolicyName, PolicyDocument] of Object.entries(spec.inlinePolicies)) {
    await iam.send(
      new PutRolePolicyCommand({ RoleName: spec.roleName, PolicyName, PolicyDocument }),
    );
  }
  for (const name of await listInline(iam, spec.roleName)) {
    if (!(name in spec.inlinePolicies)) {
      await iam.send(new DeleteRolePolicyCommand({ RoleName: spec.roleName, PolicyName: name }));
    }
  }
  const attached = new Set(await listAttached(iam, spec.roleName));
  for (const arn of spec.managedPolicyArns) {
    if (!attached.has(arn)) {
      await iam.send(new AttachRolePolicyCommand({ RoleName: spec.roleName, PolicyArn: arn }));
    }
  }
  for (const arn of attached) {
    if (!spec.managedPolicyArns.includes(arn)) {
      await iam.send(new DetachRolePolicyCommand({ RoleName: spec.roleName, PolicyArn: arn }));
    }
  }
  const arn = role?.Arn;
  if (!arn) throw new Error(`IAM returned no ARN for role '${spec.roleName}'`);
  return { arn, created };
}

/** JSON with object keys sorted, so two equal policy documents compare equal as strings. */
function canonical(json: string): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)]),
      );
    }
    return value;
  };
  return JSON.stringify(sort(JSON.parse(json)));
}

/** undefined when the live role matches `spec`; otherwise one line saying what differs. Read-only. */
export async function roleDrift(
  iam: IAMClient,
  scope: NamingScope,
  spec: RoleSpec,
): Promise<string | undefined> {
  const role = await getRole(iam, spec.roleName);
  if (!role) return `role ${spec.roleName} does not exist`;
  assertOwned(scope, spec.roleName, role.Tags);
  const inline = new Set(await listInline(iam, spec.roleName));
  for (const [name, desired] of Object.entries(spec.inlinePolicies)) {
    if (!inline.has(name)) return `inline policy ${name} is missing`;
    const live =
      (await iam.send(new GetRolePolicyCommand({ RoleName: spec.roleName, PolicyName: name })))
        .PolicyDocument ?? "";
    // IAM returns policy documents URL-encoded.
    if (canonical(decodeURIComponent(live)) !== canonical(desired)) {
      return `inline policy ${name} differs`;
    }
  }
  for (const name of inline) {
    if (!(name in spec.inlinePolicies)) return `inline policy ${name} is not declared`;
  }
  const attached = [...(await listAttached(iam, spec.roleName))].sort();
  const want = [...spec.managedPolicyArns].sort();
  if (JSON.stringify(attached) !== JSON.stringify(want)) return `managed policies differ`;
  return undefined;
}

/** Deletes the role only if it carries this scope's ownership tags. Missing role is a no-op. */
export async function deleteRole(
  iam: IAMClient,
  scope: NamingScope,
  roleName: string,
): Promise<void> {
  const role = await getRole(iam, roleName);
  if (!role || !ownsResource(scope, tagsOf(role.Tags))) return;
  for (const name of await listInline(iam, roleName)) {
    await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: name }));
  }
  for (const arn of await listAttached(iam, roleName)) {
    await iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: arn }));
  }
  try {
    await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
  } catch (error) {
    if (!isNoSuchEntity(error)) throw error;
  }
}

/** L3 memory-actions.ts: read, write, and the two namespace-scoped actions. */
const MEMORY_ACTIONS = [
  "bedrock-agentcore:GetEvent",
  "bedrock-agentcore:GetMemory",
  "bedrock-agentcore:GetMemoryRecord",
  "bedrock-agentcore:ListActors",
  "bedrock-agentcore:ListEvents",
  "bedrock-agentcore:ListSessions",
  "bedrock-agentcore:CreateEvent",
  "bedrock-agentcore:DeleteEvent",
  "bedrock-agentcore:DeleteMemoryRecord",
  "bedrock-agentcore:ListMemoryRecords",
  "bedrock-agentcore:RetrieveMemoryRecords",
];

/**
 * The runtime execution role's inline policy: the statements the L3
 * AgentCoreRuntime construct grants, plus full access to each memory in the
 * project. Memory access is not namespace-scoped (L3 adds StringLike
 * conditions per strategy namespace).
 */
export function runtimeExecutionPolicy({
  partition,
  region,
  account,
  memoryArns,
}: {
  partition: string;
  region: string;
  account: string;
  memoryArns: string[];
}): string {
  const statements: Record<string, unknown>[] = [
    {
      Sid: "BedrockModelInvocation",
      Effect: "Allow",
      Action: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:CountTokens",
      ],
      Resource: [
        `arn:${partition}:bedrock:*::foundation-model/*`,
        `arn:${partition}:bedrock:*:${account}:inference-profile/*`,
      ],
    },
    {
      Sid: "XRay",
      Effect: "Allow",
      Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
      Resource: "*",
    },
    {
      Sid: "DescribeLogGroups",
      Effect: "Allow",
      Action: ["logs:DescribeLogGroups"],
      Resource: "*",
    },
    {
      Sid: "CloudWatchLogs",
      Effect: "Allow",
      Action: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:DescribeLogStreams",
        "logs:PutLogEvents",
        "logs:GetLogEvents",
        "logs:FilterLogEvents",
        "logs:PutResourcePolicy",
      ],
      Resource: [
        `arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
      ],
    },
    {
      Sid: "ConfigurationBundles",
      Effect: "Allow",
      Action: [
        "bedrock-agentcore:GetConfigurationBundle",
        "bedrock-agentcore:GetConfigurationBundleVersion",
        "bedrock-agentcore:ListConfigurationBundles",
        "bedrock-agentcore:ListConfigurationBundleVersions",
        "bedrock-agentcore:CreateConfigurationBundle",
        "bedrock-agentcore:UpdateConfigurationBundle",
        "bedrock-agentcore:DeleteConfigurationBundle",
      ],
      Resource: [`arn:${partition}:bedrock-agentcore:*:*:configuration-bundle/*`],
    },
  ];
  if (memoryArns.length > 0) {
    statements.push({
      Sid: "MemoryAccess",
      Effect: "Allow",
      Action: MEMORY_ACTIONS,
      Resource: memoryArns,
    });
  }
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

/**
 * The spec's `additionalPolicies`: `arn:` entries are managed policies to
 * attach, anything else is a JSON policy file relative to the code directory
 * that becomes an inline policy (`Additional1`, `Additional2`, …).
 */
export async function loadAdditionalPolicies(
  entries: string[] | undefined,
  codeDir: string,
): Promise<{ managedPolicyArns: string[]; inlinePolicies: Record<string, string> }> {
  const managedPolicyArns: string[] = [];
  const inlinePolicies: Record<string, string> = {};
  let index = 0;
  for (const entry of entries ?? []) {
    if (entry.startsWith("arn:")) {
      managedPolicyArns.push(entry);
      continue;
    }
    const path = isAbsolute(entry) ? entry : resolve(codeDir, entry);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      throw new ProjectStateError(`additionalPolicies entry '${entry}' was not found at ${path}`);
    }
    try {
      JSON.parse(text);
    } catch {
      throw new ProjectStateError(
        `additionalPolicies entry '${entry}' at ${path} is not valid JSON`,
      );
    }
    inlinePolicies[`Additional${++index}`] = text;
  }
  return { managedPolicyArns, inlinePolicies };
}

const PROPAGATION = /role|assume|not authorized/i;
const RETRYABLE = new Set(["ValidationException", "AccessDeniedException"]);

/**
 * A role created seconds ago may not be assumable by the service yet; the
 * service reports that as a validation or access-denied error mentioning the
 * role. Retries only that, `attempts` times, `delayMs` apart.
 */
export async function withRolePropagationRetry<T>(
  fn: () => Promise<T>,
  {
    attempts = 12,
    delayMs = 5000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  }: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (
        attempt >= attempts ||
        !RETRYABLE.has(nameOf(error) ?? "") ||
        !PROPAGATION.test(message)
      ) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}
