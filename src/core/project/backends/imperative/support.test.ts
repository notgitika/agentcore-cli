import { describe, expect, test } from "bun:test";
import { NotImplementedError, ProjectStateError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import { assertImperativelyDeployable, SUPPORTED_KINDS } from "./support";

function project(overrides: Record<string, unknown>): Project {
  return {
    name: "Shop",
    rootPath: "/tmp/shop",
    spec: {
      ...ProjectSpecSchema.parse({ name: "Shop", version: 2 }),
      ...overrides,
    } as Project["spec"],
  };
}

describe("assertImperativelyDeployable", () => {
  test("supports runtime, runtime-endpoint and memory", () => {
    expect([...SUPPORTED_KINDS].sort()).toEqual(["memory", "runtime", "runtime-endpoint"]);
  });

  const codeZipRuntime = {
    name: "agent",
    build: "CodeZip",
    entrypoint: "main.py",
    codeLocation: "app/agent",
    runtimeVersion: "PYTHON_3_13",
  };
  const memory = { name: "m", eventExpiryDuration: 30, strategies: [] };

  test.each([
    [
      "a Node runtime version",
      { runtimes: [{ ...codeZipRuntime, runtimeVersion: "NODE_22" }] },
      /NODE_22/,
    ],
    [
      "an authorizer",
      {
        runtimes: [
          { ...codeZipRuntime, authorizerType: "CUSTOM_JWT", authorizerConfiguration: {} },
        ],
      },
      /authorizer/,
    ],
    [
      "filesystem configurations",
      { runtimes: [{ ...codeZipRuntime, filesystemConfigurations: [{}] }] },
      /filesystemConfigurations/,
    ],
    ["connections", { runtimes: [{ ...codeZipRuntime, connections: [{}] }] }, /connections/],
    [
      "memory stream delivery",
      {
        memories: [
          {
            name: "m",
            eventExpiryDuration: 3,
            strategies: [],
            streamDeliveryResources: { resources: [] },
          },
        ],
      },
      /streamDeliveryResources/,
    ],
  ] as const)("refuses %s before any AWS call", (_label, partial, pattern) => {
    expect(() => assertImperativelyDeployable(project(partial), SUPPORTED_KINDS)).toThrow(pattern);
    expect(() => assertImperativelyDeployable(project(partial), SUPPORTED_KINDS)).toThrow(
      NotImplementedError,
    );
  });

  test("a runtime with no connections or filesystems passes the feature guards", () => {
    const p = project({
      runtimes: [{ ...codeZipRuntime, connections: [], filesystemConfigurations: [] }],
    });
    expect(() => assertImperativelyDeployable(p, SUPPORTED_KINDS)).not.toThrow();
  });

  test("a CodeZip Python runtime with a memory and an endpoint passes", () => {
    const p = project({
      runtimes: [{ ...codeZipRuntime, endpoints: { prod: { version: 1 } } }],
      memories: [memory],
    });
    expect(() => assertImperativelyDeployable(p, SUPPORTED_KINDS)).not.toThrow();
  });

  test("a project with only credentials is deployable", () => {
    expect(() =>
      assertImperativelyDeployable(
        project({ credentials: [{ name: "api", authorizerType: "ApiKeyCredentialProvider" }] }),
        SUPPORTED_KINDS,
      ),
    ).not.toThrow();
  });

  test("a Container runtime is refused with a way forward, before anything else", () => {
    const p = project({
      runtimes: [
        { name: "a", build: "Container" },
        { name: "b", build: "CodeZip" },
      ],
      memories: [{ name: "m" }],
    });
    expect(() => assertImperativelyDeployable(p, new Set(["runtime", "memory"]))).toThrow(
      ProjectStateError,
    );
    expect(() => assertImperativelyDeployable(p, new Set(["runtime", "memory"]))).toThrow(
      /runtime 'a' is built as a Container.*CodeZip.*managedBy.*"CDK"/s,
    );
  });

  test("unsupported kinds are listed once each, with the CDK escape hatch", () => {
    const p = project({
      memories: [{ name: "m1" }, { name: "m2" }],
      agentCoreGateways: [{ name: "gw", targets: [{ name: "t" }] }],
    });
    let error: unknown;
    try {
      assertImperativelyDeployable(p, new Set(["memory"]));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NotImplementedError);
    expect((error as Error).message).toMatch(
      /imperative deploy does not support these resource kinds yet: gateway, gateway-target/,
    );
    expect((error as Error).message).toMatch(/managedBy.*"CDK"/);
  });

  test("tool runtimes are refused by name with the CDK escape hatch", () => {
    const p = project({
      memories: [{ name: "m1" }],
      toolRuntimes: [{ name: "search" }],
    });
    let error: unknown;
    try {
      assertImperativelyDeployable(p, new Set(["memory"]));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NotImplementedError);
    expect((error as Error).message).toMatch(/toolRuntimes/);
    expect((error as Error).message).toMatch(/managedBy.*"CDK"/);
  });

  test("everything supported passes", () => {
    const p = project({ memories: [{ name: "m1" }] });
    expect(() => assertImperativelyDeployable(p, new Set(["memory"]))).not.toThrow();
  });
});
