# Imperative deploy for the AgentCore CLI

- Status: draft for team review (2026-09-24)
- Branch: `refactor`
- Research: `docs/superpowers/research/2026-09-24-imperative-deploy-context.md`
- Plans: `docs/superpowers/plans/2026-09-24-imperative-deploy-*.md`

## 1. Why

`agentcore project deploy` provisions a project by synthesizing a CloudFormation
template with a vended CDK app and driving the CDK Toolkit. That works, but it
costs every user a Node toolchain inside their project, a CDK bootstrap in every
account and region, a CloudFormation stack per target, and a full stack update
for every change. Failure means a rollback, and iteration speed is bounded by
CloudFormation.

An imperative backend deploys the same `agentcore.json` by calling the AgentCore
control plane directly. It reconciles what the project declares with what the
account holds, converges in parallel, records what it made, and can be re-run
at any point to finish or repair a deployment. No CDK app in the project, no
bootstrap, no stack. It is the second implementation of the existing
`ProjectBackend` seam, so the CLI surface (`build`, `deploy`, `status`,
`invoke`, `dev`) does not change.

The execution model and the code structure come from a Lightsail proof of
concept (`AlricheyWPPlayground`): a generic `plan` package that runs a directed
graph of steps, each with a `do` function and a `status` function, breadth-first
with join semantics, no rollback, fully resumable; and a domain package that
builds the graph for one product.

## 2. Goals and non-goals

Goals

- Deploy a project without CDK, CloudFormation, or a bootstrap, behind a global
  feature flag so nothing changes for existing users.
- Idempotent and resumable: re-running `deploy` converges, whether the previous
  run finished, failed halfway, or someone deleted a resource by hand.
- Parallel where dependencies allow, with a progress UI that shows concurrent
  work honestly.
- One small, independently testable module per resource kind.
- Full parity with the CDK path on the environment the agent code sees (env
  var names, IAM grants), verified by tests.

Non-goals for this iteration

- Container runtimes. `build: "Container"` is rejected with a clear error until
  a build strategy (CodeBuild for parity, or local docker/finch) is chosen.
- Adopting resources the backend did not create. A same-named resource that
  lacks our ownership tags is an error, never silently reused.
- Rollback. Partial progress is recorded and the fix is to run `deploy` again.
- Migrating a target between backends. A target deployed with CDK must be torn
  down before the same target is deployed imperatively, and vice versa.
- Knowledge bases, Lambda-backed gateway compute targets, and managed code-based
  evaluators. They are reported as not implemented until a later phase.

## 3. How it fits the CLI

```
project deploy ──► FsProjectManager.deploy ──► backendFor(spec.managedBy)
                                                 ├── "CDK"        → CdkBackend        (unchanged)
                                                 └── "Imperative" → ImperativeBackend (new, flag-gated)
```

- `managedBy` in `agentcore.json` gains the value `"Imperative"`. It is the
  per-project switch and is committed with the project.
- A new global config flag `imperative-deploy` (default `false`) decides whether
  the `Imperative` backend is registered at all. With the flag off, a project
  that declares `managedBy: "Imperative"` fails fast with the exact command to
  enable it (`agentcore config imperative-deploy true`). This mirrors how
  `imperative-mutation-commands` gates the gateway mutation commands.
- Startup already reads the global config before constructing `CoreClient`, so
  the flag reaches the backend map without touching any handler.
- Both backends share `agentcore/.cli/deployed-state.json`, the credential
  provider provisioner, and the Transaction Search enabler. Those move out of
  the `cdk/` directory in a preparatory change (phase 0) so neither backend
  owns the other's plumbing.

## 4. Architecture

The layout mirrors the prior art one to one.

```
AlricheyWPPlayground                     agentcore-cli
────────────────────                     ─────────────────────────────────────────────────
plan/plan.go                             backends/imperative/plan/plan.ts
  Status, Step{Name,Do,Status,Next}        Status, Step{name,do,status,next}
  Plan{Name,Steps}.Execute/validate        Plan{name,steps}.execute/validate
lightpress/lightpress.go                 backends/imperative/agentcore/
  wpstack{ls, logicalID, region, data}     stack.ts      AgentCoreStack{clients, scope, data}
  Plan(creds, region, ...) *plan.Plan      plan.ts       plan(input) → { stack, apply, remove }
  CreateInstance / PollInstance            runtime.ts    createRuntime / pollRuntime (phase 2)
  CreateDistribution / PollDistribution    memory.ts     createMemory / pollMemory   (phase 2)
  ...                                      gateway.ts, policy.ts, ...              (phase 3+)
cmd/lp/main.go                           backends/imperative.ts
  load creds, Plan(...), Execute(ctx)       ImperativeBackend.deploy: verify, plan, execute, record
```

### 4.1 `plan/`: the generic engine

