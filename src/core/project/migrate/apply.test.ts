import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ProjectStateError } from "../../../errors";
import { createSilentLogger } from "../../../testing";
import { FsAssetSource } from "../source";
import { JOURNAL_RELATIVE_PATH, RECOVERY_RELATIVE_PATH } from "./apply";
import { BACKUP_RELATIVE_PATH, FilesRestoreError, type writeMigratedFiles } from "./files";
import { FsProjectMigrator } from "./index";
import {
  F1_DEPLOYED_STATE,
  FAKE_AWS_IDENTITY,
  fakeCloudFormation,
  fakeGit,
  fakeSynth,
  fakeTemplateStore,
  templateFixture,
  writeV0Project,
  type FakeCloudFormationOptions,
  type V0ProjectFiles,
} from "./migrate-test-support";
import { REPORT_FILE } from "./report";
import type { WorkspaceSynthesizer } from "./synth";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const STACK = "AgentCore-CompatA-default";
const V0 = templateFixture("pinned.v0");
const V1 = templateFixture("pinned.v1");

async function project(options: V0ProjectFiles = {}): Promise<string> {
  const { root, cleanup } = await writeV0Project(options);
  cleanups.push(cleanup);
  return root;
}

/** Every file under `root` with its content, skipping git metadata. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (name === ".git") continue;
      if (statSync(path).isDirectory()) visit(path);
      else files[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  visit(root);
  return files;
}

const specVersion = (root: string) =>
  (
    JSON.parse(readFileSync(join(root, "agentcore", "agentcore.json"), "utf8")) as {
      version: number;
    }
  ).version;

/**
 * The real migrator over F1, with AWS, git, and synth faked. `events` records,
 * in order, each refactor execution and change set with the project's
 * agentcore.json version at that moment, so tests can see what ran before the
 * files were written.
 */
function fakes(
  root: string,
  options: FakeCloudFormationOptions = {},
  extras: {
    targets?: string[];
    /** Wraps the fake synthesizer, e.g. to fail or interrupt a run. */
    synthesize?: (inner: WorkspaceSynthesizer) => WorkspaceSynthesizer;
    writeFiles?: typeof writeMigratedFiles;
  } = {},
) {
  const targets = extras.targets ?? ["default"];
  const cloudFormation = fakeCloudFormation(
    Object.fromEntries(targets.map((target) => [stackOf(target), { template: V0 }])),
    options,
  );
  const events: string[] = [];
  const inner = fakeSynth(
    targets.map((target) => ({ target, stackName: stackOf(target), template: V1 })),
  );
  const synthesize = Object.assign(extras.synthesize?.(inner) ?? inner, {
    workspaces: inner.workspaces,
  });
  const migrator = new FsProjectMigrator({
    logger: createSilentLogger(),
    runner: fakeGit({ status: "" }),
    assetSource: new FsAssetSource(),
    createCloudFormationClient: (config) => {
      const client = cloudFormation.create(config);
      const send = client.send.bind(client);
      client.send = (async (command: { constructor: { name: string } }) => {
        const name = command.constructor.name;
        if (name === "ExecuteStackRefactorCommand" || name === "CreateChangeSetCommand") {
          events.push(`${name} with agentcore.json version ${specVersion(root)}`);
        }
        return send(command as never);
      }) as typeof client.send;
      return client;
    },
    ...FAKE_AWS_IDENTITY,
    synthesize,
    createTemplateStore: () => fakeTemplateStore(),
    poll: { intervalMs: 0, sleep: async () => {} },
    env: {},
    ...(extras.writeFiles && { writeFiles: extras.writeFiles }),
  });
  return { migrator, cloudFormation, events, synthesize };
}

const stackOf = (target: string) => `AgentCore-CompatA-${target}`;

/** F1 deployed to `default` and to `prod`, the same way. */
function twoTargets(): V0ProjectFiles {
  const recorded = F1_DEPLOYED_STATE.targets.default.resources;
  return {
    targets: ["default", "prod"].map((name) => ({
      name,
      account: "998846730471",
      region: "us-east-1",
    })),
    deployedState: {
      targets: {
        default: { resources: recorded },
        prod: { resources: { ...recorded, stackName: stackOf("prod") } },
      },
    },
  };
}

async function prepared(
  root: string,
  options: FakeCloudFormationOptions = {},
  extras: Parameters<typeof fakes>[2] = {},
) {
  const subject = fakes(root, options, extras);
  const migration = await subject.migrator.prepare(root);
  cleanups.push(() => migration.dispose());
  return { ...subject, migration };
}

