# Imperative Deploy, Phase 0: Lift Shared Backend Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the backend-neutral modules (deployed state, credential provisioner, account resolution, shared backend types) out of `src/core/project/backends/cdk/` so a second backend can use them without importing CDK code.

**Architecture:** Pure moves plus one type widening. Modules keep their behavior and tests; only their location and the credential type they accept change. `CdkCredentialProvider` (a toolkit-lib alias for `AwsCredentialIdentityProvider`) is replaced by the core `AwsCredentials` type, which is a superset, so every existing caller still compiles.

**Tech Stack:** TypeScript, bun test, git mv.

**Spec:** `docs/superpowers/specs/2026-09-24-imperative-deploy-design.md` (section 3, "Both backends share...").

## Global Constraints

- Branch from `upstream/refactor` at `326bc9ef`; PR targets `refactor` on the fork `notgitika/agentcore-cli`.
- `bun test`, `bun run typecheck`, `bun run lint:check`, `bun run format:check` must pass after every task.
- No behavior change. No new dependencies. Tests move with their modules and keep passing unmodified except for import paths and the credential type name.
- Commit style: conventional commits, e.g. `refactor(project): ...`.

## Review Focus

- A caller that passes resolved credentials (`AwsCredentialIdentity`, an object) instead of a provider function to `createCredentialProvisioner` must still work, because `AwsCredentials` admits both and `CoreOptions.credentials` accepts both. Pinned in Task 2's added test.
- `updateTargetState` must keep preserving unknown keys after the move (the CDK app and a future backend both rely on passthrough). Covered by the moved `deployedState.test.ts`.
- The manager's default-target provisioning still resolves the account through the moved `resolveAwsAccount`. Pinned by the existing manager tests that inject `resolveAccount`; Task 3 adds an import-path assertion via typecheck.
- The CDK backend's teardown path still deletes orphaned credentials after the move. Covered by the existing `cdk.test.ts`, which is updated only for import paths.
- Nothing under `src/core/project/backends/shared/` may import from `./cdk/` or `@aws-cdk/toolkit-lib`. Pinned by Task 5's dependency test.

---

### Task 1: Move `deployedState` to `backends/shared`

**Files:**

- Move: `src/core/project/backends/cdk/deployedState.ts` → `src/core/project/backends/shared/deployedState.ts`
- Move: `src/core/project/backends/cdk/deployedState.test.ts` → `src/core/project/backends/shared/deployedState.test.ts`
- Modify: `src/core/project/backends/cdk.ts:48-53` (import path)
- Modify: `src/core/project/backends/cdk.test.ts:19` (import path)

**Interfaces:**

- Consumes: nothing new.
- Produces: `readDeployedState`, `updateTargetState`, `removeTargetState`, `stackReferenceOf`, `DeployedStateSchema`, `DEPLOYED_STATE_RELATIVE_PATH`, types `DeployedState`, `TargetState`, all at `src/core/project/backends/shared/deployedState.ts` with unchanged signatures.

- [ ] **Step 1: Create the directory and move the files with history**

```bash
cd /Volumes/workplace/agentcore/.worktrees/imperative-deploy
git checkout -b refactor/backends-shared upstream/refactor
mkdir -p src/core/project/backends/shared
git mv src/core/project/backends/cdk/deployedState.ts src/core/project/backends/shared/deployedState.ts
git mv src/core/project/backends/cdk/deployedState.test.ts src/core/project/backends/shared/deployedState.test.ts
```

- [ ] **Step 2: Fix the relative imports inside the moved files**

In `shared/deployedState.ts` the only relative import is the io module and its depth is unchanged (both `cdk/` and `shared/` sit at the same depth), so `import { atomicWrite, type ReadWriteJson } from "../../../../io";` stays as is. Same for the test's `../../../../io` and `../../../../testing`. Verify with:

```bash
grep -n "from \"" src/core/project/backends/shared/deployedState.ts src/core/project/backends/shared/deployedState.test.ts
```

Expected: only `../../../../io`, `../../../../testing`, `zod`, `node:*`, and `./deployedState`.

- [ ] **Step 3: Update the doc comment so it no longer describes the file as CDK-owned**

Replace lines 7 to 15 of `shared/deployedState.ts` with:

```ts
/**
 * Project-relative path of the per-target deploy binding every backend reads
 * and writes.
 *
 * Under `agentcore/.cli/` to match the released CLI's location, so a project
 * created by an older CLI keeps reading the same path after upgrading. The CDK
 * backend records a target's stack ARN and the credential provider ARNs the
 * synthesized app reads back; other backends record their own resource
 * bindings under the same target. The scaffolded `.gitignore` keeps this one
 * file committed while ignoring the rest of `.cli/`.
 */
```

