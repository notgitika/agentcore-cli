#!/usr/bin/env bun

/**
 Pins the vended CDK template to the published @aws/agentcore-cdk at the given dist-tag (default latest).
 Runs before bun install in release-prepare.yml, so it must not import anything from src/.
**/

import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CDK_PACKAGE = "@aws/agentcore-cdk";
const TEMPLATE = Bun.file(
  join(resolve(import.meta.dir, ".."), "src", "assets", "cdk", "package.json"),
);

const tag = Bun.argv[2] ?? "latest";
const target = (await $`bun pm view ${CDK_PACKAGE}@${tag} version`.text()).trim();
// Publishing the CLI before its companion constructs would create projects
// whose installed schema strips or rejects the new build selection.
const validationDirectory = mkdtempSync(join(tmpdir(), "agentcore-release-cdk-"));
try {
  const packagePath = join(validationDirectory, "package.json");
  await Bun.write(
    packagePath,
    JSON.stringify({ private: true, dependencies: { [CDK_PACKAGE]: target } }),
  );
  await $`bun install --cwd ${validationDirectory} --ignore-scripts --no-progress`.quiet();
  const cdk = createRequire(packagePath)(CDK_PACKAGE) as {
    BuildTypeSchema?: { safeParse(value: string): { success: boolean } };
    LocalContainerImageAsset?: unknown;
  };
  if (!cdk.BuildTypeSchema?.safeParse("Container-local").success || !cdk.LocalContainerImageAsset) {
    throw new Error(
      `${CDK_PACKAGE}@${target} does not support Container-local. ` +
        "Publish the companion CDK implementation before preparing this CLI release.",
    );
  }
} finally {
  rmSync(validationDirectory, { recursive: true, force: true });
}
const template = await TEMPLATE.json();
const current = template.dependencies[CDK_PACKAGE];

if (current === target) {
  console.log(`${CDK_PACKAGE} already pinned to ${target}`);
} else {
  template.dependencies[CDK_PACKAGE] = target;
  await Bun.write(TEMPLATE, JSON.stringify(template, null, 2) + "\n");
  console.log(`${CDK_PACKAGE}: ${current} → ${target}`);
}