describe("FsProjectMigrator.prepare", () => {
  test("previews the refactor without executing it", async () => {
    const root = await project();
    const { migration, cloudFormation } = await prepared(root);
    expect(migration.plan.ready).toBe(true);

    const previews = await migration.preview();

    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      target: "default",
      stackName: STACK,
      refactorId: "refactor-1",
    });
    expect(previews[0]!.actions).toHaveLength(10);
    expect(previews[0]!.actions.every((action) => action.action === "MOVE")).toBe(true);
    expect(cloudFormation.calls.map((call) => call.command)).not.toContain(
      "ExecuteStackRefactorCommand",
    );
    expect(cloudFormation.stacks[STACK]!.template).toEqual(V0);
  });

  test("refuses to preview or apply a plan that isn't ready", async () => {
    const root = await project({ cdkPin: "0.1.0-alpha.30" });
    const { migration } = await prepared(root);
    expect(migration.plan.ready).toBe(false);
    await expect(migration.preview()).rejects.toBeInstanceOf(ProjectStateError);
    await expect(migration.apply()).rejects.toBeInstanceOf(ProjectStateError);
  });

  test("a refactor CloudFormation rejects fails the preview, changing nothing", async () => {
    const root = await project();
    const { migration } = await prepared(root, {
      refactors: () => ({ create: { status: "CREATE_FAILED", reason: "Bad mapping" } }),
    });
    await expect(migration.preview()).rejects.toThrow(
      `CloudFormation rejected the refactor of stack '${STACK}' (CREATE_FAILED): Bad mapping.`,
    );
  });
});

