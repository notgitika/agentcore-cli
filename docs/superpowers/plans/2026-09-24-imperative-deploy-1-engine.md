# Imperative Deploy Phase 1: Engine and Backend Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the `Imperative` project backend behind the `imperative-deploy` global flag: the generic `plan/` engine (parallel, resumable, no rollback), the `agentcore/` domain skeleton (stack, plan factory, per-kind handler registry), progress events for concurrent tasks, state, naming, and a backend whose `deploy` performs every pre-mutation check and then reports what it cannot deploy yet.

**Architecture:** Mirrors `AlricheyWPPlayground` one to one: `backends/imperative/plan/plan.ts` is `plan/plan.go` (`Status`, `Step{name,do,status,next}`, `Plan{name,steps}.execute/validate`); `backends/imperative/agentcore/` is `lightpress/` (`AgentCoreStack` = `wpstack`, `plan()` = `lightpress.Plan`, one `create`/`poll` pair per kind); `backends/imperative.ts` is `cmd/lp/main.go`. Cross-step values live on the stack, typed, not in the engine. Every resource kind's handler is `notImplemented` in this phase, and `assertImperativelyDeployable` rejects the project before the first AWS mutation, so nothing half-deploys.

**Tech Stack:** TypeScript, bun 1.4 (`bun test`, colocated `*.test.ts`), zod v4, AWS SDK v3 (`@aws-sdk/credential-providers` added), Ink task list, existing `AsyncChannel`.

**Spec:** `docs/superpowers/specs/2026-09-24-imperative-deploy-design.md` (sections 3, 4, 4.1 to 4.7, 5). Research: `docs/superpowers/research/2026-09-24-imperative-deploy-context.md`.

**Depends on:** Phase 0 (`docs/superpowers/plans/2026-09-24-imperative-deploy-0-backends-shared.md`) merged or stacked underneath: `backends/shared/{deployedState,credentials,account,types}.ts` must exist. Branch `feat/imperative-deploy-engine` off `refactor/backends-shared`.

## Global Constraints

