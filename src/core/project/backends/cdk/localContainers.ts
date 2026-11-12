import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { HarnessYamlSchema } from "../../../../projectSchemas/harness";
import type { Project } from "../../../../handlers/project/types";
import { ProjectStateError } from "../../../../errors";
import type { ProcessRunner } from "../../../../io";
export {
  redactValues as buildArgumentRedactor,
  redactError as redactBuildError,
} from "../../../../io/redact";

// A static Linux ELF64 executable for AArch64, with one read/execute segment and
// entry point 0x400078. Its only instructions are:
//   mov x0, #0; mov x8, #93; svc #0  (Linux exit(0))
// It needs no shell, shared libraries, base image, or dependency downloads.
const ARM64_EXECUTION_PROBE = Buffer.from(
  [
    "7f454c460201010000000000000000000200b700010000007800400000000000",
    "4000000000000000000000000000000000000000400038000100000000000000",
    "0100000005000000000000000000000000004000000000000000400000000000",
    "840000000000000084000000000000000010000000000000",
    "000080d2a80b80d2010000d4",
  ].join(""),
  "hex",
);

async function probeArm64Build(
  runner: ProcessRunner,
  cwd: string,
  executable: string,
): Promise<void> {
  // Keep the context alongside the project so VM-backed builders can access it
  // through the same filesystem sharing used for the deployment's image assets.
  const context = mkdtempSync(join(cwd, ".agentcore-arm64-"));
  try {
    // Own the export directory even when a configured wrapper runs as root.
    mkdirSync(join(context, "output"));
    writeFileSync(join(context, "arm64-check"), ARM64_EXECUTION_PROBE);
    writeFileSync(
      join(context, "Dockerfile"),
      'FROM scratch\nCOPY --chmod=0555 arm64-check /arm64-check\nRUN ["/arm64-check"]\n',
    );
    await runner(
      [
        executable,
        "build",
        "--platform",
        "linux/arm64",
        "--network",
        "none",
        "--no-cache",
        "--output",
        "type=local,dest=output",
        "--file",
        "Dockerfile",
        ".",
      ],
      { cwd: context, signal: AbortSignal.timeout(60_000) },
    );
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

export function containerBuildSettings(project: Project) {
  const harnesses = project.spec.harnesses.flatMap((entry) => {
    const path = join(project.rootPath, entry.path, "harness.yaml");
    return existsSync(path) ? [HarnessYamlSchema.parse(parse(readFileSync(path, "utf8")))] : [];
  });
  return {
    builds: Object.fromEntries([
      ...project.spec.runtimes.map((runtime) => [`runtime/${runtime.name}`, runtime.build]),
      ...harnesses.map((harness) => [
        `harness/${harness.name}`,
        harness.build ?? (harness.dockerfile ? "Container" : "Managed"),
      ]),
    ]),
    localRuntimes: project.spec.runtimes.filter((runtime) => runtime.build === "Container-local"),
    localHarnesses: harnesses.filter((harness) => harness.build === "Container-local"),
    buildArgumentValues: [
      ...project.spec.runtimes.flatMap((runtime) =>
        Object.values(runtime.customDockerBuildArgs ?? {}),
      ),
      ...harnesses.flatMap((harness) => Object.values(harness.customDockerBuildArgs ?? {})),
    ],
  };
}

/** Probe the configured builder; never install emulation or provision a builder. */
export async function checkLocalContainerBuilder(
  runner: ProcessRunner,
  cwd: string,
  executable = process.env.CDK_DOCKER || "docker",
): Promise<void> {
  let info = "";
  try {
    await runner([executable, "info", "--format", "{{json .}}"], {
      cwd,
      onOutput: (chunk) => {
        info += chunk;
      },
    });
  } catch {
    throw new ProjectStateError(
      `Cannot access the container builder '${executable}'. Check that it is installed and its daemon is running. ` +
        "CDK_DOCKER can select a Docker-compatible executable.",
    );
  }
  let daemon: { OSType: string; Architecture: string } | undefined;
  // ProcessRunner streams stdout and stderr together. Finch can print startup
  // diagnostics before its single-line --format JSON; those are not daemon data.
  for (const candidate of [info.trim(), ...info.trim().split(/\r?\n/).reverse()]) {
    try {
      const value = JSON.parse(candidate) as Record<string, unknown> | null;
      if (value && typeof value.OSType === "string" && typeof value.Architecture === "string") {
        daemon = { OSType: value.OSType, Architecture: value.Architecture };
        break;
      }
    } catch {
      // Continue looking for the formatted daemon information.
    }
  }
  if (!daemon) {
    throw new ProjectStateError(
      `The container builder '${executable}' returned invalid daemon information.`,
    );
  }
  if (daemon.OSType === "linux" && ["arm64", "aarch64"].includes(daemon.Architecture ?? "")) return;
  let capabilities = "";
  try {
    await runner([executable, "buildx", "inspect"], {
      cwd,
      onOutput: (chunk) => {
        capabilities += chunk;
      },
    });
  } catch {
    // Finch and other Docker-compatible builders need not implement buildx.
    // Verify their actual ARM64 execution support rather than rejecting them.
    capabilities = "";
  }
  const platforms = [...capabilities.matchAll(/^\s*Platforms:\s*(.+)$/gm)].flatMap((match) =>
    match[1]!.split(",").map((platform) => platform.trim().replace(/\*$/, "")),
  );
  if (platforms.includes("linux/arm64") || platforms.includes("linux/arm64/v8")) return;
  try {
    await probeArm64Build(runner, cwd, executable);
  } catch (error) {
    throw new ProjectStateError(
      `Configure Linux ARM64 build support for '${executable}' before deploying Container-local. ` +
        "The uncached, network-free ARM64 test build failed.",
      { cause: error },
    );
  }
}

type TemplateResource = {
  Type?: string;
  Properties?: Record<string, unknown>;
};
export type ContainerTemplate = {
  Metadata?: Record<string, unknown>;
  Resources?: Record<string, TemplateResource>;
  Outputs?: Record<string, { Export?: { Name?: unknown } }>;
};

/**
 * The deployed template is authoritative; editing local configuration or deleting
 * deployed-state.json must not permit a build-mode migration.
 */
export function assertNewLocalWorkloads(
  previous: ContainerTemplate,
  builds: Record<string, string>,
  projectName: string,
  targetName: string | undefined,
): void {
  const recorded = previous.Metadata?.["agentcore:builds"];
  if (
    recorded !== undefined &&
    (typeof recorded !== "object" || recorded === null || Array.isArray(recorded))
  ) {
    throw new ProjectStateError(
      "Cannot verify build modes: the deployed template has invalid build metadata.",
    );
  }
  for (const [key, desired] of Object.entries(builds)) {
    const [kind, name] = key.split("/");
    let deployed = (recorded as Record<string, unknown> | undefined)?.[key];
    if (deployed !== undefined && typeof deployed !== "string") {
      throw new ProjectStateError(`Cannot verify the deployed build mode for ${key}.`);
    }
    if (deployed === undefined) {
      // Templates deployed before this feature have no build metadata. Match the
      // workload's stable physical name, including v0's target-less naming.
      const physicalName = [
        projectName,
        ...(targetName ? [targetName.replace(/-/g, "_")] : []),
        name,
      ].join("_");
      const type =
        kind === "runtime" ? "AWS::BedrockAgentCore::Runtime" : "AWS::BedrockAgentCore::Harness";
      const nameProperty = kind === "runtime" ? "AgentRuntimeName" : "HarnessName";
      const resource = Object.values(previous.Resources ?? {}).find(
        (entry) => entry.Type === type && entry.Properties?.[nameProperty] === physicalName,
      );
      if (resource) {
        // Inspect the image artifact rather than unrelated environment values.
        // This also recognizes the original local-build POC's bootstrap URI.
        const artifact =
          resource.Properties?.[
            kind === "runtime" ? "AgentRuntimeArtifact" : "EnvironmentArtifact"
          ];
        deployed = JSON.stringify(artifact)?.includes("container-assets")
          ? "Container-local"
          : "Container";
      } else if (
        kind === "harness" &&
        Object.values(previous.Outputs ?? {}).some((output) =>
          JSON.stringify(output.Export?.Name)?.includes(
            `-Harness-${name!.replaceAll("_", "-")}-RoleArn`,
          ),
        )
      ) {
        // Old vended apps managed the Harness outside CloudFormation, but its
        // execution role output still identifies an existing deployed workload.
        deployed = "Container";
      } else {
        continue;
      }
    }
    if ((deployed === "Container-local") !== (desired === "Container-local")) {
      throw new ProjectStateError(
        `Cannot change ${key} from ${deployed} to ${desired}. ` +
          "Container-local is supported only for new workloads. " +
          "Keep the deployed build mode or add a workload with a new name; build-mode migration is not supported.",
      );
    }
  }
}