describe("FsProjectMigrator apply", () => {
  test("refactors the stack before writing files, then verifies and reports", async () => {
    const root = await project();
    const { migration, cloudFormation, events, synthesize } = await prepared(root, {
      changeSets: {
        [STACK]: {
          changes: [
            {
              Type: "Resource",
              ResourceChange: {
                Action: "Modify",
                LogicalResourceId: "ApplicationRuntimeCompatAAgentRuntime",
                ResourceType: "AWS::BedrockAgentCore::Runtime",
                Replacement: "False",
              },
            },
            {
              Type: "Resource",
              ResourceChange: {
                Action: "Remove",
                LogicalResourceId: "McpGatewayCompatAGwRoleDefaultPolicy",
                ResourceType: "AWS::IAM::Policy",
              },
            },
          ],
        },
      },
    });
    const deployedState = await readFile(
      join(root, "agentcore", ".cli", "deployed-state.json"),
      "utf8",
    );

    const result = await migration.apply();

    expect(result.error).toBeUndefined();
    expect(result.migrated).toBe(true);
    expect(events).toEqual([
      "ExecuteStackRefactorCommand with agentcore.json version 1",
      "CreateChangeSetCommand with agentcore.json version 2",
    ]);
    expect(result.stacks).toEqual([
      {
        target: "default",
        stackName: STACK,
        region: "us-east-1",
        outcome: "refactored",
        refactorId: "refactor-1",
      },
    ]);
    expect(result.verification[0]).toMatchObject({ stackName: STACK, problems: [] });
    expect(result.verification[0]!.changes).toHaveLength(2);
    // The change set was created against the stack and deleted, never executed.
    const commands = cloudFormation.calls.map((call) => call.command);
    expect(commands).toContain("DeleteChangeSetCommand");
    expect(commands).not.toContain("ExecuteChangeSetCommand");
    expect(
      cloudFormation.calls.find((call) => call.command === "CreateChangeSetCommand")!.input,
    ).toMatchObject({ StackName: STACK, ChangeSetType: "UPDATE" });

    // The v1 project, synthesized in place after the workspace.
    expect(synthesize.workspaces.at(-1)).toBe(root);
    expect(specVersion(root)).toBe(2);
    expect(existsSync(join(root, "app", "CompatAHarness", "harness.yaml"))).toBe(true);
    expect(existsSync(join(root, "app", "CompatAHarness", "harness.json"))).toBe(false);
    expect(readFileSync(join(root, "agentcore", "cdk", "bin", "cdk.ts"), "utf8")).not.toBe(
      "// v0 CDK app\n",
    );
    expect(existsSync(join(root, "agentcore", "cdk", "jest.config.js"))).toBe(false);
    expect(existsSync(join(root, "agentcore", "cdk", "node_modules"))).toBe(false);
    // The plan lists what changed as it ended up on disk.
    expect(result.files).toContainEqual({ path: "agentcore/cdk/jest.config.js", kind: "removed" });
    expect(result.files).toContainEqual({ path: "app/CompatAHarness/harness.yaml", kind: "added" });
    expect(await readFile(join(root, "agentcore", ".cli", "deployed-state.json"), "utf8")).toBe(
      deployedState,
    );
    expect(existsSync(join(root, BACKUP_RELATIVE_PATH))).toBe(false);

    const report = readFileSync(join(root, REPORT_FILE), "utf8");
    expect(result.report).toBe(REPORT_FILE);
    expect(report).toContain("# Migrated to AgentCore CLI v1");
    expect(report).toContain("- removes AWS::IAM::Policy `McpGatewayCompatAGwRoleDefaultPolicy`");
    expect(report).toContain("- runtime `CompatAAgent`: `resourceName` = `CompatA_CompatAAgent`");
    expect(report).toContain("Run `agentcore deploy`");
  });

  test("lists a file the in-place install recreates as modified, not removed", async () => {
    const root = await project({ files: { "agentcore/cdk/package-lock.json": "{}\n" } });
    const { migration } = await prepared(
      root,
      {},
      {
        synthesize: (inner) => async (directory, options) => {
          await writeFile(join(directory, "agentcore", "cdk", "package-lock.json"), "{ }\n");
          return inner(directory, options);
        },
      },
    );
    expect(migration.plan.changes).toContainEqual({
      path: "agentcore/cdk/package-lock.json",
      kind: "removed",
    });

    const result = await migration.apply();

    expect(result.files).toContainEqual({
      path: "agentcore/cdk/package-lock.json",
      kind: "modified",
    });
  });

  test("leaves every file untouched when the refactor fails", async () => {
    const root = await project();
    const before = snapshot(root);
    const { migration, cloudFormation } = await prepared(root, {
      refactors: () => ({ execute: { status: "ROLLBACK_COMPLETE", reason: "Tag denied" } }),
    });

    const result = await migration.apply();

    expect(result.migrated).toBe(false);
    expect(result.restored).toBe(true);
    expect(result.recovery).toEqual([]);
    expect(result.error).toContain("Tag denied");
    expect(result.stacks[0]).toMatchObject({ outcome: "failed" });
    expect(snapshot(root)).toEqual(before);
    expect(cloudFormation.calls.map((call) => call.command)).not.toContain(
      "CreateChangeSetCommand",
    );
  });

  test("moves the stack back and restores the files when verification finds a replacement", async () => {
    const root = await project();
    const before = snapshot(root);
    const { migration, cloudFormation } = await prepared(root, {
      changeSets: {
        [STACK]: {
          changes: [
            {
              Type: "Resource",
              ResourceChange: {
                Action: "Modify",
                LogicalResourceId: "ApplicationMemoryCompatAAgentMemory",
                ResourceType: "AWS::BedrockAgentCore::Memory",
                Replacement: "True",
              },
            },
          ],
        },
      },
    });

    const result = await migration.apply();

    expect(result.migrated).toBe(false);
    expect(result.restored).toBe(true);
    expect(result.error).toContain(
      "AWS::BedrockAgentCore::Memory ApplicationMemoryCompatAAgentMemory would be replaced",
    );
    expect(result.verification[0]!.problems).toHaveLength(1);
    expect(result.stacks[0]).toMatchObject({ outcome: "undone" });
    expect(cloudFormation.stacks[STACK]!.template).toEqual(V0);
    // Byte for byte, including the v0 CDK app's installed dependencies.
    expect(snapshot(root)).toEqual(before);
  });

  test("restores the files and moves the stack back when the in-place synth fails", async () => {
    const root = await project();
    const before = snapshot(root);
    let calls = 0;
    const { migration, cloudFormation } = await prepared(
      root,
      {},
      {
        synthesize: (inner) => async (directory, options) => {
          if (++calls === 2) throw new Error("npm install failed: ETIMEDOUT");
          return inner(directory, options);
        },
      },
    );

    const result = await migration.apply();

    expect(result).toMatchObject({
      migrated: false,
      restored: true,
      error: "npm install failed: ETIMEDOUT",
    });
    expect(cloudFormation.stacks[STACK]!.template).toEqual(V0);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, JOURNAL_RELATIVE_PATH))).toBe(false);
  });

  test("says so when writing the files failed and putting them back did too", async () => {
    const root = await project();
    const { migration, cloudFormation } = await prepared(
      root,
      {},
      {
        writeFiles: async () => {
          throw new FilesRestoreError(new Error("ENOSPC: no space left"), new Error("EACCES"));
        },
      },
    );

    const result = await migration.apply();

    expect(result).toMatchObject({
      migrated: false,
      restored: false,
      error: "ENOSPC: no space left",
    });
    expect(result.recovery[0]).toStartWith(
      "Couldn't restore all of the project's v0 files (EACCES).",
    );
    // The stack still moves back, and the record of the migration stays for the next run.
    expect(cloudFormation.stacks[STACK]!.template).toEqual(V0);
    expect(existsSync(join(root, JOURNAL_RELATIVE_PATH))).toBe(true);
  });

  test("Ctrl-C lets the running step finish, then puts everything back", async () => {
    const root = await project();
    const before = snapshot(root);
    const steps: string[] = [];
    let calls = 0;
    const { migration, cloudFormation } = await prepared(
      root,
      {},
      {
        synthesize: (inner) => async (directory, options) => {
          // The in-place synth is interrupted part-way, and still completes.
          if (++calls === 2) process.emit("SIGINT", "SIGINT");
          return inner(directory, options);
        },
      },
    );

    const listeners = process.listeners("SIGINT");
    const result = await migration.apply({ onStep: (step) => steps.push(step) });

    expect(result).toMatchObject({
      migrated: false,
      restored: true,
      error: "Interrupted (Ctrl-C).",
    });
    expect(steps.some((step) => step.startsWith("Stopping: once the current step ends"))).toBe(
      true,
    );
    expect(cloudFormation.stacks[STACK]!.template).toEqual(V0);
    expect(snapshot(root)).toEqual(before);
    // Apply's own handler is gone again, and the workspace's cleanup is back.
    expect(process.listeners("SIGINT")).toHaveLength(listeners.length);
  });

  test("saves recovery details and gives manual steps when a refactor can't roll back", async () => {
    const root = await project();
    const { migration } = await prepared(root, {
      refactors: () => ({ execute: { status: "ROLLBACK_FAILED", reason: "Import failed" } }),
    });

    const result = await migration.apply();

    expect(result.migrated).toBe(false);
    expect(result.restored).toBe(false);
    expect(result.recovery[0]).toContain(
      `Stack ${STACK} (us-east-1) is part-way through stack refactor refactor-1`,
    );
    expect(result.recovery.join("\n")).toContain(
      `aws cloudformation describe-stack-refactor --stack-refactor-id refactor-1 --region us-east-1`,
    );
    const undoFile = join(root, RECOVERY_RELATIVE_PATH, `${STACK}.undo-refactor.json`);
    const undo = JSON.parse(readFileSync(undoFile, "utf8")) as {
      StackDefinitions: { TemplateBody: string }[];
      ResourceMappings: {
        Source: { LogicalResourceId: string };
        Destination: { LogicalResourceId: string };
      }[];
    };
    expect(JSON.parse(undo.StackDefinitions[0]!.TemplateBody)).toEqual(V0);
    expect(undo.ResourceMappings).toHaveLength(10);
    // Each mapping goes from a v1 logical ID back to the deployed one.
    for (const mapping of undo.ResourceMappings) {
      expect(V0.Resources![mapping.Destination.LogicalResourceId]).toBeDefined();
    }
    expect(specVersion(root)).toBe(1);
  });
});

