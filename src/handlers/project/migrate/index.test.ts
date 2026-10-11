import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootHandler } from "../../index";
import { InputValidationError, SilentCLIError, UserCancellationError } from "../../../errors";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import { FsProjectMigrator } from "../../../core/project/migrate";
import {
  commitAll,
  FAKE_AWS_IDENTITY,
  fakeCloudFormation,
  fakeSynth,
  fakeTemplateStore,
  templateFixture,
  writeV0Project,
  type FakeCloudFormationOptions,
} from "../../../core/project/migrate/migrate-test-support";
import { FsAssetSource } from "../../../core/project/source";
import {
  CONFIRMATION_REQUIRED_MESSAGE,
  formatMigrationPlan,
  formatMigrationResult,
  formatStackPlan,
  type MigrationOutput,
} from "./index";
import type { MigrationPlan, MigrationResult, StackMigrationPlan } from "./types";

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const STACK = "AgentCore-CompatA-default";

/**
 * The real root handler and migrator, so real git and the vended CDK assets are in
 * the path. Only AWS and the v1 synth are faked: F1's stack is deployed with the
 * live-tested CompatMig template, and the v1 app synthesizes its v1 template.
 */
function cli(
  v1 = templateFixture("pinned.v1"),
  options: { tty?: boolean; stdin?: string; cloudFormation?: FakeCloudFormationOptions } = {},
) {
  const io = testIO({
    isTTY: options.tty ?? false,
    ...(options.stdin !== undefined && { stdin: options.stdin }),
  });
  const cloudFormation = fakeCloudFormation(
    { [STACK]: { template: templateFixture("pinned.v0") } },
    options.cloudFormation,
  );
  const projectMigrator = new FsProjectMigrator({
    logger: createSilentLogger(),
    assetSource: new FsAssetSource(),
    createCloudFormationClient: cloudFormation.create,
    ...FAKE_AWS_IDENTITY,
    synthesize: fakeSynth([{ target: "default", stackName: STACK, template: v1 }]),
    createTemplateStore: () => fakeTemplateStore(),
    poll: { intervalMs: 0, sleep: async () => {} },
    env: {},
  });
  const root = createRootHandler(new TestCoreClient({ projectMigrator }), {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  return {
    io,
    cloudFormation,
    commands: () => cloudFormation.calls.map((call) => call.command),
    run: (...args: string[]) => root.route(["node", "agentcore", "migrate", ...args]),
  };
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
    expect(out).toContain(
      `  ok    stack (default)      ${STACK} is UPDATE_COMPLETE, with no stack policy\n`,
    );
    expect(out).toContain(`\nStack ${STACK} (target 'default', 998846730471/us-east-1)\n`);
    expect(out).toContain("  Refactor: move 10 resources to new logical IDs\n");
    expect(out).toContain(
      "  Replacements: 0 replacements; no AgentCore resource is replaced or deleted\n",
    );
    expect(out).toEndWith("Ready to migrate.");
    expect(subject.io.stderr()).toBe(
      `Reading stack ${STACK} (998846730471/us-east-1)...\nPlanning the refactor of ${STACK}...`,
    );
  });

  test("--dry-run exits non-zero when the v1 deploy would replace an AgentCore resource", async () => {
    await inV0Project();
    const subject = cli(templateFixture("codezip.v1-rc3"));

    await expect(subject.run("--dry-run")).rejects.toBeInstanceOf(SilentCLIError);

    const out = subject.io.stdout();
    expect(out).toContain("BLOCKER AWS::BedrockAgentCore::ConfigurationBundle");
    expect(out).toEndWith("Not ready to migrate: 1 issue needs fixing first.");
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
    expect(plan.stacks).toHaveLength(1);
    expect(plan.stacks[0]).toMatchObject({ stackName: STACK, ready: true, replaced: [] });
  });

  test("prints the plan and exits non-zero when the project can't migrate yet", async () => {
    const root = await inV0Project();
    await writeFile(join(root, "wip.txt"), "uncommitted\n");
    const subject = cli();

    await expect(subject.run("--dry-run")).rejects.toBeInstanceOf(SilentCLIError);

    expect(subject.io.stdout()).toContain("  FAIL  git ");
    expect(subject.io.stdout()).toEndWith("Not ready to migrate: 1 issue needs fixing first.");
  });

  test("fails outside a project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentcore-no-project-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    process.chdir(dir);
    await expect(cli().run("--dry-run")).rejects.toThrow("No AgentCore project found");
  });
});

