import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FsReadWriteJson } from "../../../../io";
import { createSilentLogger, inTempDirectory } from "../../../../testing";
import { DEPLOYED_STATE_RELATIVE_PATH, readDeployedState } from "../shared/deployedState";
import {
  forgetImperativeResource,
  hasCdkBinding,
  imperativeStateOf,
  readImperativeState,
  recordImperativeResource,
} from "./state";

const now = () => new Date("2026-09-24T00:00:00.000Z");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const { path: root, cleanup } = await inTempDirectory();
  cleanups.push(cleanup);
  const json = new FsReadWriteJson({ logger: createSilentLogger() });
  return { root, json, statePath: join(root, DEPLOYED_STATE_RELATIVE_PATH) };
}

describe("imperative state", () => {
  test("reads an empty ledger when nothing was recorded", async () => {
    const { root, json } = await fixture();
    expect(await readImperativeState(json, root, "dev")).toEqual({});
  });

  test("records outputs under kind and key with a timestamp, merging per target", async () => {
    const { root, json } = await fixture();
    await recordImperativeResource(
      json,
      root,
      "dev",
      "memory",
      "orders",
      { arn: "arn:m", id: "m-1" },
      now,
    );
    await recordImperativeResource(json, root, "dev", "runtime", "checkout", { arn: "arn:r" }, now);
    await recordImperativeResource(json, root, "prod", "memory", "orders", { arn: "arn:p" }, now);

    expect(await readImperativeState(json, root, "dev")).toEqual({
      memory: { orders: { arn: "arn:m", id: "m-1", updatedAt: "2026-09-24T00:00:00.000Z" } },
      runtime: { checkout: { arn: "arn:r", updatedAt: "2026-09-24T00:00:00.000Z" } },
    });
    expect(await readImperativeState(json, root, "prod")).toEqual({
      memory: { orders: { arn: "arn:p", updatedAt: "2026-09-24T00:00:00.000Z" } },
    });
  });

  test("forgetting the last key drops the kind; forgetting an unknown key is a no-op", async () => {
    const { root, json } = await fixture();
    await recordImperativeResource(json, root, "dev", "memory", "orders", { arn: "arn:m" }, now);
    await forgetImperativeResource(json, root, "dev", "memory", "nope");
    expect(await readImperativeState(json, root, "dev")).toEqual({
      memory: { orders: { arn: "arn:m", updatedAt: "2026-09-24T00:00:00.000Z" } },
    });
    await forgetImperativeResource(json, root, "dev", "memory", "orders");
    expect(await readImperativeState(json, root, "dev")).toEqual({});
  });

  test("preserves the credentials map and unknown keys beside the ledger", async () => {
    const { root, json, statePath } = await fixture();
    await json.write(statePath, {
      targets: {
        dev: { resources: { credentials: { api: { credentialProviderArn: "arn:c" } }, custom: 1 } },
      },
    });
    await recordImperativeResource(json, root, "dev", "memory", "orders", { arn: "arn:m" }, now);
    const state = await readDeployedState(json, root);
    expect(state.targets["dev"]?.resources?.credentials).toEqual({
      api: { credentialProviderArn: "arn:c" },
    });
    const resources = state.targets["dev"]?.resources as Record<string, unknown> | undefined;
    expect(resources?.["custom"]).toBe(1);
  });

  test("hasCdkBinding follows the stack reference", () => {
    expect(hasCdkBinding(undefined)).toBe(false);
    expect(hasCdkBinding({ resources: {} })).toBe(false);
    expect(hasCdkBinding({ stackArn: "arn:aws:cloudformation:us-east-1:1:stack/S/x" })).toBe(true);
    expect(hasCdkBinding({ resources: { stackName: "S" } })).toBe(true);
  });

  test("imperativeStateOf tolerates a malformed record by dropping it", () => {
    expect(
      imperativeStateOf({
        resources: { imperative: { memory: { good: { arn: "a", updatedAt: "t" }, bad: 42 } } },
      }),
    ).toEqual({ memory: { good: { arn: "a", updatedAt: "t" } } });
  });

  test("a record or forget keeps raw entries that do not parse", async () => {
    const { root, json, statePath } = await fixture();
    const legacy = { arn: "arn:legacy" };
    await json.write(statePath, {
      targets: {
        dev: {
          resources: {
            imperative: {
              memory: { legacy, doomed: { arn: "arn:d", updatedAt: "t" } },
              gateway: { odd: 42 },
            },
          },
        },
      },
    });
    await recordImperativeResource(json, root, "dev", "memory", "orders", { arn: "arn:m" }, now);
    await forgetImperativeResource(json, root, "dev", "memory", "doomed");
    const state = await readDeployedState(json, root);
    const resources = state.targets["dev"]?.resources as Record<string, unknown> | undefined;
    const raw = resources?.["imperative"];
    expect(raw).toEqual({
      memory: { legacy, orders: { arn: "arn:m", updatedAt: "2026-09-24T00:00:00.000Z" } },
      gateway: { odd: 42 },
    });
    // Reads still filter them out.
    expect(await readImperativeState(json, root, "dev")).toEqual({
      memory: { orders: { arn: "arn:m", updatedAt: "2026-09-24T00:00:00.000Z" } },
    });
  });
});
