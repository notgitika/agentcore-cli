# Imperative deploy: review triage and remaining work

Date: 2026-09-29
Scope: stacked PRs #6, #7, #8 on `notgitika/agentcore-cli` (base `refactor`).
Verified against the phase 2 head `c170b2ed` in `.worktrees/imperative-runtime`
and the L3 package the CLI pins (`@aws/agentcore-cdk` 1.0.0-rc.2, commit
`766daca` in the cdk repo, plus `origin/main`).

Every claim below was checked by reading the code at the cited line, not from
memory. "Confirmed" means the reviewer is right. "Partly" means one half holds.

## 1. Merge-blocking findings

| # | Finding | Verdict | Fix lands in |
|---|---------|---------|--------------|
| 1 | Adopt, update, delete without an ownership check; user tags can override ownership tags | Confirmed | #8 (runtime, memory, stack) |
| 2 | Credential-enabled runtimes will not work | Partly: IAM gap confirmed; env-var claim wrong | #8 (iam, runtime) + a separate CDK issue |
| 3 | Declined teardown loses credential state | Confirmed; identical order in the CDK backend | #7, then a CDK follow-up |
| 4 | Timeout and cancel do not stop in-flight AWS calls | Confirmed | #8 only (engine already passes `ctx`) |
| 5 | Drift detection reports convergence too eagerly | Confirmed | #8 (runtime, memory) |
| 6 | Packaging can follow `../` and symlinks out of the project | Confirmed as behaviour; not a regression against CDK | #8 packaging + shared schema |

### 1.1 Ownership

Evidence:

- `imperative/agentcore/runtime.ts` `locate` falls back to `findRuntimeByName`
  and records whatever carries the physical name. No tag read.
- `imperative/agentcore/memory.ts` `locate` and `findMemoryByName` do the same.
- `remove` in both handlers deletes by the recorded id. Only `deleteRole` in
  `iam.ts` checks ownership tags before deleting.
- `imperative/agentcore/stack.ts` `tags(extra)` spreads `extra` after the
  ownership tags, so a spec tag under `agentcore:` wins.
- Endpoints are located inside the recorded runtime, so they inherit the
  runtime's ownership once that is checked. No separate fix needed there.

The design (§2, non-goals) says a same-named resource without our tags is an
error. The code violates the design. Adopt-by-name itself must stay: it is how
a run resumes when `do` created the resource but the process died before the
ledger write.

Fix: one `stack.assertOwned(arn)` helper backed by `ListTagsForResource` that
requires all three ownership tags to match the scope, called after any lookup
by name and before every update and delete. `tags()` rejects extra keys in the
`agentcore:` namespace with an `InputValidationError`. Add tests for: untagged
same-name resource, resource tagged for another project or target, tampered
ledger id pointing at a foreign resource, and a spec tag that tries to override
`agentcore:managed-by`.

### 1.2 Credentials

IAM half, confirmed. `iam.ts` `runtimeExecutionPolicy` has statements for
Bedrock, X-Ray, logs, configuration bundles and memory only. The L3
`AgentCoreRuntime.grantCredentialAccess` adds, whenever the project has
credentials:

- `bedrock-agentcore:CreateWorkloadIdentity`, `GetWorkloadAccessTokenForUserId`,
  `GetApiKeyCredential`, `GetResourceApiKey`, `GetResourceOauth2Token` on
  `workload-identity-directory/*`, `token-vault/*`, `apikeycredentialprovider/*`
- `secretsmanager:GetSecretValue` on `secret:bedrock-agentcore-identity!*`

An imperatively deployed runtime that calls Identity gets AccessDenied. Fix:
add both statements when `spec.credentials` is non-empty, with a test that
pins them against the L3 list.

Env-var half, not a deviation. The reviewer says CDK extracts the provider id
from the ARN before injecting it. That is the gateway path
(`AGENTCORE_GATEWAY_<TOKEN>_CREDENTIAL_PROVIDER`, an ARN). For runtime
credentials the L3 binds `AGENTCORE_CREDENTIAL_<NAME>_NAME` to
`credential.name`, the logical name, at rc.2 (`766daca`, `AgentCoreRuntime`
bind path) and on `origin/main` (`AgentCoreApplication.ts:485`). The imperative
handler does exactly the same, so the two backends agree.