- Nothing under `src/core/project/backends/imperative/` or `backends/imperative.ts` imports from `./cdk`, `./cdk/*`, or `@aws-cdk/*` (extend the phase 0 boundary test).
- Flag name is exactly `imperative-deploy`; enum value is exactly `Imperative`; the flag-off error names the exact command `agentcore config imperative-deploy true`.
- Status vocabulary is exactly `NOT_STARTED | OUTDATED | WAITING | SUCCESSFUL | FAILED` (const object `Status`).
- Step names are `<kind>:<name>` for top-level resources and `<kind>:<parent>/<child>` for children.
- Physical names are `<project>_<target>_<name>` (`-` separated for gateways). Ownership tags are `agentcore:project-name`, `agentcore:target-name`, `agentcore:managed-by: imperative`.
- State lives at `targets.<target>.resources.imperative.<kind>.<key>` in `agentcore/.cli/deployed-state.json`, `{ arn?, id?, updatedAt }`.
- No rollback anywhere. A failing step skips only its transitive dependents; running steps finish.
- Every AWS mutation in this phase is unreachable: `deploy` must throw before `plan.execute` for any project that declares a resource. Only credential providers (shared provisioner, already imperative) may be created.
- Existing linear progress events (`step`, `output`, `warning`) keep their exact semantics; every existing test in `src/tui/progress.test.tsx` must still pass unmodified.
- Run `bun run typecheck` (or the repo's equivalent script) and `bun test` before every commit; baseline is 0 failures.

## Review Focus

Inputs the spec implies but no task's tests exercise directly, most likely to bite first. Each has a test pinned to the owning task below.

1. **A state file with an `imperative` branch written by a newer CLI (unknown keys).** Expected: read, preserved, not stripped on the next write. Pinned in Task 8 (`state.test.ts`, "preserves unknown keys").
2. **`deploy` with the flag on for a project whose target was deployed with CDK (`stackArn` recorded).** Expected: refuse with guidance, no credential provisioning. Pinned in Task 11 (`imperative.test.ts`, "refuses a CDK-bound target before provisioning").
3. **Ctrl+C mid-plan.** Expected: no new steps start; the failure reads as an abort, not a service error. Pinned in Task 5 (`plan.test.ts`, "an aborted signal stops the plan").
4. **A `status` function that throws (network error) rather than returning a report.** Expected: the step fails with that error; the plan reports it; other roots still run. Pinned in Task 5 ("a throwing status fails only its step").
5. **A spec that declares only credentials.** Expected: provisioned, deploy succeeds with empty outputs, no teardown prompt. Pinned in Task 11 ("a credentials-only project deploys without a teardown").

## File Structure

| File                                                                                                                   | Responsibility                                                                |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/globalConfig/types.tsx`, `config.tsx` (modify), `config.test.tsx` (create)                                        | `imperative-deploy` flag, default false                                       |
| `src/projectSchemas/project.ts` (modify), `project.test.ts` (modify)                                                   | `ManagedBySchema` gains `Imperative`                                          |
| `src/tui/progress.tsx` (modify), `progress.test.tsx` (modify), `src/components/ui/task-list/TaskList.tsx` (modify)     | `task-start/output/done/failed` events, `Task.id?`                            |
| `src/core/project/backends/imperative/plan/plan.ts` (create), `plan.test.ts`                                           | Generic engine: `Status`, `Step`, `Plan.validate`, `Plan.execute`, errors     |
| `src/core/project/backends/imperative/naming.ts` (create), `naming.test.ts`                                            | `ResourceKind`, `physicalName`, ownership tags, `stepName`/`parseStepName`    |
| `src/core/project/backends/imperative/status.ts` (create), `status.test.ts`                                            | Service status string → `StatusReport`                                        |
| `src/core/project/backends/imperative/state.ts` (create), `state.test.ts`; `backends/shared/deployedState.ts` (modify) | Read/record/forget under `resources.imperative`; CDK-binding check            |
| `src/core/project/backends/imperative/inventory.ts` (create), `inventory.test.ts`                                      | Flatten the spec and the recorded state into `DeclaredResource[]`             |
| `src/core/project/backends/imperative/support.ts` (create), `support.test.ts`                                          | `SUPPORTED_KINDS`, `assertImperativelyDeployable`                             |
| `src/core/project/backends/imperative/agentcore/stack.ts` (create), `stack.test.ts`                                    | `AgentCoreStack` (`wpstack` analog)                                           |
| `src/core/project/backends/imperative/agentcore/notImplemented.ts` (create)                                            | Placeholder `KindHandlers` for every kind                                     |
| `src/core/project/backends/imperative/agentcore/plan.ts` (create), `plan.test.ts`                                      | `HANDLERS` registry, `plan()` → `{ stack, apply, remove, declared, removed }` |
| `src/core/project/backends/imperative/credentials.ts` (create)                                                         | Default-chain `AwsCredentialResolver`                                         |
| `src/core/project/backends/imperative.ts` (create), `imperative.test.ts`                                               | `ImperativeBackend implements ProjectBackend`                                 |
| `src/core/project/manager.tsx`, `src/core/index.tsx`, `src/index.ts`, `src/core/project/index.tsx` (modify)            | Backend registration behind the flag; flag-off error                          |
| `src/core/project/backends/shared/boundary.test.ts` (modify)                                                           | Imperative tree stays CDK-free                                                |

---

### Task 1: The `imperative-deploy` global flag

**Files:**

- Modify: `src/globalConfig/types.tsx:14-25`
- Modify: `src/globalConfig/config.tsx:6-35`
- Create: `src/globalConfig/config.test.tsx`

**Interfaces:**

- Produces: `GlobalConfig["imperative-deploy"]: boolean` (default `false`), settable with `agentcore config imperative-deploy true` (the config handler validates through `globalConfigFileSchema`, so no handler change).

- [ ] **Step 1: Write the failing test**

```ts
// src/globalConfig/config.test.tsx
import { describe, expect, test } from "bun:test";
import { applyOverrides, DEFAULT_GLOBAL_CONFIG } from "./config";
import { globalConfigFileSchema } from "./types";

describe("imperative-deploy flag", () => {
  test("defaults to false", () => {
    expect(DEFAULT_GLOBAL_CONFIG["imperative-deploy"]).toBe(false);
  });

  test("is accepted by the file schema and applied as an override", () => {
    const data = globalConfigFileSchema.parse({ "imperative-deploy": true });
    expect(applyOverrides(DEFAULT_GLOBAL_CONFIG, data)["imperative-deploy"]).toBe(true);
  });

  test("an absent override keeps the default", () => {
    expect(applyOverrides(DEFAULT_GLOBAL_CONFIG, {})["imperative-deploy"]).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/globalConfig/config.test.tsx`
Expected: FAIL (type error / `undefined` is not `false`).

- [ ] **Step 3: Add the flag**

In `src/globalConfig/types.tsx`, inside `globalConfigFileSchema`, directly under `"imperative-mutation-commands"`:

```ts
  "imperative-deploy": z.boolean().optional(),
```

In `src/globalConfig/config.tsx`, `DEFAULT_GLOBAL_CONFIG`:

```ts
  "imperative-mutation-commands": false,
  "imperative-deploy": false,
```

and in `applyOverrides`:

```ts
    "imperative-deploy": overrides["imperative-deploy"] ?? defaults["imperative-deploy"],
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/globalConfig src/handlers/config`
Expected: PASS. (The config handler tests enumerate keys through the schema; if one snapshots the key list, update the snapshot and say so in the commit.)

- [ ] **Step 5: Commit**

```bash
git add src/globalConfig
git commit -m "feat(config): add imperative-deploy global flag (default off)"
```

---

### Task 2: `managedBy: "Imperative"`

**Files:**

- Modify: `src/projectSchemas/project.ts:16`
- Modify: `src/projectSchemas/project.test.ts`

**Interfaces:**

- Produces: `ManagedBy = "CDK" | "Imperative"`. `Partial<Record<ManagedBy, ProjectBackend>>` in the manager and `TestCoreClient` widens automatically.

- [ ] **Step 1: Write the failing test** (append to `src/projectSchemas/project.test.ts`)

```ts
describe("managedBy", () => {
  test("defaults to CDK", () => {
    expect(ProjectSpecSchema.parse({ name: "example", version: 2 }).managedBy).toBe("CDK");
  });

  test("accepts Imperative", () => {
    expect(
      ProjectSpecSchema.parse({ name: "example", version: 2, managedBy: "Imperative" }).managedBy,
    ).toBe("Imperative");
  });

  test("rejects other backends", () => {
    expect(() =>
      ProjectSpecSchema.parse({ name: "example", version: 2, managedBy: "Terraform" }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/projectSchemas/project.test.ts -t managedBy`
Expected: FAIL on "accepts Imperative".

- [ ] **Step 3: Widen the enum**

```ts
export const ManagedBySchema = z.enum(["CDK", "Imperative"]).default("CDK");
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `bun test src/projectSchemas && bun run typecheck`
Expected: PASS. `manager.test.ts:611` still passes: it builds a spec with `managedBy: "Terraform"` cast past the schema and expects the "unsupported backend" error, which Task 12 keeps for non-Imperative values.

- [ ] **Step 5: Commit**

```bash
git add src/projectSchemas
git commit -m "feat(schema): allow managedBy Imperative"
```

---

### Task 3: Progress events for concurrent tasks

**Files:**

- Modify: `src/tui/progress.tsx` (`ProgressEvent`, `applyProgressEvent`, `settleProgress`, plain path in `runWithProgress`)
- Modify: `src/components/ui/task-list/TaskList.tsx:10-14` (`Task.id?`)
- Modify: `src/tui/progress.test.tsx`

**Interfaces:**

- Produces:
  ```ts
  export type ProgressEvent =
    | { type: "step"; message: string }
    | { type: "output"; line: string }
    | { type: "warning"; message: string }
    | { type: "task-start"; id: string; title: string }
    | { type: "task-output"; id: string; line: string }
    | { type: "task-done"; id: string }
    | { type: "task-failed"; id: string; message?: string };
  ```
  `ProjectEvent = ProgressEvent` already, so backends can yield these unchanged.
- Semantics: identified tasks (`id`) are independent of the linear step: `step` settles only the running task without an id; `output` attaches to the last task without an id; `task-*` address a task by id; `settleProgress` settles every running task.

- [ ] **Step 1: Write the failing tests** (append inside `describe("applyProgressEvent / settleProgress")`)

```ts
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
```

And inside `describe("runWithProgress plain path (no TTY)")`:

```ts
test("prints task starts and failures as plain lines", async () => {
  const { io, stderr } = testIO();
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
    { io },
  );
  expect(result).toBe(1);
  expect(stderr()).toBe("memory:m\nruntime:r\nFailed: runtime:r: CREATE_FAILED\n");
});
```

(Match how the existing plain-path tests read stderr from `testIO()`; if the helper exposes it under another name, use that name.)

- [ ] **Step 2: Run to verify they fail**

Run: `bun test src/tui/progress.test.tsx`
Expected: the new tests FAIL (type errors on the event union).

- [ ] **Step 3: Extend `Task` and the event union**

`src/components/ui/task-list/TaskList.tsx`:

```ts
export interface Task {
  /** Set for tasks addressed by id (concurrent plan steps); linear steps have none. */
  id?: string;
  title: string;
  state: TaskState;
  /** Recent output lines attributed to this task. Only shown while it runs (or after it fails). */
  tail: string[];
}
```

`src/tui/progress.tsx`: replace the `ProgressEvent` type with the union above, updating the doc comment: "`task-*` events address an identified task that runs alongside the linear steps; a `task-start` adds it, `task-output` feeds its tail, `task-done`/`task-failed` settle it."

- [ ] **Step 4: Rewrite `applyProgressEvent` and `settleProgress`**

```ts
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
```

- [ ] **Step 5: Extend the plain path in `runWithProgress`**

Replace the non-interactive generator loop:

```ts
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
```

- [ ] **Step 6: Run the whole progress suite**

Run: `bun test src/tui src/components/ui/task-list && bun run typecheck`
Expected: PASS, every pre-existing test unmodified.

- [ ] **Step 7: Commit**

```bash
git add src/tui/progress.tsx src/tui/progress.test.tsx src/components/ui/task-list/TaskList.tsx
git commit -m "feat(progress): identified task events for concurrent work"
```

---

### Task 4: `plan/plan.ts` types, errors, and `Plan.validate`

**Files:**

- Create: `src/core/project/backends/imperative/plan/plan.ts`
- Create: `src/core/project/backends/imperative/plan/plan.test.ts`

**Interfaces:**

- Produces (used by every later task):

  ```ts
  export const Status = { NotStarted: "NOT_STARTED", Outdated: "OUTDATED", Waiting: "WAITING", Successful: "SUCCESSFUL", Failed: "FAILED" } as const;
  export type Status = (typeof Status)[keyof typeof Status];
  export type StatusReport = { status: Status; detail?: string };
  export type StepContext = { signal: AbortSignal; logger: Logger; report: (line: string) => void };
  export type Doer = (ctx: StepContext) => Promise<void>;
  export type Statuser = (ctx: StepContext) => Promise<StatusReport>;
  export type Step = { readonly name: string; readonly do: Doer; readonly status: Statuser; readonly next?: readonly Step[] };
  export class Plan { constructor(readonly name: string, readonly steps: readonly Step[]); validate(): ValidatedPlan; execute(options: ExecuteOptions): AsyncGenerator<ProgressEvent, PlanResult> }
  export class PlanValidationError, StepFailedError, StepNotStartedError, StepTimeoutError, PlanFailedError
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/project/backends/imperative/plan/plan.test.ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/core/project/backends/imperative/plan`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the types, errors, and `validate`**

```ts
// src/core/project/backends/imperative/plan/plan.ts
import { AgentCoreCLIError, ERROR_SOURCE } from "../../../../../errors";
import { AsyncChannel } from "../../../../../io";
import type { Logger } from "../../../../../logging";
import type { ProgressEvent } from "../../../../../tui/progress";

/**
 * The generic plan engine, after AlricheyWPPlayground's plan/plan.go: a plan is
 * a directed acyclic graph of steps; each step has an idempotent `do` and a
 * read-only `status`. Execution is a parallel breadth-first walk: a step starts
 * once every parent has succeeded, polls `status`, runs `do` when the resource
 * is missing or outdated, and polls again until the service reports it ready.
 * Nothing is ever undone: a failed step blocks only its dependents, and a re-run
 * of the same plan resumes from whatever the account already holds.
 */

/**
 * What a step's `status` reports. The prior art's NOT_STARTED / WAITING /
 * SUCCESSFUL / FAILED plus OUTDATED: the resource exists but differs from the
 * spec, so `do` runs as an update.
 */
export const Status = {
  NotStarted: "NOT_STARTED",
  Outdated: "OUTDATED",
  Waiting: "WAITING",
  Successful: "SUCCESSFUL",
  Failed: "FAILED",
} as const;
export type Status = (typeof Status)[keyof typeof Status];

export type StatusReport = {
  status: Status;
  /** Shown under the step while it runs, and carried into the failure for FAILED. */
  detail?: string;
};

export type StepContext = {
  /** Aborted when the deploy is cancelled; long polls should honour it. */
  signal: AbortSignal;
  logger: Logger;
  /** Reports one line of progress under this step. */
  report: (line: string) => void;
};

/** An idempotent mutation: create or update the resource toward the spec. */
export type Doer = (ctx: StepContext) => Promise<void>;
/** A read-only observation of the live resource against the spec. */
export type Statuser = (ctx: StepContext) => Promise<StatusReport>;

export type Step = {
  /** Unique within a plan. Convention: `<kind>:<name>`. Doubles as the progress task id. */
  readonly name: string;
  readonly do: Doer;
  readonly status: Statuser;
  /** Steps that may start once this one succeeds. */
  readonly next?: readonly Step[];
};

export type StepOutcome =
  | { name: string; outcome: "succeeded"; polls: number }
  | { name: string; outcome: "failed"; error: Error }
  | { name: string; outcome: "skipped"; blockedBy: string };

export type PlanResult = { outcomes: StepOutcome[] };

export type ExecuteOptions = {
  logger: Logger;
  signal?: AbortSignal;
  /** Steps in flight at once (default 4). */
  concurrency?: number;
  /** How many times `do` may run for one step before it is declared not started (default 1). */
  maxDoAttempts?: number;
  /** Wall clock budget per step (default 15 minutes). */
  stepTimeoutMs?: number;
  /** Delay before poll number `poll` (1-based); default 1s doubling to a 10s cap. */
  pollDelayMs?: (poll: number) => number;
  /** Injectable for tests; must reject when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injectable clock for timeout tests. */
  now?: () => number;
  /** Awaited after each step succeeds and before its dependents start; persist here. */
  onStepSucceeded?: (step: Step) => Promise<void>;
};

export type ValidatedPlan = {
  steps: Map<string, Step>;
  parents: Map<string, Set<string>>;
  children: Map<string, Set<string>>;
  roots: string[];
};

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_DO_ATTEMPTS = 1;
const DEFAULT_STEP_TIMEOUT_MS = 15 * 60 * 1000;

function defaultPollDelayMs(poll: number): number {
  return Math.min(1000 * 2 ** Math.max(poll - 1, 0), 10_000);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("The deploy was cancelled.");
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The plan's graph is malformed: a bug in the plan factory, never a user or service problem. */
export class PlanValidationError extends AgentCoreCLIError {
  constructor(message: string) {
    super(message, { source: ERROR_SOURCE.INTERNAL });
  }
}

/** The service reported the resource as failed. */
export class StepFailedError extends AgentCoreCLIError {
  constructor(
    readonly stepName: string,
    detail?: string,
  ) {
    super(`${stepName} failed${detail ? `: ${detail}` : ""}`, {
      source: ERROR_SOURCE.SERVICE,
      meta: { stepName },
    });
  }
}

/** `do` ran but `status` still cannot see its effect: the do/status pair disagree. */
export class StepNotStartedError extends AgentCoreCLIError {
  constructor(
    readonly stepName: string,
    status: Status,
  ) {
    super(`${stepName} still reports ${status} after running its action`, {
      source: ERROR_SOURCE.INTERNAL,
      meta: { stepName, status },
    });
  }
}

export class StepTimeoutError extends AgentCoreCLIError {
  constructor(
    readonly stepName: string,
    timeoutMs: number,
  ) {
    super(`${stepName} did not converge within ${Math.round(timeoutMs / 1000)}s`, {
      source: ERROR_SOURCE.SERVICE,
      meta: { stepName, timeoutMs },
    });
  }
}

/** One or more steps failed; `result` lists every outcome, including skipped dependents. */
export class PlanFailedError extends AgentCoreCLIError {
  constructor(
    readonly planName: string,
    readonly result: PlanResult,
  ) {
    const failed = result.outcomes.filter((o) => o.outcome === "failed");
    const skipped = result.outcomes.filter((o) => o.outcome === "skipped");
    const summary = failed.map((o) => `${o.name} (${o.error.message})`).join("; ");
    super(
      `${planName}: ${failed.length} step${failed.length === 1 ? "" : "s"} failed` +
        `${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}: ${summary}`,
      { source: ERROR_SOURCE.SERVICE, cause: failed[0]?.error, meta: { planName } },
    );
  }
}

export class Plan {
  constructor(
    readonly name: string,
    /** Entry points. Steps reachable through `next` need not be listed; listing them is harmless. */
    readonly steps: readonly Step[],
  ) {}

  /**
   * Walks the graph once: every step has a name, `do`, and `status`; names are
   * unique; there are no cycles. Returns the parent/child maps the scheduler
   * needs, with roots being the steps no other step lists in `next`.
   */
  validate(): ValidatedPlan {
    const steps = new Map<string, Step>();
    const parents = new Map<string, Set<string>>();
    const children = new Map<string, Set<string>>();

    const visit = (step: Step, trail: string[]): void => {
      if (typeof step.name !== "string" || step.name.length === 0) {
        throw new PlanValidationError(`${this.name}: a step has no name`);
      }
      if (typeof step.do !== "function" || typeof step.status !== "function") {
        throw new PlanValidationError(`${this.name}: step '${step.name}' is missing do or status`);
      }
      if (trail.includes(step.name)) {
        throw new PlanValidationError(`${this.name}: cycle ${[...trail, step.name].join(" -> ")}`);
      }
      const known = steps.get(step.name);
      if (known !== undefined && known !== step) {
        throw new PlanValidationError(`${this.name}: two different steps are named '${step.name}'`);
      }
      // Already walked through another parent: its edges are registered below by
      // that parent, so only the new edge needs recording.
      if (known === step) return;
      steps.set(step.name, step);
      parents.set(step.name, new Set());
      children.set(step.name, new Set());
      for (const child of step.next ?? []) {
        visit(child, [...trail, step.name]);
        parents.get(child.name)!.add(step.name);
        children.get(step.name)!.add(child.name);
      }
    };
    for (const step of this.steps) visit(step, []);

    const roots = [...steps.keys()].filter((name) => parents.get(name)!.size === 0);
    return { steps, parents, children, roots };
  }
}
```

- [ ] **Step 4: Run the validate tests**

Run: `bun test src/core/project/backends/imperative/plan -t Plan.validate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/project/backends/imperative/plan
git commit -m "feat(imperative): plan engine types, errors, and validation"
```

---

### Task 5: `Plan.execute`: the parallel scheduler and per-step loop

**Files:**

- Modify: `src/core/project/backends/imperative/plan/plan.ts`
- Modify: `src/core/project/backends/imperative/plan/plan.test.ts`

**Interfaces:**

- Consumes: Task 3's `task-*` events.
- Produces: `Plan.execute(options): AsyncGenerator<ProgressEvent, PlanResult>`; throws `PlanFailedError` when any step failed or was skipped; rethrows an `onStepSucceeded` failure after in-flight steps drain.

- [ ] **Step 1: Write the failing tests** (append to `plan.test.ts`)

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test src/core/project/backends/imperative/plan`
Expected: FAIL, `execute` is not a function.

- [ ] **Step 3: Implement `execute`, `schedule`, and `runStep`** (inside `class Plan`, after `validate`)

```ts
  /**
   * Runs the plan, yielding progress events as steps start, report, finish, or
   * fail, and resolving with every step's outcome. Throws PlanFailedError when
   * any step failed or was skipped; the outcomes on it say which and why.
   */
  async *execute(options: ExecuteOptions): AsyncGenerator<ProgressEvent, PlanResult> {
    const validated = this.validate();
    const events = new AsyncChannel<ProgressEvent>();
    const result: PlanResult = { outcomes: [] };
    const running = this.schedule(validated, options, events, result).finally(() => events.close());
    // Consumed by the await below; this keeps the window between a rejection and
    // the channel draining from surfacing as an unhandled rejection.
    running.catch(() => {});
    for await (const event of events) yield event;
    await running;
    if (result.outcomes.some((outcome) => outcome.outcome !== "succeeded")) {
      throw new PlanFailedError(this.name, result);
    }
    return result;
  }

  /**
   * The prior art's parallel BFS: roots start at once; a step with several
   * parents starts when its in-degree reaches zero (join). A failure never
   * decrements its children, so they can never become ready; they are recorded
   * as skipped instead. A persistence-hook failure is fatal to the plan but
   * still lets in-flight steps finish, so nothing is left half-observed.
   */
  private async schedule(
    plan: ValidatedPlan,
    options: ExecuteOptions,
    events: AsyncChannel<ProgressEvent>,
    result: PlanResult,
  ): Promise<void> {
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    const remaining = new Map([...plan.parents].map(([name, parents]) => [name, parents.size]));
    const ready = [...plan.roots];
    const running = new Map<string, Promise<void>>();
    const skipped = new Set<string>();
    let fatal: unknown;

    const release = (name: string) => {
      for (const child of plan.children.get(name)!) {
        const left = remaining.get(child)! - 1;
        remaining.set(child, left);
        if (left === 0) ready.push(child);
      }
    };
    const skipDependents = (name: string, blockedBy: string) => {
      for (const child of plan.children.get(name)!) {
        if (skipped.has(child)) continue;
        skipped.add(child);
        result.outcomes.push({ name: child, outcome: "skipped", blockedBy });
        skipDependents(child, blockedBy);
      }
    };

    while (ready.length > 0 || running.size > 0) {
      if (fatal !== undefined) ready.length = 0;
      while (ready.length > 0 && running.size < concurrency) {
        const name = ready.shift()!;
        const step = plan.steps.get(name)!;
        const settled = this.runStep(step, options, events)
          .then(
            async (polls) => {
              result.outcomes.push({ name, outcome: "succeeded", polls });
              await options.onStepSucceeded?.(step);
              release(name);
            },
            (error: unknown) => {
              result.outcomes.push({ name, outcome: "failed", error: toError(error) });
              skipDependents(name, name);
            },
          )
          .catch((error: unknown) => {
            fatal ??= error;
          })
          .finally(() => running.delete(name));
        running.set(name, settled);
      }
      if (running.size > 0) await Promise.race(running.values());
    }
    if (fatal !== undefined) throw fatal;
  }

  /**
   * One step's observe → act → poll loop. Returns the number of polls it took.
   * Reports task-start first and task-done or task-failed last, so the progress
   * UI shows the step for exactly as long as it runs.
   */
  private async runStep(
    step: Step,
    options: ExecuteOptions,
    events: AsyncChannel<ProgressEvent>,
  ): Promise<number> {
    const logger = options.logger.child({ step: step.name });
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? defaultSleep;
    const pollDelayMs = options.pollDelayMs ?? defaultPollDelayMs;
    const timeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    const maxDoAttempts = options.maxDoAttempts ?? DEFAULT_MAX_DO_ATTEMPTS;

    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const ctx: StepContext = {
      signal: controller.signal,
      logger,
      report: (line) => events.push({ type: "task-output", id: step.name, line }),
    };

    events.push({ type: "task-start", id: step.name, title: step.name });
    const started = now();
    let polls = 0;
    let doAttempts = 0;
    try {
      for (;;) {
        if (ctx.signal.aborted) throw abortReason(ctx.signal);
        const report = await step.status(ctx);
        polls += 1;
        logger.child({ status: report.status, detail: report.detail ?? "" }).debug("polled step");

        if (report.status === Status.Successful) {
          events.push({ type: "task-done", id: step.name });
          return polls;
        }
        if (report.status === Status.Failed) throw new StepFailedError(step.name, report.detail);
        if (report.detail) ctx.report(report.detail);

        if (report.status === Status.NotStarted || report.status === Status.Outdated) {
          if (doAttempts >= maxDoAttempts) throw new StepNotStartedError(step.name, report.status);
          doAttempts += 1;
          await step.do(ctx);
          // Poll again at once: `do` records whatever id `status` needs to find it.
          continue;
        }

        const elapsed = now() - started;
        if (elapsed >= timeoutMs) throw new StepTimeoutError(step.name, timeoutMs);
        await sleep(Math.min(pollDelayMs(polls), timeoutMs - elapsed), ctx.signal);
      }
    } catch (error) {
      const failure = toError(error);
      events.push({ type: "task-failed", id: step.name, message: failure.message });
      throw failure;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
```

- [ ] **Step 4: Run the whole plan suite**

Run: `bun test src/core/project/backends/imperative/plan && bun run typecheck`
Expected: PASS. If the timeout test reports `clock` other than 100, check that the sleep clip `Math.min(pollDelayMs(polls), timeoutMs - elapsed)` is in place.

- [ ] **Step 5: Commit**

```bash
git add src/core/project/backends/imperative/plan
git commit -m "feat(imperative): parallel plan execution with join, skip, timeout, abort"
```

---

### Task 6: `imperative/naming.ts`: resource kinds, physical names, ownership tags, step names

**Files:**

- Create: `src/core/project/backends/imperative/naming.ts`
- Test: `src/core/project/backends/imperative/naming.test.ts`

**Interfaces:**

- Consumes: `DeployableResource` from `src/handlers/project/types.ts`.
- Produces:

  ```ts
  export type ResourceKind = Exclude<DeployableResource, "credential">;
  export type NamingScope = { projectName: string; targetName: string };
  export const PROJECT_TAG = "agentcore:project-name";
  export const TARGET_TAG = "agentcore:target-name";
  export const MANAGED_BY_TAG = "agentcore:managed-by";
  export const MANAGED_BY_VALUE = "imperative";
  export function physicalName(scope: NamingScope, kind: ResourceKind, name: string, maxLength?: number): string;
  export function ownershipTags(scope: NamingScope): Record<string, string>;
  export function ownsResource(scope: NamingScope, tags: Record<string, string | undefined> | undefined): boolean;
  export function stepName(kind: ResourceKind, name: string, parent?: string): string;
  export function parseStepName(step: string): { kind: ResourceKind; name: string; parent?: string };
  ```

Credentials are excluded from `ResourceKind` because the shared provisioner from Phase 0 owns them (spec §4.6).

- [ ] **Step 1: Write the failing tests**

```ts
// src/core/project/backends/imperative/naming.test.ts
import { describe, expect, test } from "bun:test";
import {
  MANAGED_BY_TAG,
  MANAGED_BY_VALUE,
  ownershipTags,
  ownsResource,
  parseStepName,
  physicalName,
  PROJECT_TAG,
  stepName,
  TARGET_TAG,
} from "./naming";

const scope = { projectName: "Shop", targetName: "dev" };

describe("physicalName", () => {
  test("joins project, target and name with underscores", () => {
    expect(physicalName(scope, "runtime", "checkout")).toBe("Shop_dev_checkout");
    expect(physicalName(scope, "memory", "orders")).toBe("Shop_dev_orders");
  });

  test("gateways use hyphens and rewrite underscores, because their names forbid them", () => {
    expect(physicalName(scope, "gateway", "tool_gw")).toBe("Shop-dev-tool-gw");
    expect(physicalName(scope, "gateway-target", "get_order")).toBe("Shop-dev-get-order");
  });

  test("rewrites hyphens for underscore kinds", () => {
    expect(physicalName({ projectName: "Shop", targetName: "us-west" }, "runtime", "a")).toBe(
      "Shop_us_west_a",
    );
  });

  test("is deterministic and unique when shortened to a limit", () => {
    const long = { projectName: "AVeryLongProjectNameHere", targetName: "productionEuropeWest1" };
    const a = physicalName(long, "runtime", "checkout_service_frontend", 48);
    const b = physicalName(long, "runtime", "checkout_service_frontend", 48);
    const c = physicalName(long, "runtime", "checkout_service_backend", 48);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBeLessThanOrEqual(48);
    expect(c.length).toBeLessThanOrEqual(48);
    // The head stays readable; only the tail is replaced by a digest.
    expect(a.startsWith("AVeryLongProjectNameHere_productionEuropeWest1")).toBe(true);
  });

  test("leaves a name alone when it fits the limit", () => {
    expect(physicalName(scope, "runtime", "checkout", 48)).toBe("Shop_dev_checkout");
  });
});

describe("ownership tags", () => {
  test("names the project, the target and the backend", () => {
    expect(ownershipTags(scope)).toEqual({
      [PROJECT_TAG]: "Shop",
      [TARGET_TAG]: "dev",
      [MANAGED_BY_TAG]: MANAGED_BY_VALUE,
    });
  });

  test("ownsResource requires all three tags to match", () => {
    expect(ownsResource(scope, ownershipTags(scope))).toBe(true);
    expect(ownsResource(scope, { ...ownershipTags(scope), extra: "x" })).toBe(true);
    expect(ownsResource(scope, { ...ownershipTags(scope), [TARGET_TAG]: "prod" })).toBe(false);
    expect(ownsResource(scope, { [PROJECT_TAG]: "Shop" })).toBe(false);
    expect(ownsResource(scope, undefined)).toBe(false);
  });
});

describe("step names", () => {
  test("round-trips top-level and child resources", () => {
    expect(stepName("runtime", "checkout")).toBe("runtime:checkout");
    expect(stepName("gateway-target", "orders", "tools")).toBe("gateway-target:tools/orders");
    expect(parseStepName("runtime:checkout")).toEqual({ kind: "runtime", name: "checkout" });
    expect(parseStepName("gateway-target:tools/orders")).toEqual({
      kind: "gateway-target",
      name: "orders",
      parent: "tools",
    });
  });

  test("rejects a step name without a kind", () => {
    expect(() => parseStepName("checkout")).toThrow(/not a resource step name/);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test src/core/project/backends/imperative/naming.test.ts`
Expected: FAIL, module `./naming` not found.

- [ ] **Step 3: Implement `naming.ts`**

```ts
// src/core/project/backends/imperative/naming.ts
import type { DeployableResource } from "../../../../handlers/project/types";

/**
 * Every resource the imperative backend creates by itself. Credential providers
 * are excluded: the shared provisioner from `backends/shared/credentials.ts`
 * owns them for both backends.
 */
export type ResourceKind = Exclude<DeployableResource, "credential">;

export type NamingScope = { projectName: string; targetName: string };

export const PROJECT_TAG = "agentcore:project-name";
export const TARGET_TAG = "agentcore:target-name";
export const MANAGED_BY_TAG = "agentcore:managed-by";
export const MANAGED_BY_VALUE = "imperative";

/** Kinds whose service-side name pattern allows hyphens but not underscores. */
const HYPHENATED_KINDS: ReadonlySet<ResourceKind> = new Set(["gateway", "gateway-target"]);

/** FNV-1a over UTF-16 code units, hex, six characters: stable across runs and platforms. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 6);
}

/**
 * The name a resource carries in AWS: `<project><sep><target><sep><name>`, where
 * `sep` is `_` except for gateway kinds, which use `-`. The other separator is
 * rewritten so the result matches the kind's name pattern. When `maxLength` is
 * given and the full name is longer, the tail is replaced by `<sep><digest>` of
 * the full name, so two long names never collide and the head stays readable.
 */
export function physicalName(
  scope: NamingScope,
  kind: ResourceKind,
  name: string,
  maxLength?: number,
): string {
  const separator = HYPHENATED_KINDS.has(kind) ? "-" : "_";
  const other = separator === "-" ? "_" : "-";
  const full = [scope.projectName, scope.targetName, name]
    .map((part) => part.replaceAll(other, separator))
    .join(separator);
  if (maxLength === undefined || full.length <= maxLength) return full;
  const suffix = `${separator}${digest(full)}`;
  return `${full.slice(0, maxLength - suffix.length)}${suffix}`;
}

export function ownershipTags(scope: NamingScope): Record<string, string> {
  return {
    [PROJECT_TAG]: scope.projectName,
    [TARGET_TAG]: scope.targetName,
    [MANAGED_BY_TAG]: MANAGED_BY_VALUE,
  };
}

/** True when a live resource's tags say this project and target created it. */
export function ownsResource(
  scope: NamingScope,
  tags: Record<string, string | undefined> | undefined,
): boolean {
  if (!tags) return false;
  return Object.entries(ownershipTags(scope)).every(([key, value]) => tags[key] === value);
}

/** `kind:name` for top-level resources, `kind:parent/name` for children. */
export function stepName(kind: ResourceKind, name: string, parent?: string): string {
  return parent === undefined ? `${kind}:${name}` : `${kind}:${parent}/${name}`;
}

export function parseStepName(step: string): { kind: ResourceKind; name: string; parent?: string } {
  const colon = step.indexOf(":");
  if (colon <= 0) throw new Error(`'${step}' is not a resource step name`);
  const kind = step.slice(0, colon) as ResourceKind;
  const rest = step.slice(colon + 1);
  const slash = rest.indexOf("/");
  return slash < 0
    ? { kind, name: rest }
    : { kind, name: rest.slice(slash + 1), parent: rest.slice(0, slash) };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/project/backends/imperative/naming.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/project/backends/imperative/naming.ts src/core/project/backends/imperative/naming.test.ts
git commit -m "feat(imperative): resource naming, ownership tags and step names"
```

---

### Task 7: `imperative/status.ts`: service status strings to `StatusReport`

**Files:**

- Create: `src/core/project/backends/imperative/status.ts`
- Test: `src/core/project/backends/imperative/status.test.ts`

**Interfaces:**

- Consumes: `Status`, `StatusReport` from `./plan/plan`.
- Produces: `export function fromServiceStatus(status: string | undefined, options?: { statusReason?: string }): StatusReport;`

The table this implements is the research doc's status table (`docs/superpowers/research/2026-09-24-imperative-deploy-context.md`): converged is `READY` or `ACTIVE`; in progress is `CREATING`, `UPDATING`, `DELETING`, `SYNCHRONIZING`, `PROVISIONING`, `PENDING_AUTHENTICATION` and anything ending in `_PENDING_AUTH`; failed is `FAILED`, `CREATE_FAILED`, `UPDATE_FAILED`, `DELETE_FAILED`, `UPDATE_UNSUCCESSFUL`, `SYNCHRONIZE_UNSUCCESSFUL`, `ERROR`, `AUTHENTICATION_FAILED`, `AUTHENTICATION_EXPIRED`, `AWS_MARKETPLACE_SUBSCRIPTION_REQUIRED`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/project/backends/imperative/status.test.ts
import { describe, expect, test } from "bun:test";
import { Status } from "./plan/plan";
import { fromServiceStatus } from "./status";

describe("fromServiceStatus", () => {
  test.each([
    ["READY", Status.Successful],
    ["ACTIVE", Status.Successful],
    ["CREATING", Status.Waiting],
    ["UPDATING", Status.Waiting],
    ["DELETING", Status.Waiting],
    ["SYNCHRONIZING", Status.Waiting],
    ["PROVISIONING", Status.Waiting],
    ["PENDING_AUTHENTICATION", Status.Waiting],
    ["CREATE_PENDING_AUTH", Status.Waiting],
    ["FAILED", Status.Failed],
    ["CREATE_FAILED", Status.Failed],
    ["UPDATE_FAILED", Status.Failed],
    ["DELETE_FAILED", Status.Failed],
    ["UPDATE_UNSUCCESSFUL", Status.Failed],
    ["SYNCHRONIZE_UNSUCCESSFUL", Status.Failed],
    ["ERROR", Status.Failed],
    ["AUTHENTICATION_FAILED", Status.Failed],
    ["AUTHENTICATION_EXPIRED", Status.Failed],
    ["AWS_MARKETPLACE_SUBSCRIPTION_REQUIRED", Status.Failed],
  ])("%s → %s", (service, expected) => {
    expect(fromServiceStatus(service).status).toBe(expected);
  });

  test("carries the service status as detail while waiting", () => {
    expect(fromServiceStatus("CREATING")).toEqual({ status: Status.Waiting, detail: "CREATING" });
  });

  test("a failure carries the status and the reason", () => {
    expect(fromServiceStatus("CREATE_FAILED", { statusReason: "role not assumable" })).toEqual({
      status: Status.Failed,
      detail: "CREATE_FAILED: role not assumable",
    });
    expect(fromServiceStatus("FAILED").detail).toBe("FAILED");
  });

  test("no status yet is waiting, not failed", () => {
    expect(fromServiceStatus(undefined)).toEqual({
      status: Status.Waiting,
      detail: "status not reported yet",
    });
  });

  test("an unknown status keeps waiting and says so, so the step timeout bounds it", () => {
    expect(fromServiceStatus("MIGRATING")).toEqual({
      status: Status.Waiting,
      detail: "unrecognized status MIGRATING",
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test src/core/project/backends/imperative/status.test.ts`
Expected: FAIL, module `./status` not found.

- [ ] **Step 3: Implement**

```ts
// src/core/project/backends/imperative/status.ts
import { Status, type StatusReport } from "./plan/plan";

const CONVERGED = new Set(["READY", "ACTIVE"]);
const IN_PROGRESS = new Set([
  "CREATING",
  "UPDATING",
  "DELETING",
  "SYNCHRONIZING",
  "PROVISIONING",
  "PENDING_AUTHENTICATION",
]);
const FAILED = new Set([
  "FAILED",
  "CREATE_FAILED",
  "UPDATE_FAILED",
  "DELETE_FAILED",
  "UPDATE_UNSUCCESSFUL",
  "SYNCHRONIZE_UNSUCCESSFUL",
  "ERROR",
  "AUTHENTICATION_FAILED",
  "AUTHENTICATION_EXPIRED",
  "AWS_MARKETPLACE_SUBSCRIPTION_REQUIRED",
]);

/**
 * Maps an AgentCore resource status to the plan engine's vocabulary. Every kind
 * uses one of two converged words and a shared set of failure words, so one
 * table serves all of them. An unknown status is treated as still in progress:
 * the step timeout bounds how long that can last, and the detail says why.
 */
export function fromServiceStatus(
  status: string | undefined,
  options: { statusReason?: string } = {},
): StatusReport {
  if (status === undefined) return { status: Status.Waiting, detail: "status not reported yet" };
  if (CONVERGED.has(status)) return { status: Status.Successful };
  if (FAILED.has(status)) {
    const detail = options.statusReason ? `${status}: ${options.statusReason}` : status;
    return { status: Status.Failed, detail };
  }
  if (IN_PROGRESS.has(status) || status.endsWith("_PENDING_AUTH")) {
    return { status: Status.Waiting, detail: status };
  }
  return { status: Status.Waiting, detail: `unrecognized status ${status}` };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/project/backends/imperative/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/project/backends/imperative/status.ts src/core/project/backends/imperative/status.test.ts
git commit -m "feat(imperative): normalize service statuses into plan statuses"
```

---

### Task 8: `imperative/state.ts`: the `resources.imperative` ledger

**Files:**

- Modify: `src/core/project/backends/shared/deployedState.ts` (`ResourceStateSchema` gains `imperative`; new `hasImperativeResources`)
- Modify: `src/core/project/backends/shared/deployedState.test.ts` (one test)
- Create: `src/core/project/backends/imperative/state.ts`
- Test: `src/core/project/backends/imperative/state.test.ts`

**Interfaces:**

- Consumes (Phase 0): `readDeployedState(json, rootPath)`, `updateTargetState(json, rootPath, targetName, patch)`, `stackReferenceOf(targetState)`, `TargetState`, `ReadWriteJson`.
- Produces in `shared/deployedState.ts`:

  ```ts
  // inside ResourceStateSchema:
  imperative: z.record(z.string(), z.unknown()).optional(),
  export function hasImperativeResources(state: TargetState | undefined): boolean;
  ```

- Produces in `imperative/state.ts`:

  ```ts
  export const ImperativeResourceRecordSchema = z.object({ arn: z.string().optional(), id: z.string().optional(), updatedAt: z.string() }).passthrough();
  export type ImperativeResourceRecord = z.infer<typeof ImperativeResourceRecordSchema>;
  export type ImperativeState = Partial<Record<ResourceKind, Record<string, ImperativeResourceRecord>>>;
  export function imperativeStateOf(state: TargetState | undefined): ImperativeState;
  export function readImperativeState(json: ReadWriteJson, rootPath: string, targetName: string): Promise<ImperativeState>;
  export function hasCdkBinding(state: TargetState | undefined): boolean;
  export function recordImperativeResource(json, rootPath, targetName, kind: ResourceKind, key: string, outputs: { arn?: string; id?: string }, now: () => Date): Promise<void>;
  export function forgetImperativeResource(json, rootPath, targetName, kind: ResourceKind, key: string): Promise<void>;
  ```

  `key` is the resource name, or `parent/child` for children (the same shape `stepName` uses after the colon).

- [ ] **Step 1: Extend the shared schema and add the CDK-side probe**

In `src/core/project/backends/shared/deployedState.ts`, add to the `ResourceStateSchema` object (next to `credentials` and `stackName`):

```ts
    /** Resources the imperative backend created, keyed by kind then name. */
    imperative: z.record(z.string(), z.unknown()).optional(),
```

and after `stackReferenceOf`:

```ts
/**
 * True when the imperative backend recorded anything for this target. The CDK
 * backend refuses to deploy over it: the stack would create a second copy of
 * every resource and orphan the imperative ones (design §4.5 "Switching managedBy").
 */
export function hasImperativeResources(state: TargetState | undefined): boolean {
  const imperative = state?.resources?.imperative ?? {};
  return Object.values(imperative).some(
    (byName) => typeof byName === "object" && byName !== null && Object.keys(byName).length > 0,
  );
}
```

Add to `shared/deployedState.test.ts`:

```ts
  test("hasImperativeResources is false for a CDK-only target and true once a kind has an entry", () => {
    expect(hasImperativeResources(undefined)).toBe(false);
    expect(hasImperativeResources({ stackArn: "arn:aws:cloudformation:..." })).toBe(false);
    expect(hasImperativeResources({ resources: { imperative: { runtime: {} } } })).toBe(false);
    expect(
      hasImperativeResources({
        resources: { imperative: { runtime: { a: { arn: "arn", updatedAt: "t" } } } },
      }),
    ).toBe(true);
  });
```

Run: `bun test src/core/project/backends/shared/deployedState.test.ts` → PASS.

- [ ] **Step 2: Write the failing tests for `imperative/state.ts`**

```ts
// src/core/project/backends/imperative/state.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { inTempDirectory } from "../../../../testing";
import { FsReadWriteJson } from "../../../../io";
import { createSilentLogger } from "../../../../testing";
import { DEPLOYED_STATE_RELATIVE_PATH, readDeployedState } from "../shared/deployedState";
import {
  forgetImperativeResource,
  hasCdkBinding,
  imperativeStateOf,
  readImperativeState,
  recordImperativeResource,
} from "./state";

const now = () => new Date("2026-09-24T00:00:00.000Z");

async function fixture() {
  const { path: root } = await inTempDirectory();
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
    await recordImperativeResource(json, root, "dev", "memory", "orders", { arn: "arn:m", id: "m-1" }, now);
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
    expect((state.targets["dev"]?.resources as Record<string, unknown>)["custom"]).toBe(1);
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
});
```

If `inTempDirectory` or `FsReadWriteJson` live under different export paths in this tree, follow `grep -rn "export.*inTempDirectory\|export class FsReadWriteJson" src` and adjust the imports; the test in `shared/deployedState.test.ts` shows the local convention.

- [ ] **Step 3: Run to see them fail**

Run: `bun test src/core/project/backends/imperative/state.test.ts`
Expected: FAIL, module `./state` not found.

- [ ] **Step 4: Implement `state.ts`**

```ts
// src/core/project/backends/imperative/state.ts
import { z } from "zod";
import type { ReadWriteJson } from "../../../../io";
import {
  readDeployedState,
  stackReferenceOf,
  updateTargetState,
  type TargetState,
} from "../shared/deployedState";
import type { ResourceKind } from "./naming";

export const ImperativeResourceRecordSchema = z
  .object({
    arn: z.string().optional(),
    id: z.string().optional(),
    updatedAt: z.string(),
  })
  .passthrough();
export type ImperativeResourceRecord = z.infer<typeof ImperativeResourceRecordSchema>;

/** `targets.<target>.resources.imperative`, keyed by kind, then by name or `parent/child`. */
export type ImperativeState = Partial<Record<ResourceKind, Record<string, ImperativeResourceRecord>>>;

/** Parses the ledger out of a target's state, dropping entries that do not parse. */
export function imperativeStateOf(state: TargetState | undefined): ImperativeState {
  const raw = state?.resources?.imperative ?? {};
  const result: ImperativeState = {};
  for (const [kind, byKey] of Object.entries(raw)) {
    if (typeof byKey !== "object" || byKey === null) continue;
    const records: Record<string, ImperativeResourceRecord> = {};
    for (const [key, value] of Object.entries(byKey as Record<string, unknown>)) {
      const parsed = ImperativeResourceRecordSchema.safeParse(value);
      if (parsed.success) records[key] = parsed.data;
    }
    if (Object.keys(records).length > 0) result[kind as ResourceKind] = records;
  }
  return result;
}

export async function readImperativeState(
  json: ReadWriteJson,
  rootPath: string,
  targetName: string,
): Promise<ImperativeState> {
  const state = await readDeployedState(json, rootPath);
  return imperativeStateOf(state.targets[targetName]);
}

/** True when the CDK backend deployed this target (a stack ARN or name is recorded). */
export function hasCdkBinding(state: TargetState | undefined): boolean {
  return stackReferenceOf(state) !== undefined;
}

export async function recordImperativeResource(
  json: ReadWriteJson,
  rootPath: string,
  targetName: string,
  kind: ResourceKind,
  key: string,
  outputs: { arn?: string; id?: string },
  now: () => Date,
): Promise<void> {
  const current = await readImperativeState(json, rootPath, targetName);
  const record: ImperativeResourceRecord = {
    ...(outputs.arn !== undefined && { arn: outputs.arn }),
    ...(outputs.id !== undefined && { id: outputs.id }),
    updatedAt: now().toISOString(),
  };
  const imperative: ImperativeState = {
    ...current,
    [kind]: { ...current[kind], [key]: record },
  };
  // updateTargetState merges `resources` one level deep, so the whole ledger is
  // rewritten but credentials and unknown siblings survive.
  await updateTargetState(json, rootPath, targetName, { resources: { imperative } });
}

export async function forgetImperativeResource(
  json: ReadWriteJson,
  rootPath: string,
  targetName: string,
  kind: ResourceKind,
  key: string,
): Promise<void> {
  const current = await readImperativeState(json, rootPath, targetName);
  const byKey = { ...current[kind] };
  if (!(key in byKey)) return;
  delete byKey[key];
  const imperative: ImperativeState = { ...current };
  if (Object.keys(byKey).length === 0) delete imperative[kind];
  else imperative[kind] = byKey;
  await updateTargetState(json, rootPath, targetName, { resources: { imperative } });
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/project/backends/imperative/state.test.ts src/core/project/backends/shared/deployedState.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/project/backends/shared/deployedState.ts src/core/project/backends/shared/deployedState.test.ts src/core/project/backends/imperative/state.ts src/core/project/backends/imperative/state.test.ts
git commit -m "feat(imperative): record deployed resources under resources.imperative"
```

---

### Task 9: `imperative/inventory.ts` and `imperative/support.ts`: what the spec declares, what is supported

**Files:**

- Create: `src/core/project/backends/imperative/inventory.ts`
- Test: `src/core/project/backends/imperative/inventory.test.ts`
- Create: `src/core/project/backends/imperative/support.ts`
- Test: `src/core/project/backends/imperative/support.test.ts`

**Interfaces:**

- Consumes: `Project` (`src/handlers/project/types.ts`), `ResourceKind`, `stepName` (Task 6), `ImperativeState` (Task 8), `ProjectStateError`, `NotImplementedError` (`src/errors`).
- Produces in `inventory.ts`:

  ```ts
  export type DeclaredResource = { kind: ResourceKind; name: string; parent?: string };
  export const PARENT_KIND: Partial<Record<ResourceKind, ResourceKind>>; // gateway-target→gateway, policy→policy-engine, payment-connector→payment-manager, runtime-endpoint→runtime
  export function declaredResources(spec: Project["spec"]): DeclaredResource[];
  export function recordedResources(state: ImperativeState): DeclaredResource[];
  export function stateKey(resource: DeclaredResource): string;   // "name" or "parent/name"
  export function stepOf(resource: DeclaredResource): string;      // stepName(kind, name, parent)
  ```

- Produces in `support.ts`:

  ```ts
  export const SUPPORTED_KINDS: ReadonlySet<ResourceKind>; // empty in Phase 1
  export function assertImperativelyDeployable(project: Project, supported: ReadonlySet<ResourceKind>): void;
  ```

Order matters in `declaredResources`: parents before their children, and the output order is the order `resolveProjectResources` reports (runtimes, endpoints, harnesses, memories, knowledge bases, evaluators, online evals, gateways + targets, policy engines + policies, config bundles, payment managers + connectors). Runtime endpoints are declared here so Phase 2 can create them; in Phase 1 their handler is a placeholder like every other kind.

- [ ] **Step 1: Write the failing inventory tests**

```ts
// src/core/project/backends/imperative/inventory.test.ts
import { describe, expect, test } from "bun:test";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import type { Project } from "../../../../handlers/project/types";
import { declaredResources, recordedResources, stateKey, stepOf } from "./inventory";

/** A parsed spec with the defaults filled in, overlaid with partial collections. */
function spec(overrides: Record<string, unknown>): Project["spec"] {
  return { ...ProjectSpecSchema.parse({ name: "Shop", version: 2 }), ...overrides } as Project["spec"];
}

describe("declaredResources", () => {
  test("an empty spec declares nothing", () => {
    expect(declaredResources(spec({}))).toEqual([]);
  });

  test("flattens every collection, parents before children, in report order", () => {
    const declared = declaredResources(
      spec({
        runtimes: [{ name: "checkout", endpoints: { live: { version: 1 } } }],
        harnesses: [{ name: "support" }],
        memories: [{ name: "orders" }],
        knowledgeBases: [{ name: "faq" }],
        evaluators: [{ name: "tone" }],
        onlineEvalConfigs: [{ name: "prod_eval" }],
        agentCoreGateways: [{ name: "tools", targets: [{ name: "get_order" }] }],
        policyEngines: [{ name: "guard", policies: [{ name: "no_pii" }] }],
        configBundles: [{ name: "cfg" }],
        payments: [{ name: "pay", connectors: [{ name: "stripe" }] }],
      }),
    );
    expect(declared).toEqual([
      { kind: "runtime", name: "checkout" },
      { kind: "runtime-endpoint", name: "live", parent: "checkout" },
      { kind: "harness", name: "support" },
      { kind: "memory", name: "orders" },
      { kind: "knowledge-base", name: "faq" },
      { kind: "evaluator", name: "tone" },
      { kind: "online-eval", name: "prod_eval" },
      { kind: "gateway", name: "tools" },
      { kind: "gateway-target", name: "get_order", parent: "tools" },
      { kind: "policy-engine", name: "guard" },
      { kind: "policy", name: "no_pii", parent: "guard" },
      { kind: "config-bundle", name: "cfg" },
      { kind: "payment-manager", name: "pay" },
      { kind: "payment-connector", name: "stripe", parent: "pay" },
    ]);
  });
});

describe("recordedResources", () => {
  test("reads kinds and keys back, splitting parent/child keys", () => {
    expect(
      recordedResources({
        memory: { orders: { arn: "a", updatedAt: "t" } },
        "gateway-target": { "tools/get_order": { id: "x", updatedAt: "t" } },
      }),
    ).toEqual([
      { kind: "memory", name: "orders" },
      { kind: "gateway-target", name: "get_order", parent: "tools" },
    ]);
  });
});

describe("keys", () => {
  test("stateKey and stepOf agree with naming.stepName", () => {
    expect(stateKey({ kind: "memory", name: "orders" })).toBe("orders");
    expect(stateKey({ kind: "policy", name: "no_pii", parent: "guard" })).toBe("guard/no_pii");
    expect(stepOf({ kind: "policy", name: "no_pii", parent: "guard" })).toBe("policy:guard/no_pii");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/project/backends/imperative/inventory.test.ts`
Expected: FAIL, module `./inventory` not found.

- [ ] **Step 3: Implement `inventory.ts`**

```ts
// src/core/project/backends/imperative/inventory.ts
import type { Project } from "../../../../handlers/project/types";
import { stepName, type ResourceKind } from "./naming";
import type { ImperativeState } from "./state";

export type DeclaredResource = { kind: ResourceKind; name: string; parent?: string };

/** Child kinds and the kind that owns them. */
export const PARENT_KIND: Partial<Record<ResourceKind, ResourceKind>> = {
  "runtime-endpoint": "runtime",
  "gateway-target": "gateway",
  policy: "policy-engine",
  "payment-connector": "payment-manager",
};

/** Every resource the spec declares, parents before their children, in report order. */
export function declaredResources(spec: Project["spec"]): DeclaredResource[] {
  const out: DeclaredResource[] = [];
  const add = (kind: ResourceKind, name: string, parent?: string) =>
    out.push(parent === undefined ? { kind, name } : { kind, name, parent });

  for (const runtime of spec.runtimes) {
    add("runtime", runtime.name);
    for (const endpoint of Object.keys(runtime.endpoints ?? {})) {
      add("runtime-endpoint", endpoint, runtime.name);
    }
  }
  for (const { name } of spec.harnesses) add("harness", name);
  for (const { name } of spec.memories) add("memory", name);
  for (const { name } of spec.knowledgeBases) add("knowledge-base", name);
  for (const { name } of spec.evaluators) add("evaluator", name);
  for (const { name } of spec.onlineEvalConfigs) add("online-eval", name);
  for (const gateway of spec.agentCoreGateways) {
    add("gateway", gateway.name);
    for (const { name } of gateway.targets ?? []) add("gateway-target", name, gateway.name);
  }
  for (const engine of spec.policyEngines) {
    add("policy-engine", engine.name);
    for (const { name } of engine.policies ?? []) add("policy", name, engine.name);
  }
  for (const { name } of spec.configBundles) add("config-bundle", name);
  for (const manager of spec.payments ?? []) {
    add("payment-manager", manager.name);
    for (const { name } of manager.connectors ?? []) add("payment-connector", name, manager.name);
  }
  return out;
}

/** Everything the ledger says was created, as declared resources. */
export function recordedResources(state: ImperativeState): DeclaredResource[] {
  const out: DeclaredResource[] = [];
  for (const [kind, byKey] of Object.entries(state) as [ResourceKind, Record<string, unknown>][]) {
    for (const key of Object.keys(byKey)) {
      const slash = key.indexOf("/");
      out.push(
        slash < 0
          ? { kind, name: key }
          : { kind, name: key.slice(slash + 1), parent: key.slice(0, slash) },
      );
    }
  }
  return out;
}

/** The ledger key: the name, or `parent/name` for children. */
export function stateKey(resource: DeclaredResource): string {
  return resource.parent === undefined ? resource.name : `${resource.parent}/${resource.name}`;
}

export function stepOf(resource: DeclaredResource): string {
  return stepName(resource.kind, resource.name, resource.parent);
}
```

If a collection in `ProjectSpecSchema` is optional rather than defaulted (check `src/projectSchemas/project.ts`), use `?? []` for it as the code does for `payments`, `targets`, `policies`, `connectors`.

- [ ] **Step 4: Run the inventory tests**

Run: `bun test src/core/project/backends/imperative/inventory.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing support tests**

```ts
// src/core/project/backends/imperative/support.test.ts
import { describe, expect, test } from "bun:test";
import { NotImplementedError, ProjectStateError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import { assertImperativelyDeployable, SUPPORTED_KINDS } from "./support";

function project(overrides: Record<string, unknown>): Project {
  return {
    name: "Shop",
    rootPath: "/tmp/shop",
    spec: { ...ProjectSpecSchema.parse({ name: "Shop", version: 2 }), ...overrides } as Project["spec"],
  };
}

describe("assertImperativelyDeployable", () => {
  test("phase 1 supports no resource kinds", () => {
    expect(SUPPORTED_KINDS.size).toBe(0);
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
      runtimes: [{ name: "a", build: "Container" }, { name: "b", build: "CodeZip" }],
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

  test("everything supported passes", () => {
    const p = project({ memories: [{ name: "m1" }] });
    expect(() => assertImperativelyDeployable(p, new Set(["memory"]))).not.toThrow();
  });
});
```

- [ ] **Step 6: Run to see them fail, then implement `support.ts`**

Run: `bun test src/core/project/backends/imperative/support.test.ts` → FAIL (module not found).

```ts
// src/core/project/backends/imperative/support.ts
import { NotImplementedError, ProjectStateError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";
import { declaredResources } from "./inventory";
import type { ResourceKind } from "./naming";

/**
 * Kinds the imperative backend can create today. Each phase adds to this set as
 * its kind module lands (design §4.7). Phase 1 ships the engine and no kinds.
 */
export const SUPPORTED_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>([]);

const CDK_ESCAPE_HATCH = `Set managedBy to "CDK" in agentcore/agentcore.json to deploy it with CloudFormation.`;

/**
 * Fails before any AWS call when the spec declares something this backend
 * cannot deploy: a container-built runtime (deferred until the build strategy is
 * decided, design §2) or a resource kind whose module has not shipped.
 */
export function assertImperativelyDeployable(
  project: Project,
  supported: ReadonlySet<ResourceKind>,
): void {
  const container = project.spec.runtimes.find((runtime) => runtime.build === "Container");
  if (container) {
    throw new ProjectStateError(
      `Project '${project.name}' cannot be deployed imperatively: runtime '${container.name}' ` +
        `is built as a Container, which imperative deploy does not support yet. Switch it to a ` +
        `CodeZip build, or ${CDK_ESCAPE_HATCH}`,
    );
  }

  const unsupported = [
    ...new Set(declaredResources(project.spec).map(({ kind }) => kind)),
  ].filter((kind) => !supported.has(kind));
  if (unsupported.length > 0) {
    throw new NotImplementedError(
      `Project '${project.name}' cannot be deployed imperatively: imperative deploy does not ` +
        `support these resource kinds yet: ${unsupported.join(", ")}. ${CDK_ESCAPE_HATCH}`,
    );
  }
}
```

- [ ] **Step 7: Run both test files, then commit**

Run: `bun test src/core/project/backends/imperative/inventory.test.ts src/core/project/backends/imperative/support.test.ts`
Expected: PASS.

```bash
git add src/core/project/backends/imperative/inventory.ts src/core/project/backends/imperative/inventory.test.ts src/core/project/backends/imperative/support.ts src/core/project/backends/imperative/support.test.ts
git commit -m "feat(imperative): declared/recorded inventory and supported-kind gate"
```

---

### Task 10: `agentcore/`: the stack, placeholder handlers, and the plan factory

This is the `lightpress/` analog from the prior art: the domain module that knows the resources and hands the generic engine a graph.

**Files:**

- Create: `src/core/project/backends/imperative/agentcore/stack.ts`
- Test: `src/core/project/backends/imperative/agentcore/stack.test.ts`
- Create: `src/core/project/backends/imperative/agentcore/notImplemented.ts`
- Create: `src/core/project/backends/imperative/agentcore/plan.ts`
- Test: `src/core/project/backends/imperative/agentcore/plan.test.ts`

**Interfaces:**

- Consumes: `Plan`, `Step`, `Doer`, `Statuser` (Task 4); `physicalName`, `ownershipTags`, `NamingScope`, `ResourceKind` (Task 6); `ImperativeState` (Task 8); `DeclaredResource`, `declaredResources`, `recordedResources`, `stateKey`, `stepOf`, `PARENT_KIND` (Task 9); `AwsClients`, `AwsCredentials`, `ClientConfig` (`src/core/types.tsx`); `Logger`; `Project`.
- Produces in `stack.ts`:

  ```ts
  export type StackScope = NamingScope & { account: string; region: string };
  export type ResourceOutputs = { arn?: string; id?: string };
  export class AgentCoreStack {
    constructor(readonly scope: StackScope, readonly clients: AwsClients, readonly credentials: AwsCredentials, readonly logger: Logger, recorded: ImperativeState);
    options(): ClientConfig;                                   // { region, credentials }
    name(kind: ResourceKind, name: string, maxLength?: number): string;
    tags(extra?: Record<string, string>): Record<string, string>;
    record(step: string, outputs: ResourceOutputs): void;
    forget(step: string): void;
    outputsOf(step: string): ResourceOutputs | undefined;
    outputs(): Record<string, string>;                          // "<step>.arn" / "<step>.id"
  }
  ```

- Produces in `notImplemented.ts`:

  ```ts
  export type KindHandlers = {
    create(stack: AgentCoreStack, resource: DeclaredResource, spec: Project["spec"]): Doer;
    poll(stack: AgentCoreStack, resource: DeclaredResource, spec: Project["spec"]): Statuser;
    remove(stack: AgentCoreStack, resource: DeclaredResource): Doer;
    pollGone(stack: AgentCoreStack, resource: DeclaredResource): Statuser;
  };
  export function notImplemented(kind: ResourceKind): KindHandlers;
  ```

- Produces in `plan.ts`:

  ```ts
  export const HANDLERS: Record<ResourceKind, KindHandlers>;
  export type PlanInput = { project: Project; scope: StackScope; clients: AwsClients; credentials: AwsCredentials; logger: Logger; recorded: ImperativeState; handlers?: Partial<Record<ResourceKind, KindHandlers>> };
  export type Plans = { stack: AgentCoreStack; apply: Plan; remove: Plan; declared: DeclaredResource[]; removed: DeclaredResource[] };
  export function plan(input: PlanInput): Plans;
  export type PlanBuilder = typeof plan;
  ```

- [ ] **Step 1: Write the failing stack tests**

```ts
// src/core/project/backends/imperative/agentcore/stack.test.ts
import { describe, expect, test } from "bun:test";
import { createSilentLogger } from "../../../../../testing";
import type { AwsClients } from "../../../../types";
import { AgentCoreStack } from "./stack";

const clients = {} as AwsClients;
const credentials = { accessKeyId: "a", secretAccessKey: "b" };
const scope = { projectName: "Shop", targetName: "dev", account: "111122223333", region: "us-east-1" };

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
```

- [ ] **Step 2: Implement `stack.ts`**

```ts
// src/core/project/backends/imperative/agentcore/stack.ts
import type { Logger } from "../../../../../logging";
import type { AwsClients, AwsCredentials, ClientConfig } from "../../../../types";
import { recordedResources, stateKey, stepOf } from "../inventory";
import { ownershipTags, physicalName, type NamingScope, type ResourceKind } from "../naming";
import type { ImperativeState } from "../state";

export type StackScope = NamingScope & { account: string; region: string };

export type ResourceOutputs = { arn?: string; id?: string };

/**
 * What one deploy of one target knows: who it is deploying for, how to reach
 * AWS, and the identifiers of every resource it has seen. Steps read identifiers
 * of the resources they depend on from here (a runtime reads its memories' ids)
 * and write their own after they converge. Mirrors `wpstack` in the prior art.
 */
export class AgentCoreStack {
  private readonly data = new Map<string, ResourceOutputs>();

  constructor(
    readonly scope: StackScope,
    readonly clients: AwsClients,
    readonly credentials: AwsCredentials,
    readonly logger: Logger,
    recorded: ImperativeState,
  ) {
    for (const resource of recordedResources(recorded)) {
      const record = recorded[resource.kind]?.[stateKey(resource)];
      if (!record) continue;
      this.record(stepOf(resource), {
        ...(record.arn !== undefined && { arn: record.arn }),
        ...(record.id !== undefined && { id: record.id }),
      });
    }
  }

  /** Client config for every SDK call this deploy makes. */
  options(): ClientConfig {
    return { region: this.scope.region, credentials: this.credentials };
  }

  name(kind: ResourceKind, name: string, maxLength?: number): string {
    return physicalName(this.scope, kind, name, maxLength);
  }

  tags(extra: Record<string, string> = {}): Record<string, string> {
    return { ...ownershipTags(this.scope), ...extra };
  }

  record(step: string, outputs: ResourceOutputs): void {
    this.data.set(step, { ...outputs });
  }

  forget(step: string): void {
    this.data.delete(step);
  }

  outputsOf(step: string): ResourceOutputs | undefined {
    const outputs = this.data.get(step);
    return outputs ? { ...outputs } : undefined;
  }

  /** Flat `<step>.arn` / `<step>.id` map, the shape `DeployResult.outputs` wants. */
  outputs(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [step, { arn, id }] of this.data) {
      if (arn !== undefined) out[`${step}.arn`] = arn;
      if (id !== undefined) out[`${step}.id`] = id;
    }
    return out;
  }
}
```

If `ClientConfig` is not exported under that name from `src/core/types.tsx`, use whatever type `AwsClients.control(config)` accepts (`grep -n "control(config" src/core/types.tsx`).

Run: `bun test src/core/project/backends/imperative/agentcore/stack.test.ts` → PASS.

- [ ] **Step 3: Implement `notImplemented.ts`**

```ts
// src/core/project/backends/imperative/agentcore/notImplemented.ts
import { NotImplementedError } from "../../../../../errors";
import type { Project } from "../../../../../handlers/project/types";
import type { DeclaredResource } from "../inventory";
import type { ResourceKind } from "../naming";
import type { Doer, Statuser } from "../plan/plan";
import type { AgentCoreStack } from "./stack";

/**
 * One kind's four operations, the `Create*`/`Poll*` pairs of the prior art.
 * `create` and `remove` start work; `poll` and `pollGone` observe it. Each
 * returns a closure the plan installs as a step's `do` or `status`.
 */
export type KindHandlers = {
  create(stack: AgentCoreStack, resource: DeclaredResource, spec: Project["spec"]): Doer;
  poll(stack: AgentCoreStack, resource: DeclaredResource, spec: Project["spec"]): Statuser;
  remove(stack: AgentCoreStack, resource: DeclaredResource): Doer;
  pollGone(stack: AgentCoreStack, resource: DeclaredResource): Statuser;
};

/**
 * The handlers every kind starts with. `assertImperativelyDeployable` keeps a
 * plan holding one of these from ever executing, so the throw is a backstop for
 * a registry mistake, not a user-facing path.
 */
export function notImplemented(kind: ResourceKind): KindHandlers {
  const fail = () => {
    throw new NotImplementedError(`imperative deploy of ${kind} is not implemented yet`);
  };
  return {
    create: () => async () => fail(),
    poll: () => async () => fail(),
    remove: () => async () => fail(),
    pollGone: () => async () => fail(),
  };
}
```

- [ ] **Step 4: Write the failing plan factory tests**

```ts
// src/core/project/backends/imperative/agentcore/plan.test.ts
import { describe, expect, test } from "bun:test";
import type { Project } from "../../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../../projectSchemas/project";
import { createSilentLogger } from "../../../../../testing";
import type { AwsClients } from "../../../../types";
import type { ImperativeState } from "../state";
import type { KindHandlers } from "./notImplemented";
import { plan, type PlanInput } from "./plan";

function project(overrides: Record<string, unknown>): Project {
  return {
    name: "Shop",
    rootPath: "/tmp/shop",
    spec: { ...ProjectSpecSchema.parse({ name: "Shop", version: 2 }), ...overrides } as Project["spec"],
  };
}

const noop: KindHandlers = {
  create: () => async () => {},
  poll: () => async () => ({ status: "SUCCESSFUL" }),
  remove: () => async () => {},
  pollGone: () => async () => ({ status: "SUCCESSFUL" }),
};

function input(spec: Record<string, unknown>, recorded: ImperativeState = {}): PlanInput {
  return {
    project: project(spec),
    scope: { projectName: "Shop", targetName: "dev", account: "111122223333", region: "us-east-1" },
    clients: {} as AwsClients,
    credentials: { accessKeyId: "a", secretAccessKey: "b" },
    logger: createSilentLogger(),
    recorded,
    handlers: Object.fromEntries(
      [
        "runtime", "runtime-endpoint", "harness", "memory", "knowledge-base", "evaluator",
        "online-eval", "gateway", "gateway-target", "policy-engine", "policy", "config-bundle",
        "payment-manager", "payment-connector",
      ].map((kind) => [kind, noop]),
    ),
  };
}

/** `child -> [parents]` from a validated plan, for readable edge assertions. */
function parentsOf(p: ReturnType<typeof plan>["apply"]) {
  const validated = p.validate();
  return Object.fromEntries([...validated.parents].map(([k, v]) => [k, [...v].sort()]));
}

describe("plan", () => {
  test("names the plans after project and target and lists declared resources", () => {
    const plans = plan(input({ memories: [{ name: "m" }] }));
    expect(plans.apply.name).toBe("apply Shop/dev");
    expect(plans.remove.name).toBe("remove Shop/dev");
    expect(plans.declared).toEqual([{ kind: "memory", name: "m" }]);
    expect(plans.removed).toEqual([]);
  });

  test("wires the apply graph: parents before children, memories and gateways before runtimes, policy engine before its gateway, runtime and evaluators before online eval", () => {
    const plans = plan(
      input({
        runtimes: [{ name: "agent", endpoints: { live: { version: 1 } } }],
        memories: [{ name: "m" }],
        evaluators: [{ name: "tone" }],
        onlineEvalConfigs: [{ name: "oe", agent: "agent", evaluators: ["tone", "Builtin.Helpfulness"] }],
        agentCoreGateways: [
          { name: "gw", targets: [{ name: "t" }], policyEngineConfiguration: { policyEngineName: "pe" } },
        ],
        policyEngines: [{ name: "pe", policies: [{ name: "p" }] }],
      }),
    );
    expect(parentsOf(plans.apply)).toEqual({
      "runtime-endpoint:agent/live": ["runtime:agent"],
      "runtime:agent": ["gateway:gw", "memory:m"],
      "gateway-target:gw/t": ["gateway:gw"],
      "gateway:gw": ["policy-engine:pe"],
      "policy:pe/p": ["policy-engine:pe"],
      "online-eval:oe": ["evaluator:tone", "runtime:agent"],
    });
    expect(plans.apply.validate().roots.sort()).toEqual(["evaluator:tone", "memory:m", "policy-engine:pe"]);
  });

  test("the remove plan holds recorded resources the spec dropped, children before parents, dependents before dependencies", () => {
    const plans = plan(
      input(
        { memories: [{ name: "keep" }] },
        {
          memory: { keep: { arn: "k", updatedAt: "t" }, gone: { arn: "g", updatedAt: "t" } },
          runtime: { old: { arn: "r", updatedAt: "t" } },
          gateway: { gw: { arn: "gw", updatedAt: "t" } },
          "gateway-target": { "gw/t": { id: "t", updatedAt: "t" } },
          "online-eval": { oe: { arn: "oe", updatedAt: "t" } },
        },
      ),
    );
    expect(plans.removed.map((r) => `${r.kind}:${r.parent ? `${r.parent}/` : ""}${r.name}`).sort()).toEqual(
      ["gateway-target:gw/t", "gateway:gw", "memory:gone", "online-eval:oe", "runtime:old"],
    );
    expect(parentsOf(plans.remove)).toEqual({
      "gateway:gw": ["gateway-target:gw/t", "runtime:old"],
      "memory:gone": ["runtime:old"],
      "runtime:old": ["online-eval:oe"],
    });
  });

  test("the stack is seeded with recorded identifiers", () => {
    const plans = plan(input({}, { memory: { m: { arn: "arn:m", id: "m-1", updatedAt: "t" } } }));
    expect(plans.stack.outputsOf("memory:m")).toEqual({ arn: "arn:m", id: "m-1" });
  });

  test("every declared kind has a handler in the default registry", () => {
    const base = input({ memories: [{ name: "m" }] });
    delete base.handlers;
    expect(() => plan(base)).not.toThrow();
  });
});
```

- [ ] **Step 5: Implement `plan.ts`**

```ts
// src/core/project/backends/imperative/agentcore/plan.ts
import type { Project } from "../../../../../handlers/project/types";
import type { Logger } from "../../../../../logging";
import type { AwsClients, AwsCredentials } from "../../../../types";
import {
  declaredResources,
  PARENT_KIND,
  recordedResources,
  stateKey,
  stepOf,
  type DeclaredResource,
} from "../inventory";
import type { ResourceKind } from "../naming";
import { Plan, type Step } from "../plan/plan";
import type { ImperativeState } from "../state";
import { notImplemented, type KindHandlers } from "./notImplemented";
import { AgentCoreStack, type StackScope } from "./stack";

/** The kind registry. Later phases replace entries with real modules. */
export const HANDLERS: Record<ResourceKind, KindHandlers> = {
  runtime: notImplemented("runtime"),
  "runtime-endpoint": notImplemented("runtime-endpoint"),
  harness: notImplemented("harness"),
  memory: notImplemented("memory"),
  "knowledge-base": notImplemented("knowledge-base"),
  evaluator: notImplemented("evaluator"),
  "online-eval": notImplemented("online-eval"),
  gateway: notImplemented("gateway"),
  "gateway-target": notImplemented("gateway-target"),
  "policy-engine": notImplemented("policy-engine"),
  policy: notImplemented("policy"),
  "config-bundle": notImplemented("config-bundle"),
  "payment-manager": notImplemented("payment-manager"),
  "payment-connector": notImplemented("payment-connector"),
};

export type PlanInput = {
  project: Project;
  scope: StackScope;
  clients: AwsClients;
  credentials: AwsCredentials;
  logger: Logger;
  recorded: ImperativeState;
  /** Overrides for tests and for phases that ship kinds incrementally. */
  handlers?: Partial<Record<ResourceKind, KindHandlers>>;
};

export type Plans = {
  stack: AgentCoreStack;
  apply: Plan;
  remove: Plan;
  declared: DeclaredResource[];
  removed: DeclaredResource[];
};

export type PlanBuilder = typeof plan;

type MutableStep = Omit<Step, "next"> & { next: MutableStep[] };

/**
 * When removing, a kind listed here is removed before every kind in its list:
 * an online eval before the runtime and evaluators it watches, a runtime before
 * the memories and gateways it is wired to, a gateway before its policy engine.
 */
const REMOVE_BEFORE: Partial<Record<ResourceKind, ResourceKind[]>> = {
  "online-eval": ["runtime", "evaluator"],
  runtime: ["memory", "gateway"],
  gateway: ["policy-engine"],
};

/**
 * Turns the spec and the ledger into two plans for the engine, like `Plan(...)`
 * in the prior art. `apply` creates or updates everything declared, in
 * dependency order; `remove` deletes what the ledger holds but the spec no longer
 * declares. Both run against the same stack so identifiers flow between steps.
 */
export function plan(input: PlanInput): Plans {
  const { project, scope, recorded } = input;
  const handlers: Record<ResourceKind, KindHandlers> = { ...HANDLERS, ...input.handlers };
  const stack = new AgentCoreStack(scope, input.clients, input.credentials, input.logger, recorded);
  const spec = project.spec;

  const declared = declaredResources(spec);
  const declaredKeys = new Set(declared.map((r) => `${r.kind}:${stateKey(r)}`));
  const removed = recordedResources(recorded).filter(
    (r) => !declaredKeys.has(`${r.kind}:${stateKey(r)}`),
  );

  // apply: one step per declared resource.
  const applySteps = new Map<string, MutableStep>();
  for (const resource of declared) {
    const handler = handlers[resource.kind];
    applySteps.set(stepOf(resource), {
      name: stepOf(resource),
      do: handler.create(stack, resource, spec),
      status: handler.poll(stack, resource, spec),
      next: [],
    });
  }
  const link = (steps: Map<string, MutableStep>, from: string, to: string) => {
    const a = steps.get(from);
    const b = steps.get(to);
    if (a && b && !a.next.includes(b)) a.next.push(b);
  };
  const applyByKind = (kind: ResourceKind) => declared.filter((r) => r.kind === kind);

  for (const resource of declared) {
    const parentKind = PARENT_KIND[resource.kind];
    if (parentKind && resource.parent !== undefined) {
      link(applySteps, stepOf({ kind: parentKind, name: resource.parent }), stepOf(resource));
    }
  }
  // Every memory and gateway is wired into every runtime through env vars, so
  // they converge first (Phase 2 reads their ids when it creates the runtime).
  for (const runtime of applyByKind("runtime")) {
    for (const memory of applyByKind("memory")) link(applySteps, stepOf(memory), stepOf(runtime));
    for (const gateway of applyByKind("gateway")) link(applySteps, stepOf(gateway), stepOf(runtime));
  }
  for (const gateway of spec.agentCoreGateways) {
    const engine = gateway.policyEngineConfiguration?.policyEngineName;
    if (engine) {
      link(applySteps, stepOf({ kind: "policy-engine", name: engine }), stepOf({ kind: "gateway", name: gateway.name }));
    }
  }
  for (const config of spec.onlineEvalConfigs) {
    const target = stepOf({ kind: "online-eval", name: config.name });
    if (config.agent) link(applySteps, stepOf({ kind: "runtime", name: config.agent }), target);
    // Builtin evaluators have no step; link() ignores names it cannot find.
    for (const evaluator of config.evaluators ?? []) {
      link(applySteps, stepOf({ kind: "evaluator", name: evaluator }), target);
    }
  }

  // remove: one step per orphan; edges point from the thing removed first.
  const removeSteps = new Map<string, MutableStep>();
  for (const resource of removed) {
    const handler = handlers[resource.kind];
    removeSteps.set(stepOf(resource), {
      name: stepOf(resource),
      do: handler.remove(stack, resource),
      status: handler.pollGone(stack, resource),
      next: [],
    });
  }
  for (const resource of removed) {
    const parentKind = PARENT_KIND[resource.kind];
    if (parentKind && resource.parent !== undefined) {
      link(removeSteps, stepOf(resource), stepOf({ kind: parentKind, name: resource.parent }));
    }
    for (const laterKind of REMOVE_BEFORE[resource.kind] ?? []) {
      for (const later of removed.filter((r) => r.kind === laterKind)) {
        link(removeSteps, stepOf(resource), stepOf(later));
      }
    }
  }

  const label = `${project.name}/${scope.targetName}`;
  return {
    stack,
    apply: new Plan(`apply ${label}`, [...applySteps.values()]),
    remove: new Plan(`remove ${label}`, [...removeSteps.values()]),
    declared,
    removed,
  };
}
```

`Plan`'s constructor accepts every step (Task 4's `validate` derives roots as the steps no other step lists in `next`), so passing all steps is correct and keeps this factory free of root bookkeeping. `Step.next` is `readonly Step[]`; a `MutableStep` is assignable to it because the engine only reads.

- [ ] **Step 6: Run the tests**

Run: `bun test src/core/project/backends/imperative/agentcore/`
Expected: PASS for `stack.test.ts` and `plan.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/core/project/backends/imperative/agentcore/
git commit -m "feat(imperative): AgentCoreStack, placeholder kind handlers and plan factory"
```

---

### Task 11: `ImperativeBackend` and the default credential resolver

**Files:**

- Create: `src/core/project/backends/imperative/credentials.ts`
- Create: `src/core/project/backends/imperative.ts`
- Test: `src/core/project/backends/imperative.test.ts`
- Modify: `package.json` (add `@aws-sdk/credential-providers`, same version line as the other `@aws-sdk/client-*` packages; run `bun install`)

**Interfaces:**

- Consumes: `ProjectBackend`, `DeployBackendInput`, `ResolveDeployedResourcesBackendInput`, `ResolveProjectResourcesBackendInput` (`backends/types.ts`); `DeployResult`, `Project`, `ProjectEvent`, `ResolvedDeployedResource`, `ResolvedProjectResource`, `DeployableResource` (`handlers/project/types.ts`); Phase 0's `shared/credentials.ts` (`createCredentialProvisioner`, `createCredentialRemover`, `orphanedCredentials`, `CredentialProviderCalls`, `CredentialProviderRef`, `CredentialProvisioner`, `CredentialRemover`), `shared/account.ts` (`resolveAwsAccount`, `AccountResolver`), `shared/types.ts` (`TransactionSearchEnabler`, `AwsCredentialResolver`), `shared/deployedState.ts` (`readDeployedState`, `updateTargetState`, `removeTargetState`); Tasks 6-10.
- Produces:

  ```ts
  // imperative/credentials.ts
  export function createDefaultCredentialResolver(): AwsCredentialResolver;

  // imperative.ts
  export type ImperativeBackendConfig = {
    logger: Logger;
    clients: AwsClients;
    identity: CredentialProviderCalls;
    resolveCredentials: AwsCredentialResolver;
    enableTransactionSearch: TransactionSearchEnabler;
    json?: ReadWriteJson;
    resolveAccount?: AccountResolver;
    provisionCredentials?: CredentialProvisioner;
    removeCredentials?: CredentialRemover;
    plan?: PlanBuilder;
    handlers?: Partial<Record<ResourceKind, KindHandlers>>;
    supportedKinds?: ReadonlySet<ResourceKind>;
    execute?: Pick<ExecuteOptions, "concurrency" | "stepTimeoutMs" | "pollDelayMs" | "sleep" | "maxDoAttempts">;
    now?: () => Date;
  };
  export class ImperativeBackend implements ProjectBackend { constructor(config: ImperativeBackendConfig) }
  ```

- [ ] **Step 1: Add the dependency and the resolver**

```bash
bun add @aws-sdk/credential-providers@<the version the other @aws-sdk/client-* entries use>
```

```ts
// src/core/project/backends/imperative/credentials.ts
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { AwsCredentialResolver } from "../shared/types";

/**
 * The SDK's default chain (env, shared config and SSO profiles, web identity,
 * container and instance metadata), pinned to the target's region so STS
 * regional endpoints and profile `region` settings agree. The CDK backend gets
 * the equivalent chain from the CDK Toolkit; this backend must not depend on it.
 */
export function createDefaultCredentialResolver(): AwsCredentialResolver {
  return async (region) => fromNodeProviderChain({ clientConfig: { region } });
}
```

- [ ] **Step 2: Write the failing backend tests**

The backend is driven through injected seams only: a `TestIdentityClient`, a fake `resolveCredentials`, a fake `resolveAccount`, fake `provisionCredentials`/`removeCredentials` generators, and fake kind handlers. No SDK client is constructed.

```ts
// src/core/project/backends/imperative.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NotImplementedError, ProjectStateError } from "../../../errors";
import type { DeployResult, Project, ProjectEvent } from "../../../handlers/project/types";
import { FsReadWriteJson } from "../../../io";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { createSilentLogger, inTempDirectory, TestIdentityClient } from "../../../testing";
import type { AwsClients } from "../../types";
import { ImperativeBackend, type ImperativeBackendConfig } from "./imperative";
import type { KindHandlers } from "./imperative/notImplemented";
import { Status } from "./imperative/plan/plan";
import { readImperativeState } from "./imperative/state";
import { DEPLOYED_STATE_RELATIVE_PATH, readDeployedState } from "./shared/deployedState";

const target = { name: "dev", account: "111122223333", region: "us-east-1" };
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
    spec: { ...ProjectSpecSchema.parse({ name: "Shop", version: 2 }), ...overrides } as Project["spec"],
  };
}

/** A memory handler that "creates" on first do() and converges on the next poll. */
function fakeMemory(log: string[]): KindHandlers {
  const created = new Set<string>();
  return {
    create: (stack, resource) => async () => {
      log.push(`create ${resource.name}`);
      created.add(resource.name);
      stack.record(`memory:${resource.name}`, { arn: `arn:mem:${resource.name}`, id: `id-${resource.name}` });
    },
    poll: (_stack, resource) => async () =>
      created.has(resource.name) ? { status: Status.Successful } : { status: Status.NotStarted },
    remove: (stack, resource) => async () => {
      log.push(`remove ${resource.name}`);
      created.delete(resource.name);
      stack.forget(`memory:${resource.name}`);
    },
    pollGone: (_stack, resource) => async () =>
      created.has(resource.name) ? { status: Status.NotStarted } : { status: Status.Successful },
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
    provisionCredentials: async function* (project) {
      log.push("provision credentials");
      return Object.fromEntries(
        project.spec.credentials.map((c) => [c.name, { credentialProviderArn: `arn:cred:${c.name}` }]),
      );
    },
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
    expect(log).toEqual(["provision credentials", "transaction search", "create m", "remove credentials -"]);
    expect(events.filter((e) => e.type === "step").map((e) => (e as { message: string }).message)).toEqual([
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
    expect(events).toContainEqual({ type: "step", message: "Skipping Transaction Search: no permission" });
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
    expect(events).toContainEqual({ type: "step", message: "Removing 1 resource no longer declared" });
    expect(result.outputs).toEqual({ "memory:keep.arn": "arn:mem:keep", "memory:keep.id": "id-keep" });
    expect(await readImperativeState(json, p.rootPath, "dev")).toEqual({
      memory: { keep: { arn: "arn:mem:keep", id: "id-keep", updatedAt: "2026-09-24T00:00:00.000Z" } },
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
    await json.write(statePath, {
      targets: {
        dev: {
          resources: {
            credentials: { api: { credentialProviderArn: "arn:c", authorizerType: "ApiKeyCredentialProvider" } },
            imperative: { memory: { m: { arn: "arn:mem:m", id: "id-m", updatedAt: "old" } } },
          },
        },
        prod: { stackArn: "arn:other" },
      },
    });

    await expect(drain(backend.deploy(p, deployInput(false)))).rejects.toThrow(
      /would delete 1 resource.*memory:m.*--yes/s,
    );
    expect(log).toEqual(["provision credentials"]);

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
    await expect(drain(backend.deploy(p, deployInput()))).rejects.toThrow(/memory:bad.*CREATE_FAILED: quota/s);
    expect(await readImperativeState(json, p.rootPath, "dev")).toEqual({});
  });
});

describe("ImperativeBackend.build", () => {
  test("is not implemented in phase 1", async () => {
    const { backend } = harness();
    const p = await project({ memories: [{ name: "m" }] });
    const generator = backend.build(p);
    await expect(generator.next()).rejects.toThrow(NotImplementedError);
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
        children: [{ resourceType: "gateway-target", name: "t", deploymentState: "deployed", id: "t-1" }],
      },
    ]);
  });
});

describe("ImperativeBackend.resolveDeployedResources", () => {
  test("fails when nothing is recorded for the target", async () => {
    const { backend } = harness();
    const p = await project({ runtimes: [{ name: "r" }] });
    await expect(backend.resolveDeployedResources(p, { target })).rejects.toThrow(/not deployed to target 'dev'/);
  });

  test("returns runtimes and harnesses with a recorded id and the resolved credentials", async () => {
    const { backend, json } = harness();
    const p = await project({ runtimes: [{ name: "r" }, { name: "pending" }], harnesses: [{ name: "h" }] });
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
```

The runtime entries above rely on `ProjectRuntimeSchema` defaults; if parsing `{ name: "r" }` needs more required fields in this tree, add the minimum (`build: "CodeZip"`, `entrypoint: "main.py"`, `codeLocation: "app"`) to those literals. Container runtimes are covered by Task 9's tests.

- [ ] **Step 3: Run to see them fail**

Run: `bun test src/core/project/backends/imperative.test.ts`
Expected: FAIL, module `./imperative` not found.

- [ ] **Step 4: Implement `imperative.ts`**

```ts
// src/core/project/backends/imperative.ts
import { NotImplementedError, ProjectStateError } from "../../../errors";
import type {
  DeployResult,
  DeployableResource,
  Project,
  ProjectEvent,
  ResolvedDeployedResource,
  ResolvedProjectResource,
} from "../../../handlers/project/types";
import { FsReadWriteJson, type ReadWriteJson } from "../../../io";
import type { Logger } from "../../../logging";
import type { AwsDeploymentTarget } from "../../../projectSchemas/aws-targets";
import type { AwsClients } from "../../types";
import { HANDLERS, plan as buildPlan, type PlanBuilder, type Plans } from "./imperative/plan";
import type { KindHandlers } from "./imperative/notImplemented";
import { createDefaultCredentialResolver } from "./imperative/credentials";
import { stateKey, type DeclaredResource } from "./imperative/inventory";
import { parseStepName, type ResourceKind } from "./imperative/naming";
import type { ExecuteOptions, Step } from "./imperative/plan/plan";
import {
  forgetImperativeResource,
  hasCdkBinding,
  imperativeStateOf,
  recordImperativeResource,
  type ImperativeState,
} from "./imperative/state";
import { assertImperativelyDeployable, SUPPORTED_KINDS } from "./imperative/support";
import { resolveAwsAccount, type AccountResolver } from "./shared/account";
import {
  createCredentialProvisioner,
  createCredentialRemover,
  orphanedCredentials,
  type CredentialProviderCalls,
  type CredentialProviderRef,
  type CredentialProvisioner,
  type CredentialRemover,
} from "./shared/credentials";
import { readDeployedState, removeTargetState, updateTargetState } from "./shared/deployedState";
import type { AwsCredentialResolver, TransactionSearchEnabler } from "./shared/types";
import type {
  DeployBackendInput,
  ProjectBackend,
  ResolveDeployedResourcesBackendInput,
  ResolveProjectResourcesBackendInput,
} from "./types";

export type ImperativeBackendConfig = {
  logger: Logger;
  clients: AwsClients;
  identity: CredentialProviderCalls;
  resolveCredentials: AwsCredentialResolver;
  enableTransactionSearch: TransactionSearchEnabler;
  json?: ReadWriteJson;
  resolveAccount?: AccountResolver;
  provisionCredentials?: CredentialProvisioner;
  removeCredentials?: CredentialRemover;
  plan?: PlanBuilder;
  handlers?: Partial<Record<ResourceKind, KindHandlers>>;
  supportedKinds?: ReadonlySet<ResourceKind>;
  execute?: Pick<ExecuteOptions, "concurrency" | "stepTimeoutMs" | "pollDelayMs" | "sleep" | "maxDoAttempts">;
  now?: () => Date;
};

/** Reports "1 resource" / "3 resources". */
function count(n: number, noun = "resource"): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Deploys a project by calling AWS APIs directly: no synthesis, no
 * CloudFormation, no bootstrap. The spec becomes a dependency graph of steps
 * (`agentcore/plan.ts`), the engine (`plan/plan.ts`) runs it with bounded
 * concurrency, and every converged resource is recorded under
 * `resources.imperative` in deployed-state.json.
 */
export class ImperativeBackend implements ProjectBackend {
  private readonly logger: Logger;
  private readonly clients: AwsClients;
  private readonly json: ReadWriteJson;
  private readonly resolveCredentials: AwsCredentialResolver;
  private readonly resolveAccount: AccountResolver;
  private readonly enableTransactionSearch: TransactionSearchEnabler;
  private readonly provisionCredentials: CredentialProvisioner;
  private readonly removeCredentials: CredentialRemover;
  private readonly plan: PlanBuilder;
  private readonly handlers: Partial<Record<ResourceKind, KindHandlers>>;
  private readonly supportedKinds: ReadonlySet<ResourceKind>;
  private readonly execute: ImperativeBackendConfig["execute"];
  private readonly now: () => Date;

  constructor(config: ImperativeBackendConfig) {
    this.logger = config.logger;
    this.clients = config.clients;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.resolveCredentials = config.resolveCredentials ?? createDefaultCredentialResolver();
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
    this.enableTransactionSearch = config.enableTransactionSearch;
    this.provisionCredentials =
      config.provisionCredentials ?? createCredentialProvisioner(config.identity);
    this.removeCredentials = config.removeCredentials ?? createCredentialRemover(config.identity);
    this.plan = config.plan ?? buildPlan;
    this.handlers = config.handlers ?? {};
    this.supportedKinds = config.supportedKinds ?? SUPPORTED_KINDS;
    this.execute = config.execute;
    this.now = config.now ?? (() => new Date());
  }

  // eslint-disable-next-line require-yield
  public async *build(_project: Project): AsyncGenerator<ProjectEvent, void> {
    throw new NotImplementedError(
      "imperative deploy does not package code yet; 'project build' arrives with CodeZip support",
    );
  }

  public async *deploy(
    project: Project,
    input: DeployBackendInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    yield { type: "step", message: `Verifying AWS account ${target.account}` };
    const credentials = await this.credentialsForTarget(target);

    // Everything that can be decided from the spec and the state file fails here,
    // before credentials are provisioned or anything is created.
    assertImperativelyDeployable(project, this.supportedKinds);
    const targetState = (await readDeployedState(this.json, project.rootPath)).targets[target.name];
    if (hasCdkBinding(targetState)) {
      throw new ProjectStateError(
        `Target '${target.name}' of project '${project.name}' is managed by CloudFormation stack ` +
          `'${targetState?.stackArn ?? targetState?.resources?.stackName}'. The imperative backend ` +
          `does not adopt or delete CDK resources. To migrate, set managedBy back to "CDK", remove ` +
          `the resources from agentcore.json and deploy once (this deletes the stack), then set ` +
          `managedBy to "Imperative" and deploy again.`,
      );
    }
    const recordedCredentials = targetState?.resources?.credentials ?? {};
    const orphaned = orphanedCredentials(recordedCredentials, project.spec.credentials);
    const recorded = imperativeStateOf(targetState);

    // Same contract as the CDK backend: providers are recorded every deploy, even
    // when empty, so dropping the last credential clears the stale entry.
    const provisioned = yield* this.provisionCredentials(project, {
      credentials,
      region: target.region,
      targetName: target.name,
    });
    await updateTargetState(this.json, project.rootPath, target.name, {
      resources: { credentials: provisioned },
    });

    const plans = this.plan({
      project,
      scope: {
        projectName: project.name,
        targetName: target.name,
        account: target.account,
        region: target.region,
      },
      clients: this.clients,
      credentials,
      logger: this.logger,
      recorded,
      handlers: this.handlers,
    });

    if (plans.declared.length === 0) {
      if (plans.removed.length === 0) {
        if (project.spec.credentials.length > 0) return { outputs: {} };
        throw new ProjectStateError(
          `Project '${project.name}' declares no resources to deploy, and nothing is recorded for ` +
            `target '${target.name}' to remove. Add a resource — for example ` +
            `'agentcore project add runtime' — before deploying.`,
        );
      }
      return yield* this.teardown({ project, input, plans, orphaned });
    }

    if (input.transactionSearch !== false) {
      yield { type: "step", message: "Enabling CloudWatch Transaction Search" };
      try {
        await this.enableTransactionSearch(target, credentials);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        yield { type: "step", message: `Skipping Transaction Search: ${detail}` };
      }
    }

    yield { type: "step", message: `Deploying ${count(plans.declared.length)}` };
    yield* plans.apply.execute({
      ...this.execute,
      logger: this.logger,
      onStepSucceeded: (step) => this.recordStep(project, target, plans, step),
    });

    if (plans.removed.length > 0) {
      yield {
        type: "step",
        message: `Removing ${count(plans.removed.length)} no longer declared`,
      };
      yield* plans.remove.execute({
        ...this.execute,
        logger: this.logger,
        onStepSucceeded: (step) => this.forgetStep(project, target, step),
      });
    }

    yield* this.removeCredentials(project, {
      credentials,
      region: target.region,
      targetName: target.name,
      providers: orphaned,
    });

    return { outputs: plans.stack.outputs() };
  }

  /**
   * Removes everything the ledger holds, for a deploy of a project that declares
   * nothing. Mirrors the CDK backend's teardown: confirm, remove, drop providers,
   * forget the target.
   */
  private async *teardown({
    project,
    input,
    plans,
    orphaned,
  }: {
    project: Project;
    input: DeployBackendInput;
    plans: Plans;
    orphaned: CredentialProviderRef[];
  }): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    const names = plans.removed.map((r) => `${r.kind}:${stateKey(r)}`);
    const description = `${count(names.length)} (${names.join(", ")})`;
    const confirmed = await input.confirmTeardown({
      projectName: project.name,
      targetName: target.name,
      resourceDescription: description,
      account: target.account,
      region: target.region,
    });
    if (!confirmed) {
      throw new ProjectStateError(
        `Project '${project.name}' declares no resources to deploy, so deploying to target ` +
          `'${target.name}' would delete ${description}. Re-run with --yes to confirm, or restore ` +
          `the resources the project should have.`,
      );
    }

    yield { type: "step", message: `Removing ${count(names.length)}` };
    yield* plans.remove.execute({
      ...this.execute,
      logger: this.logger,
      onStepSucceeded: (step) => this.forgetStep(project, target, step),
    });

    // After the resources, since one of them may still have been using a provider.
    const credentials = plans.stack.credentials;
    yield* this.removeCredentials(project, {
      credentials,
      region: target.region,
      targetName: target.name,
      providers: [...orphaned, ...project.spec.credentials],
    });
    await removeTargetState(this.json, project.rootPath, target.name);
    return { outputs: {}, tornDown: true };
  }

  private async recordStep(
    project: Project,
    target: AwsDeploymentTarget,
    plans: Plans,
    step: Step,
  ): Promise<void> {
    const { kind, name, parent } = parseStepName(step.name);
    const outputs = plans.stack.outputsOf(step.name) ?? {};
    await recordImperativeResource(
      this.json,
      project.rootPath,
      target.name,
      kind,
      stateKey({ kind, name, parent }),
      outputs,
      this.now,
    );
  }

  private async forgetStep(project: Project, target: AwsDeploymentTarget, step: Step): Promise<void> {
    const { kind, name, parent } = parseStepName(step.name);
    await forgetImperativeResource(
      this.json,
      project.rootPath,
      target.name,
      kind,
      stateKey({ kind, name, parent }),
    );
  }

  public async resolveDeployedResources(
    project: Project,
    input: ResolveDeployedResourcesBackendInput,
  ): Promise<ResolvedDeployedResource[]> {
    const { target } = input;
    const targetState = (await readDeployedState(this.json, project.rootPath)).targets[target.name];
    const recorded = imperativeStateOf(targetState);
    if (Object.keys(recorded).length === 0) {
      throw new ProjectStateError(
        `Project '${project.name}' is not deployed to target '${target.name}'. ` +
          `Run 'agentcore project deploy --target ${target.name}' first.`,
      );
    }
    const credentials = await this.credentialsForTarget(target);
    const candidates = [
      ...project.spec.runtimes.map(({ name }) => ({ resourceType: "runtime" as const, name })),
      ...project.spec.harnesses.map(({ name }) => ({ resourceType: "harness" as const, name })),
    ];
    return candidates.flatMap((resource) => {
      const id = recorded[resource.resourceType]?.[resource.name]?.id;
      return id ? [{ ...resource, id, target, credentialProvider: credentials }] : [];
    });
  }

  public async resolveProjectResources(
    project: Project,
    input: ResolveProjectResourcesBackendInput,
  ): Promise<ResolvedProjectResource[]> {
    const { spec } = project;
    const targetState = (await readDeployedState(this.json, project.rootPath)).targets[
      input.target.name
    ];
    const recorded = imperativeStateOf(targetState);

    const identifierOf = (
      resourceType: DeployableResource,
      name: string,
      owner?: string,
    ): { arn: string } | { id: string } | undefined => {
      if (resourceType === "credential") {
        const arn = targetState?.resources?.credentials?.[name]?.credentialProviderArn;
        return arn ? { arn } : undefined;
      }
      const record = recorded[resourceType]?.[stateKey({ kind: resourceType, name, parent: owner })];
      if (record?.arn) return { arn: record.arn };
      if (record?.id) return { id: record.id };
      return undefined;
    };

    const resolve = (
      resourceType: DeployableResource,
      name: string,
      options: { owner?: string; children?: ResolvedProjectResource[] } = {},
    ): ResolvedProjectResource => {
      const identifier = identifierOf(resourceType, name, options.owner);
      return {
        resourceType,
        name,
        ...(options.children?.length ? { children: options.children } : {}),
        ...(identifier
          ? { deploymentState: "deployed", ...identifier }
          : { deploymentState: "local-only" }),
      };
    };

    return [
      ...spec.runtimes.map((runtime) =>
        resolve("runtime", runtime.name, {
          children: Object.keys(runtime.endpoints ?? {}).map((endpoint) =>
            resolve("runtime-endpoint", endpoint, { owner: runtime.name }),
          ),
        }),
      ),
      ...spec.harnesses.map(({ name }) => resolve("harness", name)),
      ...spec.memories.map(({ name }) => resolve("memory", name)),
      ...spec.knowledgeBases.map(({ name }) => resolve("knowledge-base", name)),
      ...spec.credentials.map(({ name }) => resolve("credential", name)),
      ...spec.evaluators.map(({ name }) => resolve("evaluator", name)),
      ...spec.onlineEvalConfigs.map(({ name }) => resolve("online-eval", name)),
      ...spec.agentCoreGateways.map((gateway) =>
        resolve("gateway", gateway.name, {
          children: (gateway.targets ?? []).map(({ name }) =>
            resolve("gateway-target", name, { owner: gateway.name }),
          ),
        }),
      ),
      ...spec.policyEngines.map((engine) =>
        resolve("policy-engine", engine.name, {
          children: (engine.policies ?? []).map(({ name }) =>
            resolve("policy", name, { owner: engine.name }),
          ),
        }),
      ),
      ...spec.configBundles.map(({ name }) => resolve("config-bundle", name)),
      ...(spec.payments ?? []).map((manager) =>
        resolve("payment-manager", manager.name, {
          children: (manager.connectors ?? []).map(({ name }) =>
            resolve("payment-connector", name, { owner: manager.name }),
          ),
        }),
      ),
    ];
  }

  private async credentialsForTarget(target: AwsDeploymentTarget) {
    const credentials = await this.resolveCredentials(target.region);
    const account = await this.resolveAccount(target.region, credentials);
    if (account !== target.account) {
      throw new ProjectStateError(
        `Deployment target '${target.name}' expects AWS account ${target.account}, ` +
          `but the active credentials belong to ${account}.`,
      );
    }
    return credentials;
  }
}
```

Notes for the implementer:

- `HANDLERS` is imported only so the registry module is part of this backend's graph; if the linter flags it unused, drop the import.
- `recordStep` runs inside `onStepSucceeded`, which the engine awaits before releasing dependents, so a crash between "converged" and "recorded" costs at most one resource, and the next deploy's `poll` finds it by name.
- `plans.stack.credentials` is the same provider `credentialsForTarget` returned; the teardown helper reads it from the stack rather than threading another parameter.
- The CDK backend's `teardown` checks that the stack exists before asking; here the ledger is the evidence, and a stale ledger entry makes `pollGone` report `SUCCESSFUL` immediately (Phase 2 kinds treat "not found" as gone), so nothing else is needed.

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/project/backends/imperative.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/core/project/backends/imperative.ts src/core/project/backends/imperative.test.ts src/core/project/backends/imperative/credentials.ts
git commit -m "feat(imperative): ImperativeBackend deploy, teardown and resource resolution"
```

---

### Task 12: Wire the backend behind the flag, guard the CDK side, keep the boundary

**Files:**

- Modify: `src/core/project/manager.tsx` (backend registry merge; `backendFor` message for `Imperative`)
- Modify: `src/core/project/manager.test.ts` (two tests)
- Modify: `src/core/index.tsx` (`CoreClientConfig.imperativeDeploy`, construct `ImperativeBackend`)
- Modify: `src/index.ts` (pass `globalConfig["imperative-deploy"]`)
- Modify: `src/core/project/index.tsx` (export `ImperativeBackend`, `ImperativeBackendConfig`)
- Modify: `src/core/project/backends/cdk.ts` (refuse a target with imperative resources)
- Modify: `src/core/project/backends/cdk.test.ts` (one test)
- Modify: `src/core/project/backends/shared/boundary.test.ts` (scan the imperative tree)
- Modify: `src/handlers/project/deploy/index.test.ts` (flag off / flag on)

**Interfaces:**

- Consumes: `ImperativeBackend`, `ImperativeBackendConfig` (Task 11), `createDefaultCredentialResolver` (Task 11), `hasImperativeResources` (Task 8), `GlobalConfig["imperative-deploy"]` (Task 1).
- Produces: `CoreClientConfig.imperativeDeploy?: boolean`; `FsProjectManager` accepts partial `backends` that overlay the default CDK backend.

- [ ] **Step 1: Failing manager tests**

Add to `src/core/project/manager.test.ts`, next to "refuses a project managed by a backend it cannot build":

```ts
  test("tells the user how to enable imperative deploy when the flag is off", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = manager();
    const project = await scaffolded(subject, directory);
    const imperative = { ...project, spec: { ...project.spec, managedBy: "Imperative" as const } };
    await expect(drain(subject.build(imperative))).rejects.toThrow(
      /declares managedBy "Imperative", but imperative deploy is not enabled.*agentcore config imperative-deploy true.*managedBy to "CDK"/s,
    );
  });

  test("routes an Imperative project to the injected backend while CDK stays available", async () => {
    const directory = await inTempDirectory();
    const calls: string[] = [];
    const fake: ProjectBackend = {
      build: async function* () {
        calls.push("build");
      },
      deploy: async function* () {
        calls.push("deploy");
        return { outputs: {} };
      },
      resolveDeployedResources: async () => [],
      resolveProjectResources: async () => [],
    };
    const { manager: subject } = manager({ backends: { Imperative: fake } });
    const project = await scaffolded(subject, directory);
    const imperative = { ...project, spec: { ...project.spec, managedBy: "Imperative" as const } };
    await drain(subject.build(imperative));
    expect(calls).toEqual(["build"]);
    // The CDK project still builds through the default backend (it runs the synth runner).
    await drain(subject.build(project));
  });
```

`manager(overrides)` is the file's existing factory; if it does not accept `backends`, extend it to spread overrides into the `FsProjectManager` config. Adjust the second test's final assertion to whatever the file's `commands` capture shows for a synth (the existing tests show the shape).

Run: `bun test src/core/project/manager.test.ts` → the two new tests FAIL.

- [ ] **Step 2: Manager changes**

In `FsProjectManager`'s constructor replace

```ts
    this.backends = config.backends ?? {
      CDK: new CdkBackend({ ... }),
    };
```

with

```ts
    // The CDK backend is always registered; callers add or replace entries (the
    // CoreClient adds Imperative behind its flag, tests inject fakes).
    this.backends = {
      CDK: new CdkBackend({
        logger: config.logger,
        createCloudFormationClient: config.createCloudFormationClient,
        identity: config.identity,
        enableTransactionSearch: config.enableTransactionSearch,
        runner: config.runner,
        checkTool: config.checkTool,
        json: config.json,
      }),
      ...config.backends,
    };
```

and replace `backendFor`:

```ts
  private backendFor(project: Project): ProjectBackend {
    const backend = this.backends[project.spec.managedBy];
    if (backend) return backend;
    if (project.spec.managedBy === "Imperative") {
      throw new ProjectStateError(
        `Project '${project.name}' declares managedBy "Imperative", but imperative deploy is not ` +
          `enabled. Run 'agentcore config imperative-deploy true' to enable it, or set managedBy ` +
          `to "CDK" in agentcore/agentcore.json.`,
      );
    }
    throw new ProjectStateError(
      `project '${project.name}' declares an unsupported backend: ${project.spec.managedBy}`,
    );
  }
```

Run: `bun test src/core/project/manager.test.ts` → PASS (including the pre-existing "Terraform" test).

- [ ] **Step 3: CoreClient and CLI entry**

In `src/core/index.tsx` add to `CoreClientConfig`:

```ts
  /** Registers the imperative deploy backend (global config `imperative-deploy`). */
  imperativeDeploy?: boolean;
```

and change the `FsProjectManager` construction to:

```ts
    const enableTransactionSearch: TransactionSearchEnabler = (target, credentials) =>
      this.observability.enableTransactionSearch(
        { region: target.region, credentials },
        target.account,
      );
    this.projectManager = new FsProjectManager({
      logger: this.logger.child({ module: "projectManager" }),
      createCloudFormationClient: config.createCloudFormationClient,
      identity: this.identity,
      enableTransactionSearch,
      ...(config.imperativeDeploy && {
        backends: {
          Imperative: new ImperativeBackend({
            logger: this.logger.child({ module: "imperativeBackend" }),
            clients: this,
            identity: this.identity,
            resolveCredentials: createDefaultCredentialResolver(),
            enableTransactionSearch,
          }),
        },
      }),
    });
```

with imports `import { ImperativeBackend } from "./project";`, `import { createDefaultCredentialResolver } from "./project/backends/imperative/credentials";` and `import type { TransactionSearchEnabler } from "./project/backends/shared/types";` (adjust to the paths Phase 0 produced). `CoreClient implements AwsClients`, so `clients: this` type-checks.

In `src/core/project/index.tsx` add:

```ts
export { ImperativeBackend, type ImperativeBackendConfig } from "./backends/imperative";
```

In `src/index.ts`, where `new CoreClient({...})` is built after `globalConfig` is read, add:

```ts
        imperativeDeploy: globalConfig["imperative-deploy"],
```

Run: `bun run typecheck` → clean.

- [ ] **Step 4: The CDK-side guard**

In `src/core/project/backends/cdk.ts` `deploy`, replace the `recorded` read

```ts
    const recorded =
      (await readDeployedState(this.json, project.rootPath)).targets[target.name]?.resources
        ?.credentials ?? {};
```

with

```ts
    const targetState = (await readDeployedState(this.json, project.rootPath)).targets[target.name];
    // The imperative backend names and tags its resources its own way; a stack
    // would create a second copy of each and orphan the originals (design §4.5).
    if (hasImperativeResources(targetState)) {
      throw new ProjectStateError(
        `Target '${target.name}' of project '${project.name}' has resources deployed by the ` +
          `imperative backend. The CDK backend does not adopt or delete them. To migrate, set ` +
          `managedBy back to "Imperative", remove the resources from agentcore.json and deploy ` +
          `once (this deletes them), then set managedBy to "CDK" and deploy again.`,
      );
    }
    const recorded = targetState?.resources?.credentials ?? {};
```

importing `hasImperativeResources` from `./shared/deployedState`. Add to `cdk.test.ts`, using the file's `deployBackend`/harness factory (around line 190) and its `TARGET`:

```ts
  test("refuses to deploy over a target the imperative backend populated", async () => {
    const { backend, commands, json, project } = harnessForThisFile();
    await json.write(join(project.rootPath, DEPLOYED_STATE_RELATIVE_PATH), {
      targets: {
        [TARGET.name]: {
          resources: { imperative: { memory: { m: { arn: "arn:m", updatedAt: "t" } } } },
        },
      },
    });
    await expect(drain(backend.deploy(project, deployInput()))).rejects.toThrow(
      /deployed by the imperative backend.*managedBy back to "Imperative"/s,
    );
    // Nothing synthesized, nothing provisioned.
    expect(commands).toEqual([]);
  });
```

Adapt the harness names to the file (`commands` is its runner capture; the state file is written through the same `json` the backend uses; if the harness does not expose `json`, construct the backend with an `FsReadWriteJson` you hold). Run: `bun test src/core/project/backends/cdk.test.ts` → PASS.

- [ ] **Step 5: Extend the boundary test**

In `src/core/project/backends/shared/boundary.test.ts` add a second block that walks `../imperative` recursively plus `../imperative.ts`:

```ts
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

// The imperative backend must never pull the CDK Toolkit into its import graph:
// that is the whole point of having it (design §1).
describe("backends/imperative boundary", () => {
  const sources = [...walk(join(import.meta.dir, "..", "imperative")), join(import.meta.dir, "..", "imperative.ts")];

  test("has the modules this test protects", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  for (const file of sources) {
    test(`${file.slice(file.indexOf("backends"))} does not import CDK code`, () => {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/from "[./]*\/cdk[/"]/);
      expect(text).not.toMatch(/@aws-cdk\//);
      expect(text).not.toMatch(/aws-cdk-lib/);
    });
  }
});
```

Run: `bun test src/core/project/backends/shared/boundary.test.ts` → PASS.

- [ ] **Step 6: Handler tests for the flag**

In `src/handlers/project/deploy/index.test.ts`, after scaffolding a project with `inProjectWithTargets()`, rewrite `agentcore/agentcore.json` with `managedBy: "Imperative"` (read, edit, write) and add:

```ts
  test("an Imperative project without the flag explains how to enable it", async () => {
    const projectRoot = await inProjectWithTargets();
    await setManagedBy(projectRoot, "Imperative");
    const { run } = testDeployCommand({ outputs: {} });
    await expect(run(["--target", "staging"])).rejects.toThrow(
      /imperative deploy is not enabled.*agentcore config imperative-deploy true/s,
    );
  });

  test("an Imperative project with the backend registered deploys through it", async () => {
    const projectRoot = await inProjectWithTargets();
    await setManagedBy(projectRoot, "Imperative");
    const fake = fakeBackend({ outputs: { "memory:m.arn": "arn:m" } });
    const core = new TestCoreClient({ backends: { Imperative: fake.backend } });
    const io = testIO();
    const root = createRootHandler(core, {
      io: io.io,
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      logger: createSilentLogger(),
    });
    await root.route(["node", "agentcore", "project", "deploy", "--target", "staging"]);
    expect(fake.deploys.length).toBe(1);
    expect(io.stderr()).toContain("arn:m");
  });
```

with a small helper in the test file:

```ts
async function setManagedBy(projectRoot: string, managedBy: "CDK" | "Imperative") {
  const path = join(projectRoot, "agentcore", "agentcore.json");
  const spec = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...spec, managedBy }, null, 2));
}
```

`fakeBackend` already exists in this file; if it does not expose the recorded deploy calls under `deploys`, use whatever it records (read the helper). The `CoreClient` flag plumbing itself is covered by the typecheck and by `src/globalConfig/config.test.tsx` from Task 1; `TestCoreClient` bypasses `CoreClient`, so the handler tests exercise the registry, not the flag read.

Run: `bun test src/handlers/project/deploy/index.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/project/manager.tsx src/core/project/manager.test.ts src/core/index.tsx src/index.ts src/core/project/index.tsx src/core/project/backends/cdk.ts src/core/project/backends/cdk.test.ts src/core/project/backends/shared/boundary.test.ts src/handlers/project/deploy/index.test.ts
git commit -m "feat(imperative): register the backend behind imperative-deploy; refuse cross-backend targets"
```

---

### Task 13: Verify, review, open the stacked PR

- [ ] **Step 1: Full verification**

Run: `bun run typecheck && bun test && bun run lint:check && bun run format:check`
Expected: all clean. The test count is the Phase 0 count plus every test this plan added; zero failures.

- [ ] **Step 2: Manual smoke without AWS**

```bash
bun run build
cd "$(mktemp -d)" && node <repo>/dist/index.js project create --name Smoke --template agent-python-strands --skip-install --skip-git
cd Smoke && sed -i.bak 's/"managedBy": "CDK"/"managedBy": "Imperative"/' agentcore/agentcore.json
node <repo>/dist/index.js project deploy            # expect: "imperative deploy is not enabled ... agentcore config imperative-deploy true"
node <repo>/dist/index.js config imperative-deploy true
node <repo>/dist/index.js project deploy            # expect: NotImplemented listing runtime (and memory) with the CDK escape hatch, before any AWS call
node <repo>/dist/index.js config imperative-deploy false
```

(Windows: edit the JSON by hand instead of `sed`.) If the first deploy asks for AWS credentials before printing the not-enabled error, the ordering in `FsProjectManager.deploy` resolves the target first; that is existing behavior and fine.

- [ ] **Step 3: Self-review against the spec**

Walk design §4.1-4.6 and confirm each item points at code: engine (Task 4-5), domain + plan factory (Task 10), progress events (Task 3), naming and tags (Task 6), state (Task 8), deploy sequence (Task 11), flag and enum (Tasks 1-2), the "Switching managedBy" table (Tasks 11-12). Fix gaps inline.

- [ ] **Step 4: Push and open the PR on the fork, stacked on Phase 0**

```bash
git push -u origin feat/imperative-deploy-engine
gh pr create --repo notgitika/agentcore-cli --base refactor/backends-shared --head feat/imperative-deploy-engine \
  --title "feat(project): imperative deploy backend, phase 1 (engine, state, backend skeleton)" \
  --body-file docs/superpowers/plans/2026-09-24-imperative-deploy-1-engine.pr.md
```

The PR body (write it to the `.pr.md` path above, do not commit it) summarizes: what the flag does, the `managedBy` enum, the `plan/` engine and its tests, the progress extension, the backend's deploy sequence and the two cross-backend guards, what is stubbed (every kind), and links the design doc and research doc in `docs/superpowers/`. State plainly that no resource kind deploys yet and that Phase 2 adds runtime (CodeZip), endpoints and memory.
