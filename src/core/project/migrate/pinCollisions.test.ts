import { describe, expect, test } from "bun:test";
import { pinCollisions } from "./pinCollisions";

describe("pinCollisions", () => {
  test("accepts pins that no other resource claims", () => {
    expect(
      pinCollisions("P", {
        runtimes: [{ name: "a", resourceName: "P_a" }, { name: "b" }],
        memories: [{ name: "a", resourceName: "P_a" }],
      }),
    ).toEqual([]);
  });

  test("rejects a pin another unpinned resource composes to on some target", () => {
    // Unpinned `y` composes to P_<target>_y, so on target `default` it would be P_default_y.
    const problems = pinCollisions("P", {
      runtimes: [{ name: "x", resourceName: "P_default_y" }, { name: "y" }],
    });
    expect(problems).toEqual([
      {
        file: "agentcore/agentcore.json",
        path: "runtimes[x].resourceName",
        message:
          'the runtime name \'P_default_y\' kept for runtime "x" is also the name of runtime "y"; ' +
          'rename runtime "y" before migrating',
      },
    ]);
  });

  test("rejects two resources pinned to one name, across tool and agent runtimes", () => {
    const problems = pinCollisions("P", {
      runtimes: [{ name: "agent", resourceName: "P_shared" }],
      toolRuntimes: [
        { name: "tool", compute: { runtime: { name: "shared", resourceName: "P_shared" } } },
      ],
    });
    expect(problems.map((problem) => problem.path)).toEqual([
      "toolRuntimes[tool].compute.runtime.resourceName",
    ]);
  });

  test("compares ECR repositories case-insensitively and policies verbatim", () => {
    expect(
      pinCollisions("P", {
        runtimes: [
          { name: "One", build: "Container", repositoryName: "p/two" },
          { name: "Two", build: "Container" },
        ],
      }).map((problem) => problem.path),
    ).toEqual(["runtimes[One].repositoryName"]);
    expect(
      pinCollisions("P", {
        policyEngines: [
          { name: "a", policies: [{ name: "pol", resourceName: "pol" }] },
          { name: "b", policies: [{ name: "pol" }] },
        ],
      }).map((problem) => problem.path),
    ).toEqual(["policyEngines[a].policies[pol].resourceName"]);
  });

  test("checks evaluator and gateway-target Lambda names together", () => {
    expect(
      pinCollisions("P", {
        evaluators: [
          {
            name: "judge",
            config: { codeBased: { managed: { functionName: "P-eval-judge" } } },
          },
        ],
        agentCoreGateways: [
          {
            name: "gw",
            targets: [{ name: "t", compute: { host: "Lambda", functionName: "P-eval-judge" } }],
          },
        ],
      }).map((problem) => problem.path),
    ).toEqual(["agentCoreGateways[gw].targets[t].compute.functionName"]);
  });
});
