import { describe, expect, test } from "bun:test";
import { createSilentLogger } from "../../../../../testing";
import type { ProgressEvent } from "../../../../../tui/progress";
import {
  Plan,
  PlanFailedError,
  PlanValidationError,
  Status,
  StepFailedError,
  StepNotStartedError,
  StepTimeoutError,
  type ExecuteOptions,
  type PlanResult,
  type Step,
} from "./plan";

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

type Run = { events: ProgressEvent[]; result?: PlanResult; error?: unknown };

/** Drains a plan, collecting events; a thrown PlanFailedError is returned, not rethrown. */
async function run(plan: Plan, overrides: Partial<ExecuteOptions> = {}): Promise<Run> {
  const events: ProgressEvent[] = [];
  const generator = plan.execute({
    logger: createSilentLogger(),
    sleep: async () => {},
    ...overrides,
  });
  try {
    let next = await generator.next();
    while (!next.done) {
      events.push(next.value);
      next = await generator.next();
    }
    return { events, result: next.value };
  } catch (error) {
    return { events, error };
  }
}

function outcome(run: Run, name: string) {
  const outcomes = run.result?.outcomes ?? (run.error as PlanFailedError).result.outcomes;
  return outcomes.find((o) => o.name === name);
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

describe("Plan.execute: one step", () => {
  test("creates a missing resource: do once, then poll to success", async () => {
    const step = scripted("runtime:a", [Status.NotStarted, Status.Successful]);
    const { events, result, error } = await run(new Plan("apply", [step]));
    expect(error).toBeUndefined();
    expect(step.doCalls).toBe(1);
    expect(step.statusCalls).toBe(2);
    expect(events).toEqual([
      { type: "task-start", id: "runtime:a", title: "runtime:a" },
      { type: "task-done", id: "runtime:a" },
    ]);
    expect(result).toEqual({ outcomes: [{ name: "runtime:a", outcome: "succeeded", polls: 2 }] });
  });

  test("updates an outdated resource", async () => {
    const step = scripted("runtime:a", [Status.Outdated, Status.Successful], {
      detail: "description differs",
    });
    const { events, error } = await run(new Plan("apply", [step]));
    expect(error).toBeUndefined();
    expect(step.doCalls).toBe(1);
    expect(events).toContainEqual({
      type: "task-output",
      id: "runtime:a",
      line: "description differs",
    });
  });

  test("leaves a converged resource alone", async () => {
    const step = scripted("runtime:a", [Status.Successful]);
    const { error } = await run(new Plan("apply", [step]));
    expect(error).toBeUndefined();
    expect(step.doCalls).toBe(0);
  });

  test("waits with backoff while the service works", async () => {
    const step = scripted("runtime:a", [
      Status.NotStarted,
      Status.Waiting,
      Status.Waiting,
      Status.Successful,
    ]);
    const delays: number[] = [];
    const { error } = await run(new Plan("apply", [step]), {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(error).toBeUndefined();
    // Poll 1 saw NOT_STARTED and ran do with no delay; polls 2 and 3 waited.
    expect(delays).toEqual([2000, 4000]);
    expect(step.statusCalls).toBe(4);
  });

  test("a FAILED status fails the step and the plan", async () => {
    const step = scripted("runtime:a", [Status.Failed], { detail: "CREATE_FAILED: bad image" });
    const { events, error } = await run(new Plan("apply", [step]));
    expect(error).toBeInstanceOf(PlanFailedError);
    expect((error as Error).message).toBe(
      "apply: 1 step failed: runtime:a (runtime:a failed: CREATE_FAILED: bad image)",
    );
    expect(events).toContainEqual({
      type: "task-failed",
      id: "runtime:a",
      message: "runtime:a failed: CREATE_FAILED: bad image",
    });
    expect(outcome({ events, error }, "runtime:a")).toMatchObject({
      outcome: "failed",
      error: expect.any(StepFailedError),
    });
  });

  test("a step still NOT_STARTED after do is a not-started failure", async () => {
    const step = scripted("runtime:a", [Status.NotStarted, Status.NotStarted]);
    const result = await run(new Plan("apply", [step]));
    expect(step.doCalls).toBe(1);
    expect(outcome(result, "runtime:a")).toMatchObject({
      outcome: "failed",
      error: expect.any(StepNotStartedError),
    });
  });

  test("maxDoAttempts allows a retry of do before giving up", async () => {
    const step = scripted("runtime:a", [Status.NotStarted, Status.NotStarted, Status.Successful]);
    const { error } = await run(new Plan("apply", [step]), { maxDoAttempts: 2 });
    expect(error).toBeUndefined();
    expect(step.doCalls).toBe(2);
  });

  test("a throwing do fails the step with its error", async () => {
    const boom = new Error("AccessDenied");
    const step = scripted("runtime:a", [Status.NotStarted], { doFails: boom });
    const result = await run(new Plan("apply", [step]));
    expect(outcome(result, "runtime:a")).toMatchObject({ outcome: "failed", error: boom });
  });

  test("a throwing status fails only its step", async () => {
    const broken: Step = {
      name: "runtime:a",
      do: async () => {},
      status: async () => {
        throw new Error("ECONNRESET");
      },
    };
    const other = scripted("memory:m", [Status.Successful]);
    const result = await run(new Plan("apply", [broken, other]));
    expect(outcome(result, "runtime:a")).toMatchObject({
      outcome: "failed",
      error: new Error("ECONNRESET"),
    });
    expect(outcome(result, "memory:m")).toMatchObject({ outcome: "succeeded" });
  });

  test("times out a step that never converges", async () => {
    const step = scripted("runtime:a", [Status.Waiting]);
    let clock = 0;
    const result = await run(new Plan("apply", [step]), {
      stepTimeoutMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(outcome(result, "runtime:a")).toMatchObject({
      outcome: "failed",
      error: expect.any(StepTimeoutError),
    });
    // The last sleep is clipped to the remaining budget, never past the deadline.
    expect(clock).toBe(100);
  });

  test("an aborted signal stops the plan before any do runs", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Ctrl+C"));
    const step = scripted("runtime:a", [Status.NotStarted, Status.Successful]);
    const result = await run(new Plan("apply", [step]), { signal: controller.signal });
    expect(step.doCalls).toBe(0);
    expect(outcome(result, "runtime:a")).toMatchObject({
      outcome: "failed",
      error: new Error("Ctrl+C"),
    });
  });
});

describe("Plan.execute: graph", () => {
  test("a child waits for every parent (join)", async () => {
    const log: string[] = [];
    const c = scripted("c", [Status.Successful], { log });
    const a = scripted("a", [Status.NotStarted, Status.Successful], { log, next: [c] });
    const b = scripted("b", [Status.NotStarted, Status.Successful], { log, next: [c] });
    const { error } = await run(new Plan("apply", [a, b]));
    expect(error).toBeUndefined();
    const first = log.indexOf("status:c:SUCCESSFUL");
    expect(first).toBeGreaterThan(log.lastIndexOf("status:a:SUCCESSFUL"));
    expect(first).toBeGreaterThan(log.lastIndexOf("status:b:SUCCESSFUL"));
  });

  test("a failed parent skips its transitive dependents; unrelated steps still run", async () => {
    const c = scripted("c", [Status.Successful]);
    const b = scripted("b", [Status.Successful], { next: [c] });
    const a = scripted("a", [Status.Failed], { next: [b] });
    const d = scripted("d", [Status.NotStarted, Status.Successful]);
    const result = await run(new Plan("apply", [a, d]));
    expect(result.error).toBeInstanceOf(PlanFailedError);
    expect((result.error as Error).message).toMatch(/1 step failed, 2 skipped/);
    expect(outcome(result, "b")).toEqual({ name: "b", outcome: "skipped", blockedBy: "a" });
    expect(outcome(result, "c")).toEqual({ name: "c", outcome: "skipped", blockedBy: "a" });
    expect(outcome(result, "d")).toMatchObject({ outcome: "succeeded" });
    expect(b.statusCalls + c.statusCalls).toBe(0);
    expect(d.doCalls).toBe(1);
  });

  test("respects the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const steps: Step[] = Array.from({ length: 6 }, (_, i) => ({
      name: `s${i}`,
      do: async () => {},
      status: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { status: Status.Successful };
      },
    }));
    const { error, result } = await run(new Plan("apply", steps), { concurrency: 2 });
    expect(error).toBeUndefined();
    expect(peak).toBe(2);
    expect(result!.outcomes).toHaveLength(6);
  });

  test("awaits onStepSucceeded per step before releasing dependents", async () => {
    const persisted: string[] = [];
    const log: string[] = [];
    const b = scripted("b", [Status.Successful], { log });
    const a = scripted("a", [Status.Successful], { log, next: [b] });
    const { error } = await run(new Plan("apply", [a]), {
      onStepSucceeded: async (step) => {
        persisted.push(step.name);
      },
    });
    expect(error).toBeUndefined();
    expect(persisted).toEqual(["a", "b"]);
  });

  test("a throwing onStepSucceeded aborts the plan after running steps finish", async () => {
    const disk = new Error("EACCES deployed-state.json");
    const a = scripted("a", [Status.Successful]);
    const b = scripted("b", [Status.Successful]);
    const { error } = await run(new Plan("apply", [a, b]), {
      onStepSucceeded: async () => {
        throw disk;
      },
    });
    expect(error).toBe(disk);
  });
});
