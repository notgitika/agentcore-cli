import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ProjectStateError } from "../../../../errors";
import type { ReadWriteJson } from "../../../../io";
import type { WorkloadBuild } from "./localContainers";

// The parts of a cloud assembly asset manifest (`<stack>.assets.json`) that
// describe how CDK builds a Docker image asset.
const AssetManifestSchema = z.object({
  dockerImages: z
    .record(
      z.string(),
      z.object({
        displayName: z.string().optional(),
        source: z.object({
          directory: z.string().optional(),
          dockerFile: z.string().optional(),
          dockerBuildArgs: z.record(z.string(), z.string()).optional(),
          platform: z.string().optional(),
        }),
      }),
    )
    .default({}),
});

// The assembly's manifest.json, which each synth rewrites: only the asset manifests
// its stacks depend on are current. Older *.assets.json files can linger beside them.
const AssemblyManifestSchema = z.object({
  artifacts: z
    .record(
      z.string(),
      z.object({
        type: z.string(),
        dependencies: z.array(z.string()).optional(),
        properties: z.object({ file: z.string().optional() }).passthrough().optional(),
      }),
    )
    .default({}),
});

/** The asset manifest files the current assembly's stacks depend on. */
async function stackAssetManifests(
  json: ReadWriteJson,
  assemblyDirectory: string,
): Promise<string[]> {
  const manifestPath = join(assemblyDirectory, "manifest.json");
  if (!existsSync(manifestPath)) return [];
  const { artifacts } = await json.read(manifestPath, AssemblyManifestSchema);
  const files = new Set<string>();
  for (const artifact of Object.values(artifacts)) {
    if (artifact.type !== "aws:cloudformation:stack") continue;
    for (const dependency of artifact.dependencies ?? []) {
      const asset = artifacts[dependency];
      if (asset?.type === "cdk:asset-manifest" && asset.properties?.file) {
        files.add(asset.properties.file);
      }
    }
  }
  return [...files].sort();
}

// The companion CDK package registers each ContainerLocal image as a DockerImageAsset
// whose display name is `<workload construct id>/LocalContainerImage/Image`.
export const LOCAL_IMAGE_CONSTRUCT = "LocalContainerImage";

export type LocalImageBuild = {
  /** `runtime/<name>` or `harness/<name>`; the construct id when no workload matches. */
  resource: string;
  tag: string;
  /** The staged, already filtered build context inside the assembly. */
  directory: string;
  /** `load` adds --load, which Docker with a non-default buildx driver needs to keep the image. */
  command: (executable: string, options?: { load?: boolean }) => string[];
};

const alphanumeric = (value: string) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();
const tagComponent = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "");

/**
 * The ContainerLocal images the synthesized assembly's stacks declare, as local
 * build commands. Images shared by several target stacks are built once.
 */
export async function localImageBuilds(
  json: ReadWriteJson,
  assemblyDirectory: string,
  projectName: string,
  builds: Record<string, WorkloadBuild>,
): Promise<LocalImageBuild[]> {
  if (!existsSync(assemblyDirectory)) return [];
  // The CDK construct id of a workload is its kind and name in PascalCase, so
  // compare both without case or separators.
  const workloads = new Map(
    Object.entries(builds)
      .filter(([, build]) => build === "ContainerLocal")
      .map(([key]) => [alphanumeric(key), key]),
  );
  const images = new Map<string, LocalImageBuild>();
  for (const file of await stackAssetManifests(json, assemblyDirectory)) {
    const manifest = await json.read(join(assemblyDirectory, file), AssetManifestSchema);
    for (const [hash, image] of Object.entries(manifest.dockerImages)) {
      const segments = image.displayName?.split("/") ?? [];
      const index = segments.indexOf(LOCAL_IMAGE_CONSTRUCT);
      if (index < 1 || images.has(hash)) continue;
      const constructId = segments[index - 1]!;
      const resource = workloads.get(alphanumeric(constructId)) ?? constructId;
      const { directory, dockerFile, dockerBuildArgs, platform } = image.source;
      if (!directory) {
        throw new ProjectStateError(
          `The asset manifest ${file} has no build context for the ${resource} image.`,
        );
      }
      const tag = `agentcore-local/${tagComponent(`${projectName}-${resource.replace("/", "-")}`)}:${hash}`;
      images.set(hash, {
        resource,
        tag,
        directory: resolve(assemblyDirectory, directory),
        command: (executable, options) => [
          executable,
          "build",
          ...(options?.load ? ["--load"] : []),
          "--platform",
          platform ?? "linux/arm64",
          "--tag",
          tag,
          ...(dockerFile ? ["--file", dockerFile] : []),
          ...Object.entries(dockerBuildArgs ?? {}).flatMap(([key, value]) => [
            "--build-arg",
            `${key}=${value}`,
          ]),
          ".",
        ],
      });
    }
  }
  return [...images.values()];
}