```ts
export const Status = {
  NotStarted: "NOT_STARTED", // resource is missing → run `do`
  Outdated: "OUTDATED", // exists but differs from the spec → run `do` (update)   [our addition]
  Waiting: "WAITING", // service is working → poll again
  Successful: "SUCCESSFUL", // converged
  Failed: "FAILED", // terminal service failure
} as const;

export type StatusReport = { status: Status; detail?: string };
export type Doer = (ctx: StepContext) => Promise<void>;
export type Statuser = (ctx: StepContext) => Promise<StatusReport>;

export type Step = {
  readonly name: string; // "<kind>:<name>", e.g. "runtime:strands_agent"
  readonly do: Doer; // idempotent mutation
  readonly status: Statuser; // read-only observation, also the readiness waiter
  readonly next?: readonly Step[]; // steps that may start once this one succeeds
};

export class Plan {
  constructor(
    readonly name: string,
    readonly steps: readonly Step[],
  ) {} // roots
  validate(): ValidatedPlan; // every step has do+status, names unique, no cycles, in-degrees
  execute(options): AsyncGenerator<ProgressEvent, PlanResult>;
}
```

`execute` is the prior art's parallel BFS: roots start immediately; a step with
several parents starts once all of them have succeeded (in-degree join). Per
step the loop is `status` → `SUCCESSFUL` done; `WAITING` sleep with backoff and
poll again; `FAILED` throw; `NOT_STARTED` or `OUTDATED` run `do` once and poll
again. A step that still reports `NOT_STARTED` or `OUTDATED` after `do` fails
as not started (the prior art's `ErrStepNotStarted`), so a `status` function
must see its own `do` (for example by polling the id `do` recorded). Steps have
a timeout and honour an `AbortSignal`. Concurrency is capped (default 4). When a
step fails, its transitive dependents are skipped and reported; running steps
finish; nothing is undone. An `onStepSucceeded` hook lets the caller persist as
steps land, which is what makes a re-run resume rather than restart.

Cross-step values do not travel through the engine. Like the prior art's
`w.data`, they live on the domain object (4.2), but typed.

### 4.2 `agentcore/`: the domain

`AgentCoreStack` is the `wpstack` analog: it holds the SDK clients, the scope
(project, target, account, region), and `data`, a typed record of every
resource's outputs (`arn`, `id`, ...) keyed by kind and name, seeded from the
state file and written to by `poll*` functions on success. It also owns naming
and tagging for the scope.

Each resource kind has one module exporting a `create<Kind>(stack, spec)` /
`poll<Kind>(stack, spec)` pair (a `Doer` and a `Statuser`) and, where the kind
can be removed, a `delete<Kind>` / `pollGone<Kind>` pair. A removal is the same
contract with absence as the desired state: `SUCCESSFUL` when gone, `WAITING`
while the service deletes, `NOT_STARTED` while it still exists.

`plan(input)` is the `lightpress.Plan` analog. It reads the spec and the
recorded state and returns two plans plus the stack: `apply` for everything
declared (memory → runtime → runtime endpoint; policy engine → policy; policy
engine → gateway → gateway target; runtime → httpRuntime gateway target;
runtimes and evaluators → online eval config; runtimes → config bundle;
payment manager → connector) and `remove` for everything recorded that the spec
no longer declares (children before parents).

### 4.3 Progress with concurrent tasks

The progress vocabulary today is linear: a `step` event completes the one
before it. Concurrent steps need identified tasks:

```ts
| { type: "task-start";  id: string; title: string }
| { type: "task-output"; id: string; line: string }
| { type: "task-done";   id: string }
| { type: "task-failed"; id: string; message?: string }
```

The existing `step`, `output` and `warning` events keep their meaning. The Ink
task list already renders a list of tasks with state and tail; it gains an
optional id per task and nothing else. The plain, non-TTY path prints a line
per task start and per failure.

### 4.4 Naming and ownership

Physical names are `<project>_<target>_<name>` (gateways use `-` because the
service requires it). Including the target is a deliberate divergence from the
CDK path, which names most resources `<project>_<name>` and therefore cannot
host two targets in one account and region. Length limits are validated before
the first AWS call and reported against `agentcore.json`.

Every resource carries the tags `agentcore:project-name`,
`agentcore:target-name`, and `agentcore:managed-by: imperative`. A same-named
resource without those tags is refused with guidance, following the credential
provisioner's vendor check.

### 4.5 State

`agentcore/.cli/deployed-state.json` already exists, is committed, and is
merged per target with unknown keys preserved. The imperative backend records
under `targets.<target>.resources.imperative.<kind>.<name>`:

```json
{ "arn": "arn:aws:bedrock-agentcore:...", "id": "abc123", "updatedAt": "2026-09-24T..." }
```

Recorded state is a cache and an orphan ledger, not the source of truth. `poll`
functions observe the live resource by its deterministic name and tags, so a
lost or stale state file is repaired by the next deploy. A resource that is
recorded but no longer declared is an orphan and is removed after the declared
resources converge, as the credential provisioner does today. A project that
declares nothing and has recorded resources is a teardown, confirmed through the
existing `confirmTeardown` flow.

#### Switching `managedBy`

`managedBy` is a spec-level field; the CDK binding (`stackArn`) and the imperative
records live per target. Both backends check the _other_ backend's records for the
target they are about to deploy, before any AWS mutation, and refuse rather than
adopt or delete resources they did not create:

| Project state for the target                   | Flip to `Imperative`                                                              | Flip to `CDK`                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Flag `imperative-deploy` off                   | Backend selection fails: run `agentcore config imperative-deploy true` or revert. | n/a                                                                  |
| Never deployed (no target entry)               | Deploys fresh. The scaffolded `agentcore/cdk/` directory is ignored.              | Deploys fresh.                                                       |
| Deployed by CDK (`stackArn` recorded)          | `ProjectStateError`: target is managed by stack `<arn>`; migrate first.           | Normal CDK deploy.                                                   |
| Deployed imperatively (`resources.imperative`) | Normal imperative deploy.                                                         | `ProjectStateError`: target has imperative resources; migrate first. |

Migration is explicit in both directions: revert `managedBy`, deploy an empty
project (the existing teardown flow removes the stack or the imperative
resources), then set the new value and deploy again. Adoption is out of scope:
CDK resources carry CloudFormation-generated names and no ownership tags, and
most kinds cannot be renamed in place, so adopting would be a recreate anyway.
Because the check is per target, a never-deployed `prod` can go imperative while a
CDK-deployed `dev` on the same project is refused until migrated.

### 4.6 The deploy sequence (`ImperativeBackend.deploy`)

1. Verify the active credentials belong to the target account.
2. Validate the spec is deployable by this backend at this phase; reject
   container runtimes and any kind not yet implemented with an actionable
   message, before any mutation.
3. Refuse if the target's recorded state carries a CDK stack binding.
4. Provision credential providers with the shared provisioner; record them.
5. `plan()` → `{ stack, apply, remove }`.
6. Nothing declared: with recorded resources → confirmed teardown (run
   `remove`, delete providers, drop the target's state); with nothing recorded
   → error, as the CDK backend does.
7. Enable Transaction Search (best effort, unchanged).
8. `apply.execute()`; persist each succeeded step's outputs from `stack.data`.
9. `remove.execute()`; drop each removed resource's record.
10. Delete orphaned credential providers. Return outputs.

### 4.7 What each phase delivers

| Phase | Deliverable                                                                                                                                                                                                      | Resource kinds that deploy          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 0     | Lift shared modules out of `backends/cdk/`                                                                                                                                                                       | none (refactor only)                |
| 1     | Flag, `managedBy: Imperative`, `plan/` engine, progress extension, `agentcore/` stack + plan factory, state, naming, status normalizer, backend skeleton; every kind reports not implemented before any mutation | none                                |
| 2     | Execution role reconciler, CodeZip packaging and upload, `runtime.ts`, `memory.ts`, runtime endpoints; `project create --managed-by`                                                                             | runtime (CodeZip), endpoint, memory |
| 3     | `gateway.ts` (non-Lambda-compute targets), `policy.ts`, credential wiring                                                                                                                                        | + gateway family, policy family     |
| 4     | Evaluator, online eval config, config bundle, harness (non-container), payments                                                                                                                                  | the rest of the spec                |
| later | Containers (build strategy decision), knowledge bases, Lambda compute                                                                                                                                            |                                     |

Phase 2 needs a bucket for CodeZip artifacts because `CreateAgentRuntime`
accepts only an S3 location or an ECR image. The recommendation is a
CLI-managed bucket per account and region with an override in
`aws-targets.json`; the decision is open.

## 5. Testing

- `plan/`: unit tests with scripted fake steps and an injected sleep and clock;
  cover create, update, waiting, failure, not-started, timeout, dependency skip,
  join, concurrency limit, abort.
- `agentcore/`: graph-shape tests for `plan()`; per-kind `create`/`poll` tests
  against the `Test*Client` fakes for decision logic; golden record/replay
  (`RECORD=1 bun test`) for real request shapes (phase 2+).
- Backend: unit tests with an injected `plan()` for the orchestration rules
  (teardown, CDK-binding refusal, orphan pruning, state persistence).
- Parity: tests that assert the env var names and IAM statements the imperative
  path produces match the CLI's own helpers and the documented CDK grants.
- Handler: `project deploy` with `managedBy: Imperative` and the flag off and
  on, through the real root handler and `TestCoreClient`.

## 6. Risks

- Status vocabularies differ per resource kind (`READY` vs `ACTIVE`, several
  failure spellings); a normalizer with an exhaustive test against the SDK
  enums keeps this honest.
- Update calls on this service replace rather than merge; `do` must send the
  full desired configuration.
- Some properties are create-only (names, some network settings). `poll`
  reports these as `OUTDATED` with a detail that tells the user a rename or
  replacement is needed rather than silently recreating.
- Read-after-write lag: `poll` must find what `do` just created (poll by the
  recorded id, not by listing), or the engine reports the step as not started.
- Two concurrent deploys of one project can lose a state write; this is already
  true today and stays out of scope.
