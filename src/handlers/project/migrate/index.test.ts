import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootHandler } from "../../index";
import { SilentCLIError } from "../../../errors";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { commitAll, writeV0Project } from "../../../core/project/migrate/migrate-test-support";
import { APPLY_UNAVAILABLE_MESSAGE, formatMigrationPlan } from "./index";
import type { MigrationPlan } from "./types";

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/** The real root handler, so the real migrator, git, and the vended CDK assets are in the path. */
function cli() {
  const io = testIO();
  const root = createRootHandler(new TestCoreClient(), {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  return { io, run: (...args: string[]) => root.route(["node", "agentcore", "migrate", ...args]) };
}

/** Writes the F1 v0 project, commits it, and cds into it. */
async function inV0Project(options: Parameters<typeof writeV0Project>[0] = {}): Promise<string> {
  const { root, cleanup } = await writeV0Project(options);
  cleanups.push(cleanup);
  commitAll(root);
  process.chdir(join(root, "app"));
  return root;
}

describe("agentcore migrate", () => {
  test("--dry-run prints the plan for the enclosing v0 project", async () => {
    await inV0Project();
    const subject = cli();

    await subject.run("--dry-run");

    const out = subject.io.stdout();
    expect(out).toStartWith(
      "Migration plan for project 'CompatA' (dry run: nothing was changed)\n",
    );
    expect(out).toContain("  ok    git ");
    expect(out).toMatch(/runtime\s+CompatAAgent\s+resourceName\s+CompatA_CompatAAgent/);
    expect(out).toMatch(/credential\s+compatA-key\s+providerName\s+compatA-key/);
    expect(out).toContain("  modified  agentcore/agentcore.json\n");
    expect(out).toContain("  added     app/CompatAHarness/harness.yaml\n");
    expect(out).toContain("  - Dropped fields v1 doesn't use: credentials[compatA-oauth].usage\n");
    expect(out).toEndWith("Ready to migrate.");
  });

  test("--dry-run --json renders the plan as JSON", async () => {
    const root = await inV0Project();
    const subject = cli();

    await subject.run("--dry-run", "--json");

    const plan = JSON.parse(subject.io.stdout()) as MigrationPlan;
    expect(plan.ready).toBe(true);
    expect(plan.rootPath).toBe(root);
    expect(plan.pins).toContainEqual({
      resourceType: "harness",
      name: "CompatAHarness",
      field: "resourceName",
      value: "CompatA_CompatAHarness",
    });
  });

  test("prints the plan and exits non-zero when the project can't migrate yet", async () => {
    const root = await inV0Project();
    await writeFile(join(root, "wip.txt"), "uncommitted\n");
    const subject = cli();

    await expect(subject.run("--dry-run")).rejects.toBeInstanceOf(SilentCLIError);

    expect(subject.io.stdout()).toContain("  FAIL  git ");
    expect(subject.io.stdout()).toEndWith("Not ready to migrate: 1 issue needs fixing first.");
  });

  test("refuses to apply a migration without --dry-run", async () => {
    await inV0Project();
    await expect(cli().run()).rejects.toThrow(APPLY_UNAVAILABLE_MESSAGE);
  });

  test("fails outside a project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentcore-no-project-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    process.chdir(dir);
    await expect(cli().run("--dry-run")).rejects.toThrow("No AgentCore project found");
  });
});

describe("formatMigrationPlan", () => {
  test("renders checks, pins, changes, warnings, and problems", () => {
    const plan: MigrationPlan = {
      rootPath: "/p",
      projectName: "Proj",
      checks: [
        { name: "v0 project", ok: true, message: "'Proj' is a v0 project" },
        { name: "git", ok: false, message: "Commit or stash these changes first:\n  ?? x" },
      ],
      problems: [
        { file: "agentcore/agentcore.json", path: "credentials[ab].name", message: "too short" },
      ],
      pins: [
        { resourceType: "runtime", name: "agent", field: "resourceName", value: "Proj_agent" },
      ],
      warnings: ["Dropped fields v1 doesn't use: credentials[o].usage"],
      changes: [
        { path: "agentcore/agentcore.json", kind: "modified" },
        { path: "app/h/harness.yaml", kind: "added" },
      ],
      ready: false,
    };
    expect(formatMigrationPlan(plan)).toBe(
      [
        "Migration plan for project 'Proj' (dry run: nothing was changed)",
        "",
        "Checks",
        "  ok    v0 project  'Proj' is a v0 project",
        "  FAIL  git         Commit or stash these changes first:",
        "                      ?? x",
        "",
        "Names kept for deployed resources",
        "  TYPE     NAME   FIELD         AWS NAME",
        "  runtime  agent  resourceName  Proj_agent",
        "",
        "File changes",
        "  modified  agentcore/agentcore.json",
        "  added     app/h/harness.yaml",
        "",
        "Warnings",
        "  - Dropped fields v1 doesn't use: credentials[o].usage",
        "",
        "Fix before migrating",
        "  - agentcore/agentcore.json credentials[ab].name: too short",
        "",
        "Not ready to migrate: 2 issues need fixing first.",
        "",
      ].join("\n"),
    );
  });

  test("says when nothing is deployed and skips sections for a project it couldn't read", () => {
    const base = { rootPath: "/p", problems: [], pins: [], warnings: [], changes: [] };
    expect(
      formatMigrationPlan({
        ...base,
        projectName: "Proj",
        checks: [{ name: "v0 project", ok: true, message: "ok" }],
        ready: true,
      }),
    ).toContain("Names kept for deployed resources\n  none (nothing is deployed yet)\n");
    const unreadable = formatMigrationPlan({
      ...base,
      checks: [{ name: "v0 project", ok: false, message: "already v1" }],
      ready: false,
    });
    expect(unreadable).toStartWith("Migration plan for /p (dry run: nothing was changed)");
    expect(unreadable).not.toContain("File changes");
  });
});