describe("agentcore migrate (apply)", () => {
  const specVersion = (root: string) =>
    (
      JSON.parse(readFileSync(join(root, "agentcore", "agentcore.json"), "utf8")) as {
        version: number;
      }
    ).version;

  test("--yes refactors, writes the files, verifies, and reports", async () => {
    const root = await inV0Project();
    const subject = cli();

    await subject.run("--yes");

    const out = subject.io.stdout();
    expect(out).toStartWith("Migration plan for project 'CompatA'\n");
    expect(out).toContain(`Stack refactor refactor-1 for ${STACK}, validated by CloudFormation:\n`);
    expect(out).toMatch(
      /\n {2}MOVE {4}ApplicationMemoryMigagentMemoryCA18A787 +ApplicationMemoryMigagentMemoryMemoryA587350B +No configuration changes detected\.\n/,
    );
    expect(out).toContain("No configuration changes detected.\n\nMigrated to v1.");
    expect(out).toContain(`\nMigrated to v1.\n\nStacks\n  ${STACK}: refactored\n`);
    expect(out).toContain("  modified  agentcore/agentcore.json\n");
    expect(out).toContain("  added     MIGRATION.md\n");
    expect(out).toEndWith(
      "Next: review the changes (git diff), commit them, then run `agentcore deploy`.",
    );
    expect(subject.io.stderr()).toContain(`Refactoring stack ${STACK}...\n`);
    expect(subject.commands()).toContain("ExecuteStackRefactorCommand");
    expect(specVersion(root)).toBe(2);
    expect(existsSync(join(root, "MIGRATION.md"))).toBe(true);
  });

  test("refuses without --yes when it can't ask, before reading anything", async () => {
    const root = await inV0Project();
    const subject = cli();

    await expect(subject.run()).rejects.toThrow(CONFIRMATION_REQUIRED_MESSAGE);
    await expect(subject.run()).rejects.toBeInstanceOf(InputValidationError);

    expect(subject.commands()).toEqual([]);
    expect(specVersion(root)).toBe(1);
  });

  test("asks for confirmation after showing the validated refactor", async () => {
    const root = await inV0Project();
    const subject = cli(undefined, { tty: true, stdin: "y\n" });

    await subject.run();

    expect(subject.io.stderr()).toContain(
      "Migrate project 'CompatA' to v1? This refactors 1 deployed stack",
    );
    expect(subject.io.stdout()).toContain("Migrated to v1.");
    expect(specVersion(root)).toBe(2);
  });

  test("changes nothing when the confirmation is declined", async () => {
    const root = await inV0Project();
    const subject = cli(undefined, { tty: true, stdin: "n\n" });

    await expect(subject.run()).rejects.toBeInstanceOf(UserCancellationError);

    expect(subject.commands()).toContain("CreateStackRefactorCommand");
    expect(subject.commands()).not.toContain("ExecuteStackRefactorCommand");
    expect(specVersion(root)).toBe(1);
  });

  test("prints the plan and stops when the project can't migrate", async () => {
    await inV0Project();
    const subject = cli(templateFixture("codezip.v1-rc3"));

    await expect(subject.run("--yes")).rejects.toBeInstanceOf(SilentCLIError);

    expect(subject.io.stdout()).toEndWith("Not ready to migrate: 1 issue needs fixing first.");
    expect(subject.commands()).not.toContain("CreateStackRefactorCommand");
  });

  test("reports a failed refactor, exits non-zero, and leaves the files alone", async () => {
    const root = await inV0Project();
    const subject = cli(undefined, {
      cloudFormation: {
        refactors: () => ({ execute: { status: "EXECUTE_FAILED", reason: "Access denied" } }),
      },
    });

    await expect(subject.run("--yes")).rejects.toBeInstanceOf(SilentCLIError);

    const out = subject.io.stdout();
    expect(out).toContain(`Migration didn't complete.\n\nStacks\n  ${STACK}: FAILED\n`);
    expect(out).toContain("Error: The refactor of stack");
    expect(out).toContain("Access denied");
    expect(out).toContain("Nothing was changed: every stack and file is as it was");
    expect(specVersion(root)).toBe(1);
  });

  test("--yes --json prints the plan, the refactors, and the result as one document", async () => {
    await inV0Project();
    const subject = cli();

    await subject.run("--yes", "--json");

    const output = JSON.parse(subject.io.stdout()) as MigrationOutput;
    expect(output.plan.ready).toBe(true);
    expect(output.refactors[0]).toMatchObject({ stackName: STACK, refactorId: "refactor-1" });
    expect(output.refactors[0]!.actions).toHaveLength(10);
    expect(output.result).toMatchObject({ migrated: true, report: "MIGRATION.md", recovery: [] });
    expect(output.result.stacks[0]!.outcome).toBe("refactored");
  });
});