describe("FsProjectMigrator apply, several targets", () => {
  test("a refactor that can't roll back leaves the earlier stack refactored, and says so", async () => {
    const root = await project(twoTargets());
    const { migration, cloudFormation } = await prepared(
      root,
      {
        refactors: ({ stackName }) =>
          stackName === stackOf("prod") ? { execute: { status: "ROLLBACK_FAILED" } } : {},
      },
      { targets: ["default", "prod"] },
    );

    const result = await migration.apply();

    expect(result.stacks.map((stack) => [stack.stackName, stack.outcome])).toEqual([
      [stackOf("default"), "refactored"],
      [stackOf("prod"), "failed"],
    ]);
    // No undo was attempted: only the two refactors were ever created.
    expect(
      cloudFormation.calls.filter((call) => call.command === "CreateStackRefactorCommand"),
    ).toHaveLength(2);
    const recovery = result.recovery.join("\n");
    expect(recovery).toContain(`Stack ${stackOf("prod")} (us-east-1) is part-way through`);
    expect(recovery).toContain(
      `Stack ${stackOf("default")} is still refactored to the v1 logical IDs (its resources are intact), because it was refactored before that failure.`,
    );
    expect(result.recovery[0]).toContain("and no project file was changed.");
    expect(specVersion(root)).toBe(1);
    // Kept, so the next run's "unfinished migration" check names both stacks.
    expect(existsSync(join(root, JOURNAL_RELATIVE_PATH))).toBe(true);
  });

  test("a later target's failure undoes the earlier one", async () => {
    const root = await project(twoTargets());
    const before = snapshot(root);
    const { migration, cloudFormation } = await prepared(
      root,
      {
        refactors: ({ stackName }) =>
          stackName === stackOf("prod")
            ? { execute: { status: "EXECUTE_FAILED", reason: "No" } }
            : {},
      },
      { targets: ["default", "prod"] },
    );

    const result = await migration.apply();

    expect(result.stacks.map((stack) => stack.outcome)).toEqual(["undone", "failed"]);
    expect(result).toMatchObject({ restored: true, recovery: [] });
    expect(cloudFormation.stacks[stackOf("default")]!.template).toEqual(V0);
    expect(snapshot(root)).toEqual(before);
  });
});