Open question for both backends: since CLI PR #2332 the provisioner creates the
provider as `<project>_<target>_<credential>`, while the agent template reads the
env var and falls back to the spec name. Neither backend injects the scoped
name. Either the logical name resolves (unlikely) or credential-enabled agents
are broken on the CDK path too. The reviewer's suggested API-key e2e test is the
right way to settle it. If it fails, export `providerName` from
`backends/shared/credentials.ts` and inject the scoped name in both backends.

### 1.3 Teardown before confirmation

`imperative.ts` provisions and records credentials (empty map on
`remove all`) before `teardown()` calls `confirmTeardown`. `cdk.ts` has the
same order: state written at line 297, confirmation at line 426. The unit test
at `imperative.test.ts:281` restores the ledger by hand between the declined
and the confirmed attempt, which documents the bug rather than guarding
against it.

Fix in #7: compute `plans` before provisioning. When nothing is declared and
something is recorded, ask for confirmation first and skip provisioning
entirely. Change the test so the declined attempt leaves the credential map
untouched. File the same fix for the CDK backend separately; it is outside
this stack.

### 1.4 Signal threading

The engine's `bounded()` races each call against the step budget and aborts
an internal controller, and `StepContext.signal` is handed to both `Doer` and
`Statuser`. No handler uses it: there is no `abortSignal` in
`agentcore/*.ts`, `iam.ts` or `artifacts.ts`, and `withRolePropagationRetry`
sleeps without a signal. After a timeout the SDK call and its retry loop keep
running until the process exits. Impact is bounded because the next deploy
adopts whatever completed, but Ctrl-C is not clean.

Fix in #8 only: `stack.send(command, ctx)` that passes
`{ abortSignal: ctx.signal }`, used by every handler; `sleep(ms, signal)` in
the retry helper. Engine changes are not required.

### 1.5 Drift

Runtime: `desiredRequest` sends VPC subnets and security groups, the request
header allowlist and lifecycle settings, but `runtimeDrift` compares only code,
entry point, runtime version, role, network mode, protocol, description and
environment. Memory: `memoryDrift` compares description, expiry and the set of
strategy types. Namespaces, strategy configuration, encryption key and
execution role are ignored, and the update path can add or delete strategies
but cannot modify one in place.

Fix: canonical comparison of the full desired request against the live
resource. Two cautions for whoever implements it. Service defaults must be
normalised (the service returns default lifecycle values when none were sent)
or every deploy reports Outdated. Create-only fields must map to `Failed` with
a message that names the field and says a remove and re-add is required, not to
`Outdated`, which would loop.

### 1.6 Packaging paths

`codeLocation` is `z.string().min(1)`, so `../` is accepted, and `copySource`
uses `stat`, which follows symlinks. Both are true of the CDK path as well:
the L3 `copyEntry` also uses `stat` and the same schema. There is no existing
realpath validator to reuse; the only path check in the schema is for
Dockerfile paths.

Fix: a realpath containment check on `codeLocation` in the shared schema so
both backends benefit, `lstat` in the packager with symlinks that resolve
outside the code directory skipped and reported. Worth doing, but it is a
hardening of pre-existing behaviour, not a regression introduced by #8.

## 2. Other review items

