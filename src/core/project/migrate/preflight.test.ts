import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { V0AgentCoreProjectSpecSchema } from "../../../projectSchemas/v0";
import { v0Fixture } from "../legacy/fixtures-test-support";
import { F1_SPEC, fakeGit, writeV0Project, type V0ProjectFiles } from "./migrate-test-support";
import {
  checkCdkPin,
  checkDeployedState,
  checkGit,
  checkProjectFormat,
  checkSupportedResources,
  OLD_CDK_MESSAGE,
  preflight,
} from "./preflight";

const cleanups: Array<() => Promise<void>> = [];
afterEach(() => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function project(options: V0ProjectFiles = {}): Promise<string> {
  const { root, cleanup } = await writeV0Project(options);
  cleanups.push(cleanup);
  return root;
}

describe("checkProjectFormat", () => {
  test("accepts a v0 project and returns its parsed spec", async () => {
    const result = await checkProjectFormat(await project());
    expect(result.check).toEqual({
      name: "v0 project",
      ok: true,
      message: "'CompatA' is a v0 project",
    });
    expect(result.v0Spec?.name).toBe("CompatA");
  });

  test("says a v1 project has nothing to migrate", async () => {
    const result = await checkProjectFormat(
      await project({ spec: { name: "Already", version: 2, managedBy: "CDK" } }),
    );
    expect(result.check.ok).toBe(false);
    expect(result.check.message).toContain("already a v1 project");
    expect(result.v0Spec).toBeUndefined();
  });

  test("rejects an unknown version", async () => {
    const result = await checkProjectFormat(await project({ spec: { ...F1_SPEC, version: 7 } }));
    expect(result.check.message).toContain("has version 7; only v0 projects (version 1)");
  });

  test("reports a spec the v0 schema rejects", async () => {
    const result = await checkProjectFormat(await project({ spec: { ...F1_SPEC, name: "1bad" } }));
    expect(result.check.ok).toBe(false);
    expect(result.check.message).toContain("isn't a valid v0 project");
  });

  test("reports unreadable JSON", async () => {
    const root = await project();
    await writeFile(join(root, "agentcore", "agentcore.json"), "{ not json");
    const result = await checkProjectFormat(root);
    expect(result.check.message).toStartWith("Couldn't read agentcore/agentcore.json");
  });
});

describe("checkGit", () => {
  test("passes a clean working tree", async () => {
    expect(await checkGit("/p", fakeGit({ status: "" }))).toEqual({
      name: "git",
      ok: true,
      message: "working tree is clean",
    });
  });

  test("fails outside a git repository", async () => {
    const check = await checkGit("/p", fakeGit({ insideWorkTree: false }));
    expect(check.ok).toBe(false);
    expect(check.message).toContain("run 'git init' and commit the project");
  });

  test("lists the uncommitted changes, up to five", async () => {
    const status = [" M agentcore/agentcore.json", "?? notes.txt", ...Array(5).fill("?? x")].join(
      "\n",
    );
    const check = await checkGit("/p", fakeGit({ status }));
    expect(check.ok).toBe(false);
    expect(check.message).toContain(
      "Commit or stash these changes first:\n   M agentcore/agentcore.json\n  ?? notes.txt",
    );
    expect(check.message).toEndWith("...and 2 more");
  });

  test("ignores git warnings mixed into the output", async () => {
    const status = "warning: could not open directory 'x/': Permission denied\n";
    expect((await checkGit("/p", fakeGit({ status }))).ok).toBe(true);
  });

  test("asks git about the project directory only", async () => {
    const commands: string[][] = [];
    await checkGit("/p", async (command, options) => {
      commands.push(command);
      expect(options.cwd).toBe("/p");
    });
    expect(commands).toEqual([
      ["git", "rev-parse", "--is-inside-work-tree"],
      ["git", "status", "--porcelain", "--", "."],
    ]);
  });
});

describe("checkCdkPin", () => {
  test.each(["0.1.0-alpha.45", "0.1.0-alpha.54", "0.1.0-alpha.100"])("accepts %s", async (pin) => {
    expect((await checkCdkPin(await project({ cdkPin: pin }))).ok).toBe(true);
  });

  test.each(["0.1.0-alpha.44", "0.1.0-alpha.9", "^0.1.0-alpha.54", "1.0.0"])(
    "rejects %s with the update guidance",
    async (pin) => {
      expect(await checkCdkPin(await project({ cdkPin: pin }))).toEqual({
        name: "cdk dependencies",
        ok: false,
        message: OLD_CDK_MESSAGE,
      });
    },
  );

  test("reports a missing CDK app manifest", async () => {
    const check = await checkCdkPin(await project({ cdkPin: null }));
    expect(check.ok).toBe(false);
    expect(check.message).toStartWith("Couldn't read agentcore/cdk/package.json");
  });
});

describe("checkSupportedResources", () => {
  test("passes a project without unsupported resources", () => {
    expect(checkSupportedResources(V0AgentCoreProjectSpecSchema.parse(F1_SPEC))).toEqual({
      name: "supported resources",
      ok: true,
      message: "no knowledge bases, datasets, or capacity providers",
    });
  });

  test("blocks knowledge bases, naming them", () => {
    const check = checkSupportedResources(v0Fixture("baseline.json"));
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(
      /^This project uses knowledge bases \(.+\), which v1 doesn't support yet/,
    );
    expect(check.message).toContain("compatibility mode");
  });

  test("blocks datasets", () => {
    expect(checkSupportedResources(v0Fixture("top-datasets-nonempty.json")).message).toContain(
      "datasets (",
    );
  });

  test("blocks capacity providers and the runtimes that use them", () => {
    const check = checkSupportedResources(v0Fixture("runtime-capacityProviderArn-only.json"));
    expect(check.ok).toBe(false);
    expect(check.message).toContain("runtimes on capacity providers (");
    expect(checkSupportedResources(v0Fixture("runtime-capacityProvider.json")).message).toContain(
      "capacity providers (",
    );
  });
});

describe("checkDeployedState", () => {
  test("treats a never-deployed project as having nothing to keep", async () => {
    const result = await checkDeployedState(await project({ deployedState: null }));
    expect(result.check).toEqual({
      name: "deployed state",
      ok: true,
      message: "never deployed; no names to keep",
    });
    expect(result.state).toEqual({ targets: {} });
  });

  test("names the deployed targets", async () => {
    const result = await checkDeployedState(await project());
    expect(result.check.message).toBe("deployed to 'default'");
    expect(Object.keys(result.state.targets)).toEqual(["default"]);
  });

  test("fails on state v0 couldn't have written", async () => {
    const result = await checkDeployedState(
      await project({
        deployedState: { targets: { default: { resources: { runtimes: { a: {} } } } } },
      }),
    );
    expect(result.check.ok).toBe(false);
    expect(result.check.message).toContain("isn't valid v0 deployed state");
  });
});

describe("preflight", () => {
  test("runs every check for a v0 project", async () => {
    const result = await preflight(
      await project({ cdkPin: "0.1.0-alpha.40" }),
      fakeGit({ status: "?? x" }),
    );
    expect(result.checks.map((check) => [check.name, check.ok])).toEqual([
      ["v0 project", true],
      ["git", false],
      ["cdk dependencies", false],
      ["supported resources", true],
      ["deployed state", true],
    ]);
    expect(result.context?.v0Spec.name).toBe("CompatA");
  });

  test("stops after the format check when the project isn't v0", async () => {
    const result = await preflight(
      await project({ spec: { name: "Already", version: 2 } }),
      fakeGit({ status: "" }),
    );
    expect(result.checks.map((check) => check.name)).toEqual(["v0 project"]);
    expect(result.context).toBeUndefined();
  });
});
