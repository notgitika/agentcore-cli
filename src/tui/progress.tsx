import { render } from "ink";
import { TaskList, type Task } from "../components/ui/task-list";
import type { AppIO } from "../io";

/**
 * The event vocabulary long-running operations report progress through. A
 * `step` starts a new unit of work and implicitly completes the one before it;
 * an `output` line belongs to the most recent step, and a `warning` remains
 * visible without blocking the operation. The final step completes when the
 * generator returns, and fails when it throws.
 *
 * `task-*` events address an identified task that runs alongside the linear
 * steps; a `task-start` adds it, `task-output` feeds its tail,
 * `task-done`/`task-failed` settle it.
 */
export type ProgressEvent =
  | { type: "step"; message: string }
  | { type: "output"; line: string }
  | { type: "warning"; message: string }
  | { type: "task-start"; id: string; title: string }
  | { type: "task-output"; id: string; line: string }
  | { type: "task-done"; id: string }
  | { type: "task-failed"; id: string; message?: string };

export type ProgressResult<T> = Promise<T> | AsyncGenerator<ProgressEvent, T>;

export function isProgressGenerator<T>(
  result: ProgressResult<T>,
): result is AsyncGenerator<ProgressEvent, T> {
  return typeof (result as AsyncGenerator<ProgressEvent, T>)[Symbol.asyncIterator] === "function";
}

export type RunWithProgressOptions = {
  io: AppIO;
  /** A single waiting step for callback operations; cleared before their first output. */
  label?: string;
  /** Lines of live output kept under the running step (default 5). */
  tailLines?: number;
  /**
   * Overrides TTY detection: pass false to force the plain line-per-step path
   * (e.g. in --json mode, where stderr may be a TTY but the caller wants no
   * ANSI). Defaults to whether io.stderr is a TTY.
   */
  interactive?: boolean;
};

const DEFAULT_TAIL_LINES = 5;

function lastIndexWhere(tasks: readonly Task[], predicate: (task: Task) => boolean): number {
  for (let index = tasks.length - 1; index >= 0; index -= 1) {
    if (predicate(tasks[index]!)) return index;
  }
  return -1;
}

function replaceAt(tasks: readonly Task[], index: number, update: (task: Task) => Task): Task[] {
  return tasks.map((task, i) => (i === index ? update(task) : task));
}

function appendTail(task: Task, line: string, tailLines: number): Task {
  return { ...task, tail: [...task.tail, line].slice(-tailLines) };
}

/**
 * Folds one progress event into a task list. Linear events: a `step` completes
 * the running unidentified task and starts a new one, an `output` line joins
 * the last unidentified task's tail, and a `warning` is retained as a standalone
 * advisory above the running tasks. Identified events (`task-*`) address one
 * task by id and leave every other task alone, so several can run at once.
 */
export function applyProgressEvent(
  tasks: readonly Task[],
  event: ProgressEvent,
  tailLines = DEFAULT_TAIL_LINES,
): Task[] {
  switch (event.type) {
    case "warning": {
      const warning: Task = { title: event.message, state: "warning", tail: [] };
      // Keep running tasks last so later output and settlement still attach to them.
      const firstRunning = tasks.findIndex((task) => task.state === "running");
      return firstRunning === -1
        ? [...tasks, warning]
        : [...tasks.slice(0, firstRunning), warning, ...tasks.slice(firstRunning)];
    }
    case "step": {
      const current = lastIndexWhere(tasks, (task) => task.id === undefined);
      const settled =
        current !== -1 && tasks[current]!.state === "running"
          ? replaceAt(tasks, current, (task) => ({ ...task, state: "done", tail: [] }))
          : [...tasks];
      return [...settled, { title: event.message, state: "running", tail: [] }];
    }
    case "output": {
      // An output line before the first step has nowhere to render; the debug log
      // still has it.
      const current = lastIndexWhere(tasks, (task) => task.id === undefined);
      if (current === -1) return [...tasks];
      return replaceAt(tasks, current, (task) => appendTail(task, event.line, tailLines));
    }
    case "task-start":
      return [...tasks, { id: event.id, title: event.title, state: "running", tail: [] }];
    case "task-output": {
      const index = tasks.findIndex((task) => task.id === event.id);
      if (index === -1) return [...tasks];
      return replaceAt(tasks, index, (task) => appendTail(task, event.line, tailLines));
    }
    case "task-done": {
      const index = tasks.findIndex((task) => task.id === event.id);
      if (index === -1) return [...tasks];
      return replaceAt(tasks, index, (task) => ({ ...task, state: "done", tail: [] }));
    }
    case "task-failed": {
      const index = tasks.findIndex((task) => task.id === event.id);
      if (index === -1) return [...tasks];
      return replaceAt(tasks, index, (task) => ({
        ...(event.message ? appendTail(task, event.message, tailLines) : task),
        state: "failed",
      }));
    }
  }
}

