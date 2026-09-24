import { describe, expect, test } from "bun:test";
import { testIO, tick, waitFor } from "../testing";
import {
  applyProgressEvent,
  driveProgress,
  runWithProgress,
  settleProgress,
  type ProgressEvent,
} from "./progress";

// Ink writes cursor/erase sequences around each frame; the assertions here
// care about frame text, not terminal control. Built without a control-char
// literal so lint stays quiet.
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, "");
}

async function* scripted<T>(
  events: ProgressEvent[],
  outcome: { result: T } | { failure: Error },
): AsyncGenerator<ProgressEvent, T> {
  yield* events;
  if ("failure" in outcome) throw outcome.failure;
  return outcome.result;
}

describe("runWithProgress plain path (no TTY)", () => {
  test("writes step and warning lines, drops output lines, and resolves the return value", async () => {
    const io = testIO();

    const result = await runWithProgress(
      scripted(
        [
          { type: "warning", message: "Legacy CDK version" },
          { type: "step", message: "Step one" },
          { type: "output", line: "noisy detail" },
          { type: "step", message: "Step two" },
        ],
        { result: 7 },
      ),
      { io: io.io },
    );

    expect(result).toBe(7);
    expect(io.stderr()).toBe("Warning: Legacy CDK version\nStep one\nStep two");
    expect(io.stdout()).toBe("");
  });

  test("rethrows a failure after writing the steps that ran", async () => {
    const io = testIO();
    const failure = new Error("synth exploded");

    await expect(
      runWithProgress(scripted([{ type: "step", message: "Synthesizing" }], { failure }), {
        io: io.io,
      }),
    ).rejects.toBe(failure);
    expect(io.stderr()).toBe("Synthesizing");
  });

  test("interactive: false forces the plain path even on a TTY", async () => {
    const io = testIO({ isTTY: true });

    await runWithProgress(scripted([{ type: "step", message: "Step one" }], { result: null }), {
      io: io.io,
      interactive: false,
    });

    expect(io.stderr()).toBe("Step one");
  });

  test("prints task starts and failures as plain lines", async () => {
    const io = testIO();
    const result = await runWithProgress(
      scripted(
        [
          { type: "task-start", id: "a", title: "memory:m" },
          { type: "task-output", id: "a", line: "CREATING" },
          { type: "task-done", id: "a" },
          { type: "task-start", id: "b", title: "runtime:r" },
          { type: "task-failed", id: "b", message: "CREATE_FAILED" },
        ],
        { result: 1 },
      ),
      { io: io.io },
    );
    expect(result).toBe(1);
    expect(io.stderr()).toBe("memory:m\nruntime:r\nFailed: runtime:r: CREATE_FAILED");
  });
});

