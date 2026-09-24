import { describe, expect, test } from "bun:test";
import { createSilentLogger } from "../../../../../testing";
import type { AwsClients } from "../../../../types";
import { AgentCoreStack } from "./stack";

const clients = {} as AwsClients;
const credentials = { accessKeyId: "a", secretAccessKey: "b" };
const scope = {
  projectName: "Shop",
  targetName: "dev",
  account: "111122223333",
  region: "us-east-1",
  rootPath: "/project",
};

describe("AgentCoreStack", () => {
  test("seeds its data from the recorded state and exposes it as outputs", () => {
    const stack = new AgentCoreStack(scope, clients, credentials, createSilentLogger(), {
      memory: { orders: { arn: "arn:m", id: "m-1", updatedAt: "t" } },
      "gateway-target": { "tools/get": { id: "gt-1", updatedAt: "t" } },
    });
    expect(stack.outputsOf("memory:orders")).toEqual({ arn: "arn:m", id: "m-1" });
    expect(stack.outputsOf("gateway-target:tools/get")).toEqual({ id: "gt-1" });
    expect(stack.outputs()).toEqual({
      "memory:orders.arn": "arn:m",
      "memory:orders.id": "m-1",
      "gateway-target:tools/get.id": "gt-1",
    });
  });

  test("record replaces and forget removes", () => {
    const stack = new AgentCoreStack(scope, clients, credentials, createSilentLogger(), {});
    stack.record("runtime:a", { arn: "arn:1" });
    stack.record("runtime:a", { arn: "arn:2", id: "r-2" });
    expect(stack.outputsOf("runtime:a")).toEqual({ arn: "arn:2", id: "r-2" });
    stack.forget("runtime:a");
    expect(stack.outputsOf("runtime:a")).toBeUndefined();
    expect(stack.outputs()).toEqual({});
  });

  test("names and tags come from the scope", () => {
    const stack = new AgentCoreStack(scope, clients, credentials, createSilentLogger(), {});
    expect(stack.name("runtime", "checkout")).toBe("Shop_dev_checkout");
    expect(stack.tags({ team: "payments" })).toEqual({
      "agentcore:project-name": "Shop",
      "agentcore:target-name": "dev",
      "agentcore:managed-by": "imperative",
      team: "payments",
    });
    expect(stack.options()).toEqual({ region: "us-east-1", credentials });
  });
});
