import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FsAssetSource } from "../source";
import { FsProjectMigrator } from "./index";
import {
  commitAll,
  F1_SPEC,
  fakeGit,
  writeV0Project,
  type V0ProjectFiles,
} from "./migrate-test-support";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function project(options: V0ProjectFiles = {}): Promise<string> {
  const { root, cleanup } = await writeV0Project(options);
  cleanups.push(cleanup);
  return root;
}

const migrator = () =>
  new FsProjectMigrator({ runner: fakeGit({ status: "" }), assetSource: new FsAssetSource() });

describe("FsProjectMigrator.plan", () => {
  test("plans a deployed v0 project committed to git, without touching it", async () => {
    const root = await project();
    commitAll(root);
    const before = await readFile(join(root, "agentcore", "agentcore.json"), "utf8");

    // The real process runner, so the git check runs real git.
    const plan = await new FsProjectMigrator({ assetSource: new FsAssetSource() }).plan(root);

    expect(plan.ready).toBe(true);
    expect(plan.projectName).toBe("CompatA");
    expect(plan.checks.every((check) => check.ok)).toBe(true);
    expect(plan.problems).toEqual([]);
    // Every pin convertSpec makes for F1, plus the harness role it can name only from harness.json.
    expect(plan.pins).toHaveLength(12);
    expect(plan.pins).toContainEqual({
      resourceType: "harness-role",
      name: "CompatAHarness",
      field: "roleName",
      value: "CompatA_CompatAHarness",
    });
    expect(plan.warnings).toEqual([
      "Dropped fields v1 doesn't use: credentials[compatA-oauth].usage",
    ]);
    expect(plan.changes).toContainEqual({ path: "agentcore/agentcore.json", kind: "modified" });
    expect(plan.changes).toContainEqual({ path: "app/CompatAHarness/harness.yaml", kind: "added" });
    expect(plan.changes).toContainEqual({
      path: "app/CompatAHarness/harness.json",
      kind: "removed",
    });
    expect(await readFile(join(root, "agentcore", "agentcore.json"), "utf8")).toBe(before);
  });

  test("fails the git check for uncommitted changes", async () => {
    const root = await project();
    commitAll(root);
    await writeFile(join(root, "notes.txt"), "wip\n");
    const plan = await new FsProjectMigrator({ assetSource: new FsAssetSource() }).plan(root);
    expect(plan.ready).toBe(false);
    expect(plan.checks.find((check) => check.name === "git")?.message).toContain("?? notes.txt");
  });

  test("returns only the format check for a project that isn't v0", async () => {
    const plan = await migrator().plan(await project({ spec: { name: "Already", version: 2 } }));
    expect(plan).toMatchObject({ ready: false, pins: [], changes: [], problems: [] });
    expect(plan.projectName).toBeUndefined();
    expect(plan.checks.map((check) => check.name)).toEqual(["v0 project"]);
  });

  test("collects problems from the spec, harnesses, and deployment targets", async () => {
    const plan = await migrator().plan(
      await project({
        spec: {
          ...F1_SPEC,
          credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "ab" }],
        },
        targets: [{ name: "prod-us", account: "998846730471", region: "us-east-1" }],
        files: { "app/CompatAHarness/harness.json": JSON.stringify({ name: "CompatAHarness" }) },
        deployedState: null,
      }),
    );
    expect(plan.ready).toBe(false);
    expect(plan.problems.map((problem) => `${problem.file} ${problem.path}`)).toEqual([
      "agentcore/agentcore.json credentials[ab].name",
      "app/CompatAHarness/harness.json model",
      "agentcore/aws-targets.json [prod-us].name",
    ]);
    // The unconvertible harness keeps its harness.json in the plan.
    expect(plan.changes.some((change) => change.path.startsWith("app/CompatAHarness/"))).toBe(
      false,
    );
  });

  test("blocks on unsupported resources and an old CDK app", async () => {
    const plan = await migrator().plan(
      await project({
        cdkPin: "0.1.0-alpha.30",
        spec: {
          ...F1_SPEC,
          datasets: [
            {
              name: "ds1",
              schemaType: "AGENTCORE_EVALUATION_PREDEFINED_V1",
              config: { managed: { location: "d/x.jsonl" } },
            },
          ],
        },
      }),
    );
    const failed = plan.checks.filter((check) => !check.ok).map((check) => check.name);
    expect(failed).toEqual(["cdk dependencies", "supported resources"]);
    expect(plan.ready).toBe(false);
  });
});
