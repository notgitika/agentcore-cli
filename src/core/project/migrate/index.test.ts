import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSilentLogger } from "../../../testing";
import { FsAssetSource } from "../source";
import { deployedTargets, FsProjectMigrator } from "./index";
import {
  commitAll,
  F1_DEPLOYED_STATE,
  F1_SPEC,
  FAKE_AWS_IDENTITY,
  fakeCloudFormation,
  fakeGit,
  fakeSynth,
  templateFixture,
  writeV0Project,
  type FakeStack,
  type V0ProjectFiles,
} from "./migrate-test-support";
import type { WorkspaceSynthesizer } from "./synth";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function project(options: V0ProjectFiles = {}): Promise<string> {
  const { root, cleanup } = await writeV0Project(options);
  cleanups.push(cleanup);
  return root;
}

const STACK = "AgentCore-CompatA-default";

/**
 * The real migrator with its AWS and synth seams faked: F1's stack is deployed
 * with the live-tested CompatMig template, and the v1 app "synthesizes" the
 * CompatMig v1 template, which keeps every deployed AgentCore resource.
 */
function fakes(
  options: {
    stacks?: Record<string, FakeStack>;
    synthesize?: WorkspaceSynthesizer;
    /** Run real git rather than answering it from a script. */
    realGit?: boolean;
    account?: string;
  } = {},
) {
  const cloudFormation = fakeCloudFormation(
    options.stacks ?? { [STACK]: { template: templateFixture("pinned.v0") } },
  );
  const synthesize =
    options.synthesize ??
    fakeSynth([{ target: "default", stackName: STACK, template: templateFixture("pinned.v1") }]);
  const migrator = new FsProjectMigrator({
    logger: createSilentLogger(),
    ...(!options.realGit && { runner: fakeGit({ status: "" }) }),
    assetSource: new FsAssetSource(),
    createCloudFormationClient: cloudFormation.create,
    resolveCredentials: FAKE_AWS_IDENTITY.resolveCredentials,
    resolveAccount: async () => options.account ?? "998846730471",
    synthesize,
  });
  return { migrator, cloudFormation, synthesize };
}

const migrator = () => fakes().migrator;

