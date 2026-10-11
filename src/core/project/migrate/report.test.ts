import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MigrationPlan } from "../../../handlers/project/migrate/types";
import { migrationReport, scanAgentCode } from "./report";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const PLAN: MigrationPlan = {
  rootPath: "/p",
  projectName: "CompatMig",
  checks: [],
  problems: [],
  deployedChanges: [],
  pins: [
    {
      resourceType: "runtime",
      name: "migagent",
      field: "resourceName",
      value: "CompatMig_migagent",
    },
    { resourceType: "credential", name: "key", field: "providerName", value: "key" },
  ],
  warnings: [
    "Removed abTests (exp1) from agentcore.json: v1 doesn't track A/B tests there. They stay in AgentCore; manage them with 'agentcore eval ab-test'.",
  ],
  changes: [],
  stacks: [
    {
      target: "default",
      account: "1",
      region: "us-east-1",
      stackName: "AgentCore-CompatMig-default",
      moves: [{ type: "AWS::BedrockAgentCore::Memory", from: "OldMem", to: "NewMem" }],
      unchanged: 3,
      added: [],
      removed: [],
      replaced: [],
      blockers: [],
      ready: true,
    },
  ],
  ready: true,
};

describe("migrationReport", () => {
  test("covers what changed, kept names, what's left, and the next step", () => {
    const report = migrationReport({
      plan: PLAN,
      stacks: [
        {
          target: "default",
          stackName: "AgentCore-CompatMig-default",
          region: "us-east-1",
          outcome: "refactored",
          refactorId: "rf-1",
        },
      ],
      verification: [
        {
          target: "default",
          stackName: "AgentCore-CompatMig-default",
          changeSetName: "cs",
          changes: [
            {
              logicalId: "NewMem",
              type: "AWS::BedrockAgentCore::Memory",
              action: "Modify",
              replacement: "False",
            },
            { logicalId: "OldPolicy", type: "AWS::IAM::Policy", action: "Remove" },
          ],
          problems: [],
        },
      ],
      files: [
        { path: "agentcore/agentcore.json", kind: "modified" },
        { path: "agentcore/cdk/bin/cdk.ts", kind: "modified" },
        { path: "agentcore/cdk/cdk.json", kind: "added" },
        { path: "app/h/harness.json", kind: "removed" },
        { path: "app/h/harness.yaml", kind: "added" },
      ],
      codeNotes: [
        {
          file: "app/migagent/main.py",
          reads: "CREDENTIAL_KEY_NAME",
          instead: "AGENTCORE_CREDENTIAL_KEY_NAME",
        },
      ],
      libraryOverride: "/tmp/lib.tgz",
      date: new Date("2026-10-11T12:00:00Z"),
    });

    expect(report).toStartWith(
      "# Migrated to AgentCore CLI v1\n\n`agentcore migrate` moved project `CompatMig` from the AgentCore CLI v0 to v1 on 2026-10-11.",
    );
    expect(report).toContain(
      "- modified `agentcore/agentcore.json`: now a v1 (version 2) project spec\n",
    );
    expect(report).toContain("- removed `app/h/harness.json`: replaced by harness.yaml\n");
    expect(report).toContain("- added `app/h/harness.yaml`: converted from harness.json\n");
    expect(report).toContain(
      "- replaced `agentcore/cdk/` with the v1 CDK app, and installed its dependencies\n",
    );
    expect(report).toContain("deployed-state.json` as it was");
    expect(report).toContain("#### `AgentCore-CompatMig-default` (target `default`, us-east-1)");
    expect(report).toContain("A CloudFormation stack refactor (`rf-1`) moved 1 resource");
    expect(report).toContain("- AWS::BedrockAgentCore::Memory: `OldMem` → `NewMem`\n");
    expect(report).toContain(
      "It adds 0, updates 1 (0 by replacement), and removes 1 of the stack's resources",
    );
    expect(report).toContain("- removes AWS::IAM::Policy `OldPolicy`\n");
    expect(report).toContain("- runtime `migagent`: `resourceName` = `CompatMig_migagent`\n");
    expect(report).toContain("- credential `key`: `providerName` = `key`\n");
    expect(report).toContain("manage them with 'agentcore eval ab-test'.\n");
    expect(report).toContain(
      "- `app/migagent/main.py` reads `CREDENTIAL_KEY_NAME`, which v1 no longer sets. Read `AGENTCORE_CREDENTIAL_KEY_NAME` instead",
    );
    expect(report).toContain("(`/tmp/lib.tgz`, from AGENTCORE_MIGRATE_CDK_LIBRARY)");
    expect(report).toContain("2. Run `agentcore deploy`.");
  });

  test("says so when nothing was deployed or left to do", () => {
    const report = migrationReport({
      plan: { ...PLAN, pins: [], warnings: [], stacks: [] },
      stacks: [],
      verification: [],
      files: [],
      codeNotes: [],
      date: new Date("2026-10-11T12:00:00Z"),
    });
    expect(report).toContain("Nothing was deployed, so no stack was changed.");
    expect(report).toContain("None: nothing was deployed");
    expect(report).toContain("Nothing: the migration carried everything over.");
  });
});

describe("scanAgentCode", () => {
  test("finds v0 credential variables in agent code, skipping dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcore-scan-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "app", "agent", ".venv", "lib"), { recursive: true });
    await writeFile(
      join(root, "app", "agent", "main.py"),
      'name = os.environ["CREDENTIAL_MY_KEY_NAME"]\nok = os.environ["AGENTCORE_CREDENTIAL_OTHER_NAME"]\n',
    );
    await writeFile(join(root, "app", "agent", "README.md"), "CREDENTIAL_DOCS_NAME\n");
    await writeFile(join(root, "app", "agent", ".venv", "lib", "x.py"), "CREDENTIAL_DEP_NAME\n");

    expect(await scanAgentCode(root, ["app/agent/", "app/missing/"])).toEqual([
      {
        file: "app/agent/main.py",
        reads: "CREDENTIAL_MY_KEY_NAME",
        instead: "AGENTCORE_CREDENTIAL_MY_KEY_NAME",
      },
    ]);
  });
});