describe("formatMigrationResult", () => {
  test("numbers the recovery steps of a migration that couldn't be undone", () => {
    const result: MigrationResult = {
      migrated: false,
      stacks: [
        { target: "a", stackName: "SA", region: "r", outcome: "undo-failed", message: "Throttled" },
        { target: "b", stackName: "SB", region: "r", outcome: "failed", message: "boom" },
      ],
      files: [],
      verification: [],
      error: "boom",
      restored: false,
      recovery: ["First.", "Second."],
    };
    expect(formatMigrationResult(result)).toBe(
      [
        "",
        "Migration didn't complete.",
        "",
        "Stacks",
        "  SA: refactored; moving it back FAILED",
        "    Throttled",
        "  SB: FAILED",
        "",
        "Error: boom",
        "",
        "To recover",
        "  1. First.",
        "  2. Second.",
        "",
      ].join("\n"),
    );
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
      deployedChanges: [
        {
          file: "agentcore/agentcore.json",
          path: "payments[pm].x",
          message: "v1 drops this field",
        },
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
      stacks: [],
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
        "Would change deployed configuration",
        "  - agentcore/agentcore.json payments[pm].x: v1 drops this field",
        "",
        "Fix before migrating",
        "  - agentcore/agentcore.json credentials[ab].name: too short",
        "",
        "Not ready to migrate: 3 issues need fixing first.",
        "",
      ].join("\n"),
    );
  });

  test("says when nothing is deployed and skips sections for a project it couldn't read", () => {
    const base = {
      rootPath: "/p",
      problems: [],
      deployedChanges: [],
      pins: [],
      warnings: [],
      changes: [],
      stacks: [],
    };
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

describe("formatStackPlan", () => {
  const stack: StackMigrationPlan = {
    target: "default",
    account: "123456789012",
    region: "us-east-1",
    stackName: "AgentCore-P-default",
    moves: [{ type: "AWS::BedrockAgentCore::Memory", from: "OldMem", to: "NewMem" }],
    unchanged: 1,
    added: [{ logicalId: "Trigger2", type: "AWS::CloudFormation::CustomResource" }],
    removed: [
      {
        logicalId: "Trigger1",
        type: "AWS::CloudFormation::CustomResource",
        severity: "info",
        reason: "recreated",
      },
    ],
    replaced: [
      { logicalId: "Repo", type: "AWS::ECR::Repository", severity: "warning", reason: "rebuilt" },
      {
        logicalId: "Bundle",
        type: "AWS::BedrockAgentCore::ConfigurationBundle",
        severity: "blocker",
        reason: "lost",
      },
    ],
    blockers: ["the stack name changes"],
    ready: false,
  };

  test("lists moves, the first v1 deploy's changes, and the verdict", () => {
    expect(formatStackPlan(stack)).toEqual([
      "Stack AgentCore-P-default (target 'default', 123456789012/us-east-1)",
      "  Refactor: move 1 resource to new logical IDs",
      "    TYPE                           FROM    TO",
      "    AWS::BedrockAgentCore::Memory  OldMem  NewMem",
      "  1 resource keep their logical IDs",
      "  Then the first v1 deploy:",
      "    creates",
      "      AWS::CloudFormation::CustomResource Trigger2",
      "    deletes",
      "      AWS::CloudFormation::CustomResource Trigger1: recreated",
      "    replaces",
      "      warning AWS::ECR::Repository Repo: rebuilt",
      "      BLOCKER AWS::BedrockAgentCore::ConfigurationBundle Bundle: lost",
      "  Replacements: 1 AgentCore resource would be replaced or deleted",
      "  BLOCKER: the stack name changes",
    ]);
  });

  test("says when the deploy changes nothing", () => {
    const quiet = formatStackPlan({
      ...stack,
      moves: [],
      added: [],
      removed: [],
      replaced: [],
      blockers: [],
    });
    expect(quiet).toContain("  Refactor: move 0 resources to new logical IDs");
    expect(quiet).toContain("    creates, deletes, and replaces nothing");
    expect(quiet.at(-1)).toBe(
      "  Replacements: 0 replacements; no AgentCore resource is replaced or deleted",
    );
  });
});
