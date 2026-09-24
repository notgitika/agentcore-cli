import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DeployResult, Project, ProjectEvent } from "../../../handlers/project/types";
import { FsReadWriteJson } from "../../../io";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { createSilentLogger, inTempDirectory, TestIdentityClient } from "../../../testing";
import type { AwsClients } from "../../types";
import { ImperativeBackend } from "./imperative";
import type { KindHandlers } from "./imperative/agentcore/notImplemented";
import { Status } from "./imperative/plan/plan";
import { readImperativeState } from "./imperative/state";

/** Ledger bookkeeping across concurrent steps and removals. */

const target: AwsDeploymentTarget = { name: "dev", account: "111122223333", region: "us-east-1" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function project(rootPath: string, memories: string[]): Promise<Project> {
  return {
    name: "Shop",
    rootPath,
    spec: {
      ...ProjectSpecSchema.parse({ name: "Shop", version: 2 }),
      memories: memories.map((name) => ({ name })),
    } as Project["spec"],
  };
}

/**
 * Memories that converge on the first poll after create. remove() deletes the
 * resource but, unlike a careful handler, leaves the stack alone, so the
 * backend has to forget the step itself.
 */
function memories(): KindHandlers {
  const live = new Set<string>();
  return {
    create: (stack, resource) => async () => {
      live.add(resource.name);
      stack.record(`memory:${resource.name}`, { arn: `arn:mem:${resource.name}` });
    },
    poll: (_stack, resource) => async () =>
      live.has(resource.name) ? { status: Status.Successful } : { status: Status.NotStarted },
    remove: (_stack, resource) => async () => {
      live.delete(resource.name);
    },
    pollGone: (_stack, resource) => async () =>
      live.has(resource.name) ? { status: Status.NotStarted } : { status: Status.Successful },
  };
}

function backend(json: FsReadWriteJson, handlers: KindHandlers) {
  return new ImperativeBackend({
    logger: createSilentLogger(),
    clients: {} as AwsClients,
    identity: new TestIdentityClient(),
    json,
    resolveCredentials: async () => async () => ({ accessKeyId: "a", secretAccessKey: "b" }),
    resolveAccount: async () => target.account,
    enableTransactionSearch: async () => {},
    // eslint-disable-next-line require-yield
    provisionCredentials: async function* () {
      return {};
    },
    // eslint-disable-next-line require-yield
    removeCredentials: async function* () {},
    handlers: { memory: handlers },
    supportedKinds: new Set(["memory"]),
    execute: { sleep: async () => {}, concurrency: 4 },
  });
}

async function drain(generator: AsyncGenerator<ProjectEvent, DeployResult>): Promise<DeployResult> {
  let next = await generator.next();
  while (!next.done) next = await generator.next();
  return next.value;
}

const deployInput = { target, confirmTeardown: async () => true };

async function root(): Promise<string> {
  const { path, cleanup } = await inTempDirectory();
  cleanups.push(cleanup);
  await mkdir(join(path, "agentcore"), { recursive: true });
  return path;
}

describe("ImperativeBackend ledger", () => {
  test("concurrent successful steps all land in deployed-state.json", async () => {
    const path = await root();
    const json = new FsReadWriteJson({ logger: createSilentLogger() });
    const names = ["m1", "m2", "m3", "m4", "m5", "m6"];
    await drain(backend(json, memories()).deploy(await project(path, names), deployInput));
    const ledger = await readImperativeState(json, path, target.name);
    expect(Object.keys(ledger.memory ?? {}).sort()).toEqual(names);
  });

  test("concurrent removals all leave the ledger", async () => {
    const path = await root();
    const json = new FsReadWriteJson({ logger: createSilentLogger() });
    const handlers = memories();
    const names = ["m1", "m2", "m3", "m4", "m5", "m6"];
    await drain(backend(json, handlers).deploy(await project(path, names), deployInput));
    await drain(backend(json, handlers).deploy(await project(path, ["m1"]), deployInput));
    const ledger = await readImperativeState(json, path, target.name);
    expect(Object.keys(ledger.memory ?? {})).toEqual(["m1"]);
  });

  test("outputs after a removal exclude the removed resource", async () => {
    const path = await root();
    const json = new FsReadWriteJson({ logger: createSilentLogger() });
    const handlers = memories();
    await drain(backend(json, handlers).deploy(await project(path, ["a", "b"]), deployInput));
    const result = await drain(
      backend(json, handlers).deploy(await project(path, ["a"]), deployInput),
    );
    expect(result.outputs).toEqual({ "memory:a.arn": "arn:mem:a" });
  });
});
