import { describe, expect, test } from "bun:test";
import { buildBridgeTemplate } from "./bridge";
import {
  fakeCloudFormation,
  fakeTemplateStore,
  type FakeCloudFormationOptions,
} from "./migrate-test-support";
import {
  createRefactor,
  executeRefactor,
  executeRefactors,
  poll,
  StackRefactorError,
  type RefactorStack,
} from "./refactor";
import type { CfnTemplate } from "./templates";
import { MAX_TEMPLATE_BODY_BYTES } from "./templateStore";

const DEPLOYED: CfnTemplate = {
  Resources: {
    OldMemory: { Type: "AWS::BedrockAgentCore::Memory", Properties: { Name: "P_mem" } },
    OldRuntime: {
      Type: "AWS::BedrockAgentCore::Runtime",
      Properties: { AgentRuntimeName: "P_agent", Memory: { Ref: "OldMemory" } },
    },
    OldRole: { Type: "AWS::IAM::Role", Properties: {} },
  },
};
const RENAMES = new Map([
  ["OldMemory", "NewMemory"],
  ["OldRuntime", "NewRuntime"],
  ["OldRole", "NewRole"],
]);
const NO_WAIT = { intervalMs: 0, sleep: async () => {} };

/** One stack per name, each deployed with DEPLOYED, refactored through one fake. */
function setup(stackNames: string[], options: FakeCloudFormationOptions = {}) {
  const cloudFormation = fakeCloudFormation(
    Object.fromEntries(stackNames.map((name) => [name, { template: DEPLOYED }])),
    options,
  );
  const store = fakeTemplateStore();
  const client = cloudFormation.create({ region: "us-east-1" } as never);
  const stack = (stackName: string, template = buildBridgeTemplate(DEPLOYED, RENAMES)) =>
    ({
      target: stackName,
      region: "us-east-1",
      stackName,
      renames: RENAMES,
      template,
      client,
      templates: async () => store,
    }) satisfies RefactorStack;
  const commands = () => cloudFormation.calls.map((call) => call.command);
  return { cloudFormation, store, stack, commands };
}

async function rejection(promise: Promise<unknown>): Promise<StackRefactorError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StackRefactorError);
    return error as StackRefactorError;
  }
  throw new Error("expected a StackRefactorError");
}