describe("runWithProgress interactive path", () => {
  test("stops a transient display on failure without replacing the error", async () => {
    const io = testIO({ isTTY: true });
    const failure = new Error("invoke failed");
    await expect(
      runWithProgress(
        async () => {
          await waitFor(() => io.stderr().includes("Waiting"));
          throw failure;
        },
        { io: io.io, label: "Waiting" },
      ),
    ).rejects.toBe(failure);
    const completed = io.stderr();
    await tick(120);
    expect(io.stderr()).toBe(completed);
    expect(io.stdout()).toBe("");
  });

  test("callback operations stay silent in screen-reader mode", async () => {
    const previous = process.env.INK_SCREEN_READER;
    process.env.INK_SCREEN_READER = "true";
    const io = testIO({ isTTY: true });
    try {
      expect(await runWithProgress(async () => 42, { io: io.io, label: "Waiting" })).toBe(42);
      expect(io.stderr()).toBe("");
    } finally {
      if (previous === undefined) delete process.env.INK_SCREEN_READER;
      else process.env.INK_SCREEN_READER = previous;
    }
  });

  test("renders every step completed and resolves the return value", async () => {
    const io = testIO({ isTTY: true });

    const result = await runWithProgress(
      scripted(
        [
          { type: "step", message: "Verifying account" },
          { type: "output", line: "identity checked" },
          { type: "step", message: "Deploying stack" },
        ],
        { result: "outputs" },
      ),
      { io: io.io },
    );

    const frames = stripAnsi(io.stderr());
    expect(result).toBe("outputs");
    expect(frames).toContain("✓ Verifying account");
    expect(frames).toContain("✓ Deploying stack");
    // Progress renders on stderr only; stdout stays machine-readable.
    expect(io.stdout()).toBe("");
  });

  test("renders a persistent warning without blocking subsequent steps", async () => {
    const io = testIO({ isTTY: true });

    await runWithProgress(
      scripted(
        [
          { type: "warning", message: "Legacy CDK version" },
          { type: "step", message: "Synthesizing" },
        ],
        { result: null },
      ),
      { io: io.io },
    );

    const frames = stripAnsi(io.stderr());
    expect(frames).toContain("Legacy CDK version");
    expect(frames).toContain("✓ Synthesizing");
  });

  test("marks the failing step ✕, keeps its recent tail, and rethrows", async () => {
    const io = testIO({ isTTY: true });
    const failure = new Error("Access Denied");

    await expect(
      runWithProgress(
        scripted<never>(
          [
            { type: "step", message: "Deploying stack" },
            { type: "output", line: "dropped early line" },
            { type: "output", line: "CREATE_FAILED | RuntimeRole" },
            { type: "output", line: "ROLLBACK_IN_PROGRESS" },
          ],
          { failure },
        ),
        { io: io.io, tailLines: 2 },
      ),
    ).rejects.toBe(failure);

    const frames = stripAnsi(io.stderr());
    expect(frames).toContain("✕ Deploying stack");
    expect(frames).toContain("│ CREATE_FAILED | RuntimeRole");
    expect(frames).toContain("│ ROLLBACK_IN_PROGRESS");
    // The final frame honors tailLines; the oldest line has scrolled away.
    const finalFrame = frames.slice(frames.lastIndexOf("✕ Deploying stack"));
    expect(finalFrame).not.toContain("dropped early line");
  });

  test("tolerates output lines that arrive before the first step", async () => {
    const io = testIO({ isTTY: true });

    const result = await runWithProgress(
      scripted(
        [
          { type: "output", line: "orphan line" },
          { type: "step", message: "Only step" },
        ],
        { result: 1 },
      ),
      { io: io.io },
    );

    expect(result).toBe(1);
    expect(stripAnsi(io.stderr())).toContain("✓ Only step");
  });
});

