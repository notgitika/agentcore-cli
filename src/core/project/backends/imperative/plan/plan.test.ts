import { describe, expect, test } from "bun:test";
import { Plan, PlanValidationError, Status, type Step } from "./plan";

type Scripted = Step & { doCalls: number; statusCalls: number };

/**
 * A step whose status reports follow `reports` in order (the last one repeats)
 * and whose do() appends to `log`, so tests can assert what ran and in what order.
 */
function scripted(
  name: string,
  reports: Status[],
  options: { next?: Step[]; log?: string[]; doFails?: Error; detail?: string } = {},
): Scripted {
  const step: Scripted = {
    name,
    next: options.next,
    doCalls: 0,
    statusCalls: 0,
    do: async () => {
      step.doCalls += 1;
      options.log?.push(`do:${name}`);
      if (options.doFails) throw options.doFails;
    },
    status: async () => {
      const status = reports[Math.min(step.statusCalls, reports.length - 1)]!;
      step.statusCalls += 1;
      options.log?.push(`status:${name}:${status}`);
      return { status, detail: options.detail };
    },
  };
  return step;
}

describe("Plan.validate", () => {
  test("rejects a step without do or status", () => {
    const broken = { name: "x", do: async () => {} } as unknown as Step;
    expect(() => new Plan("p", [broken]).validate()).toThrow(PlanValidationError);
  });

  test("rejects two different steps with the same name", () => {
    const a = scripted("dup", [Status.Successful]);
    const b = scripted("dup", [Status.Successful]);
    expect(() => new Plan("p", [a, b]).validate()).toThrow(/two different steps are named 'dup'/);
  });

  test("rejects a cycle", () => {
    const next: Step[] = [];
    const a: Step = {
      name: "a",
      do: async () => {},
      status: async () => ({ status: Status.Successful }),
      next,
    };
    const b: Step = {
      name: "b",
      do: async () => {},
      status: async () => ({ status: Status.Successful }),
      next: [a],
    };
    next.push(b);
    expect(() => new Plan("p", [a]).validate()).toThrow(/cycle a -> b -> a/);
  });

  test("accepts a diamond and computes parents once per edge", () => {
    const d = scripted("d", [Status.Successful]);
    const b = scripted("b", [Status.Successful], { next: [d] });
    const c = scripted("c", [Status.Successful], { next: [d] });
    const a = scripted("a", [Status.Successful], { next: [b, c] });
    const validated = new Plan("p", [a]).validate();
    expect(validated.roots).toEqual(["a"]);
    expect([...validated.parents.get("d")!]).toEqual(["b", "c"]);
    expect(validated.steps.size).toBe(4);
  });

  test("a step listed as a root but reachable from another is not a root", () => {
    const b = scripted("b", [Status.Successful]);
    const a = scripted("a", [Status.Successful], { next: [b] });
    expect(new Plan("p", [a, b]).validate().roots).toEqual(["a"]);
  });
});