describe("createRefactor", () => {
  test("creates the refactor inline, waits for it, and lists every action", async () => {
    const { cloudFormation, stack, store } = setup(["S"]);

    const created = await createRefactor(stack("S"), NO_WAIT);

    const request = cloudFormation.calls.find(
      (call) => call.command === "CreateStackRefactorCommand",
    )!;
    expect(request.input).toMatchObject({
      EnableStackCreation: false,
      StackDefinitions: [
        { StackName: "S", TemplateBody: JSON.stringify(buildBridgeTemplate(DEPLOYED, RENAMES)) },
      ],
      ResourceMappings: [
        {
          Source: { StackName: "S", LogicalResourceId: "OldMemory" },
          Destination: { StackName: "S", LogicalResourceId: "NewMemory" },
        },
        {
          Source: { StackName: "S", LogicalResourceId: "OldRuntime" },
          Destination: { StackName: "S", LogicalResourceId: "NewRuntime" },
        },
        {
          Source: { StackName: "S", LogicalResourceId: "OldRole" },
          Destination: { StackName: "S", LogicalResourceId: "NewRole" },
        },
      ],
    });
    // Polled past CREATE_IN_PROGRESS, and followed the actions' NextToken.
    expect(
      cloudFormation.calls.filter((call) => call.command === "DescribeStackRefactorCommand"),
    ).toHaveLength(2);
    expect(created.refactorId).toBe("refactor-1");
    expect(created.actions).toEqual([
      {
        action: "MOVE",
        entity: "RESOURCE",
        from: "OldMemory",
        to: "NewMemory",
        physicalResourceId: "physical-OldMemory",
        description: "No configuration changes detected.",
      },
      expect.objectContaining({ from: "OldRuntime", to: "NewRuntime" }),
      expect.objectContaining({ from: "OldRole", to: "NewRole" }),
    ]);
    expect(store.puts).toEqual([]);
  });

  test("uploads a template over the inline limit and passes its URL", async () => {
    const { cloudFormation, stack, store } = setup(["S"]);
    const big = buildBridgeTemplate(DEPLOYED, RENAMES);
    big.Metadata = { padding: "x".repeat(MAX_TEMPLATE_BODY_BYTES) };

    await createRefactor(stack("S", big), NO_WAIT);

    const request = cloudFormation.calls.find(
      (call) => call.command === "CreateStackRefactorCommand",
    )!;
    const [definition] = request.input.StackDefinitions as Record<string, string>[];
    expect(definition!.TemplateBody).toBeUndefined();
    expect(definition!.TemplateURL).toMatch(
      /^https:\/\/bootstrap\.example\/agentcore-migrate\/S-[0-9a-f]{16}\.json$/,
    );
    // Deleted once CloudFormation has read it.
    expect(store.removed).toEqual(store.puts);
    expect(store.puts).toHaveLength(1);
  });

  test("reports CREATE_FAILED with CloudFormation's reason", async () => {
    const { stack, commands } = setup(["S"], {
      refactors: () => ({
        create: { status: "CREATE_FAILED", reason: "Resource OldRole can't be moved" },
      }),
    });

    const error = await rejection(createRefactor(stack("S"), NO_WAIT));

    expect(error.message).toBe(
      "CloudFormation rejected the refactor of stack 'S' (CREATE_FAILED): Resource OldRole can't be moved. Nothing was changed.",
    );
    expect(error.details).toMatchObject({ kind: "create-failed", refactorId: "refactor-1" });
    expect(commands()).not.toContain("ExecuteStackRefactorCommand");
  });
});

describe("executeRefactor", () => {
  test("executes and waits for EXECUTE_COMPLETE", async () => {
    const { cloudFormation, stack } = setup(["S"]);
    const created = await createRefactor(stack("S"), NO_WAIT);

    await executeRefactor(created, NO_WAIT);

    expect(cloudFormation.stacks.S!.template).toEqual(buildBridgeTemplate(DEPLOYED, RENAMES));
  });

  test("reports EXECUTE_FAILED as rolled back, with the reason", async () => {
    const { stack } = setup(["S"], {
      refactors: () => ({ execute: { status: "EXECUTE_FAILED", reason: "Tagging denied" } }),
    });
    const created = await createRefactor(stack("S"), NO_WAIT);

    const error = await rejection(executeRefactor(created, NO_WAIT));

    expect(error.details).toMatchObject({
      kind: "execute-failed",
      status: "EXECUTE_FAILED",
      reason: "Tagging denied",
    });
    expect(error.message).toContain("CloudFormation rolled it back, so the stack is unchanged.");
  });

  test("reports ROLLBACK_FAILED as needing manual repair", async () => {
    const { stack } = setup(["S"], {
      refactors: () => ({ execute: { status: "ROLLBACK_FAILED", reason: "Import failed" } }),
    });
    const created = await createRefactor(stack("S"), NO_WAIT);

    const error = await rejection(executeRefactor(created, NO_WAIT));

    expect(error.details).toMatchObject({ kind: "rollback-failed", status: "ROLLBACK_FAILED" });
    expect(error.message).toContain("couldn't roll it back (Import failed)");
  });
});