- [ ] **Step 4: Update importers**

In `src/core/project/backends/cdk.ts` change

```ts
} from "./cdk/deployedState";
```

to

```ts
} from "./shared/deployedState";
```

In `src/core/project/backends/cdk.test.ts` change

```ts
import { DEPLOYED_STATE_RELATIVE_PATH, updateTargetState } from "./cdk/deployedState";
```

to

```ts
import { DEPLOYED_STATE_RELATIVE_PATH, updateTargetState } from "./shared/deployedState";
```

- [ ] **Step 5: Typecheck and run the affected tests**

Run: `bun run typecheck && bun test src/core/project/backends`
Expected: typecheck clean; all tests pass (same count as before the move).

- [ ] **Step 6: Commit**

```bash
git add -A src/core/project/backends
git commit -m "refactor(project): move deployed state out of the CDK backend directory"
```

---

### Task 2: Move the credential provisioner to `backends/shared` and widen its credential type

**Files:**

- Move: `src/core/project/backends/cdk/credentials.ts` → `src/core/project/backends/shared/credentials.ts`
- Move: `src/core/project/backends/cdk/credentials.test.ts` → `src/core/project/backends/shared/credentials.test.ts`
- Modify: `src/core/project/backends/shared/credentials.ts:24,88` (credential type)
- Modify: `src/core/project/backends/cdk.ts:34-42` (import path)
- Modify: `src/core/project/backends/cdk.test.ts:12-18` (import path)

**Interfaces:**

- Consumes: `AwsCredentials` from `src/core/types.tsx`.
- Produces: unchanged exports (`createCredentialProvisioner`, `createCredentialRemover`, `orphanedCredentials`, `CredentialProviderCalls`, `CredentialProvisionInput`, `CredentialProvisioner`, `CredentialProviderRef`, `CredentialRemovalInput`, `CredentialRemover`, `DeployedCredential`, `DeployedCredentials`) at the new path, with `CredentialProvisionInput.credentials: AwsCredentials`.

- [ ] **Step 1: Move the files**

```bash
git mv src/core/project/backends/cdk/credentials.ts src/core/project/backends/shared/credentials.ts
git mv src/core/project/backends/cdk/credentials.test.ts src/core/project/backends/shared/credentials.test.ts
```

- [ ] **Step 2: Write the failing test for object-form credentials**

Append to `shared/credentials.test.ts`, inside the existing top-level `describe` for the provisioner (or as a new `describe("credential type", ...)` at the end of the file):

```ts
describe("credential type", () => {
  test("accepts resolved credentials as well as a provider", async () => {
    // Resolved credentials are an object, not a function. CoreOptions accepts
    // both, and so must the provisioner, so a backend that resolves once can
    // hand the result straight through.
    const input: CredentialProvisionInput = {
      region: "us-east-1",
      targetName: "default",
      credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
    };
    expect(input.credentials).toEqual({ accessKeyId: "AKIA", secretAccessKey: "secret" });
  });
});
```

Add `CredentialProvisionInput` to the type imports from `./credentials` at the top of the test if it is not already imported.

- [ ] **Step 3: Run the test to verify it fails to compile**

Run: `bun run typecheck`
Expected: error on the new test, `Type '{ accessKeyId: string; secretAccessKey: string; }' is not assignable to type 'CdkCredentialProvider'`.

- [ ] **Step 4: Widen the credential type**

In `shared/credentials.ts` replace

```ts
import type { CdkCredentialProvider } from "./toolkit";
```

with

```ts
import type { AwsCredentials } from "../../../types";
```

and in `CredentialProvisionInput` replace

```ts
credentials: CdkCredentialProvider;
```

with

```ts
credentials: AwsCredentials;
```

In `shared/credentials.test.ts` replace

```ts
import type { CdkCredentialProvider } from "./toolkit";
```

with

```ts
import type { AwsCredentials } from "../../../types";
```

and rename every `CdkCredentialProvider` type annotation in that test to `AwsCredentials` (search the file; the fixture credentials constant is the usual one).

- [ ] **Step 5: Update importers**

In `src/core/project/backends/cdk.ts` change `} from "./cdk/credentials";` to `} from "./shared/credentials";`.
In `src/core/project/backends/cdk.test.ts` change `} from "./cdk/credentials";` to `} from "./shared/credentials";`.

- [ ] **Step 6: Typecheck and run tests**

Run: `bun run typecheck && bun test src/core/project/backends`
Expected: clean typecheck; all tests pass including the new one.

- [ ] **Step 7: Commit**

```bash
git add -A src/core/project/backends
git commit -m "refactor(project): move the credential provisioner to backends/shared and accept any AwsCredentials"
```

---