describe("FsProjectMigrator.plan", () => {
  test("plans a deployed v0 project committed to git, without touching it", async () => {
    const root = await project();
    commitAll(root);
    const before = await readFile(join(root, "agentcore", "agentcore.json"), "utf8");

    // The real process runner, so the git check runs real git.
    const plan = await fakes({ realGit: true }).migrator.plan(root);

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
    const plan = await fakes({ realGit: true }).migrator.plan(root);
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

describe("FsProjectMigrator.plan, deployed stacks", () => {
  test("reads each deployed stack, synthesizes the converted project, and plans the refactor", async () => {
    const root = await project();
    const subject = fakes();
    const steps: string[] = [];

    const plan = await subject.migrator.plan(root, { onStep: (step) => steps.push(step) });

    expect(plan.ready).toBe(true);
    expect(plan.checks.slice(-2)).toEqual([
      {
        name: "stack (default)",
        ok: true,
        message: `${STACK} is UPDATE_COMPLETE, with no stack policy`,
      },
      { name: "v1 synth", ok: true, message: "the converted project synthesizes" },
    ]);
    expect(subject.cloudFormation.calls).toEqual([
      { command: "DescribeStacksCommand", input: { StackName: STACK }, region: "us-east-1" },
      { command: "GetStackPolicyCommand", input: { StackName: STACK }, region: "us-east-1" },
      {
        command: "GetTemplateCommand",
        input: { StackName: STACK, TemplateStage: "Original" },
        region: "us-east-1",
      },
    ]);
    expect(plan.stacks).toHaveLength(1);
    expect(plan.stacks[0]).toMatchObject({
      target: "default",
      account: "998846730471",
      region: "us-east-1",
      stackName: STACK,
      unchanged: 5,
      added: [],
      replaced: [],
      blockers: [],
      ready: true,
    });
    expect(plan.stacks[0]!.moves).toHaveLength(10);
    expect(steps).toEqual([
      `Reading stack ${STACK} (998846730471/us-east-1)`,
      `Planning the refactor of ${STACK}`,
    ]);
  });

  test("synthesizes the converted copy, not the project", async () => {
    const root = await project();
    const seen: string[] = [];
    const synth = fakeSynth([
      { target: "default", stackName: STACK, template: templateFixture("pinned.v1") },
    ]);
    const subject = fakes({
      synthesize: async (workspace, options) => {
        seen.push(await readFile(join(workspace, "agentcore", "agentcore.json"), "utf8"));
        return synth(workspace, options);
      },
    });

    await subject.migrator.plan(root);

    expect(synth.workspaces).toHaveLength(1);
    expect(synth.workspaces[0]).not.toBe(root);
    expect(JSON.parse(seen[0]!)).toMatchObject({ name: "CompatA", version: 2 });
  });

  test("reports a v1 deploy that would replace an AgentCore resource", async () => {
    const subject = fakes({
      stacks: { [STACK]: { template: templateFixture("codezip.v0") } },
      synthesize: fakeSynth([
        { target: "default", stackName: STACK, template: templateFixture("codezip.v1-rc3") },
      ]),
    });

    const plan = await subject.migrator.plan(await project());

    expect(plan.ready).toBe(false);
    expect(plan.checks.every((check) => check.ok)).toBe(true);
    expect(plan.stacks[0]!.ready).toBe(false);
    expect(
      plan.stacks[0]!.replaced.filter((change) => change.severity === "blocker"),
    ).toMatchObject([{ type: "AWS::BedrockAgentCore::ConfigurationBundle" }]);
  });

  test("never reads AWS or synthesizes for a project that was never deployed", async () => {
    const synth = fakeSynth([]);
    const subject = fakes({ synthesize: synth });
    const plan = await subject.migrator.plan(await project({ deployedState: null }));
    expect(plan.ready).toBe(true);
    expect(plan.stacks).toEqual([]);
    expect(subject.cloudFormation.calls).toEqual([]);
    expect(synth.workspaces).toEqual([]);
  });

  test("fails the stack check when the credentials are for another account", async () => {
    const subject = fakes({ account: "111122223333" });
    const plan = await subject.migrator.plan(await project());
    const check = plan.checks.find((entry) => entry.name === "stack (default)");
    expect(check).toMatchObject({ ok: false });
    expect(check?.message).toContain("the active credentials belong to 111122223333");
    expect(subject.cloudFormation.calls).toEqual([]);
    expect(plan.stacks).toEqual([]);
    expect(plan.ready).toBe(false);
  });

  test("doesn't synthesize when a stack can't be refactored", async () => {
    const synth = fakeSynth([]);
    const subject = fakes({
      stacks: {
        [STACK]: { template: templateFixture("pinned.v0"), policy: '{"Statement":[]}' },
      },
      synthesize: synth,
    });
    const plan = await subject.migrator.plan(await project());
    expect(plan.checks.find((check) => check.name === "stack (default)")?.message).toContain(
      "doesn't support stacks with a stack policy",
    );
    expect(synth.workspaces).toEqual([]);
    expect(subject.cloudFormation.calls.map((call) => call.command)).not.toContain(
      "GetTemplateCommand",
    );
    expect(plan.ready).toBe(false);
  });

  test("turns an AWS error into a failed stack check", async () => {
    const failing = new FsProjectMigrator({
      logger: createSilentLogger(),
      runner: fakeGit({ status: "" }),
      assetSource: new FsAssetSource(),
      createCloudFormationClient: () =>
        ({
          send: async () => {
            throw Object.assign(new Error("User is not authorized to perform DescribeStacks"), {
              name: "AccessDenied",
            });
          },
        }) as never,
      ...FAKE_AWS_IDENTITY,
      synthesize: fakeSynth([]),
    });
    const plan = await failing.plan(await project());
    expect(plan.checks.find((check) => check.name === "stack (default)")).toEqual({
      name: "stack (default)",
      ok: false,
      message: `Couldn't read stack '${STACK}' in 998846730471/us-east-1: User is not authorized to perform DescribeStacks`,
    });
  });

  test("reports a v1 app that doesn't synthesize", async () => {
    const plan = await fakes({
      synthesize: async () => {
        throw new Error("'npm run cdk -- synth' failed (exit code 1).\n\nboom");
      },
    }).migrator.plan(await project());
    expect(plan.checks.at(-1)).toEqual({
      name: "v1 synth",
      ok: false,
      message:
        "The converted project's v1 CDK app didn't synthesize:\n'npm run cdk -- synth' failed (exit code 1).\n\nboom",
    });
    expect(plan.stacks).toEqual([]);
    expect(plan.ready).toBe(false);
  });

  test("reports a target the v1 app has no stack for, and still returns the plan", async () => {
    const plan = await fakes({
      synthesize: fakeSynth([{ target: "other", stackName: STACK, template: {} }]),
    }).migrator.plan(await project());
    const check = plan.checks.at(-1);
    expect(check).toMatchObject({ name: "plan (default)", ok: false });
    expect(check?.message).toStartWith(
      `Couldn't plan the refactor of '${STACK}': The synthesized cloud assembly has no stack for deployment target 'default'.`,
    );
    expect(plan.stacks).toEqual([]);
    expect(plan.ready).toBe(false);
  });

  test("still checks the stacks, but doesn't synthesize, when the files need fixing first", async () => {
    const synth = fakeSynth([]);
    const subject = fakes({ synthesize: synth });
    const plan = await subject.migrator.plan(
      await project({
        spec: {
          ...F1_SPEC,
          credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "ab" }],
        },
      }),
    );
    expect(plan.problems).not.toEqual([]);
    expect(plan.checks.find((check) => check.name === "stack (default)")?.ok).toBe(true);
    expect(synth.workspaces).toEqual([]);
  });
});

describe("deployedTargets", () => {
  const target = { name: "default", account: "998846730471", region: "us-east-1" as const };

  test("uses the recorded stack name, or derives v0's", () => {
    expect(deployedTargets("CompatA", [target], F1_DEPLOYED_STATE as never).targets).toEqual([
      { target, stackName: STACK },
    ]);
    expect(
      deployedTargets("My_Proj", [{ ...target, name: "dev_1" }], {
        targets: { dev_1: { resources: {} } },
      }).targets,
    ).toEqual([{ target: { ...target, name: "dev_1" }, stackName: "AgentCore-My-Proj-dev-1" }]);
  });

  test("skips targets with nothing deployed and fails ones missing from aws-targets.json", () => {
    const result = deployedTargets("CompatA", [], {
      targets: { gone: { resources: {} }, empty: {} },
    });
    expect(result.targets).toEqual([]);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ name: "stack (gone)", ok: false });
    expect(result.checks[0]!.message).toContain("target 'gone', which isn't in");
  });
});