describe("executeRefactors", () => {
  test("refactors every stack in turn", async () => {
    const { cloudFormation, stack } = setup(["A", "B"]);
    const created = [
      await createRefactor(stack("A"), NO_WAIT),
      await createRefactor(stack("B"), NO_WAIT),
    ];

    const run = await executeRefactors(created, NO_WAIT);

    expect(run.failure).toBeUndefined();
    expect(run.refactored.map((entry) => entry.stackName)).toEqual(["A", "B"]);
    expect(Object.keys(cloudFormation.stacks.B!.template!.Resources!)).toEqual([
      "NewMemory",
      "NewRuntime",
      "NewRole",
    ]);
  });

  test("undoes the earlier stacks when a later one fails", async () => {
    const { cloudFormation, stack } = setup(["A", "B", "C"], {
      refactors: ({ stackName }) =>
        stackName === "C" ? { execute: { status: "ROLLBACK_COMPLETE", reason: "Nope" } } : {},
    });
    const created = [];
    for (const name of ["A", "B", "C"]) created.push(await createRefactor(stack(name), NO_WAIT));

    const run = await executeRefactors(created, NO_WAIT);

    expect(run.failure?.error.details).toMatchObject({ stackName: "C", kind: "execute-failed" });
    // Last first, each back on the template it was deployed with.
    expect(run.failure?.undone.map((entry) => entry.stackName)).toEqual(["B", "A"]);
    expect(run.failure?.undoFailed).toEqual([]);
    expect(run.refactored).toEqual([]);
    for (const name of ["A", "B", "C"])
      expect(cloudFormation.stacks[name]!.template).toEqual(DEPLOYED);
    const undo = cloudFormation.calls
      .filter((call) => call.command === "CreateStackRefactorCommand")
      .at(-1)!;
    expect(undo.input).toMatchObject({
      StackDefinitions: [{ StackName: "A", TemplateBody: JSON.stringify(DEPLOYED) }],
      ResourceMappings: expect.arrayContaining([
        {
          Source: { StackName: "A", LogicalResourceId: "NewMemory" },
          Destination: { StackName: "A", LogicalResourceId: "OldMemory" },
        },
      ]),
    });
  });

  test("reports an earlier stack it couldn't undo as still refactored", async () => {
    const { stack } = setup(["A", "B"], {
      refactors: ({ stackName, index }) =>
        stackName === "B"
          ? { execute: { status: "EXECUTE_FAILED" } }
          : index === 1
            ? { create: { status: "CREATE_FAILED", reason: "Throttled" } }
            : {},
    });
    const created = [
      await createRefactor(stack("A"), NO_WAIT),
      await createRefactor(stack("B"), NO_WAIT),
    ];

    const run = await executeRefactors(created, NO_WAIT);

    expect(run.failure?.undone).toEqual([]);
    expect(run.failure?.undoFailed.map((entry) => entry.stack.stackName)).toEqual(["A"]);
    expect(run.failure?.undoFailed[0]!.error.message).toContain("Throttled");
    expect(run.refactored.map((entry) => entry.stackName)).toEqual(["A"]);
  });

  test("stops at once on ROLLBACK_FAILED, undoing nothing", async () => {
    const { cloudFormation, stack } = setup(["A", "B"], {
      refactors: ({ stackName }) =>
        stackName === "B" ? { execute: { status: "ROLLBACK_FAILED" } } : {},
    });
    const created = [
      await createRefactor(stack("A"), NO_WAIT),
      await createRefactor(stack("B"), NO_WAIT),
    ];

    const run = await executeRefactors(created, NO_WAIT);

    expect(run.failure?.error.details.kind).toBe("rollback-failed");
    expect(run.failure?.undone).toEqual([]);
    expect(run.refactored.map((entry) => entry.stackName)).toEqual(["A"]);
    expect(
      cloudFormation.calls.filter((call) => call.command === "CreateStackRefactorCommand"),
    ).toHaveLength(2);
  });
});

describe("poll", () => {
  test("gives up after the timeout", async () => {
    await expect(
      poll(
        async () => "IN_PROGRESS",
        () => false,
        { intervalMs: 0, timeoutMs: 0, sleep: async () => {} },
      ),
    ).rejects.toThrow("still not finished after 0 s");
  });
});