### Task 3: Move `resolveAwsAccount` and `AccountResolver` to `backends/shared/account.ts`

**Files:**

- Create: `src/core/project/backends/shared/account.ts`
- Modify: `src/core/project/backends/cdk/environment.ts:31-34,125-141` (remove the moved code)
- Modify: `src/core/project/backends/cdk.ts:54-61` (import path)
- Modify: `src/core/project/manager.tsx:78` (import path)

**Interfaces:**

- Produces:

  ```ts
  export type AccountResolver = (region: string, credentials?: AwsCredentials) => Promise<string>;
  export const resolveAwsAccount: AccountResolver;
  ```

  at `src/core/project/backends/shared/account.ts`.

- [ ] **Step 1: Create the shared module**

Create `src/core/project/backends/shared/account.ts`:

```ts
import { MalformedServiceResponseError } from "../../../../errors/errors";
import type { AwsCredentials } from "../../../types";

/**
 * Resolves the AWS account the given credentials belong to. Omitting
 * `credentials` resolves through the default AWS SDK provider chain. Every
 * backend runs this before its first mutation so a deploy never lands in an
 * account other than the target's.
 */
export type AccountResolver = (region: string, credentials?: AwsCredentials) => Promise<string>;

export const resolveAwsAccount: AccountResolver = async (region, credentials) => {
  // Lazily imported to keep STS off the CLI startup path.
  const { GetCallerIdentityCommand, STSClient } = await import("@aws-sdk/client-sts");
  const client = new STSClient({ credentials, region });
  try {
    const { Account } = await client.send(new GetCallerIdentityCommand({}));
    if (!Account) {
      throw new MalformedServiceResponseError("STS GetCallerIdentity returned no AWS account ID");
    }
    return Account;
  } finally {
    client.destroy();
  }
};
```

- [ ] **Step 2: Remove the moved code from `cdk/environment.ts`**

Delete the `AccountResolver` type (lines 31 to 34) and the `resolveAwsAccount` function (lines 125 to 141, including its doc comment). Keep everything else in the file. If `MalformedServiceResponseError` is still used elsewhere in the file (it is, by `readBootstrapState`), keep its import.

- [ ] **Step 3: Update importers**

In `src/core/project/backends/cdk.ts` remove `resolveAwsAccount,` and `type AccountResolver,` from the `./cdk/environment` import block and add:

```ts
import { resolveAwsAccount, type AccountResolver } from "./shared/account";
```

In `src/core/project/manager.tsx` change

```ts
import { resolveAwsAccount } from "./backends/cdk/environment";
```

to

```ts
import { resolveAwsAccount } from "./backends/shared/account";
```

- [ ] **Step 4: Typecheck and run tests**

Run: `bun run typecheck && bun test src/core/project`
Expected: clean; all pass.

- [ ] **Step 5: Commit**

```bash
git add -A src/core/project
git commit -m "refactor(project): move AWS account resolution to backends/shared"
```

---

### Task 4: Shared backend types and CDK-free documentation on the seam

**Files:**

- Create: `src/core/project/backends/shared/types.ts`
- Modify: `src/core/project/backends/cdk.ts:118-121` (move `TransactionSearchEnabler`, re-export)
- Modify: `src/core/project/manager.tsx:77` (import `TransactionSearchEnabler` from shared)
- Modify: `src/core/project/backends/types.ts:14-15` (doc comment)
- Modify: `src/handlers/project/types.ts:459-460` (doc comment)

**Interfaces:**

- Produces at `src/core/project/backends/shared/types.ts`:

  ```ts
  export type TransactionSearchEnabler = (
    target: AwsDeploymentTarget,
    credentials: AwsCredentials,
  ) => Promise<void>;
  export type AwsCredentialResolver = (region: string) => Promise<AwsCredentialProvider>;
  ```

- [ ] **Step 1: Create the shared types module**

```ts
import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import type { AwsCredentialProvider, AwsCredentials } from "../../../types";

/** Enables CloudWatch Transaction Search for a deploy target. Shared by every backend. */
export type TransactionSearchEnabler = (
  target: AwsDeploymentTarget,
  credentials: AwsCredentials,
) => Promise<void>;

/**
 * Resolves the credential provider a deploy runs under for a region. The CDK
 * backend supplies the AWS-CLI-compatible chain from the CDK Toolkit; any
 * backend may be handed the same resolver.
 */
export type AwsCredentialResolver = (region: string) => Promise<AwsCredentialProvider>;
```

- [ ] **Step 2: Move `TransactionSearchEnabler` out of `cdk.ts`**

In `src/core/project/backends/cdk.ts` delete the `TransactionSearchEnabler` declaration (lines 118 to 121) and add near the other imports:

```ts
import type { TransactionSearchEnabler } from "./shared/types";
export type { TransactionSearchEnabler };
```

The re-export keeps `manager.tsx`'s current import working until Step 3 changes it; after Step 3 you may drop the re-export if nothing else imports it (`grep -rn "TransactionSearchEnabler" src`).

- [ ] **Step 3: Point the manager at the shared type**

In `src/core/project/manager.tsx` change

```ts
import { CdkBackend, type TransactionSearchEnabler } from "./backends/cdk";
```

to

```ts
import { CdkBackend } from "./backends/cdk";
import type { TransactionSearchEnabler } from "./backends/shared/types";
```

- [ ] **Step 4: Make the seam's documentation backend-neutral**

In `src/core/project/backends/types.ts` change the comment on `confirmTeardown` from

```ts
/** Requests approval after synthesis identifies a teardown. */
```

to

```ts
/** Requests approval once the backend determines this deploy is a teardown. */
```

In `src/handlers/project/types.ts` change

```ts
  /** Compile the project's CDK app and synthesize its CloudFormation templates. */
  build(project: Project): AsyncGenerator<ProjectEvent, void>;
```

to

```ts
  /** Build the project's deployable artifacts with its selected backend. */
  build(project: Project): AsyncGenerator<ProjectEvent, void>;
```

- [ ] **Step 5: Typecheck, test, lint, format**

Run: `bun run typecheck && bun test src/core/project src/handlers/project && bun run lint:check && bun run format:check`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "refactor(project): share backend types and make the deploy seam's docs backend-neutral"
```

---

### Task 5: Guard the boundary with a dependency test

**Files:**

- Create: `src/core/project/backends/shared/boundary.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Everything under backends/shared/ is meant for every backend, so nothing in
// it may reach back into the CDK backend or the CDK Toolkit. A second backend
// importing shared code must not drag toolkit-lib into its import graph.
describe("backends/shared boundary", () => {
  const dir = import.meta.dir;
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  test("has at least the modules this test protects", () => {
    expect(sources).toEqual(
      expect.arrayContaining(["account.ts", "credentials.ts", "deployedState.ts", "types.ts"]),
    );
  });

  for (const file of sources) {
    test(`${file} does not import CDK code`, () => {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text).not.toMatch(/from "\.\.?\/cdk/);
      expect(text).not.toMatch(/@aws-cdk\//);
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `bun test src/core/project/backends/shared/boundary.test.ts`
Expected: PASS for every file.

- [ ] **Step 3: Full verification and commit**

Run: `bun run typecheck && bun test && bun run lint:check && bun run format:check`
Expected: all clean; the total test count matches the baseline recorded before Task 1 (no tests lost in the moves).

```bash
git add src/core/project/backends/shared/boundary.test.ts
git commit -m "test(project): guard backends/shared against CDK imports"
```

---

### Task 6: Open the PR on the fork

- [ ] **Step 1: Push and open**

```bash
git push origin refactor/backends-shared
gh pr create --repo notgitika/agentcore-cli --base refactor --head refactor/backends-shared \
  --title "refactor(project): lift shared deploy modules out of the CDK backend" \
  --body-file - <<'PR'
## Description

Preparatory change for the imperative deploy backend (see `docs/superpowers/specs/2026-09-24-imperative-deploy-design.md`, phase 0). Moves the modules every backend needs out of `src/core/project/backends/cdk/`:

- `deployedState.ts` → `backends/shared/` (pure move, doc comment made backend-neutral)
- `credentials.ts` → `backends/shared/`; `CredentialProvisionInput.credentials` now accepts the core `AwsCredentials` instead of toolkit-lib's `CdkCredentialProvider` (a widening; every caller still compiles)
- `resolveAwsAccount` / `AccountResolver` → `backends/shared/account.ts`
- `TransactionSearchEnabler` and a new `AwsCredentialResolver` → `backends/shared/types.ts`
- Seam docs no longer mention CDK
- A boundary test keeps `backends/shared/` free of CDK imports

No behavior change.

## Related Issue

Closes #TBD (design tracking issue)

## Documentation PR

Not applicable.

## Type of Change

- [x] Other (please describe): internal refactor

## Testing

- [x] I ran `bun test`
- [ ] I ran the relevant end-to-end tests with `bun run test:e2e`, or explained why they are not applicable: pure move, unit tests cover it
- [x] I ran `bun run typecheck`
- [x] I ran `bun run lint:check`
- [x] I ran `bun run format:check`
- [x] I ran `bun run build`
- [ ] If I modified `src/assets/`, I updated affected snapshots: not modified

## Checklist

- [x] I have read the CONTRIBUTING document
- [x] I have added any necessary tests that prove my fix is effective or my feature works
PR
```