- **Unknown kinds in the ledger (#7).** Confirmed. `imperativeStateOf` casts
  each key to `ResourceKind` without checking it, so a ledger written by a newer
  CLI reaches `handlers[kind]` as `undefined` and fails with a TypeError. Fix:
  validate against the known kinds and throw `ProjectStateError` naming the kind
  and suggesting a CLI upgrade.
- **Shared boundary test scans one level (#6).** Confirmed. The file already
  defines a recursive `walk`; the shared describe block should use it.
- **PR sizes.** Agreed. Both PRs were built as one commit per module, so the
  split is mechanical. Proposed cuts: #7 into progress protocol and UI, plan
  engine, state and naming and inventory, backend wiring and flag. #8 into
  packaging and artifact store, IAM reconciler, memory handler, runtime and
  endpoint handlers, scaffolding and e2e. Ten PRs in total. Fix first as
  fixup commits on the owning module, then split, so each fix travels with the
  code it fixes.
- **Complexity table.** Agreed, with one note: the scheduler is the mechanism
  the design asks for (parallel DAG, status-first, resumable) and nothing in
  the dependency tree provides it, so it is essential rather than accidental.
  It should still be reviewed in isolation.
- **Hosted CI on the fork.** Not informative. The Linux and Windows verify
  jobs and CodeQL use self-hosted CodeBuild runner labels that exist only in
  the upstream account, so they queue for 24 hours and cancel. The e2e job
  runs on push only. The AI review lacks the fork's secrets. Evidence for the
  stack is the local suite, typecheck, lint, build, the committed e2e run and
  the live golden path. CI becomes meaningful when the stack targets upstream.

## 3. Fix order

1. Ownership helper and tag namespace guard (#8).
2. Identity and Secrets Manager statements; API-key e2e; scoped-name decision (#8).
3. `stack.send` and signal-aware sleep (#8).
4. Full drift comparison with default normalisation (#8).
5. Confirm-before-provision on teardown (#7).
6. Ledger kind validation (#7).
7. Path containment and symlink handling (shared schema, #8 packaging).
8. Recursive shared boundary test (#6).
9. Split into the ten PRs above.

## 4. Remaining work for full parity

Kinds still NotImplemented, by the phase the design assigns them:

- Phase 3: gateways and non-Lambda targets, policy engines and policies,
  credential wiring into gateway target auth.
- Phase 4: evaluators, online eval configs, config bundles, harnesses
  (non-container), payment managers and connectors.
- Later, decision needed first: container runtimes (CodeBuild vs local
  docker or finch plus ECR), knowledge bases, Lambda compute targets.

Gaps inside supported kinds: Node.js CodeZip packaging; runtime authorizers,
filesystem configurations, connections, tool runtimes; memory stream
delivery; a replace flow for create-only property changes.

Engine and lifecycle: abort signal from the deploy handler into the backend;
dependency edges for kinds no phase has enabled; artifact bucket retention
(below); bucket-name override in aws-targets; migration between backends on
one target; parity test that diffs env vars and IAM against CDK synth output.

Delivery: uv on the CodeBuild runner for the imperative e2e (unverified);
Windows packaging untested; GovCloud and China partitions untested live;
user-facing docs for the flag and `--managed-by`; flag removal criteria
(below).

Live testing not yet done: partial removal, repair after UPDATE_FAILED,
interrupt mid-deploy, multi-runtime projects, multiple targets, adopting an
untagged same-name resource, the dependency-too-large error path.

## 5. Proposed criteria for removing the flag

- Every phase 0 to 4 kind deploys, and the container decision is either
  implemented or documented as CDK-only.
- The parity test in section 4 passes for a fixture project with a runtime,
  a memory, a credential and a gateway.
- The `imperative` e2e tag has been green on upstream CI for four consecutive
  weeks.
- Items 1 to 8 in section 3 are merged, and the live tests listed in
  section 4 have been run once and recorded.
- User docs and a CDK-to-imperative migration guide are published.
- The artifact retention policy below is implemented.

## 6. Proposed artifact retention policy

The bucket `agentcore-cli-<account>-<region>` is shared by every project in
the account and region and is never deleted by the CLI. Objects live under
`<project>/<target>/<runtime>/<sha256>.zip`. After a successful deploy, the
backend deletes objects under its own prefix that the ledger does not
reference, keeping the three most recent by last-modified so a rollback by
redeploying an older commit still finds its artifact. Teardown of a target
deletes the objects under `<project>/<target>/`. A bucket lifecycle rule is
not used because objects are content-addressed and may be re-referenced.
This belongs in design §4.5 once accepted.