/**
 * Marks every running task finished: `done` when the generator returned (tails
 * collapse), `failed` when it threw (tails stay, so the last output is visible
 * above the error).
 */
export function settleProgress(tasks: readonly Task[], state: "done" | "failed"): Task[] {
  return tasks.map((task) =>
    task.state === "running" ? { ...task, state, tail: state === "done" ? [] : task.tail } : task,
  );
}

/**
 * Drains a progress generator, reporting the task list after every change, and
 * resolves with its return value. On failure the running task is marked failed
 * and the error rethrown unchanged. Renderers supply only how to draw the tasks.
 */
export async function driveProgress<T>(
  generator: AsyncGenerator<ProgressEvent, T>,
  onChange: (tasks: Task[]) => void,
  tailLines = DEFAULT_TAIL_LINES,
): Promise<T> {
  let tasks: Task[] = [];
  try {
    let next = await generator.next();
    while (!next.done) {
      tasks = applyProgressEvent(tasks, next.value, tailLines);
      onChange(tasks);
      next = await generator.next();
    }
    onChange(settleProgress(tasks, "done"));
    return next.value;
  } catch (error) {
    onChange(settleProgress(tasks, "failed"));
    throw error;
  }
}

/**
 * Drains a progress generator into a live step list and resolves with the
 * generator's return value.
 *
 * Interactive path (stderr is a TTY): mounts an inline Ink TaskList on
 * io.stderr — normal scrollback, not the alternate screen — with a spinner on
 * the running step and a scrolling tail of its recent output. stdout is never
 * touched, so machine output stays clean. On failure the current step is
 * marked ✕ with its tail left visible in scrollback, and the error is rethrown
 * unchanged for the caller's exit-code handling to print in full.
 *
 * Fallback path (non-TTY or interactive: false): writes each step and warning
 * as a plain line to stderr and drops output lines (they are in the debug log).
 *
 * Callback operations show one transient step and receive a stop function for
 * handing the terminal to streaming output. They stay silent outside a human TTY.
 */
export async function runWithProgress<T>(
  work: AsyncGenerator<ProgressEvent, T> | ((stop: () => Promise<void>) => Promise<T>),
  options: RunWithProgressOptions,
): Promise<T> {
  const interactive = options.interactive ?? options.io.stderr.isTTY === true;
  if (
    typeof work === "function" &&
    (!interactive || options.io.stderr.isTTY !== true || process.env.INK_SCREEN_READER === "true")
  ) {
    return work(async () => {});
  }
  if (typeof work !== "function" && !interactive) {
    const titles = new Map<string, string>();
    let next = await work.next();
    while (!next.done) {
      const event = next.value;
      if (event.type === "step") options.io.stderr.write(`${event.message}\n`);
      if (event.type === "warning") options.io.stderr.write(`Warning: ${event.message}\n`);
      if (event.type === "task-start") {
        titles.set(event.id, event.title);
        options.io.stderr.write(`${event.title}\n`);
      }
      if (event.type === "task-failed") {
        const title = titles.get(event.id) ?? event.id;
        options.io.stderr.write(`Failed: ${title}${event.message ? `: ${event.message}` : ""}\n`);
      }
      next = await work.next();
    }
    return next.value;
  }

  const tailLines = options.tailLines ?? DEFAULT_TAIL_LINES;
  const tasks: Task[] =
    typeof work === "function"
      ? [{ title: options.label ?? "Working...", state: "running", tail: [] }]
      : [];
  // Ink renders onto its `stdout` option; handing it io.stderr keeps progress
  // off the machine-readable stream, same as the plain path.
  const instance = render(<TaskList tasks={tasks} tailLines={tailLines} />, {
    stdout: options.io.stderr,
    stderr: options.io.stderr,
    stdin: options.io.stdin,
    interactive: typeof work === "function" ? true : undefined,
    // Nothing here reads input, so stdin stays out of raw mode and Ctrl+C
    // reaches the process as a normal SIGINT; Ink's exit hook restores the
    // cursor on the way down.
    exitOnCtrlC: false,
    patchConsole: false,
  });

  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      if (typeof work === "function") instance.clear();
      instance.unmount();
      await instance.waitUntilExit();
    })());

  // A failed step keeps its tail: the last frame stays in scrollback above the
  // error runWithExitCode prints after the rethrow.
  try {
    if (typeof work === "function") return await work(stop);
    return await driveProgress(
      work,
      (tasks) => instance.rerender(<TaskList tasks={tasks} tailLines={tailLines} />),
      tailLines,
    );
  } finally {
    await stop();
  }
}
