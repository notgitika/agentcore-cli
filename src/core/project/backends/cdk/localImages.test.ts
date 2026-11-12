import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsReadWriteJson } from "../../../../io";
import { createSilentLogger } from "../../../../testing";
import { LOCAL_IMAGE_CONSTRUCT, localImageBuilds } from "./localImages";

const json = new FsReadWriteJson({ logger: createSilentLogger() });
const directories: string[] = [];
afterEach(() => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))));

/** An assembly whose one stack, AgentCore-shop-default, declares `dockerImages`. */
async function assembly(dockerImages: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-local-images-"));
  directories.push(directory);
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      version: "36.0.0",
      artifacts: {
        "AgentCore-shop-default.assets": {
          type: "cdk:asset-manifest",
          properties: { file: "AgentCore-shop-default.assets.json" },
        },
        "AgentCore-shop-default": {
          type: "aws:cloudformation:stack",
          dependencies: ["AgentCore-shop-default.assets"],
        },
      },
    }),
  );
  await writeFile(
    join(directory, "AgentCore-shop-default.assets.json"),
    JSON.stringify({ version: "36.0.0", files: {}, dockerImages }),
  );
  return directory;
}

describe("localImageBuilds", () => {
  test("maps ContainerLocal images to their workloads and ignores other images", async () => {
    const directory = await assembly({
      h1: {
        displayName: "Application/HarnessHelpDesk/LocalContainerImage/Image",
        source: { directory: "asset.h1", platform: "linux/arm64" },
      },
      other: {
        displayName: "Application/SomethingElse/Image",
        source: { directory: "asset.other" },
      },
    });
    const images = await localImageBuilds(json, directory, "Shop_App", {
      "harness/help_desk": "ContainerLocal",
      "runtime/agent": "Container",
    });
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      resource: "harness/help_desk",
      tag: "agentcore-local/shop_app-harness-help_desk:h1",
      directory: join(directory, "asset.h1"),
    });
    expect(images[0]!.command("docker")).toEqual([
      "docker",
      "build",
      "--platform",
      "linux/arm64",
      "--tag",
      "agentcore-local/shop_app-harness-help_desk:h1",
      ".",
    ]);
  });

  test("returns nothing before synthesis", async () => {
    expect(
      await localImageBuilds(json, join(tmpdir(), "agentcore-missing-assembly"), "shop", {
        "runtime/agent": "ContainerLocal",
      }),
    ).toEqual([]);
  });

  test("pins the companion CDK's image construct path", async () => {
    // @aws/agentcore-cdk's RuntimeEnvironment and AgentCoreHarnessEnvironment add
    // `new LocalContainerImageAsset(this, "LocalContainerImage")`, whose
    // DockerImageAsset is "Image"; CDK names the asset by that construct path. If
    // the CDK package renames either construct, agentcore build would find no
    // images and skip them silently, so update LOCAL_IMAGE_CONSTRUCT with it.
    const directory = await assembly({
      abc: {
        displayName: "RuntimeOrdersAgent/LocalContainerImage/Image",
        source: { directory: "asset.abc" },
      },
    });
    const images = await localImageBuilds(json, directory, "shop", {
      "runtime/orders_agent": "ContainerLocal",
    });
    if (LOCAL_IMAGE_CONSTRUCT !== "LocalContainerImage" || images.length !== 1) {
      throw new Error(
        "agentcore build no longer recognizes ContainerLocal images named " +
          "'<workload>/LocalContainerImage/Image'. Keep localImages.ts in step with the " +
          "construct ids in @aws/agentcore-cdk's LocalContainerImageAsset.",
      );
    }
    expect(images[0]!.resource).toBe("runtime/orders_agent");
  });

  test("adds --load only on request", async () => {
    const directory = await assembly({
      abc: {
        displayName: "RuntimeAgent/LocalContainerImage/Image",
        source: { directory: "asset.abc" },
      },
    });
    const [image] = await localImageBuilds(json, directory, "shop", {
      "runtime/agent": "ContainerLocal",
    });
    expect(image!.command("docker", { load: true }).slice(0, 3)).toEqual([
      "docker",
      "build",
      "--load",
    ]);
    expect(image!.command("finch")).not.toContain("--load");
  });

  test("ignores asset manifests no current stack depends on", async () => {
    const directory = await assembly({
      current: {
        displayName: "RuntimeOrders/LocalContainerImage/Image",
        source: { directory: "asset.current" },
      },
    });
    // Left by a synth before a target existed, when the stack was AgentCore-shop.
    await writeFile(
      join(directory, "AgentCore-shop.assets.json"),
      JSON.stringify({
        version: "36.0.0",
        files: {},
        dockerImages: {
          stale: {
            displayName: "RuntimeOrders/LocalContainerImage/Image",
            source: { directory: "asset.stale" },
          },
        },
      }),
    );
    const images = await localImageBuilds(json, directory, "shop", {
      "runtime/orders": "ContainerLocal",
    });
    expect(images.map((image) => image.tag)).toEqual([
      "agentcore-local/shop-runtime-orders:current",
    ]);
  });
});