describe("an unfinished migration", () => {
  test("its journal and backup fail a check that says what to look at", async () => {
    const root = await project({
      files: {
        [JOURNAL_RELATIVE_PATH]: JSON.stringify({
          startedAt: "2026-10-11T00:00:00.000Z",
          refactors: [{ stackName: STACK, region: "us-east-1", refactorId: "rf-9" }],
          files: "writing",
        }),
        [join(BACKUP_RELATIVE_PATH, "cdk", "bin", "cdk.ts")]: "// v0\n",
      },
    });
    const { migration } = await prepared(root);

    const check = migration.plan.checks.find((entry) => entry.name === "unfinished migration");
    expect(migration.plan.ready).toBe(false);
    expect(check?.message).toContain(
      "(started 2026-10-11T00:00:00.000Z) was stopped before it finished.",
    );
    expect(check?.message).toContain("--stack-refactor-id rf-9 --region us-east-1");
    expect(check?.message).toContain(`The v0 files it replaced are in ${BACKUP_RELATIVE_PATH}`);
  });

  test("a successful migration leaves no journal, backup, or recovery files", async () => {
    const root = await project({
      files: { [join(RECOVERY_RELATIVE_PATH, "old.json")]: "{}", [REPORT_FILE]: "notes\n" },
    });
    const { migration } = await prepared(root);

    const result = await migration.apply();

    expect(result.migrated).toBe(true);
    for (const path of [JOURNAL_RELATIVE_PATH, BACKUP_RELATIVE_PATH, RECOVERY_RELATIVE_PATH]) {
      expect(existsSync(join(root, path))).toBe(false);
    }
    // An existing MIGRATION.md is overwritten, and listed as modified.
    expect(result.files.at(-1)).toEqual({ path: REPORT_FILE, kind: "modified" });
  });
});

describe("symlinks out of the workspace", () => {
  test("fail a check before anything is installed or synthesized", async () => {
    const root = await project();
    const outside = await project();
    await symlink(join(outside, "app"), join(root, "app", "shared"));
    await symlink(join(root, "app", "CompatAAgent"), join(root, "app", "absolute-inside"));
    await symlink("../CompatAAgent", join(root, "app", "CompatAHarness", "relative-inside"));
    const { migration, synthesize } = await prepared(root);

    const check = migration.plan.checks.find((entry) => entry.name === "symlinks");
    expect(migration.plan.ready).toBe(false);
    expect(check?.ok).toBe(false);
    // Absolute links lead back into the real project from the copy; relative ones inside it are fine.
    expect(check?.message).toContain(
      `  app/absolute-inside -> ${join(root, "app", "CompatAAgent")}`,
    );
    expect(check?.message).toContain(`  app/shared -> ${join(outside, "app")}`);
    expect(check?.message).not.toContain("relative-inside");
    expect(synthesize.workspaces).toEqual([]);
  });
});

describe("a leftover backup without a journal", () => {
  test("fails the check too", async () => {
    const root = await project({ files: { [join(BACKUP_RELATIVE_PATH, "files", "x")]: "x" } });
    const { migration } = await prepared(root);
    const check = migration.plan.checks.find((entry) => entry.name === "unfinished migration");
    expect(check?.ok).toBe(false);
    expect(check?.message).not.toContain("--stack-refactor-id");
    expect(migration.plan.ready).toBe(false);
  });
});
