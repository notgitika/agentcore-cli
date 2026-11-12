import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { HarnessYamlSchema } from "../../../../projectSchemas/harness";
import type { Project } from "../../../../handlers/project/types";
import { ProjectStateError } from "../../../../errors";

/** How a workload's code reaches AgentCore. `Managed` is a Harness without a Dockerfile. */
export type WorkloadBuild = "CodeZip" | "Container" | "ContainerLocal" | "Managed";

/** Build mode of every runtime and harness, keyed `runtime/<name>` or `harness/<name>`. */
export function workloadBuilds(project: Project): Record<string, WorkloadBuild> {
  const builds: Record<string, WorkloadBuild> = {};
  for (const runtime of project.spec.runtimes) builds[`runtime/${runtime.name}`] = runtime.build;
  for (const entry of project.spec.harnesses) {
    const path = join(project.rootPath, entry.path, "harness.yaml");
    if (!existsSync(path)) continue;
    const harness = HarnessYamlSchema.parse(parse(readFileSync(path, "utf8")));
    builds[`harness/${harness.name}`] =
      harness.build ?? (harness.dockerfile ? "Container" : "Managed");
  }
  return builds;
}

export function hasLocalContainerBuilds(builds: Record<string, WorkloadBuild>): boolean {
  return Object.values(builds).includes("ContainerLocal");
}

type TemplateResource = { Type?: string; Properties?: Record<string, unknown> };
export type DeployedTemplate = {
  Metadata?: Record<string, unknown>;
  Resources?: Record<string, TemplateResource>;
  Outputs?: Record<string, { Export?: { Name?: unknown } }>;
};

/**
 * Finds the build mode a workload was deployed with. Templates synthesized by a
 * CDK package that supports ContainerLocal record it in `agentcore:builds`. Older
 * templates predate ContainerLocal, so a workload found in them is either a
 * container image (Container) or not. Returns undefined when it was not deployed.
 */
function deployedBuild(
  template: DeployedTemplate,
  recorded: Record<string, unknown> | undefined,
  key: string,
  projectName: string,
  targetName: string | undefined,
): string | undefined {
  const value = recorded?.[key];
  if (value !== undefined) {
    if (typeof value !== "string") {
      throw new ProjectStateError(`Cannot verify the deployed build mode for ${key}.`);
    }
    return value;
  }

  const [kind, name] = key.split("/") as [string, string];
  // Physical names are <project>_<target>_<name>; v0 projects omit the target.
  const physicalName = [
    projectName,
    ...(targetName ? [targetName.replace(/-/g, "_")] : []),
    name,
  ].join("_");
  const [type, nameProperty] =
    kind === "runtime"
      ? ["AWS::BedrockAgentCore::Runtime", "AgentRuntimeName"]
      : ["AWS::BedrockAgentCore::Harness", "HarnessName"];
  const found = Object.values(template.Resources ?? {}).find(
    (resource) => resource.Type === type && resource.Properties?.[nameProperty] === physicalName,
  );
  if (found) {
    const artifact = found.Properties?.[
      kind === "runtime" ? "AgentRuntimeArtifact" : "EnvironmentArtifact"
    ] as { ContainerConfiguration?: unknown } | undefined;
    if (artifact?.ContainerConfiguration !== undefined) return "Container";
    return kind === "runtime" ? "CodeZip" : "Managed";
  }

  // Older vended apps managed the Harness outside CloudFormation; its execution
  // role output still identifies a deployed workload. Its image source is not in
  // the template, so assume a container build and fail closed.
  if (kind === "harness") {
    const roleExport = `-Harness-${name.replaceAll("_", "-")}-RoleArn`;
    const legacyHarness = Object.values(template.Outputs ?? {}).some((output) =>
      JSON.stringify(output.Export?.Name)?.includes(roleExport),
    );
    if (legacyHarness) return "Container";
  }
  return undefined;
}

/**
 * Rejects switching a deployed workload between Container (CodeBuild) and
 * ContainerLocal, in either direction. Other changes, such as CodeZip to
 * ContainerLocal, are left to CloudFormation. The deployed
 * template is authoritative: editing agentcore.json or deleting deployed-state.json
 * must not permit a build-mode migration.
 */
export function assertNewLocalWorkloads(
  template: DeployedTemplate,
  builds: Record<string, WorkloadBuild>,
  projectName: string,
  targetName: string | undefined,
): void {
  const recorded = template.Metadata?.["agentcore:builds"];
  if (
    recorded !== undefined &&
    (typeof recorded !== "object" || recorded === null || Array.isArray(recorded))
  ) {
    throw new ProjectStateError(
      "Cannot verify build modes: the deployed template has invalid build metadata.",
    );
  }
  for (const [key, desired] of Object.entries(builds)) {
    const deployed = deployedBuild(
      template,
      recorded as Record<string, unknown> | undefined,
      key,
      projectName,
      targetName,
    );
    if (deployed === undefined) continue;
    const pair = new Set([deployed, desired]);
    if (pair.has("Container") && pair.has("ContainerLocal")) {
      throw new ProjectStateError(
        `Cannot change ${key} from ${deployed} to ${desired}. ` +
          "Switching a deployed workload between Container and ContainerLocal is not supported. " +
          "Keep the deployed build mode or add a workload with a new name.",
      );
    }
  }
}