describe("applyProgressEvent / settleProgress", () => {
  test("a step completes the running task and starts the next", () => {
    let tasks = applyProgressEvent([], { type: "step", message: "synth" });
    expect(tasks).toEqual([{ title: "synth", state: "running", tail: [] }]);

    tasks = applyProgressEvent(tasks, { type: "output", line: "one" });
    tasks = applyProgressEvent(tasks, { type: "step", message: "deploy" });
    expect(tasks).toEqual([
      { title: "synth", state: "done", tail: [] },
      { title: "deploy", state: "running", tail: [] },
    ]);
  });

  test("a warning remains visible and does not become the running task", () => {
    let tasks = applyProgressEvent([], { type: "warning", message: "legacy dependency" });
    tasks = applyProgressEvent(tasks, { type: "step", message: "synth" });
    tasks = settleProgress(tasks, "done");

    expect(tasks).toEqual([
      { title: "legacy dependency", state: "warning", tail: [] },
      { title: "synth", state: "done", tail: [] },
    ]);
  });

  test("output joins the running task's tail, bounded by tailLines", () => {
    let tasks = applyProgressEvent([], { type: "step", message: "deploy" });
    for (const line of ["a", "b", "c"]) {
      tasks = applyProgressEvent(tasks, { type: "output", line }, 2);
    }
    expect(tasks[0]!.tail).toEqual(["b", "c"]);
  });

  test("output before any step is dropped", () => {
    expect(applyProgressEvent([], { type: "output", line: "stray" })).toEqual([]);
  });

  test("settling keeps the tail on failure and clears it on success", () => {
    let tasks = applyProgressEvent([], { type: "step", message: "deploy" });
    tasks = applyProgressEvent(tasks, { type: "output", line: "boom" });

    expect(settleProgress(tasks, "failed")).toEqual([
      { title: "deploy", state: "failed", tail: ["boom"] },
    ]);
    expect(settleProgress(tasks, "done")).toEqual([{ title: "deploy", state: "done", tail: [] }]);
    expect(settleProgress([], "done")).toEqual([]);
  });

  test("identified tasks run alongside the linear step", () => {
    let tasks = applyProgressEvent([], { type: "step", message: "Deploying 2 resources" });
    tasks = applyProgressEvent(tasks, { type: "task-start", id: "memory:m", title: "memory:m" });
    tasks = applyProgressEvent(tasks, { type: "task-start", id: "runtime:a", title: "runtime:a" });
    tasks = applyProgressEvent(tasks, { type: "task-output", id: "runtime:a", line: "CREATING" });
    tasks = applyProgressEvent(tasks, { type: "output", line: "for the step" });
    tasks = applyProgressEvent(tasks, { type: "task-done", id: "memory:m" });
    expect(tasks).toEqual([
      { title: "Deploying 2 resources", state: "running", tail: ["for the step"] },
      { id: "memory:m", title: "memory:m", state: "done", tail: [] },
      { id: "runtime:a", title: "runtime:a", state: "running", tail: ["CREATING"] },
    ]);
  });

  test("a failed task keeps its tail and appends the failure message", () => {
    let tasks = applyProgressEvent([], { type: "task-start", id: "t", title: "runtime:a" });
    tasks = applyProgressEvent(tasks, { type: "task-output", id: "t", line: "CREATING" });
    tasks = applyProgressEvent(tasks, { type: "task-failed", id: "t", message: "CREATE_FAILED" });
    expect(tasks).toEqual([
      { id: "t", title: "runtime:a", state: "failed", tail: ["CREATING", "CREATE_FAILED"] },
    ]);
  });

  test("a later step settles the linear task but not identified tasks", () => {
    let tasks = applyProgressEvent([], { type: "step", message: "one" });
    tasks = applyProgressEvent(tasks, { type: "task-start", id: "t", title: "t" });
    tasks = applyProgressEvent(tasks, { type: "step", message: "two" });
    expect(tasks.map((task) => [task.title, task.state])).toEqual([
      ["one", "done"],
      ["t", "running"],
      ["two", "running"],
    ]);
  });

  test("a reused id addresses the latest task, never a settled one", () => {
    let tasks = applyProgressEvent([], { type: "task-start", id: "t", title: "apply" });
    tasks = applyProgressEvent(tasks, { type: "task-done", id: "t" });
    tasks = applyProgressEvent(tasks, { type: "task-start", id: "t", title: "retry" });
    tasks = applyProgressEvent(tasks, { type: "task-output", id: "t", line: "CREATING" });
    expect(tasks.map((task) => [task.title, task.state, task.tail])).toEqual([
      ["apply", "done", []],
      ["retry", "running", ["CREATING"]],
    ]);
    const failed = applyProgressEvent(tasks, { type: "task-failed", id: "t", message: "boom" });
    expect(failed.map((task) => [task.title, task.state])).toEqual([
      ["apply", "done"],
      ["retry", "failed"],
    ]);
    const done = applyProgressEvent(tasks, { type: "task-done", id: "t" });
    expect(done.map((task) => [task.title, task.state])).toEqual([
      ["apply", "done"],
      ["retry", "done"],
    ]);
    // The first task is settled and must not be touched by the later events.
    expect(failed[0]).toBe(tasks[0]!);
  });

  test("events for an unknown task id are ignored", () => {
    expect(applyProgressEvent([], { type: "task-done", id: "nope" })).toEqual([]);
    expect(applyProgressEvent([], { type: "task-output", id: "nope", line: "x" })).toEqual([]);
  });

  test("settling marks every running task", () => {
    let tasks = applyProgressEvent([], { type: "task-start", id: "a", title: "a" });
    tasks = applyProgressEvent(tasks, { type: "task-start", id: "b", title: "b" });
    tasks = applyProgressEvent(tasks, { type: "task-output", id: "b", line: "boom" });
    expect(settleProgress(tasks, "failed").map((task) => [task.state, task.tail])).toEqual([
      ["failed", []],
      ["failed", ["boom"]],
    ]);
  });
});

describe("driveProgress", () => {
  test("reports the task list after each event, settles done, and resolves the return value", async () => {
    async function* work() {
      yield { type: "step", message: "one" } as ProgressEvent;
      yield { type: "output", line: "detail" } as ProgressEvent;
      return 42;
    }
    const frames: string[] = [];
    const result = await driveProgress(work(), (tasks) =>
      frames.push(
        tasks.map((task) => `${task.state}:${task.title}:${task.tail.join(",")}`).join("|"),
      ),
    );
    expect(result).toBe(42);
    expect(frames).toEqual(["running:one:", "running:one:detail", "done:one:"]);
  });

  test("settles the running task failed and rethrows unchanged", async () => {
    const failure = new Error("boom");
    async function* work() {
      yield { type: "step", message: "one" } as ProgressEvent;
      throw failure;
    }
    let last: string | undefined;
    await expect(
      driveProgress(work(), (tasks) => {
        last = tasks.map((task) => `${task.state}:${task.title}`).join("|");
      }),
    ).rejects.toBe(failure);
    expect(last).toBe("failed:one");
  });
});
