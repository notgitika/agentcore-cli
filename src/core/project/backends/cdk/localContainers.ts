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
  let daemon: { OSType?: string; Architecture?: string };
  try {
    daemon = JSON.parse(info.trim()) as typeof daemon;
  } catch {
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
  Properties?: {
    RepositoryName?: unknown;
    EncryptionConfiguration?: { KmsKey?: unknown }[];
  };
  DeletionPolicy?: string;
};
export type ContainerTemplate = { Resources?: Record<string, TemplateResource> };

/** A switch to local assets must preserve the old images and the key needed to decrypt them. */
export function assertRetainedContainerImages(
  previous: ContainerTemplate,
  next: ContainerTemplate,
  repositoryNames: readonly string[],
): void {
  const current = previous.Resources ?? {};
  const desired = next.Resources ?? {};
  const removed = new Set<string>();
  for (const [id, resource] of Object.entries(current)) {
    if (
      resource.Type !== "AWS::ECR::Repository" ||
      desired[id] ||
      !repositoryNames.includes(String(resource.Properties?.RepositoryName))
    )
      continue;
    removed.add(id);
    for (const encryption of resource.Properties?.EncryptionConfiguration ?? []) {
      const key = encryption.KmsKey as
        { "Fn::GetAtt"?: [string, string]; Ref?: string } | undefined;
      const keyId = key?.["Fn::GetAtt"]?.[0] ?? key?.Ref;
      if (keyId && current[keyId]?.Type === "AWS::KMS::Key" && !desired[keyId]) removed.add(keyId);
    }
  }
  const unsafe = [...removed].filter(
    (id) => !["Retain", "RetainExceptOnCreate"].includes(current[id]?.DeletionPolicy ?? ""),
  );
  if (unsafe.length) {
    throw new ProjectStateError(
      `Switching to Container-local would delete managed image resources: ${unsafe.join(", ")}. ` +
        "Keep build as Container, apply RemovalPolicy.RETAIN to the existing ECR repository and KMS key " +
        "in the CDK app, and deploy that retention change first. Then select Container-local. " +
        "Retain the images needed for rollback.",
    );
  }
}
