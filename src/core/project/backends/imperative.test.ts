import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NotImplementedError, ProjectStateError } from "../../../errors";
import type { DeployResult, Project, ProjectEvent } from "../../../handlers/project/types";
import { FsReadWriteJson } from "../../../io";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { createSilentLogger, inTempDirectory, TestIdentityClient } from "../../../testing";
import type { AwsClients } from "../../types";
import { ImperativeBackend, type ImperativeBackendConfig } from "./imperative";
import type { KindHandlers } from "./imperative/agentcore/notImplemented";
import type { CodeArtifact } from "./imperative/artifacts";
import type { CodeZipPackager } from "./imperative/packaging/python";
import { Status } from "./imperative/plan/plan";
import { readImperativeState } from "./imperative/state";
import { fakeClient, sdkError, type FakeClient } from "./imperative/testing";
import { DEPLOYED_STATE_RELATIVE_PATH, readDeployedState } from "./shared/deployedState";

const target: AwsDeploymentTarget = { name: "dev", account: "111122223333", region: "us-east-1" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function project(overrides: Record<string, unknown>): Promise<Project> {
  const { path, cleanup } = await inTempDirectory();
  cleanups.push(cleanup);
  await mkdir(join(path, "agentcore"), { recursive: true });
  return {
    name: "Shop",
    rootPath: path,
    spec: {
      ...ProjectSpecSchema.parse({ name: "Shop", version: 2 }),
      ...overrides,
    } as Project["spec"],
  };
}

/** A memory handler that "creates" on first do() and converges on the next poll. */
function fakeMemory(log: string[]): KindHandlers {
  const created = new Set<string>();
  return {
    create: (stack, resource) => async () => {
      log.push(`create ${resource.name}`);
      created.add(resource.name);
      stack.record(`memory:${resource.name}`, {
        arn: `arn:mem:${resource.name}`,
        id: `id-${resource.name}`,
      });
    },
    poll: (_stack, resource) => async () =>
      created.has(resource.name) ? { status: Status.Successful } : { status: Status.NotStarted },
    remove: (stack, resource) => async () => {
      log.push(`remove ${resource.name}`);
      created.delete(resource.name);
      stack.forget(`memory:${resource.name}`);
    },
    // The stack is seeded from the ledger, so a resource recorded by an earlier
    // deploy exists until remove() forgets it.
    pollGone: (stack, resource) => async () =>
      stack.outputsOf(`memory:${resource.name}`)
        ? { status: Status.NotStarted }
        : { status: Status.Successful },
  };
}

type Harness = {
  backend: ImperativeBackend;
  log: string[];
  json: FsReadWriteJson;
  identity: TestIdentityClient;
};

function harness(overrides: Partial<ImperativeBackendConfig> = {}): Harness {
  const log: string[] = [];
  const json = new FsReadWriteJson({ logger: createSilentLogger() });
  const identity = new TestIdentityClient();
  const backend = new ImperativeBackend({
    logger: createSilentLogger(),
    clients: {} as AwsClients,
    identity,
    json,
    resolveCredentials: async () => async () => ({ accessKeyId: "a", secretAccessKey: "b" }),
    resolveAccount: async () => target.account,
    enableTransactionSearch: async () => {
      log.push("transaction search");
    },
    // eslint-disable-next-line require-yield
    provisionCredentials: async function* (project) {
      log.push("provision credentials");
      return Object.fromEntries(
        project.spec.credentials.map((c) => [
          c.name,
          { credentialProviderArn: `arn:cred:${c.name}` },
        ]),
      );
    },
    // eslint-disable-next-line require-yield
    removeCredentials: async function* (_project, input) {
      log.push(`remove credentials ${input.providers.map((p) => p.name).join(",") || "-"}`);
    },
    handlers: { memory: fakeMemory(log) },
    supportedKinds: new Set(["memory"]),
    execute: { sleep: async () => {} },
    now: () => new Date("2026-09-24T00:00:00.000Z"),
    ...overrides,
  });
  return { backend, log, json, identity };
}

async function drain(
  generator: AsyncGenerator<ProjectEvent, DeployResult>,
): Promise<{ events: ProjectEvent[]; result: DeployResult }> {
  const events: ProjectEvent[] = [];
  let next = await generator.next();
  while (!next.done) {
    events.push(next.value);
    next = await generator.next();
  }
  return { events, result: next.value };
}

const deployInput = (confirm = true) => ({
  target,
  confirmTeardown: async () => confirm,
});

describe("ImperativeBackend.deploy", () => {
  test("refuses when the active credentials belong to another account, before any mutation", async () => {
    const { backend, log } = harness({ resolveAccount: async () => "999999999999" });
    const p = await project({ memories: [{ name: "m" }] });
    await expect(drain(backend.deploy(p, deployInput()))).rejects.toThrow(
      /expects AWS account 111122223333, but the active credentials belong to 999999999999/,
    );
    expect(log).toEqual([]);
  });

  test("refuses an unsupported kind before provisioning anything", async () => {
    const { backend, log } = harness();
    const p = await project({ agentCoreGateways: [{ name: "gw" }] });
    await expect(drain(backend.deploy(p, deployInput()))).rejects.toThrow(NotImplementedError);
    expect(log).toEqual([]);
  });

  test("refuses a target the CDK backend deployed", async () => {
    const { backend, json, log } = harness();
    const p = await project({ memories: [{ name: "m" }] });
    await json.write(join(p.rootPath, DEPLOYED_STATE_RELATIVE_PATH), {
      targets: { dev: { stackArn: "arn:aws:cloudformation:us-east-1:111122223333:stack/S/1" } },
    });
    await expect(drain(backend.deploy(p, deployInput()))).rejects.toThrow(ProjectStateError);
    await expect(drain(backend.deploy(p, deployInput()))).rejects.toThrow(
      /managed by CloudFormation stack .*set managedBy back to "CDK"/s,
    );
    expect(log).toEqual([]);
  });

  test("creates declared resources, records them, enables transaction search and reports outputs", async () => {
    const { backend, log, json } = harness();
    const p = await project({ memories: [{ name: "m" }] });
    const { events, result } = await drain(backend.deploy(p, deployInput()));

    expect(result).toEqual({ outputs: { "memory:m.arn": "arn:mem:m", "memory:m.id": "id-m" } });
    expect(log).toEqual([
      "provision credentials",
      "transaction search",
      "create m",
      "remove credentials -",
    ]);
    expect(
      events.filter((e) => e.type === "step").map((e) => (e as { message: string }).message),
    ).toEqual([
      "Verifying AWS account 111122223333",
      "Enabling CloudWatch Transaction Search",
      "Deploying 1 resource",
    ]);
    expect(events.some((e) => e.type === "task-start" && e.id === "memory:m")).toBe(true);
    expect(events.some((e) => e.type === "task-done" && e.id === "memory:m")).toBe(true);
    expect(await readImperativeState(json, p.rootPath, "dev")).toEqual({
      memory: { m: { arn: "arn:mem:m", id: "id-m", updatedAt: "2026-09-24T00:00:00.000Z" } },
    });
  });

  test("skips transaction search when the input opts out", async () => {
    const { backend, log } = harness();
    const p = await project({ memories: [{ name: "m" }] });
    await drain(backend.deploy(p, { ...deployInput(), transactionSearch: false }));
    expect(log).not.toContain("transaction search");
  });

  test("a transaction search failure is reported as a step and does not fail the deploy", async () => {
    const { backend } = harness({
      enableTransactionSearch: async () => {
        throw new Error("no permission");
      },
    });
    const p = await project({ memories: [{ name: "m" }] });
    const { events, result } = await drain(backend.deploy(p, deployInput()));
    expect(events).toContainEqual({
      type: "step",
      message: "Skipping Transaction Search: no permission",
    });
    expect(result.outputs["memory:m.arn"]).toBe("arn:mem:m");
  });

  test("removes recorded resources the spec no longer declares, after the declared ones converge", async () => {
    const { backend, log, json } = harness();
    const p = await project({ memories: [{ name: "keep" }] });
    await json.write(join(p.rootPath, DEPLOYED_STATE_RELATIVE_PATH), {
      targets: {
        dev: {
          resources: {
            imperative: {
              memory: { gone: { arn: "arn:mem:gone", id: "id-gone", updatedAt: "old" } },
            },
          },
        },
      },
    });
    const { events, result } = await drain(backend.deploy(p, deployInput()));
    expect(log).toEqual([
      "provision credentials",
      "transaction search",
      "create keep",
      "remove gone",
      "remove credentials -",
    ]);
    expect(events).toContainEqual({
      type: "step",
      message: "Removing 1 resource no longer declared",
    });
    expect(result.outputs).toEqual({
      "memory:keep.arn": "arn:mem:keep",
      "memory:keep.id": "id-keep",
    });
    expect(await readImperativeState(json, p.rootPath, "dev")).toEqual({
      memory: {
        keep: { arn: "arn:mem:keep", id: "id-keep", updatedAt: "2026-09-24T00:00:00.000Z" },
      },
    });
  });

  test("a credentials-only project provisions and returns no outputs", async () => {
    const { backend, log } = harness();
    const p = await project({
      credentials: [{ name: "api", authorizerType: "ApiKeyCredentialProvider" }],
    });
    const { result } = await drain(backend.deploy(p, deployInput()));
    expect(result).toEqual({ outputs: {} });
    expect(log).toEqual(["provision credentials"]);
  });

  test("an empty project with nothing recorded is an error, not a teardown", async () => {
    const { backend } = harness();
    const p = await project({});
    await expect(drain(backend.deploy(p, deployInput()))).rejects.toThrow(
      /declares no resources to deploy, and nothing is recorded/,
    );
  });

  test("an empty project with recorded resources is a teardown that needs confirmation", async () => {
    const { backend, json, log } = harness();
    const p = await project({});
    const statePath = join(p.rootPath, DEPLOYED_STATE_RELATIVE_PATH);
    const recorded = {
      targets: {
        dev: {
          resources: {
            credentials: {
              api: { credentialProviderArn: "arn:c", authorizerType: "ApiKeyCredentialProvider" },
            },
            imperative: { memory: { m: { arn: "arn:mem:m", id: "id-m", updatedAt: "old" } } },
          },
        },
        prod: { stackArn: "arn:other" },
      },
    };
    await json.write(statePath, recorded);

    await expect(drain(backend.deploy(p, deployInput(false)))).rejects.toThrow(
      /would delete 1 resource.*memory:m.*--yes/s,
    );
    expect(log).toEqual(["provision credentials"]);

    // A declined teardown still records the (empty) provisioned credentials, as the
    // CDK backend does, so restore the recorded providers before confirming.
    await json.write(statePath, recorded);
    log.length = 0;
    const { result } = await drain(backend.deploy(p, deployInput(true)));
    expect(result).toEqual({ outputs: {}, tornDown: true });
    expect(log).toEqual(["provision credentials", "remove m", "remove credentials api"]);
    const state = await readDeployedState(json, p.rootPath);
    expect(state.targets["dev"]).toBeUndefined();
    expect(state.targets["prod"]).toEqual({ stackArn: "arn:other" });
  });

  test("a failed step surfaces as a PlanFailedError after the others finish, and records nothing for it", async () => {
    const log: string[] = [];
    const failing: KindHandlers = {
      ...fakeMemory(log),
      poll: (_stack, resource) => async () =>
        resource.name === "bad"
          ? { status: Status.Failed, detail: "CREATE_FAILED: quota" }
          : { status: Status.Successful },
    };
    const { backend, json } = harness({ handlers: { memory: failing } });
    const p = await project({ memories: [{ name: "good" }, { name: "bad" }] });
    await expect(drain(backend.deploy(p, deployInput()))).rejects.toThrow(
      /memory:bad.*CREATE_FAILED: quota/s,
    );
    // The sibling that converged is recorded; the failed step is not.
    expect(await readImperativeState(json, p.rootPath, "dev")).toEqual({
      memory: { good: { updatedAt: "2026-09-24T00:00:00.000Z" } },
    });
  });
});

const codeZipRuntime = (name: string) => ({
  name,
  build: "CodeZip",
  entrypoint: "main.py",
  codeLocation: `app/${name}`,
  runtimeVersion: "PYTHON_3_13",
});

type CodeZipHarness = Harness & {
  packaged: string[];
  s3: FakeClient;
  seen: Map<string, CodeArtifact | undefined>;
};

/**
 * A harness whose packager writes a real zip (uploadArtifact reads it from disk),
 * whose S3 client is a fake, and whose runtime handler records the artifact the
 * stack handed it. `order` interleaves packaging, provisioning, upload and create.
 */
function codeZipHarness(
  order: string[],
  options: {
    packager?: CodeZipPackager;
    s3?: Parameters<typeof fakeClient>[0];
  } = {},
): CodeZipHarness {
  const packaged: string[] = [];
  const seen = new Map<string, CodeArtifact | undefined>();
  const packager: CodeZipPackager =
    options.packager ??
    (async ({ codeDir, buildDir, report }) => {
      order.push("package");
      packaged.push(codeDir);
      report?.("Resolved 1 package");
      await mkdir(buildDir, { recursive: true });
      const zipPath = join(buildDir, "code.zip");
      await writeFile(zipPath, "zip");
      return { zipPath, sizeBytes: 3, sha256: "deadbeef" };
    });
  const s3 = fakeClient(
    options.s3 ?? {
      HeadBucketCommand: () => ({}),
      HeadObjectCommand: () => {
        throw sdkError("NotFound", 404);
      },
      PutObjectCommand: () => {
        order.push("upload");
        return {};
      },
    },
  );
  const created = new Set<string>();
  const runtime: KindHandlers = {
    create: (stack, resource) => async () => {
      order.push("create");
      seen.set(resource.name, stack.artifacts.get(resource.name));
      created.add(resource.name);
      stack.record(`runtime:${resource.name}`, { arn: `arn:rt:${resource.name}`, id: "rt-1" });
    },
    poll: (_stack, resource) => async () =>
      created.has(resource.name) ? { status: Status.Successful } : { status: Status.NotStarted },
    remove: (stack, resource) => async () => {
      order.push(`remove ${resource.name}`);
      stack.forget(`runtime:${resource.name}`);
    },
    pollGone: (stack, resource) => async () =>
      stack.outputsOf(`runtime:${resource.name}`)
        ? { status: Status.NotStarted }
        : { status: Status.Successful },
  };
  const base = harness({
    clients: { s3: () => s3 } as unknown as AwsClients,
    packager,
    handlers: { runtime },
    supportedKinds: new Set(["runtime"]),
    // eslint-disable-next-line require-yield
    provisionCredentials: async function* () {
      order.push("provision");
      return {};
    },
  });
  return { ...base, packaged, s3, seen };
}

async function drainBuild(generator: AsyncGenerator<ProjectEvent, void>): Promise<ProjectEvent[]> {
  const events: ProjectEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("ImperativeBackend.build", () => {
  test("build packages every CodeZip runtime and uploads nothing", async () => {
    const order: string[] = [];
    const { backend, packaged, s3 } = codeZipHarness(order);
    const p = await project({ runtimes: [codeZipRuntime("agent"), codeZipRuntime("helper")] });
    const events = await drainBuild(backend.build(p));

    expect(packaged).toEqual([join(p.rootPath, "app/agent"), join(p.rootPath, "app/helper")]);
    for (const name of ["agent", "helper"]) {
      expect(events).toContainEqual({
        type: "task-start",
        id: `package:${name}`,
        title: `Packaging runtime '${name}'`,
      });
      expect(events).toContainEqual({
        type: "task-output",
        id: `package:${name}`,
        line: "Resolved 1 package",
      });
      expect(events).toContainEqual({ type: "task-done", id: `package:${name}` });
    }
    expect(s3.sent).toEqual([]);
  });

  test("build refuses an undeployable spec before packaging", async () => {
    const order: string[] = [];
    const { backend, packaged } = codeZipHarness(order);
    const p = await project({
      runtimes: [{ ...codeZipRuntime("agent"), runtimeVersion: "NODE_22" }],
    });
    await expect(drainBuild(backend.build(p))).rejects.toThrow(NotImplementedError);
    expect(packaged).toEqual([]);
  });
});

describe("ImperativeBackend.deploy with CodeZip runtimes", () => {
  test("deploy packages before provisioning credentials and uploads before the plan runs", async () => {
    const order: string[] = [];
    const { backend, s3, seen } = codeZipHarness(order);
    const p = await project({ runtimes: [codeZipRuntime("agent")] });
    await drain(backend.deploy(p, deployInput()));

    expect(order).toEqual(["package", "provision", "upload", "create"]);
    const put = s3.sent.find((c) => c.name === "PutObjectCommand")!.input;
    expect(put["Key"]).toBe("Shop/dev/agent/deadbeef.zip");
    expect(put["Bucket"]).toBe("agentcore-cli-111122223333-us-east-1");
    expect(seen.get("agent")).toEqual({
      bucket: "agentcore-cli-111122223333-us-east-1",
      key: "Shop/dev/agent/deadbeef.zip",
      sha256: "deadbeef",
      sizeBytes: 3,
    });
  });

  test("deploy skips the upload when the object already exists", async () => {
    const order: string[] = [];
    const { backend, s3, seen } = codeZipHarness(order, {
      s3: { HeadBucketCommand: () => ({}), HeadObjectCommand: () => ({}) },
    });
    const p = await project({ runtimes: [codeZipRuntime("agent")] });
    const { events } = await drain(backend.deploy(p, deployInput()));

    expect(s3.sent.map((c) => c.name)).toEqual(["HeadBucketCommand", "HeadObjectCommand"]);
    expect(events).toContainEqual({
      type: "output",
      line: "agent: already present Shop/dev/agent/deadbeef.zip",
    });
    expect(seen.get("agent")?.key).toBe("Shop/dev/agent/deadbeef.zip");
  });

  test("a packaging failure stops the deploy before credentials are provisioned", async () => {
    const order: string[] = [];
    const { backend, s3 } = codeZipHarness(order, {
      packager: async () => {
        throw new Error("uv failed");
      },
    });
    const p = await project({ runtimes: [codeZipRuntime("agent")] });
    const events: ProjectEvent[] = [];
    const generator = backend.deploy(p, deployInput());
    await expect(
      (async () => {
        for await (const event of generator) events.push(event);
      })(),
    ).rejects.toThrow("uv failed");
    expect(events).toContainEqual({
      type: "task-failed",
      id: "package:agent",
      message: "uv failed",
    });
    expect(order).not.toContain("provision");
    expect(s3.sent).toEqual([]);
  });

  test("a teardown deploy does not package or touch S3", async () => {
    const order: string[] = [];
    let confirmed = false;
    const { backend, json, s3, packaged } = codeZipHarness(order);
    const p = await project({});
    await json.write(join(p.rootPath, DEPLOYED_STATE_RELATIVE_PATH), {
      targets: {
        dev: {
          resources: {
            imperative: { runtime: { agent: { arn: "arn:rt:agent", id: "rt-1", updatedAt: "t" } } },
          },
        },
      },
    });
    const { result } = await drain(
      backend.deploy(p, {
        target,
        confirmTeardown: async () => {
          confirmed = true;
          return true;
        },
      }),
    );
    expect(result).toEqual({ outputs: {}, tornDown: true });
    expect(confirmed).toBe(true);
    expect(order).toEqual(["provision", "remove agent"]);
    expect(packaged).toEqual([]);
    expect(s3.sent).toEqual([]);
  });
});

describe("ImperativeBackend.resolveProjectResources", () => {
  test("reports recorded resources as deployed and the rest as local-only, nesting children", async () => {
    const { backend, json } = harness();
    const p = await project({
      memories: [{ name: "m" }],
      credentials: [{ name: "api", authorizerType: "ApiKeyCredentialProvider" }],
      agentCoreGateways: [{ name: "gw", targets: [{ name: "t" }] }],
    });
    await json.write(join(p.rootPath, DEPLOYED_STATE_RELATIVE_PATH), {
      targets: {
        dev: {
          resources: {
            credentials: { api: { credentialProviderArn: "arn:c" } },
            imperative: {
              memory: { m: { arn: "arn:m", updatedAt: "t" } },
              "gateway-target": { "gw/t": { id: "t-1", updatedAt: "t" } },
            },
          },
        },
      },
    });
    expect(await backend.resolveProjectResources(p, { target })).toEqual([
      { resourceType: "memory", name: "m", deploymentState: "deployed", arn: "arn:m" },
      { resourceType: "credential", name: "api", deploymentState: "deployed", arn: "arn:c" },
      {
        resourceType: "gateway",
        name: "gw",
        deploymentState: "local-only",
        children: [
          { resourceType: "gateway-target", name: "t", deploymentState: "deployed", id: "t-1" },
        ],
      },
    ]);
  });
});

describe("ImperativeBackend.resolveDeployedResources", () => {
  test("fails when nothing is recorded for the target", async () => {
    const { backend } = harness();
    const p = await project({ runtimes: [{ name: "r" }] });
    await expect(backend.resolveDeployedResources(p, { target })).rejects.toThrow(
      /not deployed to target 'dev'/,
    );
  });

  test("returns runtimes and harnesses with a recorded id and the resolved credentials", async () => {
    const { backend, json } = harness();
    const p = await project({
      runtimes: [{ name: "r" }, { name: "pending" }],
      harnesses: [{ name: "h" }],
    });
    await json.write(join(p.rootPath, DEPLOYED_STATE_RELATIVE_PATH), {
      targets: {
        dev: {
          resources: {
            imperative: {
              runtime: { r: { arn: "arn:r", id: "r-1", updatedAt: "t" } },
              harness: { h: { arn: "arn:h", id: "h-1", updatedAt: "t" } },
            },
          },
        },
      },
    });
    const resolved = await backend.resolveDeployedResources(p, { target });
    expect(resolved.map(({ resourceType, name, id }) => ({ resourceType, name, id }))).toEqual([
      { resourceType: "runtime", name: "r", id: "r-1" },
      { resourceType: "harness", name: "h", id: "h-1" },
    ]);
    expect(resolved[0]!.target).toEqual(target);
    expect(typeof resolved[0]!.credentialProvider).toBe("function");
  });
});
