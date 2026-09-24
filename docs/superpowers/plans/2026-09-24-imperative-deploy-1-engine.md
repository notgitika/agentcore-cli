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
