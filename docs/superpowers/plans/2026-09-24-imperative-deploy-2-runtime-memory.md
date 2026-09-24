# Imperative Deploy Phase 2: Runtime, Memory and CodeZip Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agentcore project deploy` work end to end for a `managedBy: "Imperative"` project that declares CodeZip Python runtimes, runtime endpoints and memories: package the code with `uv`, upload it to a per-account S3 bucket, create the execution roles, create or update the memories and runtimes through the control plane, record everything in the ledger, and tear it all down again when the spec empties.

**Architecture:** Three kind modules under `backends/imperative/agentcore/` (`memory.ts`, `runtime.ts`, `endpoint.ts`) each export a `KindHandlers` (`create`/`poll`/`remove`/`pollGone`) and replace the `notImplemented` entries in `HANDLERS`. Supporting modules under `backends/imperative/` hold the pieces the handlers share: `packaging/python.ts` builds the CodeZip exactly the way the L3 construct does, `artifacts.ts` owns the S3 bucket and keys, `iam.ts` owns execution roles and the runtime policy document. The backend gains a staging pass (package, ensure bucket, upload) between the pre-mutation checks and `plan.apply.execute`, and hands the uploaded artifacts to the stack so the runtime step can read them. `project create --managed-by Imperative` scaffolds a project without the CDK app.

**Tech Stack:** TypeScript, bun 1.4 (`bun test`, colocated `*.test.ts`), zod v4, AWS SDK v3 (`@aws-sdk/client-s3` added), `fflate` (added, the zip library L3 uses), `uv` on the developer's PATH, existing `runProcess` from `src/io/exec.ts`.

**Spec:** `docs/superpowers/specs/2026-09-24-imperative-deploy-design.md` (sections 2, 4.2 to 4.7, 6). Research: `docs/superpowers/research/2026-09-24-imperative-deploy-context.md`. Phase 1 plan: `docs/superpowers/plans/2026-09-24-imperative-deploy-1-engine.md`.

**Depends on:** Phase 1 (`feat/imperative-deploy-engine`, PR #7 on the fork). Branch `feat/imperative-deploy-runtime-memory` off `feat/imperative-deploy-engine`. Worktree: `/Volumes/workplace/agentcore/.worktrees/imperative-runtime`.

**L3 reference:** `/Users/gitikavj/node_modules/@aws/agentcore-cdk/dist/lib/packaging/python.js` (packaging), `.../lib/runtime/*.js` (runtime construct, role policy), `.../lib/memory/*.js` (memory construct). Read these before implementing Tasks 2, 4, 5 and 6; the plan quotes the parts that matter, the source is the tie-breaker.

## Global Constraints

- Nothing under `src/core/project/backends/imperative/` or `backends/imperative.ts` imports from `./cdk`, `./cdk/*`, `@aws-cdk/*` or `@aws/agentcore-cdk` (phase 0 boundary test keeps enforcing this).
- Physical names: runtime `physicalName(scope, "runtime", name, 48)`, memory `physicalName(scope, "memory", name, 48)` (both service patterns are `^[a-zA-Z][a-zA-Z0-9_]{0,47}$`). Execution roles: `physicalName(scope, kind, name, 64 - suffix.length) + suffix` with suffix `_runtime_role` / `_memory_role`.
- Artifact bucket is exactly `agentcore-cli-<account>-<region>`; artifact key is exactly `<project>/<target>/<runtime>/<sha256>.zip`. Public access is blocked on creation. The bucket is never deleted by teardown.
- Packaging output lives under `agentcore/.cli/build/<runtime>/` (`staging/` and `code.zip`), never under `app/`.
- CodeZip contents, order of operations and exclusions match the L3 packager: `uv pip install -r pyproject.toml --target <staging> --python-version X.Y --python-platform <p> --only-binary :all:`, platforms tried in order `aarch64-manylinux2014`, `aarch64-manylinux_2_28`, `aarch64-manylinux_2_34`; excluded entries `.git`, `.venv`, `__pycache__`, `.pytest_cache`, `.DS_Store`, `node_modules`; zip entries at level 6 with mtime `1980-01-02T00:00:00Z`; max zip size 250 MiB.
- Runtime environment variables: the spec's `envVars` plus `AGENTCORE_MEMORY_<NAME>_ID` (`memoryEnvVarName` from `src/projectSchemas/memory.ts`) for every memory in the spec. A memory id missing from the stack is an error, not an empty string.
- Entry point: `["opentelemetry-instrument", <path>]` when `instrumentation.enableOtel !== false`, else `[<path>]`, where `<path>` is `entrypoint` before any `:`.
- Handler `do` closures are idempotent per the engine contract: `poll` returning `NOT_STARTED` or `OUTDATED` runs `do` once, then polls until `SUCCESSFUL`, `FAILED` or timeout. `pollGone` returns `NOT_STARTED` while the resource still exists and is not `DELETING`.
- No `clientToken` is sent on Create calls (the SDK fills the idempotency token). Create calls that fail because a freshly created role cannot be assumed yet are retried by `withRolePropagationRetry` (12 attempts, 5 s apart).
- Roles are created only when the spec omits `executionRoleArn`; a role that exists without this deploy's ownership tags is a `ProjectStateError`, never overwritten. `deleteRole` deletes only roles that carry the ownership tags.
- Unsupported inputs fail in `assertImperativelyDeployable` before any AWS call: `Container` builds, `NODE_*` runtime versions, `authorizerConfiguration`/`authorizerType`, `filesystemConfigurations`, `connections`, memory `streamDeliveryResources`, and every kind outside `SUPPORTED_KINDS = {runtime, runtime-endpoint, memory}`.
- `project create --managed-by Imperative` requires the global flag on; the error names the exact command `agentcore config imperative-deploy true`.
- Run `bun run typecheck`, `bun test` and `bun run lint:check` before every commit; baseline is 0 failures (phase 1 tip: 3686 pass / 253 files).

## Review Focus

Inputs the spec implies but no task's tests exercise by default, most likely to bite first. Each has a test pinned to the owning task below.

1. **A second deploy with no code change.** Expected: the runtime polls `SUCCESSFUL` on the first status check, no `UpdateAgentRuntime` is sent. Pinned in Task 6 (`runtime.test.ts`, "a converged runtime with the same artifact is Successful and is not updated").
2. **A code change between deploys.** Expected: the new sha256 changes the key, `poll` reports `OUTDATED`, `do` sends `UpdateAgentRuntime` with the new prefix. Pinned in Task 6 ("a new artifact marks the runtime Outdated and update sends the new prefix").
3. **An execution role that already exists but was not created by this project and target.** Expected: `ensureRole` refuses with a `ProjectStateError`, no `PutRolePolicy`. Pinned in Task 4 (`iam.test.ts`, "refuses a role that carries no ownership tags").
4. **A dependency with no wheel for `aarch64-manylinux2014`.** Expected: the packager retries on `aarch64-manylinux_2_28`, then `_2_34`, and fails with `uv`'s output only when every platform fails. Pinned in Task 2 (`python.test.ts`, "falls back to the next platform when wheels are unavailable").
5. **The artifact bucket name is taken by another account.** Expected: `ensureArtifactBucket` fails with a `ProjectStateError` naming the bucket, nothing is uploaded, no runtime is created. Pinned in Task 3 (`artifacts.test.ts`, "a bucket owned by another account fails with guidance").

## File Structure

| File                                                                                                                                      | Responsibility                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `package.json` (modify)                                                                                                                   | add `@aws-sdk/client-s3`, `fflate`                                                             |
| `src/core/types.tsx`, `src/core/factories.tsx`, `src/core/index.tsx`, `src/index.ts` (modify)                                             | `CreateS3Client`, `AwsClients.s3()`, `CoreClient.s3()` cache                                   |
| `src/core/observability/client.test.ts`, `src/core/datasetUpdate.test.ts`, `src/core/datasetDownload.test.ts`, `src/core/gateway.test.ts`, `src/handlers/eval/ab-test/ab-test.test.tsx` (modify) | `AwsClients` literals gain `s3`                                     |
| `src/core/project/backends/imperative/testing.ts` (create)                                                                                | `fakeClient()`, `notFound()`, shared by every kind test                                        |
| `src/core/project/backends/imperative/packaging/python.ts` (create), `python.test.ts`                                                     | CodeZip packaging: uv install with platform fallback, source copy, otel scripts, fflate zip    |
| `src/core/project/backends/imperative/artifacts.ts` (create), `artifacts.test.ts`                                                         | bucket name, key, `ensureArtifactBucket`, `uploadArtifact`                                     |
| `src/core/project/backends/imperative/iam.ts` (create), `iam.test.ts`                                                                     | `ensureRole`, `deleteRole`, `roleDrift`, `runtimeExecutionPolicy`, `withRolePropagationRetry`  |
| `src/core/project/backends/imperative/agentcore/memory.ts` (create), `memory.test.ts`                                                     | memory `KindHandlers`                                                                          |
| `src/core/project/backends/imperative/agentcore/runtime.ts` (create), `runtime.test.ts`                                                   | runtime `KindHandlers`, environment, entry point, drift                                        |
| `src/core/project/backends/imperative/agentcore/endpoint.ts` (create), `endpoint.test.ts`                                                 | runtime endpoint `KindHandlers`                                                                |
| `src/core/project/backends/imperative/agentcore/stack.ts`, `plan.ts` (modify), `stack.test.ts`, `plan.test.ts` (modify)                   | `StackScope.rootPath`, `stack.artifacts`, real `HANDLERS`                                      |
| `src/core/project/backends/imperative/support.ts` (modify), `support.test.ts` (modify)                                                    | `SUPPORTED_KINDS`, new guards                                                                  |
| `src/core/project/backends/imperative.ts` (modify), `imperative.test.ts` (modify)                                                         | `build()` packages; `deploy()` stages artifacts                                                |
| `src/handlers/project/types.ts`, `src/handlers/project/create/index.ts`, `src/core/project/templates/project.ts`, `src/core/project/manager.tsx` (modify), `create/index.test.ts` (modify) | `--managed-by`                                                        |
| `e2eTest/constants.ts` (modify), `e2eTest/project/imperative.test.ts` (create)                                                            | golden path e2e                                                                                |

---

### Task 1: S3 client seam and new dependencies

**Files:**

- Modify: `package.json`
- Modify: `src/core/types.tsx` (factory types, `AwsClients`)
- Modify: `src/core/factories.tsx`
- Modify: `src/core/index.tsx` (`CoreClientConfig`, `CoreClient`)
- Modify: `src/index.ts`
- Modify: `src/core/observability/client.test.ts`, `src/core/datasetUpdate.test.ts`, `src/core/datasetDownload.test.ts`, `src/core/gateway.test.ts`, `src/handlers/eval/ab-test/ab-test.test.tsx` (every `AwsClients` object literal)
- Test: `src/core/factories.test.tsx` (create if absent)

**Interfaces:**

- Produces: `CreateS3Client = (config: ClientConfig) => S3Client`; `AwsClients.s3(config: ClientConfig): S3Client`; `createS3Client` in `factories.tsx`; `CoreClientConfig.createS3Client: CreateS3Client`.

- [ ] **Step 1: Add the dependencies**

```bash
bun add @aws-sdk/client-s3@^3.1092.0 fflate@^0.8.2
```

Then open `package.json` and confirm both landed under `dependencies`, and that `@aws-sdk/client-s3` is pinned with the same `^3.10xx.0` style as its siblings. Confirm `bun.lock` changed only for those two packages (`git diff --stat bun.lock`).

- [ ] **Step 2: Write the failing factory test**

Create (or extend) `src/core/factories.test.tsx`:

```ts
import { describe, expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Client } from "./factories";

describe("createS3Client", () => {
  test("builds an S3 client for the requested region", async () => {
    const client = createS3Client({ region: "us-west-2" });
    expect(client).toBeInstanceOf(S3Client);
    expect(await client.config.region()).toBe("us-west-2");
  });
});
```

Run: `bun test src/core/factories.test.tsx`
Expected: FAIL, `createS3Client` is not exported.

- [ ] **Step 3: Add the type, factory, cache and wiring**

`src/core/types.tsx`: import `type { S3Client } from "@aws-sdk/client-s3"`, add next to the other factory types

```ts
export type CreateS3Client = (config: ClientConfig) => S3Client;
```

and to `AwsClients`

```ts
  // s3 holds the CodeZip artifacts the imperative backend uploads before it
  // creates or updates a runtime. Nothing else in the CLI talks to S3.
  s3(config: ClientConfig): S3Client;
```

`src/core/factories.tsx`:

```ts
import { S3Client } from "@aws-sdk/client-s3";
export const createS3Client: CreateS3Client = (config) => new S3Client({ ...config });
```

`src/core/index.tsx`: mirror `control()` exactly. Add `private s3Clients = new ClientCache<S3Client>()`, `private readonly createS3Client: CreateS3Client`, `createS3Client: CreateS3Client` to `CoreClientConfig`, assign in the constructor, export the `CreateS3Client` type alongside the others, and add

```ts
  s3(config: ClientConfig): S3Client {
    return this.s3Clients.get(config, this.createS3Client);
  }
```

(Copy the body of `control()` if the cache API differs; the two must be identical apart from the names.)

`src/index.ts`: import `createS3Client` from `./core/factories` and pass `createS3Client` into the `CoreClient` config next to `createXrayClient`.

- [ ] **Step 4: Fix every `AwsClients` literal in tests**

`bun run typecheck` now lists each test file whose `AwsClients` object lacks `s3`. In each, add an `s3` member in the same style the file uses for `xray` / `applicationSignals` (a throwing stub is fine when the test never calls it):

```ts
s3: () => {
  throw new Error("s3 is not used by this test");
},
```

- [ ] **Step 5: Verify**

Run: `bun test src/core/factories.test.tsx && bun run typecheck && bun test`
Expected: PASS, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/core/types.tsx src/core/factories.tsx src/core/factories.test.tsx src/core/index.tsx src/index.ts src/core/observability/client.test.ts src/core/datasetUpdate.test.ts src/core/datasetDownload.test.ts src/core/gateway.test.ts src/handlers/eval/ab-test/ab-test.test.tsx
git commit -m "feat(core): S3 client seam for CodeZip artifacts; add fflate"
```

---

### Task 2: Python CodeZip packaging

**Files:**

- Create: `src/core/project/backends/imperative/packaging/python.ts`
- Test: `src/core/project/backends/imperative/packaging/python.test.ts`

**Interfaces:**

- Consumes: `ProcessRunner`, `ProcessFailedError`, `requireTool` from `src/io/exec.ts`; `ProjectStateError` from `src/errors`; `zipSync`, `unzipSync` from `fflate`.
- Produces:

```ts
export type PackageInput = {
  /** Absolute path of the runtime's code directory: <project root>/<codeLocation>. */
  codeDir: string;
  /** PYTHON_3_10 … PYTHON_3_14 (the spec's runtimeVersion). */
  runtimeVersion: string;
  /** Directory this packager owns and may wipe: <project root>/agentcore/.cli/build/<runtime>. */
  buildDir: string;
  run: ProcessRunner;
  /** Verifies `uv` is on PATH; injectable so tests do not need uv. */
  checkTool?: (tool: string, installHint: string) => Promise<void>;
  /** One line of progress at a time (uv output, "copying source", "zipping"). */
  report?: (line: string) => void;
  signal?: AbortSignal;
};
export type PackagedCode = { zipPath: string; sizeBytes: number; sha256: string };
export type CodeZipPackager = (input: PackageInput) => Promise<PackagedCode>;
export const packagePythonCodeZip: CodeZipPackager;
export const PLATFORM_CANDIDATES: readonly string[];
export const EXCLUDED_ENTRIES: ReadonlySet<string>;
export const MAX_ZIP_SIZE_BYTES: number;
export const UV_INSTALL_HINT: string;
```

- [ ] **Step 1: Read the L3 packager**

Read `/Users/gitikavj/node_modules/@aws/agentcore-cdk/dist/lib/packaging/python.js` end to end. Note `PLATFORM_CANDIDATES`, `detectUnavailablePlatform`, `EXCLUDED_ENTRIES`, the two console-script bodies, `ZIP_ENTRY_OPTS`, `MAX_ZIP_SIZE_BYTES`. Everything below reproduces it; where the two disagree, follow L3 and fix the plan text in your commit message.

- [ ] **Step 2: Write the failing tests**

`python.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { ProcessFailedError, type ProcessRunner } from "../../../../../io/exec";
import { packagePythonCodeZip, PLATFORM_CANDIDATES } from "./python";

let root: string;
let codeDir: string;
let buildDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codezip-"));
  codeDir = join(root, "app", "agent");
  buildDir = join(root, "agentcore", ".cli", "build", "agent");
  await mkdir(join(codeDir, ".venv", "lib"), { recursive: true });
  await mkdir(join(codeDir, "__pycache__"), { recursive: true });
  await writeFile(join(codeDir, "pyproject.toml"), '[project]\nname="agent"\ndependencies=["strands-agents"]\n');
  await writeFile(join(codeDir, "main.py"), "print('hi')\n");
  await writeFile(join(codeDir, ".venv", "lib", "junk.py"), "");
  await writeFile(join(codeDir, "__pycache__", "main.cpython-314.pyc"), "");
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** A uv stand-in: writes a fake site-packages tree into --target and records the platform. */
function fakeUv(options: { failOn?: string[]; withOtel?: boolean; output?: string } = {}) {
  const platforms: string[] = [];
  const run: ProcessRunner = async (command, { cwd, onOutput }) => {
    expect(command.slice(0, 3)).toEqual(["uv", "pip", "install"]);
    expect(cwd).toBe(codeDir);
    const target = command[command.indexOf("--target") + 1]!;
    const platform = command[command.indexOf("--python-platform") + 1]!;
    platforms.push(platform);
    onOutput?.(`Resolved 3 packages for ${platform}\n`);
    if (options.failOn?.includes(platform)) {
      throw new ProcessFailedError(command, cwd, 1, options.output ?? "error: no wheels with a matching platform tag");
    }
    await mkdir(join(target, "strands"), { recursive: true });
    await writeFile(join(target, "strands", "__init__.py"), "");
    if (options.withOtel) {
      await mkdir(join(target, "opentelemetry", "instrumentation", "auto_instrumentation"), { recursive: true });
      await writeFile(join(target, "opentelemetry", "instrumentation", "auto_instrumentation", "__init__.py"), "");
    }
  };
  return { run, platforms };
}

const entriesOf = async (zipPath: string) => Object.keys(unzipSync(new Uint8Array(await readFile(zipPath)))).sort();

describe("packagePythonCodeZip", () => {
  test("installs for the first platform, copies the source, excludes junk, and zips", async () => {
    const uv = fakeUv();
    const lines: string[] = [];
    const result = await packagePythonCodeZip({
      codeDir, runtimeVersion: "PYTHON_3_14", buildDir, run: uv.run,
      checkTool: async () => {}, report: (line) => lines.push(line),
    });
    expect(uv.platforms).toEqual(["aarch64-manylinux2014"]);
    expect(result.zipPath).toBe(join(buildDir, "code.zip"));
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    const entries = await entriesOf(result.zipPath);
    expect(entries).toContain("main.py");
    expect(entries).toContain("pyproject.toml");
    expect(entries).toContain("strands/__init__.py");
    expect(entries.some((e) => e.startsWith(".venv"))).toBe(false);
    expect(entries.some((e) => e.includes("__pycache__"))).toBe(false);
    expect(lines.some((l) => l.includes("Resolved 3 packages"))).toBe(true);
  });

  test("passes the python version derived from the runtime version", async () => {
    let seen: string[] = [];
    const run: ProcessRunner = async (command) => { seen = command; await fakeUv().run(command, { cwd: codeDir }); };
    await packagePythonCodeZip({ codeDir, runtimeVersion: "PYTHON_3_12", buildDir, run, checkTool: async () => {} });
    expect(seen[seen.indexOf("--python-version") + 1]).toBe("3.12");
    expect(seen).toContain("--only-binary");
    expect(seen[seen.indexOf("-r") + 1]).toBe(join(codeDir, "pyproject.toml"));
  });

  test("falls back to the next platform when wheels are unavailable", async () => {
    const uv = fakeUv({ failOn: ["aarch64-manylinux2014"] });
    await packagePythonCodeZip({ codeDir, runtimeVersion: "PYTHON_3_14", buildDir, run: uv.run, checkTool: async () => {} });
    expect(uv.platforms).toEqual(["aarch64-manylinux2014", "aarch64-manylinux_2_28"]);
  });

  test("fails with uv's output when every platform fails", async () => {
    const uv = fakeUv({ failOn: [...PLATFORM_CANDIDATES] });
    await expect(
      packagePythonCodeZip({ codeDir, runtimeVersion: "PYTHON_3_14", buildDir, run: uv.run, checkTool: async () => {} }),
    ).rejects.toThrow(/no wheels with a matching platform/);
    expect(uv.platforms).toEqual([...PLATFORM_CANDIDATES]);
  });

  test("rethrows a uv failure that is not a platform problem", async () => {
    const uv = fakeUv({ failOn: ["aarch64-manylinux2014"], output: "error: Failed to parse pyproject.toml" });
    await expect(
      packagePythonCodeZip({ codeDir, runtimeVersion: "PYTHON_3_14", buildDir, run: uv.run, checkTool: async () => {} }),
    ).rejects.toThrow(/Failed to parse pyproject.toml/);
    expect(uv.platforms).toEqual(["aarch64-manylinux2014"]);
  });

  test("regenerates the opentelemetry console scripts when the package is installed", async () => {
    const uv = fakeUv({ withOtel: true });
    const result = await packagePythonCodeZip({ codeDir, runtimeVersion: "PYTHON_3_14", buildDir, run: uv.run, checkTool: async () => {} });
    const zip = unzipSync(new Uint8Array(await readFile(result.zipPath)));
    const instrument = new TextDecoder().decode(zip["bin/opentelemetry-instrument"]!);
    expect(instrument.startsWith("#!/usr/bin/env python3\n")).toBe(true);
    expect(instrument).toContain("from opentelemetry.instrumentation.auto_instrumentation import run");
    expect(new TextDecoder().decode(zip["bin/opentelemetry-bootstrap"]!)).toContain("from opentelemetry.instrumentation.bootstrap import run");
  });

  test("produces the same sha256 for the same inputs", async () => {
    const a = await packagePythonCodeZip({ codeDir, runtimeVersion: "PYTHON_3_14", buildDir, run: fakeUv().run, checkTool: async () => {} });
    await new Promise((r) => setTimeout(r, 1100)); // a second later, mtimes differ on disk
    const b = await packagePythonCodeZip({ codeDir, runtimeVersion: "PYTHON_3_14", buildDir, run: fakeUv().run, checkTool: async () => {} });
    expect(b.sha256).toBe(a.sha256);
  });

  test("requires uv before running anything", async () => {
    const uv = fakeUv();
    await expect(
      packagePythonCodeZip({
        codeDir, runtimeVersion: "PYTHON_3_14", buildDir, run: uv.run,
        checkTool: async () => { throw new Error("'uv' was not found on your PATH"); },
      }),
    ).rejects.toThrow(/uv/);
    expect(uv.platforms).toEqual([]);
    expect(existsSync(join(buildDir, "code.zip"))).toBe(false);
  });

  test("refuses a code directory without pyproject.toml", async () => {
    await rm(join(codeDir, "pyproject.toml"));
    await expect(
      packagePythonCodeZip({ codeDir, runtimeVersion: "PYTHON_3_14", buildDir, run: fakeUv().run, checkTool: async () => {} }),
    ).rejects.toThrow(/pyproject.toml/);
  });
});
```

Run: `bun test src/core/project/backends/imperative/packaging/python.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the packager**

`python.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { ProjectStateError } from "../../../../../errors";
import { ProcessFailedError, requireTool, type ProcessRunner } from "../../../../../io/exec";

export type PackageInput = { /* as in Interfaces */ };
export type PackagedCode = { zipPath: string; sizeBytes: number; sha256: string };
export type CodeZipPackager = (input: PackageInput) => Promise<PackagedCode>;

export const UV_INSTALL_HINT = "Install uv: https://docs.astral.sh/uv/getting-started/installation/";
/** Same order as the L3 packager: oldest glibc first so the widest wheel set wins. */
export const PLATFORM_CANDIDATES = ["aarch64-manylinux2014", "aarch64-manylinux_2_28", "aarch64-manylinux_2_34"] as const;
export const EXCLUDED_ENTRIES: ReadonlySet<string> = new Set([".git", ".venv", "__pycache__", ".pytest_cache", ".DS_Store", "node_modules"]);
export const MAX_ZIP_SIZE_BYTES = 250 * 1024 * 1024;
const ZIP_MTIME = new Date("1980-01-02T00:00:00Z");
const UNAVAILABLE_PLATFORM = /platforms:\s*[^\n]*manylinux|no wheels with a matching platform|Python ABI tag|no compatible wheels|no usable wheels/i;

const CONSOLE_SCRIPTS: Record<string, { module: string; func: string }> = {
  "opentelemetry-instrument": { module: "opentelemetry.instrumentation.auto_instrumentation", func: "run" },
  "opentelemetry-bootstrap": { module: "opentelemetry.instrumentation.bootstrap", func: "run" },
};

function pythonVersionOf(runtimeVersion: string): string {
  const match = /^PYTHON_(\d+)_(\d+)$/.exec(runtimeVersion);
  if (!match) throw new ProjectStateError(`'${runtimeVersion}' is not a Python runtime version`);
  return `${match[1]}.${match[2]}`;
}

function consoleScript(module: string, func: string): string {
  return [
    "#!/usr/bin/env python3",
    "import re",
    "import sys",
    `from ${module} import ${func}`,
    "if __name__ == '__main__':",
    "    sys.argv[0] = re.sub(r'(-script\\.pyw|\\.exe)?$', '', sys.argv[0])",
    `    sys.exit(${func}())`,
    "",
  ].join("\n");
}

async function installDependencies(input: PackageInput, staging: string, report: (line: string) => void): Promise<string> {
  const pyproject = join(input.codeDir, "pyproject.toml");
  if (!existsSync(pyproject)) {
    throw new ProjectStateError(`${input.codeDir} has no pyproject.toml; CodeZip runtimes declare their dependencies there.`);
  }
  const pythonVersion = pythonVersionOf(input.runtimeVersion);
  let lastError: ProcessFailedError | undefined;
  for (const platform of PLATFORM_CANDIDATES) {
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    report(`Installing dependencies for ${platform} (python ${pythonVersion})`);
    try {
      await input.run(
        ["uv", "pip", "install", "-r", pyproject, "--target", staging, "--python-version", pythonVersion, "--python-platform", platform, "--only-binary", ":all:"],
        { cwd: input.codeDir, signal: input.signal, onOutput: (chunk) => chunk.split(/\r?\n/).filter(Boolean).forEach(report) },
      );
      return platform;
    } catch (error) {
      if (error instanceof ProcessFailedError && UNAVAILABLE_PLATFORM.test(error.message)) {
        lastError = error;
        report(`No compatible wheels for ${platform}; trying the next platform`);
        continue;
      }
      throw error;
    }
  }
  throw new ProjectStateError(
    `Could not install dependencies for any supported platform (${PLATFORM_CANDIDATES.join(", ")}).\n\n${lastError?.message ?? ""}`,
  );
}

async function copySource(codeDir: string, staging: string): Promise<void> {
  await cp(codeDir, staging, {
    recursive: true,
    force: true,
    filter: (source) => {
      const rel = relative(codeDir, source);
      if (rel === "") return true;
      return !rel.split(sep).some((part) => EXCLUDED_ENTRIES.has(part));
    },
  });
}

async function regenerateConsoleScripts(staging: string): Promise<void> {
  const bin = join(staging, "bin");
  for (const [name, { module, func }] of Object.entries(CONSOLE_SCRIPTS)) {
    if (!existsSync(join(staging, ...module.split(".")))) continue;
    await mkdir(bin, { recursive: true });
    const path = join(bin, name);
    await writeFile(path, consoleScript(module, func));
    await chmod(path, 0o755);
  }
}

async function collectFiles(dir: string, base = dir): Promise<{ path: string; bytes: Uint8Array; executable: boolean }[]> {
  const out: { path: string; bytes: Uint8Array; executable: boolean }[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (EXCLUDED_ENTRIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectFiles(full, base)));
    else if (entry.isFile()) {
      const mode = (await stat(full)).mode;
      out.push({ path: relative(base, full).split(sep).join("/"), bytes: new Uint8Array(await readFile(full)), executable: (mode & 0o111) !== 0 });
    }
  }
  return out;
}

export const packagePythonCodeZip: CodeZipPackager = async (input) => {
  const report = input.report ?? (() => {});
  await (input.checkTool ?? requireTool)("uv", UV_INSTALL_HINT);
  const staging = join(input.buildDir, "staging");
  await installDependencies(input, staging, report);
  report("Copying source");
  await copySource(input.codeDir, staging);
  await regenerateConsoleScripts(staging);
  report("Zipping");
  const files = await collectFiles(staging);
  const zippable: Zippable = {};
  for (const file of files) {
    // os 3 = Unix, so the high 16 bits of attrs are the st_mode the runtime unpacks.
    const mode = file.executable ? 0o100755 : 0o100644;
    zippable[file.path] = [file.bytes, { level: 6, mtime: ZIP_MTIME, os: 3, attrs: (mode << 16) >>> 0 }];
  }
  const zip = zipSync(zippable, { level: 6, mtime: ZIP_MTIME });
  if (zip.byteLength > MAX_ZIP_SIZE_BYTES) {
    throw new ProjectStateError(
      `The packaged code is ${(zip.byteLength / 1024 / 1024).toFixed(1)} MiB; CodeZip runtimes are limited to 250 MiB. Trim dependencies or switch the runtime to a Container build.`,
    );
  }
  const zipPath = join(input.buildDir, "code.zip");
  await writeFile(zipPath, zip);
  return { zipPath, sizeBytes: zip.byteLength, sha256: createHash("sha256").update(zip).digest("hex") };
};
```

Check `node_modules/fflate/lib/index.d.ts` for the exact `ZipAttributes` field names (`os`, `attrs`, `mtime`, `level`) and adjust. If `attrs` is not supported by the installed version, drop `os`/`attrs` and keep `level` + `mtime` (that is what L3 ships).

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/project/backends/imperative/packaging/python.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/project/backends/imperative/packaging/
git commit -m "feat(imperative): package Python CodeZip runtimes the way the L3 construct does"
```

---

### Task 3: Fake SDK client for tests, and the artifact bucket

**Files:**

- Create: `src/core/project/backends/imperative/testing.ts`
- Create: `src/core/project/backends/imperative/artifacts.ts`
- Test: `src/core/project/backends/imperative/artifacts.test.ts`

**Interfaces:**

- Produces (`testing.ts`, shared by Tasks 3 to 7):

```ts
export type SentCommand = { name: string; input: Record<string, unknown> };
export type FakeClient = { send(command: unknown): Promise<unknown>; sent: SentCommand[] };
/** `handlers` is keyed by command class name, e.g. "GetMemoryCommand"; a handler may throw. */
export function fakeClient(handlers: Record<string, (input: any) => unknown>): FakeClient;
/** An SDK-shaped error: `name` and `$metadata.httpStatusCode` set. */
export function sdkError(name: string, httpStatusCode: number, message?: string): Error;
export const notFound: (message?: string) => Error; // sdkError("ResourceNotFoundException", 404, message)
```

- Produces (`artifacts.ts`):

```ts
export type CodeArtifact = { bucket: string; key: string; sha256: string; sizeBytes: number };
export function artifactBucketName(account: string, region: string): string;
export function artifactKey(scope: NamingScope, runtimeName: string, sha256: string): string;
export async function ensureArtifactBucket(s3: S3Client, input: { bucket: string; region: string; tags: Record<string, string> }): Promise<{ created: boolean }>;
export async function uploadArtifact(s3: S3Client, input: { bucket: string; key: string; zipPath: string }): Promise<{ uploaded: boolean }>;
```

- [ ] **Step 1: Write the fake client**

`testing.ts`:

```ts
export type SentCommand = { name: string; input: Record<string, unknown> };
export type FakeClient = { send(command: unknown): Promise<unknown>; sent: SentCommand[] };

/** Routes `send(command)` by the command's class name; unknown commands throw. */
export function fakeClient(handlers: Record<string, (input: any) => unknown>): FakeClient {
  const sent: SentCommand[] = [];
  return {
    sent,
    async send(command: unknown) {
      const name = (command as object).constructor.name;
      const input = ((command as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
      sent.push({ name, input });
      const handler = handlers[name];
      if (!handler) throw new Error(`fake client has no handler for ${name}`);
      return handler(input);
    },
  };
}

export function sdkError(name: string, httpStatusCode: number, message = name): Error {
  const error = new Error(message);
  error.name = name;
  Object.assign(error, { $metadata: { httpStatusCode } });
  return error;
}

export const notFound = (message?: string) => sdkError("ResourceNotFoundException", 404, message);
```

Every kind test casts: `fakeClient({...}) as unknown as BedrockAgentCoreControlClient`.

- [ ] **Step 2: Write the failing artifact tests**

`artifacts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { artifactBucketName, artifactKey, ensureArtifactBucket, uploadArtifact } from "./artifacts";
import { fakeClient, sdkError } from "./testing";

const scope = { projectName: "orders", targetName: "staging" };
const s3 = (handlers: Parameters<typeof fakeClient>[0]) => {
  const client = fakeClient(handlers);
  return { client: client as unknown as S3Client, sent: client.sent };
};

describe("names", () => {
  test("bucket is per account and region", () => {
    expect(artifactBucketName("111122223333", "us-west-2")).toBe("agentcore-cli-111122223333-us-west-2");
  });
  test("key is project/target/runtime/sha.zip", () => {
    expect(artifactKey(scope, "agent", "abc123")).toBe("orders/staging/agent/abc123.zip");
  });
});

describe("ensureArtifactBucket", () => {
  const input = { bucket: "agentcore-cli-111122223333-us-west-2", region: "us-west-2", tags: { "agentcore:managed-by": "imperative" } };

  test("does nothing when the bucket exists", async () => {
    const { client, sent } = s3({ HeadBucketCommand: () => ({}) });
    expect(await ensureArtifactBucket(client, input)).toEqual({ created: false });
    expect(sent.map((c) => c.name)).toEqual(["HeadBucketCommand"]);
  });

  test("creates, blocks public access and tags a missing bucket", async () => {
    const { client, sent } = s3({
      HeadBucketCommand: () => { throw sdkError("NotFound", 404); },
      CreateBucketCommand: () => ({}),
      PutPublicAccessBlockCommand: () => ({}),
      PutBucketTaggingCommand: () => ({}),
    });
    expect(await ensureArtifactBucket(client, input)).toEqual({ created: true });
    expect(sent.map((c) => c.name)).toEqual(["HeadBucketCommand", "CreateBucketCommand", "PutPublicAccessBlockCommand", "PutBucketTaggingCommand"]);
    expect(sent[1]!.input).toEqual({ Bucket: input.bucket, CreateBucketConfiguration: { LocationConstraint: "us-west-2" } });
    expect(sent[2]!.input).toEqual({
      Bucket: input.bucket,
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
    });
    expect(sent[3]!.input).toEqual({ Bucket: input.bucket, Tagging: { TagSet: [{ Key: "agentcore:managed-by", Value: "imperative" }] } });
  });

  test("omits the location constraint in us-east-1", async () => {
    const { client, sent } = s3({
      HeadBucketCommand: () => { throw sdkError("NotFound", 404); },
      CreateBucketCommand: () => ({}), PutPublicAccessBlockCommand: () => ({}), PutBucketTaggingCommand: () => ({}),
    });
    await ensureArtifactBucket(client, { ...input, bucket: "agentcore-cli-111122223333-us-east-1", region: "us-east-1" });
    expect(sent[1]!.input).toEqual({ Bucket: "agentcore-cli-111122223333-us-east-1" });
  });

  test("treats BucketAlreadyOwnedByYou as created", async () => {
    const { client } = s3({
      HeadBucketCommand: () => { throw sdkError("NotFound", 404); },
      CreateBucketCommand: () => { throw sdkError("BucketAlreadyOwnedByYou", 409); },
      PutPublicAccessBlockCommand: () => ({}), PutBucketTaggingCommand: () => ({}),
    });
    expect(await ensureArtifactBucket(client, input)).toEqual({ created: true });
  });

  test("a bucket owned by another account fails with guidance", async () => {
    const { client, sent } = s3({
      HeadBucketCommand: () => { throw sdkError("NotFound", 404); },
      CreateBucketCommand: () => { throw sdkError("BucketAlreadyExists", 409); },
    });
    await expect(ensureArtifactBucket(client, input)).rejects.toThrow(/agentcore-cli-111122223333-us-west-2.*another AWS account/);
    expect(sent.map((c) => c.name)).not.toContain("PutPublicAccessBlockCommand");
  });

  test("a forbidden HeadBucket fails with guidance", async () => {
    const { client } = s3({ HeadBucketCommand: () => { throw sdkError("Forbidden", 403); } });
    await expect(ensureArtifactBucket(client, input)).rejects.toThrow(/not accessible/);
  });
});

describe("uploadArtifact", () => {
  test("skips an object that already exists", async () => {
    const { client, sent } = s3({ HeadObjectCommand: () => ({}) });
    expect(await uploadArtifact(client, { bucket: "b", key: "k", zipPath: "/nowhere.zip" })).toEqual({ uploaded: false });
    expect(sent.map((c) => c.name)).toEqual(["HeadObjectCommand"]);
  });

  test("uploads a missing object with its bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-"));
    const zipPath = join(dir, "code.zip");
    await writeFile(zipPath, "PK-bytes");
    const { client, sent } = s3({
      HeadObjectCommand: () => { throw sdkError("NotFound", 404); },
      PutObjectCommand: () => ({}),
    });
    expect(await uploadArtifact(client, { bucket: "b", key: "k", zipPath })).toEqual({ uploaded: true });
    const put = sent[1]!.input;
    expect(put.Bucket).toBe("b");
    expect(put.Key).toBe("k");
    expect(put.ContentType).toBe("application/zip");
    expect(Buffer.from(put.Body as Uint8Array).toString()).toBe("PK-bytes");
  });
});
```

Run: `bun test src/core/project/backends/imperative/artifacts.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`artifacts.ts`:

```ts
import { readFile } from "node:fs/promises";
import {
  CreateBucketCommand, HeadBucketCommand, HeadObjectCommand, PutBucketTaggingCommand,
  PutObjectCommand, PutPublicAccessBlockCommand, type S3Client,
} from "@aws-sdk/client-s3";
import { ProjectStateError } from "../../../../errors";
import type { NamingScope } from "./naming";

/** Where a runtime's code lives in S3 after staging; the runtime step reads this off the stack. */
export type CodeArtifact = { bucket: string; key: string; sha256: string; sizeBytes: number };

export function artifactBucketName(account: string, region: string): string {
  return `agentcore-cli-${account}-${region}`;
}

/** Content-addressed, so re-deploying unchanged code re-uses the object and a changed sha is a new key. */
export function artifactKey(scope: NamingScope, runtimeName: string, sha256: string): string {
  return `${scope.projectName}/${scope.targetName}/${runtimeName}/${sha256}.zip`;
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}
function nameOf(error: unknown): string | undefined {
  return (error as { name?: string })?.name;
}
const isMissing = (error: unknown) =>
  statusOf(error) === 404 || ["NotFound", "NoSuchBucket", "NoSuchKey"].includes(nameOf(error) ?? "");

export async function ensureArtifactBucket(
  s3: S3Client,
  { bucket, region, tags }: { bucket: string; region: string; tags: Record<string, string> },
): Promise<{ created: boolean }> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return { created: false };
  } catch (error) {
    if (statusOf(error) === 403 || nameOf(error) === "Forbidden") {
      throw new ProjectStateError(
        `The artifact bucket '${bucket}' exists but is not accessible with the current credentials. ` +
          `It may belong to another AWS account; delete or rename it, or grant this principal s3:ListBucket on it.`,
      );
    }
    if (!isMissing(error)) throw error;
  }
  try {
    await s3.send(new CreateBucketCommand({
      Bucket: bucket,
      ...(region !== "us-east-1" && { CreateBucketConfiguration: { LocationConstraint: region as never } }),
    }));
  } catch (error) {
    if (nameOf(error) === "BucketAlreadyExists") {
      throw new ProjectStateError(
        `The artifact bucket name '${bucket}' is already taken by another AWS account. ` +
          `Bucket names are global; this one is derived from the account and region and cannot be changed yet.`,
      );
    }
    if (nameOf(error) !== "BucketAlreadyOwnedByYou") throw error;
  }
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
  }));
  await s3.send(new PutBucketTaggingCommand({
    Bucket: bucket,
    Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) },
  }));
  return { created: true };
}

export async function uploadArtifact(
  s3: S3Client,
  { bucket, key, zipPath }: { bucket: string; key: string; zipPath: string },
): Promise<{ uploaded: boolean }> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { uploaded: false };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const body = await readFile(zipPath);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/zip", ContentLength: body.byteLength }));
  return { uploaded: true };
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/project/backends/imperative/artifacts.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/project/backends/imperative/testing.ts src/core/project/backends/imperative/artifacts.ts src/core/project/backends/imperative/artifacts.test.ts
git commit -m "feat(imperative): per-account artifact bucket and content-addressed CodeZip uploads"
```

---

### Task 4: Execution roles

**Files:**

- Create: `src/core/project/backends/imperative/iam.ts`
- Test: `src/core/project/backends/imperative/iam.test.ts`

**Interfaces:**

- Consumes: `physicalName`, `ownsResource`, `NamingScope`, `ResourceKind` from `./naming`; `ProjectStateError` from `src/errors`; `fakeClient`, `sdkError` from `./testing`.
- Produces:

```ts
export function partitionFor(region: string): string; // us-gov-* → aws-us-gov, cn-* → aws-cn, else aws
export function executionRoleName(scope: NamingScope, kind: ResourceKind, name: string): string;
export function roleArn(partition: string, account: string, roleName: string): string; // arn:<p>:iam::<acct>:role/<name>
export function trustPolicy(): string;
export type RoleSpec = {
  roleName: string;
  description: string;
  tags: Record<string, string>;
  /** Inline policy name → JSON document. */
  inlinePolicies: Record<string, string>;
  managedPolicyArns: string[];
};
export async function ensureRole(iam: IAMClient, scope: NamingScope, spec: RoleSpec): Promise<{ arn: string; created: boolean }>;
/** undefined when the live role matches `spec`; otherwise one line saying what differs. Read-only. */
export async function roleDrift(iam: IAMClient, scope: NamingScope, spec: RoleSpec): Promise<string | undefined>;
/** Deletes the role only if it carries this scope's ownership tags. Missing role is a no-op. */
export async function deleteRole(iam: IAMClient, scope: NamingScope, roleName: string): Promise<void>;
export function runtimeExecutionPolicy(input: { partition: string; region: string; account: string; memoryArns: string[] }): string;
export async function loadAdditionalPolicies(entries: string[] | undefined, codeDir: string): Promise<{ managedPolicyArns: string[]; inlinePolicies: Record<string, string> }>;
export async function withRolePropagationRetry<T>(fn: () => Promise<T>, options?: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<T>;
export const RUNTIME_POLICY_NAME = "AgentCoreRuntimeExecutionPolicy";
```

- [ ] **Step 1: Read the L3 runtime policy**

Read `/Users/gitikavj/node_modules/@aws/agentcore-cdk/dist/lib/runtime/runtime.js` (or the file that grants the runtime role) and copy the statement list below against it. Deviation kept on purpose: memory `ListMemoryRecords`/`RetrieveMemoryRecords` are granted on the memory ARN without namespace conditions (L3 adds `StringLike` conditions per namespace; this phase grants the whole memory to its own runtime).

- [ ] **Step 2: Write the failing tests**

`iam.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAMClient } from "@aws-sdk/client-iam";
import {
  deleteRole, ensureRole, executionRoleName, loadAdditionalPolicies, partitionFor, roleArn, roleDrift,
  runtimeExecutionPolicy, trustPolicy, withRolePropagationRetry, RUNTIME_POLICY_NAME,
} from "./iam";
import { ownershipTags } from "./naming";
import { fakeClient, sdkError } from "./testing";

const scope = { projectName: "orders", targetName: "staging" };
const tags = ownershipTags(scope);
const iamTags = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
const iam = (handlers: Parameters<typeof fakeClient>[0]) => {
  const client = fakeClient(handlers);
  return { client: client as unknown as IAMClient, sent: client.sent };
};
const spec = {
  roleName: "orders_staging_agent_runtime_role",
  description: "Execution role for runtime agent",
  tags,
  inlinePolicies: { [RUNTIME_POLICY_NAME]: '{"Version":"2012-10-17","Statement":[]}' },
  managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
};
const liveRole = { Role: { Arn: "arn:aws:iam::111122223333:role/orders_staging_agent_runtime_role", RoleName: spec.roleName, Tags: iamTags } };

describe("names", () => {
  test("partitionFor", () => {
    expect(partitionFor("us-west-2")).toBe("aws");
    expect(partitionFor("us-gov-west-1")).toBe("aws-us-gov");
    expect(partitionFor("cn-north-1")).toBe("aws-cn");
  });
  test("executionRoleName keeps the kind suffix and fits 64 chars", () => {
    expect(executionRoleName(scope, "runtime", "agent")).toBe("orders_staging_agent_runtime_role");
    const long = executionRoleName({ projectName: "p".repeat(40), targetName: "t".repeat(20) }, "memory", "m".repeat(30));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("_memory_role")).toBe(true);
  });
  test("roleArn", () => {
    expect(roleArn("aws", "111122223333", "r")).toBe("arn:aws:iam::111122223333:role/r");
  });
  test("trust policy names the AgentCore service", () => {
    expect(JSON.parse(trustPolicy()).Statement[0].Principal.Service).toBe("bedrock-agentcore.amazonaws.com");
  });
});

describe("ensureRole", () => {
  test("creates a missing role with tags, then puts inline and attaches managed policies", async () => {
    const { client, sent } = iam({
      GetRoleCommand: () => { throw sdkError("NoSuchEntityException", 404); },
      CreateRoleCommand: (input) => ({ Role: { Arn: liveRole.Role.Arn, RoleName: input.RoleName } }),
      PutRolePolicyCommand: () => ({}),
      ListRolePoliciesCommand: () => ({ PolicyNames: [] }),
      ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
      AttachRolePolicyCommand: () => ({}),
    });
    expect(await ensureRole(client, scope, spec)).toEqual({ arn: liveRole.Role.Arn, created: true });
    const create = sent.find((c) => c.name === "CreateRoleCommand")!.input;
    expect(create.RoleName).toBe(spec.roleName);
    expect(create.Tags).toEqual(iamTags);
    expect(JSON.parse(create.AssumeRolePolicyDocument as string).Statement[0].Principal.Service).toBe("bedrock-agentcore.amazonaws.com");
    expect(sent.find((c) => c.name === "PutRolePolicyCommand")!.input).toEqual({
      RoleName: spec.roleName, PolicyName: RUNTIME_POLICY_NAME, PolicyDocument: spec.inlinePolicies[RUNTIME_POLICY_NAME],
    });
    expect(sent.find((c) => c.name === "AttachRolePolicyCommand")!.input).toEqual({ RoleName: spec.roleName, PolicyArn: spec.managedPolicyArns[0] });
  });

  test("reconciles an owned role: rewrites inline policies, drops extras, detaches stale managed policies", async () => {
    const { client, sent } = iam({
      GetRoleCommand: () => liveRole,
      PutRolePolicyCommand: () => ({}),
      ListRolePoliciesCommand: () => ({ PolicyNames: [RUNTIME_POLICY_NAME, "Stale"] }),
      DeleteRolePolicyCommand: () => ({}),
      ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [{ PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }] }),
      AttachRolePolicyCommand: () => ({}),
      DetachRolePolicyCommand: () => ({}),
    });
    expect(await ensureRole(client, scope, spec)).toEqual({ arn: liveRole.Role.Arn, created: false });
    expect(sent.map((c) => c.name)).not.toContain("CreateRoleCommand");
    expect(sent.find((c) => c.name === "DeleteRolePolicyCommand")!.input).toEqual({ RoleName: spec.roleName, PolicyName: "Stale" });
    expect(sent.find((c) => c.name === "DetachRolePolicyCommand")!.input.PolicyArn).toBe("arn:aws:iam::aws:policy/AdministratorAccess");
    expect(sent.find((c) => c.name === "AttachRolePolicyCommand")!.input.PolicyArn).toBe(spec.managedPolicyArns[0]);
  });

  test("refuses a role that carries no ownership tags", async () => {
    const { client, sent } = iam({ GetRoleCommand: () => ({ Role: { ...liveRole.Role, Tags: [] } }) });
    await expect(ensureRole(client, scope, spec)).rejects.toThrow(/orders_staging_agent_runtime_role.*not created by project 'orders'/);
    expect(sent.map((c) => c.name)).toEqual(["GetRoleCommand"]);
  });
});

describe("roleDrift", () => {
  const inSync = {
    GetRoleCommand: () => liveRole,
    GetRolePolicyCommand: () => ({ PolicyDocument: encodeURIComponent('{"Version":"2012-10-17","Statement":[]}') }),
    ListRolePoliciesCommand: () => ({ PolicyNames: [RUNTIME_POLICY_NAME] }),
    ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [{ PolicyArn: spec.managedPolicyArns[0] }] }),
  };
  test("is undefined when the role matches", async () => {
    expect(await roleDrift(iam(inSync).client, scope, spec)).toBeUndefined();
  });
  test("reports a missing role", async () => {
    expect(await roleDrift(iam({ ...inSync, GetRoleCommand: () => { throw sdkError("NoSuchEntityException", 404); } }).client, scope, spec)).toMatch(/does not exist/);
  });
  test("reports a changed inline policy, ignoring key order and encoding", async () => {
    const drift = await roleDrift(iam({ ...inSync, GetRolePolicyCommand: () => ({ PolicyDocument: encodeURIComponent('{"Statement":[{"Effect":"Deny"}],"Version":"2012-10-17"}') }) }).client, scope, spec);
    expect(drift).toMatch(new RegExp(`${RUNTIME_POLICY_NAME}.*differs`));
  });
  test("reports a managed policy set change", async () => {
    const drift = await roleDrift(iam({ ...inSync, ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }) }).client, scope, spec);
    expect(drift).toMatch(/managed polic/);
  });
});

describe("deleteRole", () => {
  test("deletes an owned role after removing its policies", async () => {
    const { client, sent } = iam({
      GetRoleCommand: () => liveRole,
      ListRolePoliciesCommand: () => ({ PolicyNames: [RUNTIME_POLICY_NAME] }),
      DeleteRolePolicyCommand: () => ({}),
      ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [{ PolicyArn: spec.managedPolicyArns[0] }] }),
      DetachRolePolicyCommand: () => ({}),
      DeleteRoleCommand: () => ({}),
    });
    await deleteRole(client, scope, spec.roleName);
    expect(sent.map((c) => c.name)).toEqual([
      "GetRoleCommand", "ListRolePoliciesCommand", "DeleteRolePolicyCommand", "ListAttachedRolePoliciesCommand", "DetachRolePolicyCommand", "DeleteRoleCommand",
    ]);
  });
  test("leaves a role it does not own", async () => {
    const { client, sent } = iam({ GetRoleCommand: () => ({ Role: { ...liveRole.Role, Tags: [] } }) });
    await deleteRole(client, scope, spec.roleName);
    expect(sent.map((c) => c.name)).toEqual(["GetRoleCommand"]);
  });
  test("a missing role is a no-op", async () => {
    const { client } = iam({ GetRoleCommand: () => { throw sdkError("NoSuchEntityException", 404); } });
    await deleteRole(client, scope, spec.roleName);
  });
});

describe("runtimeExecutionPolicy", () => {
  const doc = JSON.parse(runtimeExecutionPolicy({ partition: "aws", region: "us-west-2", account: "111122223333", memoryArns: ["arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/m-1"] }));
  const bySid = (sid: string) => doc.Statement.find((s: { Sid: string }) => s.Sid === sid);
  test("grants model invocation on foundation models and inference profiles", () => {
    expect(bySid("BedrockModelInvocation").Resource).toEqual(["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:*:111122223333:inference-profile/*"]);
    expect(bySid("BedrockModelInvocation").Action).toContain("bedrock:InvokeModelWithResponseStream");
  });
  test("grants logs on the runtime log groups", () => {
    expect(bySid("CloudWatchLogs").Resource).toEqual(["arn:aws:logs:us-west-2:111122223333:log-group:/aws/bedrock-agentcore/runtimes/*"]);
  });
  test("grants X-Ray and DescribeLogGroups on *", () => {
    expect(bySid("XRay").Resource).toBe("*");
    expect(bySid("DescribeLogGroups").Resource).toBe("*");
  });
  test("grants memory read, write and retrieval on each memory", () => {
    expect(bySid("MemoryAccess").Resource).toEqual(["arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/m-1"]);
    expect(bySid("MemoryAccess").Action).toEqual(expect.arrayContaining(["bedrock-agentcore:CreateEvent", "bedrock-agentcore:GetMemory", "bedrock-agentcore:RetrieveMemoryRecords", "bedrock-agentcore:ListMemoryRecords"]));
  });
  test("omits the memory statement when there are no memories", () => {
    const none = JSON.parse(runtimeExecutionPolicy({ partition: "aws", region: "us-west-2", account: "111122223333", memoryArns: [] }));
    expect(none.Statement.find((s: { Sid: string }) => s.Sid === "MemoryAccess")).toBeUndefined();
  });
});

describe("loadAdditionalPolicies", () => {
  test("splits ARNs from JSON files relative to the code directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "policies-"));
    await writeFile(join(dir, "extra.json"), '{"Version":"2012-10-17","Statement":[]}');
    const result = await loadAdditionalPolicies(["arn:aws:iam::aws:policy/ReadOnlyAccess", "extra.json"], dir);
    expect(result.managedPolicyArns).toEqual(["arn:aws:iam::aws:policy/ReadOnlyAccess"]);
    expect(result.inlinePolicies).toEqual({ Additional1: '{"Version":"2012-10-17","Statement":[]}' });
  });
  test("a missing file is a ProjectStateError naming the path", async () => {
    await expect(loadAdditionalPolicies(["nope.json"], "/tmp")).rejects.toThrow(/nope.json/);
  });
  test("undefined is empty", async () => {
    expect(await loadAdditionalPolicies(undefined, "/tmp")).toEqual({ managedPolicyArns: [], inlinePolicies: {} });
  });
});

describe("withRolePropagationRetry", () => {
  test("retries a role-assumption validation error, then succeeds", async () => {
    let calls = 0;
    const slept: number[] = [];
    const result = await withRolePropagationRetry(async () => {
      calls++;
      if (calls < 3) throw sdkError("ValidationException", 400, "Role arn:aws:iam::1:role/x cannot be assumed by bedrock-agentcore");
      return "ok";
    }, { sleep: async (ms) => { slept.push(ms); }, delayMs: 5000 });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(slept).toEqual([5000, 5000]);
  });
  test("does not retry other errors", async () => {
    let calls = 0;
    await expect(withRolePropagationRetry(async () => { calls++; throw sdkError("ConflictException", 409); }, { sleep: async () => {} })).rejects.toThrow(/ConflictException/);
    expect(calls).toBe(1);
  });
  test("gives up after the attempt budget", async () => {
    let calls = 0;
    await expect(withRolePropagationRetry(async () => { calls++; throw sdkError("AccessDeniedException", 403, "not authorized to assume role"); }, { attempts: 3, sleep: async () => {} })).rejects.toThrow(/assume role/);
    expect(calls).toBe(3);
  });
});
```

Run: `bun test src/core/project/backends/imperative/iam.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`iam.ts`:

```ts
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  AttachRolePolicyCommand, CreateRoleCommand, DeleteRoleCommand, DeleteRolePolicyCommand, DetachRolePolicyCommand,
  GetRoleCommand, GetRolePolicyCommand, ListAttachedRolePoliciesCommand, ListRolePoliciesCommand, PutRolePolicyCommand,
  type IAMClient, type Tag,
} from "@aws-sdk/client-iam";
import { ProjectStateError } from "../../../../errors";
import { ownsResource, physicalName, type NamingScope, type ResourceKind } from "./naming";

export const RUNTIME_POLICY_NAME = "AgentCoreRuntimeExecutionPolicy";
const SERVICE_PRINCIPAL = "bedrock-agentcore.amazonaws.com";
const ROLE_NAME_MAX = 64;

export function partitionFor(region: string): string {
  if (region.startsWith("us-gov-")) return "aws-us-gov";
  if (region.startsWith("cn-")) return "aws-cn";
  return "aws";
}

export function executionRoleName(scope: NamingScope, kind: ResourceKind, name: string): string {
  const suffix = `_${kind}_role`;
  return `${physicalName(scope, kind, name, ROLE_NAME_MAX - suffix.length)}${suffix}`;
}

export function roleArn(partition: string, account: string, roleName: string): string {
  return `arn:${partition}:iam::${account}:role/${roleName}`;
}

export function trustPolicy(): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: SERVICE_PRINCIPAL }, Action: "sts:AssumeRole" }],
  });
}

export type RoleSpec = { roleName: string; description: string; tags: Record<string, string>; inlinePolicies: Record<string, string>; managedPolicyArns: string[] };

const isNoSuchEntity = (error: unknown) => (error as { name?: string })?.name === "NoSuchEntityException";
const tagsOf = (tags: Tag[] | undefined) => Object.fromEntries((tags ?? []).map((t) => [t.Key ?? "", t.Value]));

async function getRole(iam: IAMClient, roleName: string) {
  try {
    return (await iam.send(new GetRoleCommand({ RoleName: roleName }))).Role;
  } catch (error) {
    if (isNoSuchEntity(error)) return undefined;
    throw error;
  }
}

async function listInline(iam: IAMClient, roleName: string): Promise<string[]> {
  const names: string[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.send(new ListRolePoliciesCommand({ RoleName: roleName, Marker: marker }));
    names.push(...(page.PolicyNames ?? []));
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return names;
}

async function listAttached(iam: IAMClient, roleName: string): Promise<string[]> {
  const arns: string[] = [];
  let marker: string | undefined;
  do {
    const page = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName, Marker: marker }));
    arns.push(...(page.AttachedPolicies ?? []).flatMap((p) => (p.PolicyArn ? [p.PolicyArn] : [])));
    marker = page.IsTruncated ? page.Marker : undefined;
  } while (marker);
  return arns;
}

function assertOwned(scope: NamingScope, roleName: string, tags: Tag[] | undefined): void {
  if (ownsResource(scope, tagsOf(tags))) return;
  throw new ProjectStateError(
    `IAM role '${roleName}' already exists but was not created by project '${scope.projectName}' for target ` +
      `'${scope.targetName}' (its tags do not match). Delete or rename it, or set executionRoleArn in agentcore.json to use it as is.`,
  );
}

export async function ensureRole(iam: IAMClient, scope: NamingScope, spec: RoleSpec): Promise<{ arn: string; created: boolean }> {
  let role = await getRole(iam, spec.roleName);
  let created = false;
  if (role) {
    assertOwned(scope, spec.roleName, role.Tags);
  } else {
    role = (await iam.send(new CreateRoleCommand({
      RoleName: spec.roleName,
      AssumeRolePolicyDocument: trustPolicy(),
      Description: spec.description,
      Tags: Object.entries(spec.tags).map(([Key, Value]) => ({ Key, Value })),
    }))).Role;
    created = true;
  }
  for (const [PolicyName, PolicyDocument] of Object.entries(spec.inlinePolicies)) {
    await iam.send(new PutRolePolicyCommand({ RoleName: spec.roleName, PolicyName, PolicyDocument }));
  }
  for (const name of await listInline(iam, spec.roleName)) {
    if (!(name in spec.inlinePolicies)) await iam.send(new DeleteRolePolicyCommand({ RoleName: spec.roleName, PolicyName: name }));
  }
  const attached = new Set(await listAttached(iam, spec.roleName));
  for (const arn of spec.managedPolicyArns) {
    if (!attached.has(arn)) await iam.send(new AttachRolePolicyCommand({ RoleName: spec.roleName, PolicyArn: arn }));
  }
  for (const arn of attached) {
    if (!spec.managedPolicyArns.includes(arn)) await iam.send(new DetachRolePolicyCommand({ RoleName: spec.roleName, PolicyArn: arn }));
  }
  return { arn: role!.Arn!, created };
}

function canonical(json: string): string {
  const sort = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(sort)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]))
      : value;
  return JSON.stringify(sort(JSON.parse(json)));
}

export async function roleDrift(iam: IAMClient, scope: NamingScope, spec: RoleSpec): Promise<string | undefined> {
  const role = await getRole(iam, spec.roleName);
  if (!role) return `role ${spec.roleName} does not exist`;
  assertOwned(scope, spec.roleName, role.Tags);
  const inline = new Set(await listInline(iam, spec.roleName));
  for (const [name, desired] of Object.entries(spec.inlinePolicies)) {
    if (!inline.has(name)) return `inline policy ${name} is missing`;
    const live = (await iam.send(new GetRolePolicyCommand({ RoleName: spec.roleName, PolicyName: name }))).PolicyDocument ?? "";
    if (canonical(decodeURIComponent(live)) !== canonical(desired)) return `inline policy ${name} differs`;
  }
  for (const name of inline) if (!(name in spec.inlinePolicies)) return `inline policy ${name} is not declared`;
  const attached = await listAttached(iam, spec.roleName);
  const want = [...spec.managedPolicyArns].sort();
  if (JSON.stringify([...attached].sort()) !== JSON.stringify(want)) return `managed policies differ`;
  return undefined;
}

export async function deleteRole(iam: IAMClient, scope: NamingScope, roleName: string): Promise<void> {
  const role = await getRole(iam, roleName);
  if (!role || !ownsResource(scope, tagsOf(role.Tags))) return;
  for (const name of await listInline(iam, roleName)) await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: name }));
  for (const arn of await listAttached(iam, roleName)) await iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: arn }));
  try {
    await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
  } catch (error) {
    if (!isNoSuchEntity(error)) throw error;
  }
}

export function runtimeExecutionPolicy({ partition, region, account, memoryArns }: { partition: string; region: string; account: string; memoryArns: string[] }): string {
  const statements: Record<string, unknown>[] = [
    { Sid: "BedrockModelInvocation", Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:CountTokens"],
      Resource: [`arn:${partition}:bedrock:*::foundation-model/*`, `arn:${partition}:bedrock:*:${account}:inference-profile/*`] },
    { Sid: "XRay", Effect: "Allow", Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"], Resource: "*" },
    { Sid: "DescribeLogGroups", Effect: "Allow", Action: ["logs:DescribeLogGroups"], Resource: "*" },
    { Sid: "CloudWatchLogs", Effect: "Allow",
      Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents", "logs:GetLogEvents", "logs:FilterLogEvents", "logs:PutResourcePolicy"],
      Resource: [`arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`] },
    { Sid: "ConfigurationBundles", Effect: "Allow",
      Action: ["bedrock-agentcore:GetConfigurationBundle", "bedrock-agentcore:ListConfigurationBundles", "bedrock-agentcore:CreateConfigurationBundle", "bedrock-agentcore:UpdateConfigurationBundle", "bedrock-agentcore:DeleteConfigurationBundle",
        "bedrock-agentcore:GetConfigurationBundleVersion", "bedrock-agentcore:ListConfigurationBundleVersions", "bedrock-agentcore:CreateConfigurationBundleVersion", "bedrock-agentcore:DeleteConfigurationBundleVersion"],
      Resource: [`arn:${partition}:bedrock-agentcore:*:*:configuration-bundle/*`] },
  ];
  if (memoryArns.length > 0) {
    statements.push({ Sid: "MemoryAccess", Effect: "Allow",
      Action: ["bedrock-agentcore:GetEvent", "bedrock-agentcore:GetMemory", "bedrock-agentcore:GetMemoryRecord", "bedrock-agentcore:ListActors", "bedrock-agentcore:ListEvents", "bedrock-agentcore:ListSessions",
        "bedrock-agentcore:CreateEvent", "bedrock-agentcore:DeleteEvent", "bedrock-agentcore:DeleteMemoryRecord", "bedrock-agentcore:ListMemoryRecords", "bedrock-agentcore:RetrieveMemoryRecords"],
      Resource: memoryArns });
  }
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}

export async function loadAdditionalPolicies(entries: string[] | undefined, codeDir: string): Promise<{ managedPolicyArns: string[]; inlinePolicies: Record<string, string> }> {
  const managedPolicyArns: string[] = [];
  const inlinePolicies: Record<string, string> = {};
  let index = 0;
  for (const entry of entries ?? []) {
    if (entry.startsWith("arn:")) { managedPolicyArns.push(entry); continue; }
    const path = isAbsolute(entry) ? entry : join(codeDir, entry);
    let text: string;
    try { text = await readFile(path, "utf8"); } catch {
      throw new ProjectStateError(`additionalPolicies entry '${entry}' was not found at ${path}`);
    }
    try { JSON.parse(text); } catch { throw new ProjectStateError(`additionalPolicies entry '${entry}' at ${path} is not valid JSON`); }
    inlinePolicies[`Additional${++index}`] = text;
  }
  return { managedPolicyArns, inlinePolicies };
}

const PROPAGATION = /role|assume|not authorized/i;
const RETRYABLE = new Set(["ValidationException", "AccessDeniedException"]);

/** A role created seconds ago may not be assumable by the service yet; the service reports that as a validation error. */
export async function withRolePropagationRetry<T>(
  fn: () => Promise<T>,
  { attempts = 12, delayMs = 5000, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const name = (error as { name?: string })?.name ?? "";
      const message = (error as Error)?.message ?? "";
      if (attempt >= attempts || !RETRYABLE.has(name) || !PROPAGATION.test(message)) throw error;
      await sleep(delayMs);
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/project/backends/imperative/iam.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/project/backends/imperative/iam.ts src/core/project/backends/imperative/iam.test.ts
git commit -m "feat(imperative): owned execution roles, runtime policy document, role propagation retry"
```

---

### Task 5: Memory kind handlers

**Files:**

- Create: `src/core/project/backends/imperative/agentcore/memory.ts`
- Test: `src/core/project/backends/imperative/agentcore/memory.test.ts`

**Interfaces:**

- Consumes: `KindHandlers` from `./notImplemented`; `AgentCoreStack` from `./stack`; `fromServiceStatus` from `../status`; `Status`, `StepContext` from `../plan/plan`; `ensureRole`, `deleteRole`, `executionRoleName`, `withRolePropagationRetry` from `../iam`; `stepOf` from `../inventory`; `MemorySchema` types, `DEFAULT_STRATEGY_NAMESPACE_TEMPLATES`, `DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES` from `src/projectSchemas/memory`.
- Produces: `export const memoryHandlers: KindHandlers`; `export function memoryStrategyInputs(memory: Memory): MemoryStrategyInput[]` (exported for tests); `export function memoryDrift(live: Memory, desired: MemorySpec): string | undefined`.
- SDK shapes (verified in `@aws-sdk/client-bedrock-agentcore-control/dist-types/models/models_1.d.ts`): `MemoryStrategyInput` is a union of `{ semanticMemoryStrategy }`, `{ summaryMemoryStrategy }`, `{ userPreferenceMemoryStrategy }`, `{ episodicMemoryStrategy }`, `{ customMemoryStrategy }`; each member is `{ name: string; description?: string; namespaces?: string[]; namespaceTemplates?: string[] }` and the episodic member adds `reflectionConfiguration?: { namespaceTemplates?: string[]; namespaces?: string[] }` (check the exact `EpisodicMemoryStrategyInput` fields before writing). `UpdateMemoryInput.memoryStrategies = { addMemoryStrategies?: MemoryStrategyInput[]; deleteMemoryStrategies?: { memoryStrategyId: string }[]; modifyMemoryStrategies?: ... }`. `Memory.strategies[]` items have `strategyId`, `name`, `type` (`SEMANTIC | SUMMARIZATION | USER_PREFERENCE | EPISODIC | CUSTOM`), `namespaces`, `namespaceTemplates`. `MemoryStatus` is `ACTIVE | CREATING | DELETING | FAILED | UPDATING`; `Memory.failureReason` carries the reason.

- [ ] **Step 1: Write the failing tests**

`memory.test.ts` (build a stack the way `stack.test.ts` does; the scope now needs `rootPath`, see Task 8; use a placeholder `rootPath: "/project"` here and in every other kind test):

```ts
import { describe, expect, test } from "bun:test";
import type { BedrockAgentCoreControlClient } from "@aws-sdk/client-bedrock-agentcore-control";
import type { IAMClient } from "@aws-sdk/client-iam";
import { createSilentLogger } from "../../../../../testing/logger"; // or wherever phase 1 tests get a silent logger
import type { Project } from "../../../../../handlers/project/types";
import type { AwsClients } from "../../../../types";
import { Status, type StepContext } from "../plan/plan";
import { fakeClient, notFound, sdkError } from "../testing";
import { AgentCoreStack } from "./stack";
import { memoryDrift, memoryHandlers, memoryStrategyInputs } from "./memory";

const scope = { projectName: "orders", targetName: "staging", account: "111122223333", region: "us-west-2", rootPath: "/project" };
const ctx: StepContext = { signal: new AbortController().signal, logger: createSilentLogger(), report: () => {} };
const memorySpec = {
  name: "agentMemory",
  eventExpiryDuration: 30,
  strategies: [
    { type: "SEMANTIC" as const, namespaceTemplates: ["/users/{actorId}/facts"] },
    { type: "EPISODIC" as const, namespaceTemplates: ["/episodes/{actorId}/{sessionId}"], reflectionNamespaceTemplates: ["/episodes/{actorId}"] },
  ],
};
const spec = { name: "orders", version: 2, managedBy: "Imperative", runtimes: [], memories: [memorySpec], knowledgeBases: [], credentials: [], evaluators: [], onlineEvalConfigs: [], agentCoreGateways: [], policyEngines: [], configBundles: [], harnesses: [] } as unknown as Project["spec"];
const resource = { kind: "memory" as const, name: "agentMemory" };
const liveMemory = (overrides: Record<string, unknown> = {}) => ({
  memory: {
    arn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/orders_staging_agentMemory-abc", id: "orders_staging_agentMemory-abc",
    name: "orders_staging_agentMemory", eventExpiryDuration: 30, status: "ACTIVE",
    strategies: [{ strategyId: "s1", name: "agentMemory_Semantic", type: "SEMANTIC" }, { strategyId: "s2", name: "agentMemory_Episodic", type: "EPISODIC" }],
    ...overrides,
  },
});

function harness(control: Parameters<typeof fakeClient>[0], iam: Parameters<typeof fakeClient>[0] = {}, recorded = {}) {
  const controlClient = fakeClient(control);
  const iamClient = fakeClient(iam);
  const clients = {
    control: () => controlClient as unknown as BedrockAgentCoreControlClient,
    iam: () => iamClient as unknown as IAMClient,
  } as unknown as AwsClients;
  const stack = new AgentCoreStack(scope, clients, { accessKeyId: "a", secretAccessKey: "b" }, createSilentLogger(), recorded);
  return { stack, control: controlClient.sent, iam: iamClient.sent };
}

describe("memoryStrategyInputs", () => {
  test("maps each type to its SDK member with default names and templates", () => {
    const inputs = memoryStrategyInputs({ ...memorySpec, strategies: [{ type: "SEMANTIC" }, { type: "SUMMARIZATION" }, { type: "USER_PREFERENCE" }, { type: "EPISODIC", reflectionNamespaceTemplates: ["/episodes/{actorId}"] }] });
    expect(inputs).toEqual([
      { semanticMemoryStrategy: { name: "agentMemory_Semantic", namespaceTemplates: ["/users/{actorId}/facts"] } },
      { summaryMemoryStrategy: { name: "agentMemory_Summarization", namespaceTemplates: ["/summaries/{actorId}/{sessionId}"] } },
      { userPreferenceMemoryStrategy: { name: "agentMemory_Userpreference", namespaceTemplates: ["/users/{actorId}/preferences"] } },
      { episodicMemoryStrategy: { name: "agentMemory_Episodic", namespaceTemplates: ["/episodes/{actorId}/{sessionId}"], reflectionConfiguration: { namespaceTemplates: ["/episodes/{actorId}"] } } },
    ]);
  });
  test("keeps explicit names, descriptions and deprecated namespaces", () => {
    const [input] = memoryStrategyInputs({ ...memorySpec, strategies: [{ type: "SEMANTIC", name: "facts", description: "d", namespaces: ["/x"] }] });
    expect(input).toEqual({ semanticMemoryStrategy: { name: "facts", description: "d", namespaceTemplates: ["/x"] } });
  });
  test("truncates a default name to 48 characters", () => {
    const [input] = memoryStrategyInputs({ ...memorySpec, name: "m".repeat(48), strategies: [{ type: "USER_PREFERENCE" }] });
    const name = (input as { userPreferenceMemoryStrategy: { name: string } }).userPreferenceMemoryStrategy.name;
    expect(name.length).toBe(48);
    expect(name.endsWith("_Userpreference")).toBe(true);
  });
});

describe("memoryDrift", () => {
  test("undefined when description, expiry and strategy types match", () => {
    expect(memoryDrift(liveMemory().memory as never, memorySpec)).toBeUndefined();
  });
  test("reports a changed expiry", () => {
    expect(memoryDrift(liveMemory({ eventExpiryDuration: 7 }).memory as never, memorySpec)).toMatch(/eventExpiryDuration/);
  });
  test("reports a strategy type set change", () => {
    expect(memoryDrift(liveMemory({ strategies: [{ strategyId: "s1", type: "SEMANTIC" }] }).memory as never, memorySpec)).toMatch(/strateg/);
  });
});

describe("poll", () => {
  test("NotStarted when nothing is recorded and no memory has the physical name", async () => {
    const { stack, control } = harness({ ListMemoriesCommand: () => ({ memories: [] }) });
    expect(await memoryHandlers.poll(stack, resource, spec)(ctx)).toEqual({ status: Status.NotStarted });
    expect(control.map((c) => c.name)).toEqual(["ListMemoriesCommand"]);
  });
  test("adopts a memory found by physical name and records it", async () => {
    const { stack } = harness({
      ListMemoriesCommand: () => ({ memories: [{ id: "other" }, { id: "orders_staging_agentMemory-abc" }] }),
      GetMemoryCommand: ({ memoryId }) => (memoryId === "other" ? { memory: { id: "other", name: "someone_else", status: "ACTIVE" } } : liveMemory()),
    });
    expect((await memoryHandlers.poll(stack, resource, spec)(ctx)).status).toBe(Status.Successful);
    expect(stack.outputsOf("memory:agentMemory")).toEqual({ arn: liveMemory().memory.arn, id: "orders_staging_agentMemory-abc" });
  });
  test("uses the recorded id and maps CREATING to Waiting", async () => {
    const { stack, control } = harness({ GetMemoryCommand: () => liveMemory({ status: "CREATING" }) }, {}, { memory: { agentMemory: { id: "orders_staging_agentMemory-abc", updatedAt: "t" } } });
    expect(await memoryHandlers.poll(stack, resource, spec)(ctx)).toEqual({ status: Status.Waiting, detail: "CREATING" });
    expect(control[0]!.input).toEqual({ memoryId: "orders_staging_agentMemory-abc" });
  });
  test("a recorded id that no longer exists is NotStarted", async () => {
    const { stack } = harness({ GetMemoryCommand: () => { throw notFound(); }, ListMemoriesCommand: () => ({ memories: [] }) }, {}, { memory: { agentMemory: { id: "gone", updatedAt: "t" } } });
    expect((await memoryHandlers.poll(stack, resource, spec)(ctx)).status).toBe(Status.NotStarted);
  });
  test("FAILED carries the failure reason", async () => {
    const { stack } = harness({ GetMemoryCommand: () => liveMemory({ status: "FAILED", failureReason: "quota" }) }, {}, { memory: { agentMemory: { id: "x", updatedAt: "t" } } });
    expect(await memoryHandlers.poll(stack, resource, spec)(ctx)).toEqual({ status: Status.Failed, detail: "FAILED: quota" });
  });
  test("ACTIVE with drift is Outdated", async () => {
    const { stack } = harness({ GetMemoryCommand: () => liveMemory({ eventExpiryDuration: 7 }) }, {}, { memory: { agentMemory: { id: "x", updatedAt: "t" } } });
    expect((await memoryHandlers.poll(stack, resource, spec)(ctx)).status).toBe(Status.Outdated);
  });
});

describe("create", () => {
  const iamOk = {
    GetRoleCommand: () => { throw sdkError("NoSuchEntityException", 404); },
    CreateRoleCommand: () => ({ Role: { Arn: "arn:aws:iam::111122223333:role/orders_staging_agentMemory_memory_role" } }),
    ListRolePoliciesCommand: () => ({ PolicyNames: [] }),
    ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
  };
  test("creates the role and the memory with physical name, strategies and tags, then records ids", async () => {
    const { stack, control, iam } = harness({ CreateMemoryCommand: () => liveMemory({ status: "CREATING" }) }, iamOk);
    await memoryHandlers.create(stack, resource, spec)(ctx);
    expect(iam.find((c) => c.name === "CreateRoleCommand")!.input.RoleName).toBe("orders_staging_agentMemory_memory_role");
    const create = control.find((c) => c.name === "CreateMemoryCommand")!.input;
    expect(create.name).toBe("orders_staging_agentMemory");
    expect(create.eventExpiryDuration).toBe(30);
    expect(create.memoryExecutionRoleArn).toBe("arn:aws:iam::111122223333:role/orders_staging_agentMemory_memory_role");
    expect(create.memoryStrategies).toEqual(memoryStrategyInputs(memorySpec));
    expect(create.tags).toEqual({ "agentcore:project-name": "orders", "agentcore:target-name": "staging", "agentcore:managed-by": "imperative" });
    expect(create.clientToken).toBeUndefined();
    expect(stack.outputsOf("memory:agentMemory")).toEqual({ arn: liveMemory().memory.arn, id: "orders_staging_agentMemory-abc" });
  });
  test("uses executionRoleArn from the spec instead of creating a role", async () => {
    const withRole = { ...spec, memories: [{ ...memorySpec, executionRoleArn: "arn:aws:iam::111122223333:role/mine" }] } as Project["spec"];
    const { control, iam, stack } = harness({ CreateMemoryCommand: () => liveMemory() });
    await memoryHandlers.create(stack, resource, withRole)(ctx);
    expect(iam).toEqual([]);
    expect(control[0]!.input.memoryExecutionRoleArn).toBe("arn:aws:iam::111122223333:role/mine");
  });
  test("updates an existing memory: expiry plus added and deleted strategies", async () => {
    const recorded = { memory: { agentMemory: { id: "orders_staging_agentMemory-abc", arn: liveMemory().memory.arn, updatedAt: "t" } } };
    const { stack, control } = harness({
      GetMemoryCommand: () => liveMemory({ eventExpiryDuration: 7, strategies: [{ strategyId: "s1", type: "SEMANTIC" }, { strategyId: "s9", type: "SUMMARIZATION" }] }),
      UpdateMemoryCommand: () => liveMemory({ status: "UPDATING" }),
    }, { ...iamOk, GetRoleCommand: () => ({ Role: { Arn: "arn:aws:iam::111122223333:role/orders_staging_agentMemory_memory_role", Tags: [{ Key: "agentcore:project-name", Value: "orders" }, { Key: "agentcore:target-name", Value: "staging" }, { Key: "agentcore:managed-by", Value: "imperative" }] } }) }, recorded);
    await memoryHandlers.create(stack, resource, spec)(ctx);
    const update = control.find((c) => c.name === "UpdateMemoryCommand")!.input;
    expect(update.memoryId).toBe("orders_staging_agentMemory-abc");
    expect(update.eventExpiryDuration).toBe(30);
    expect((update.memoryStrategies as { addMemoryStrategies: unknown[] }).addMemoryStrategies).toEqual([memoryStrategyInputs(memorySpec)[1]]);
    expect((update.memoryStrategies as { deleteMemoryStrategies: unknown[] }).deleteMemoryStrategies).toEqual([{ memoryStrategyId: "s9" }]);
  });
  test("retries CreateMemory while the new role propagates", async () => {
    let attempts = 0;
    const { stack } = harness({
      CreateMemoryCommand: () => { if (++attempts < 2) throw sdkError("ValidationException", 400, "role cannot be assumed"); return liveMemory(); },
    }, iamOk);
    await memoryHandlers.create(stack, resource, spec, { sleep: async () => {} } as never)(ctx); // see Step 2 for how sleep is injected
    expect(attempts).toBe(2);
  });
});

describe("remove and pollGone", () => {
  const recorded = { memory: { agentMemory: { id: "orders_staging_agentMemory-abc", updatedAt: "t" } } };
  test("remove deletes by recorded id and tolerates not found", async () => {
    const { stack, control } = harness({ DeleteMemoryCommand: () => { throw notFound(); } }, {}, recorded);
    await memoryHandlers.remove(stack, resource)(ctx);
    expect(control[0]).toEqual({ name: "DeleteMemoryCommand", input: { memoryId: "orders_staging_agentMemory-abc" } });
  });
  test("pollGone is NotStarted while the memory is ACTIVE", async () => {
    const { stack } = harness({ GetMemoryCommand: () => liveMemory() }, {}, recorded);
    expect((await memoryHandlers.pollGone(stack, resource)(ctx)).status).toBe(Status.NotStarted);
  });
  test("pollGone is Waiting while DELETING", async () => {
    const { stack } = harness({ GetMemoryCommand: () => liveMemory({ status: "DELETING" }) }, {}, recorded);
    expect((await memoryHandlers.pollGone(stack, resource)(ctx)).status).toBe(Status.Waiting);
  });
  test("pollGone deletes the owned role and forgets the step once the memory is gone", async () => {
    const { stack, iam } = harness({ GetMemoryCommand: () => { throw notFound(); } }, {
      GetRoleCommand: () => ({ Role: { Arn: "arn", Tags: [{ Key: "agentcore:project-name", Value: "orders" }, { Key: "agentcore:target-name", Value: "staging" }, { Key: "agentcore:managed-by", Value: "imperative" }] } }),
      ListRolePoliciesCommand: () => ({ PolicyNames: [] }), ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }), DeleteRoleCommand: () => ({}),
    }, recorded);
    expect(await memoryHandlers.pollGone(stack, resource)(ctx)).toEqual({ status: Status.Successful });
    expect(iam.map((c) => c.name)).toContain("DeleteRoleCommand");
    expect(stack.outputsOf("memory:agentMemory")).toBeUndefined();
  });
  test("pollGone with nothing recorded is Successful without calls", async () => {
    const { stack, control } = harness({});
    expect(await memoryHandlers.pollGone(stack, resource)(ctx)).toEqual({ status: Status.Successful });
    expect(control).toEqual([]);
  });
});
```

Run: `bun test src/core/project/backends/imperative/agentcore/memory.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 2: Implement**

`memory.ts`. The handlers take an optional fourth `options` argument `{ sleep?: (ms: number) => Promise<void> }` that only tests pass (the `KindHandlers` type allows extra optional parameters on the implementation side; declare `memoryHandlers` as `KindHandlers` and implement `create` as `(stack, resource, spec, options?) => Doer`):

```ts
import {
  CreateMemoryCommand, DeleteMemoryCommand, GetMemoryCommand, ListMemoriesCommand, UpdateMemoryCommand,
  type Memory as LiveMemory, type MemoryStrategyInput,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { NotImplementedError, ProjectStateError } from "../../../../../errors";
import type { Project } from "../../../../../handlers/project/types";
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES, DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  MEMORY_NAME_MAX_LENGTH, type Memory, type MemoryStrategy, type MemoryStrategyType,
} from "../../../../../projectSchemas/memory";
import { deleteRole, ensureRole, executionRoleName, withRolePropagationRetry } from "../iam";
import { stepOf, type DeclaredResource } from "../inventory";
import { Status, type Doer, type Statuser, type StatusReport } from "../plan/plan";
import { fromServiceStatus } from "../status";
import type { KindHandlers } from "./notImplemented";
import type { AgentCoreStack } from "./stack";

type Options = { sleep?: (ms: number) => Promise<void> };

const isNotFound = (error: unknown) =>
  (error as { name?: string })?.name === "ResourceNotFoundException" || (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;

function memorySpec(spec: Project["spec"], name: string): Memory {
  const memory = spec.memories.find((m) => m.name === name);
  if (!memory) throw new ProjectStateError(`memory '${name}' is not declared in agentcore.json`);
  if (memory.streamDeliveryResources) {
    throw new NotImplementedError(`memory '${name}' declares streamDeliveryResources, which imperative deploy does not support yet`);
  }
  return memory;
}

const STRATEGY_MEMBER: Record<MemoryStrategyType, string> = {
  SEMANTIC: "semanticMemoryStrategy", SUMMARIZATION: "summaryMemoryStrategy", USER_PREFERENCE: "userPreferenceMemoryStrategy", EPISODIC: "episodicMemoryStrategy",
};

function defaultStrategyName(memoryName: string, type: MemoryStrategyType): string {
  const suffix = `_${type.charAt(0)}${type.slice(1).toLowerCase().replaceAll("_", "")}`;
  return `${memoryName.slice(0, MEMORY_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
}

function strategyInput(memory: Memory, strategy: MemoryStrategy): MemoryStrategyInput {
  const base = {
    name: strategy.name ?? defaultStrategyName(memory.name, strategy.type),
    ...(strategy.description && { description: strategy.description }),
    namespaceTemplates: strategy.namespaceTemplates ?? strategy.namespaces ?? DEFAULT_STRATEGY_NAMESPACE_TEMPLATES[strategy.type] ?? [],
  };
  if (strategy.type === "EPISODIC") {
    return {
      episodicMemoryStrategy: {
        ...base,
        reflectionConfiguration: { namespaceTemplates: strategy.reflectionNamespaceTemplates ?? strategy.reflectionNamespaces ?? DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES },
      },
    } as MemoryStrategyInput;
  }
  return { [STRATEGY_MEMBER[strategy.type]]: base } as MemoryStrategyInput;
}

export function memoryStrategyInputs(memory: Memory): MemoryStrategyInput[] {
  return memory.strategies.map((strategy) => strategyInput(memory, strategy));
}

export function memoryDrift(live: LiveMemory, desired: Memory): string | undefined {
  if ((live.description ?? undefined) !== (desired.description ?? undefined)) return "description differs";
  if (live.eventExpiryDuration !== desired.eventExpiryDuration) return `eventExpiryDuration is ${live.eventExpiryDuration}, want ${desired.eventExpiryDuration}`;
  const liveTypes = [...new Set((live.strategies ?? []).map((s) => s.type))].sort();
  const wantTypes = [...new Set(desired.strategies.map((s) => s.type))].sort();
  if (JSON.stringify(liveTypes) !== JSON.stringify(wantTypes)) return `strategies are [${liveTypes}], want [${wantTypes}]`;
  return undefined;
}

async function getMemory(stack: AgentCoreStack, memoryId: string): Promise<LiveMemory | undefined> {
  try {
    return (await stack.clients.control(stack.options()).send(new GetMemoryCommand({ memoryId }))).memory;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** ListMemories summaries carry no name, so each candidate is fetched until one matches. */
async function findMemoryByName(stack: AgentCoreStack, physical: string): Promise<LiveMemory | undefined> {
  const control = stack.clients.control(stack.options());
  let nextToken: string | undefined;
  do {
    const page = await control.send(new ListMemoriesCommand({ nextToken, maxResults: 100 }));
    for (const summary of page.memories ?? []) {
      if (!summary.id) continue;
      const memory = await getMemory(stack, summary.id);
      if (memory?.name === physical) return memory;
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return undefined;
}

async function locate(stack: AgentCoreStack, resource: DeclaredResource): Promise<LiveMemory | undefined> {
  const recorded = stack.outputsOf(stepOf(resource))?.id;
  const memory = (recorded ? await getMemory(stack, recorded) : undefined) ?? (await findMemoryByName(stack, stack.name("memory", resource.name, MEMORY_NAME_MAX_LENGTH)));
  if (memory?.arn && memory.id) stack.record(stepOf(resource), { arn: memory.arn, id: memory.id });
  return memory;
}

async function roleArnFor(stack: AgentCoreStack, memory: Memory): Promise<string> {
  if (memory.executionRoleArn) return memory.executionRoleArn;
  const { arn } = await ensureRole(stack.clients.iam(stack.options()), stack.scope, {
    roleName: executionRoleName(stack.scope, "memory", memory.name),
    description: `Execution role for AgentCore memory ${memory.name} (project ${stack.scope.projectName}, target ${stack.scope.targetName})`,
    tags: stack.tags(),
    inlinePolicies: {},
    managedPolicyArns: [],
  });
  return arn;
}

export const memoryHandlers: KindHandlers = {
  poll(stack, resource, spec): Statuser {
    return async () => {
      const desired = memorySpec(spec, resource.name);
      const live = await locate(stack, resource);
      if (!live) return { status: Status.NotStarted };
      const report = fromServiceStatus(live.status, { statusReason: live.failureReason });
      if (report.status !== Status.Successful) return report;
      const drift = memoryDrift(live, desired);
      return drift ? { status: Status.Outdated, detail: drift } : { status: Status.Successful };
    };
  },
  create(stack, resource, spec, options?: Options): Doer {
    return async (ctx) => {
      const desired = memorySpec(spec, resource.name);
      const control = stack.clients.control(stack.options());
      const roleArn = await roleArnFor(stack, desired);
      const existing = await locate(stack, resource);
      if (existing?.id) {
        ctx.report(`Updating memory ${existing.id}`);
        const liveByType = new Map((existing.strategies ?? []).map((s) => [s.type, s]));
        const wantTypes = new Set(desired.strategies.map((s) => s.type));
        const add = desired.strategies.filter((s) => !liveByType.has(s.type)).map((s) => strategyInput(desired, s));
        const remove = [...liveByType.values()].filter((s) => !wantTypes.has(s.type as MemoryStrategyType)).map((s) => ({ memoryStrategyId: s.strategyId! }));
        await control.send(new UpdateMemoryCommand({
          memoryId: existing.id,
          ...(desired.description !== undefined && { description: desired.description }),
          eventExpiryDuration: desired.eventExpiryDuration,
          memoryExecutionRoleArn: roleArn,
          ...((add.length > 0 || remove.length > 0) && {
            memoryStrategies: { ...(add.length > 0 && { addMemoryStrategies: add }), ...(remove.length > 0 && { deleteMemoryStrategies: remove }) },
          }),
        }));
        return;
      }
      ctx.report(`Creating memory ${stack.name("memory", desired.name, MEMORY_NAME_MAX_LENGTH)}`);
      const created = await withRolePropagationRetry(
        () => control.send(new CreateMemoryCommand({
          name: stack.name("memory", desired.name, MEMORY_NAME_MAX_LENGTH),
          ...(desired.description !== undefined && { description: desired.description }),
          eventExpiryDuration: desired.eventExpiryDuration,
          memoryExecutionRoleArn: roleArn,
          ...(desired.encryptionKeyArn && { encryptionKeyArn: desired.encryptionKeyArn }),
          ...(desired.strategies.length > 0 && { memoryStrategies: memoryStrategyInputs(desired) }),
          ...(desired.indexedKeys && { indexedKeys: desired.indexedKeys }),
          tags: stack.tags(desired.tags),
        })),
        { sleep: options?.sleep },
      );
      if (created.memory?.arn && created.memory.id) stack.record(stepOf(resource), { arn: created.memory.arn, id: created.memory.id });
    };
  },
  remove(stack, resource): Doer {
    return async (ctx) => {
      const id = stack.outputsOf(stepOf(resource))?.id;
      if (!id) return;
      ctx.report(`Deleting memory ${id}`);
      try {
        await stack.clients.control(stack.options()).send(new DeleteMemoryCommand({ memoryId: id }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    };
  },
  pollGone(stack, resource): Statuser {
    return async (): Promise<StatusReport> => {
      const id = stack.outputsOf(stepOf(resource))?.id;
      if (!id) return { status: Status.Successful };
      const live = await getMemory(stack, id);
      if (live) {
        if (live.status === "DELETING") return { status: Status.Waiting, detail: "DELETING" };
        if (live.status === "FAILED") return { status: Status.Failed, detail: live.failureReason ?? "FAILED" };
        return { status: Status.NotStarted };
      }
      await deleteRole(stack.clients.iam(stack.options()), stack.scope, executionRoleName(stack.scope, "memory", resource.name));
      stack.forget(stepOf(resource));
      return { status: Status.Successful };
    };
  },
};
```

If `KindHandlers.create`'s declared arity rejects the optional fourth parameter, widen the type in `notImplemented.ts` to `create(stack, resource, spec, options?: { sleep?: (ms: number) => Promise<void> }): Doer` (a type-only change; the phase 1 tests still pass).

- [ ] **Step 3: Run the tests**

Run: `bun test src/core/project/backends/imperative/agentcore/memory.test.ts`
Expected: PASS. If the `reflectionConfiguration` field name differs in the SDK's `EpisodicMemoryStrategyInput`, fix the implementation and the test together.

- [ ] **Step 4: Commit**

```bash
git add src/core/project/backends/imperative/agentcore/memory.ts src/core/project/backends/imperative/agentcore/memory.test.ts src/core/project/backends/imperative/agentcore/notImplemented.ts
git commit -m "feat(imperative): memory create, update, poll and delete handlers"
```

---

### Task 6: Runtime kind handlers

**Files:**

- Create: `src/core/project/backends/imperative/agentcore/runtime.ts`
- Test: `src/core/project/backends/imperative/agentcore/runtime.test.ts`

**Interfaces:**

- Consumes: `CodeArtifact` from `../artifacts` (read from `stack.artifacts`, added in Task 8; in this task add the field to `AgentCoreStack` if Task 8 has not run yet: `readonly artifacts = new Map<string, CodeArtifact>()`); `ensureRole`, `deleteRole`, `executionRoleName`, `roleArn`, `roleDrift`, `partitionFor`, `runtimeExecutionPolicy`, `loadAdditionalPolicies`, `withRolePropagationRetry`, `RUNTIME_POLICY_NAME` from `../iam`; `memoryEnvVarName` from `src/projectSchemas/memory`; `stepName` from `../naming`; `stepOf` from `../inventory`.
- Produces: `export const runtimeHandlers: KindHandlers`; `export function runtimeEnvironment(stack, runtime, spec): Record<string, string>`; `export function runtimeEntryPoint(runtime): string[]`; `export function runtimeDrift(live: GetAgentRuntimeResponse, desired: RuntimeRequest): string | undefined`; `export type RuntimeRequest` = the shared fields of Create/Update.
- SDK shapes: `CreateAgentRuntimeRequest { agentRuntimeName, agentRuntimeArtifact: { codeConfiguration: { code: { s3: { bucket, prefix } }, runtime, entryPoint } }, roleArn, networkConfiguration: { networkMode, networkModeConfig?: { subnets, securityGroups } }, description?, protocolConfiguration?: { serverProtocol }, requestHeaderConfiguration?: { requestHeaderAllowlist }, lifecycleConfiguration?, environmentVariables?, tags? }`; `UpdateAgentRuntimeRequest` = same minus `agentRuntimeName`/`tags` plus `agentRuntimeId`; `GetAgentRuntimeResponse { agentRuntimeArn, agentRuntimeId, agentRuntimeName, agentRuntimeVersion, roleArn, status, failureReason?, description?, agentRuntimeArtifact?, networkConfiguration?, protocolConfiguration?, environmentVariables? }`; `ListAgentRuntimesResponse { agentRuntimes: { agentRuntimeArn, agentRuntimeId, agentRuntimeName, status }[], nextToken? }`; statuses `CREATING | CREATE_FAILED | UPDATING | UPDATE_FAILED | READY | DELETING`.

- [ ] **Step 1: Write the failing tests**

`runtime.test.ts` (same harness style as Task 5; the stack is seeded with the memory id via `recorded`):

```ts
const runtimeSpec = {
  name: "agent", build: "CodeZip", entrypoint: "main.py", codeLocation: "app/agent", runtimeVersion: "PYTHON_3_14",
  envVars: [{ name: "LOG_LEVEL", value: "info" }],
};
const memory = { name: "agentMemory", eventExpiryDuration: 30, strategies: [] };
const spec = { ...emptySpec, runtimes: [runtimeSpec], memories: [memory] } as unknown as Project["spec"];
const resource = { kind: "runtime" as const, name: "agent" };
const artifact = { bucket: "agentcore-cli-111122223333-us-west-2", key: "orders/staging/agent/aaaa.zip", sha256: "aaaa", sizeBytes: 10 };
const memoryRecorded = { memory: { agentMemory: { arn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/mem-1", id: "mem-1", updatedAt: "t" } } };
const roleArnValue = "arn:aws:iam::111122223333:role/orders_staging_agent_runtime_role";
const ownedRole = { Role: { Arn: roleArnValue, Tags: [/* ownership tags as IAM Tag[] */] } };
const liveRuntime = (overrides = {}) => ({
  agentRuntimeArn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:runtime/orders_staging_agent-xyz", agentRuntimeId: "orders_staging_agent-xyz",
  agentRuntimeName: "orders_staging_agent", agentRuntimeVersion: "1", roleArn: roleArnValue, status: "READY",
  description: "AgentCore Runtime: agent",
  agentRuntimeArtifact: { codeConfiguration: { code: { s3: { bucket: artifact.bucket, prefix: artifact.key } }, runtime: "PYTHON_3_14", entryPoint: ["opentelemetry-instrument", "main.py"] } },
  networkConfiguration: { networkMode: "PUBLIC" },
  environmentVariables: { LOG_LEVEL: "info", AGENTCORE_MEMORY_AGENTMEMORY_ID: "mem-1" },
  ...overrides,
});
const inSyncIam = {
  GetRoleCommand: () => ownedRole,
  ListRolePoliciesCommand: () => ({ PolicyNames: [RUNTIME_POLICY_NAME] }),
  GetRolePolicyCommand: () => ({ PolicyDocument: encodeURIComponent(runtimeExecutionPolicy({ partition: "aws", region: "us-west-2", account: "111122223333", memoryArns: [memoryRecorded.memory.agentMemory.arn] })) }),
  ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
};

describe("runtimeEnvironment", () => {
  test("merges envVars with every memory id", () => { /* expect {LOG_LEVEL:"info", AGENTCORE_MEMORY_AGENTMEMORY_ID:"mem-1"} using a stack seeded with memoryRecorded */ });
  test("throws when a memory id is missing from the stack", () => { /* stack without recorded memory → /memory 'agentMemory'/ */ });
});
describe("runtimeEntryPoint", () => {
  test("wraps in opentelemetry-instrument by default", () => expect(runtimeEntryPoint(runtimeSpec)).toEqual(["opentelemetry-instrument", "main.py"]));
  test("strips a :handler suffix", () => expect(runtimeEntryPoint({ ...runtimeSpec, entrypoint: "main.py:app" })).toEqual(["opentelemetry-instrument", "main.py"]));
  test("omits the wrapper when otel is disabled", () => expect(runtimeEntryPoint({ ...runtimeSpec, instrumentation: { enableOtel: false } })).toEqual(["main.py"]));
});
describe("poll", () => {
  test("NotStarted when no runtime carries the physical name", ...);   // ListAgentRuntimesCommand → { agentRuntimes: [] }
  test("adopts by name, records arn and id", ...);                       // ListAgentRuntimesCommand → [liveRuntime()], GetAgentRuntimeCommand → liveRuntime()
  test("CREATING is Waiting; CREATE_FAILED carries failureReason", ...);
  test("a converged runtime with the same artifact is Successful and is not updated", async () => {
    // recorded runtime id + memoryRecorded; stack.artifacts.set("agent", artifact); GetAgentRuntimeCommand → liveRuntime(); inSyncIam
    // expect status Successful and no UpdateAgentRuntimeCommand in sent
  });
  test("a new artifact marks the runtime Outdated and update sends the new prefix", async () => {
    // stack.artifacts.set("agent", { ...artifact, key: "orders/staging/agent/bbbb.zip", sha256: "bbbb" }); poll → Outdated with detail /artifact/
    // then create(...)(ctx) → UpdateAgentRuntimeCommand with agentRuntimeArtifact.codeConfiguration.code.s3.prefix === ".../bbbb.zip" and no agentRuntimeName/tags
  });
  test("a changed environment variable is Outdated", ...);
  test("a changed role policy is Outdated", ...);                        // GetRolePolicyCommand returns a different document → detail /policy/
  test("READY without a staged artifact skips artifact drift (status/invoke paths)", ...); // no stack.artifacts entry → Successful
});
describe("create", () => {
  test("creates the role with the runtime policy over every memory, then the runtime", async () => {
    // iam: NoSuchEntity → CreateRole; control: CreateAgentRuntimeCommand → liveRuntime({status:"CREATING"})
    // expect PutRolePolicyCommand.PolicyDocument to equal runtimeExecutionPolicy({... memoryArns:[memory arn]})
    // expect CreateAgentRuntimeCommand input: agentRuntimeName "orders_staging_agent", roleArn, artifact bucket/prefix, runtime "PYTHON_3_14",
    //   entryPoint ["opentelemetry-instrument","main.py"], networkConfiguration {networkMode:"PUBLIC"}, environmentVariables incl. memory id,
    //   description "AgentCore Runtime: agent", tags = ownership tags, no protocolConfiguration, no clientToken
    // expect stack.outputsOf("runtime:agent") toEqual {arn, id}
  });
  test("passes protocol, VPC network config, request headers and lifecycle when declared", ...);
  test("uses executionRoleArn without touching IAM", ...);
  test("attaches managed policies and inline files from additionalPolicies", async () => {
    // write /tmp dir with extra.json; scope.rootPath = that dir's parent so codeLocation resolves; additionalPolicies ["arn:aws:iam::aws:policy/ReadOnlyAccess","extra.json"]
    // expect AttachRolePolicyCommand and PutRolePolicyCommand with PolicyName "Additional1"
  });
  test("fails before any AWS call when no artifact is staged", ...);   // stack.artifacts empty → rejects /no code artifact/ ; control.sent empty
  test("retries CreateAgentRuntime while the role propagates", ...);
});
describe("remove and pollGone", () => {
  test("remove deletes by recorded id", ...);                          // DeleteAgentRuntimeCommand { agentRuntimeId }
  test("pollGone is NotStarted while READY, Waiting while DELETING", ...);
  test("pollGone deletes the owned role and forgets the step when the runtime is gone", ...);
  test("pollGone with nothing recorded is Successful", ...);
});
```

Write every `...` body out in full using the Task 5 tests as the template (same harness, same assertions style). Run and confirm the file fails with "module not found".

- [ ] **Step 2: Implement**

`runtime.ts`:

```ts
import {
  CreateAgentRuntimeCommand, DeleteAgentRuntimeCommand, GetAgentRuntimeCommand, ListAgentRuntimesCommand, UpdateAgentRuntimeCommand,
  type CreateAgentRuntimeRequest, type GetAgentRuntimeResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { join } from "node:path";
import { ProjectStateError } from "../../../../../errors";
import type { Project } from "../../../../../handlers/project/types";
import { memoryEnvVarName } from "../../../../../projectSchemas/memory";
import {
  deleteRole, ensureRole, executionRoleName, loadAdditionalPolicies, partitionFor, roleArn as roleArnOf, roleDrift,
  runtimeExecutionPolicy, withRolePropagationRetry, RUNTIME_POLICY_NAME, type RoleSpec,
} from "../iam";
import { stepOf, type DeclaredResource } from "../inventory";
import { stepName } from "../naming";
import { Status, type Doer, type Statuser } from "../plan/plan";
import { fromServiceStatus } from "../status";
import type { KindHandlers } from "./notImplemented";
import type { AgentCoreStack } from "./stack";

type RuntimeSpec = Project["spec"]["runtimes"][number];
export type RuntimeRequest = Omit<CreateAgentRuntimeRequest, "agentRuntimeName" | "tags" | "clientToken">;
type Options = { sleep?: (ms: number) => Promise<void> };
const RUNTIME_NAME_MAX = 48;

const isNotFound = (error: unknown) =>
  (error as { name?: string })?.name === "ResourceNotFoundException" || (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;

function runtimeSpec(spec: Project["spec"], name: string): RuntimeSpec {
  const runtime = spec.runtimes.find((r) => r.name === name);
  if (!runtime) throw new ProjectStateError(`runtime '${name}' is not declared in agentcore.json`);
  return runtime;
}

export function runtimeEntryPoint(runtime: Pick<RuntimeSpec, "entrypoint" | "instrumentation">): string[] {
  const path = runtime.entrypoint.split(":")[0]!;
  return runtime.instrumentation?.enableOtel === false ? [path] : ["opentelemetry-instrument", path];
}

export function runtimeEnvironment(stack: AgentCoreStack, runtime: RuntimeSpec, spec: Project["spec"]): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries((runtime.envVars ?? []).map((v) => [v.name, v.value]));
  for (const memory of spec.memories) {
    const id = stack.outputsOf(stepName("memory", memory.name))?.id;
    if (!id) throw new ProjectStateError(`memory '${memory.name}' has no deployed id yet; the runtime '${runtime.name}' cannot be wired to it`);
    env[memoryEnvVarName(memory.name)] = id;
  }
  return env;
}

function memoryArns(stack: AgentCoreStack, spec: Project["spec"]): string[] {
  return spec.memories.flatMap((m) => { const arn = stack.outputsOf(stepName("memory", m.name))?.arn; return arn ? [arn] : []; });
}

function desiredRequest(stack: AgentCoreStack, runtime: RuntimeSpec, spec: Project["spec"], roleArn: string): RuntimeRequest {
  const artifact = stack.artifacts.get(runtime.name);
  if (!artifact) throw new ProjectStateError(`no code artifact was staged for runtime '${runtime.name}'; this is a bug in the deploy sequence`);
  const vpc = runtime.networkMode === "VPC" && runtime.networkConfig;
  return {
    agentRuntimeArtifact: {
      codeConfiguration: {
        code: { s3: { bucket: artifact.bucket, prefix: artifact.key } },
        runtime: runtime.runtimeVersion as CreateAgentRuntimeRequest["agentRuntimeArtifact"] extends infer A ? never : never, // replace with the SDK's AgentManagedRuntimeType cast
        entryPoint: runtimeEntryPoint(runtime),
      },
    },
    roleArn,
    networkConfiguration: {
      networkMode: runtime.networkMode ?? "PUBLIC",
      ...(vpc && { networkModeConfig: { subnets: vpc.subnets, securityGroups: vpc.securityGroups } }),
    },
    description: runtime.description ?? `AgentCore Runtime: ${runtime.name}`,
    ...(runtime.protocol && runtime.protocol !== "HTTP" && { protocolConfiguration: { serverProtocol: runtime.protocol } }),
    ...(runtime.requestHeaderAllowlist?.length && { requestHeaderConfiguration: { requestHeaderAllowlist: runtime.requestHeaderAllowlist } }),
    ...(runtime.lifecycleConfiguration && { lifecycleConfiguration: runtime.lifecycleConfiguration }),
    environmentVariables: runtimeEnvironment(stack, runtime, spec),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function runtimeDrift(live: GetAgentRuntimeResponse, desired: RuntimeRequest): string | undefined {
  const liveCode = live.agentRuntimeArtifact?.codeConfiguration;
  const wantCode = desired.agentRuntimeArtifact?.codeConfiguration;
  if (!same(liveCode?.code?.s3, wantCode?.code?.s3)) return "code artifact differs";
  if (!same(liveCode?.entryPoint, wantCode?.entryPoint)) return "entry point differs";
  if (liveCode?.runtime !== wantCode?.runtime) return "runtime version differs";
  if (live.roleArn !== desired.roleArn) return "execution role differs";
  if (live.networkConfiguration?.networkMode !== desired.networkConfiguration?.networkMode) return "network mode differs";
  if ((live.protocolConfiguration?.serverProtocol ?? "HTTP") !== (desired.protocolConfiguration?.serverProtocol ?? "HTTP")) return "protocol differs";
  if ((live.description ?? "") !== (desired.description ?? "")) return "description differs";
  if (!same(sortKeys(live.environmentVariables ?? {}), sortKeys(desired.environmentVariables ?? {}))) return "environment variables differ";
  return undefined;
}
const sortKeys = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

async function getRuntime(stack: AgentCoreStack, agentRuntimeId: string): Promise<GetAgentRuntimeResponse | undefined> {
  try {
    return await stack.clients.control(stack.options()).send(new GetAgentRuntimeCommand({ agentRuntimeId }));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function findRuntimeByName(stack: AgentCoreStack, physical: string): Promise<GetAgentRuntimeResponse | undefined> {
  const control = stack.clients.control(stack.options());
  let nextToken: string | undefined;
  do {
    const page = await control.send(new ListAgentRuntimesCommand({ nextToken, maxResults: 100 }));
    const hit = (page.agentRuntimes ?? []).find((r) => r.agentRuntimeName === physical);
    if (hit?.agentRuntimeId) return getRuntime(stack, hit.agentRuntimeId);
    nextToken = page.nextToken;
  } while (nextToken);
  return undefined;
}

async function locate(stack: AgentCoreStack, resource: DeclaredResource) {
  const recorded = stack.outputsOf(stepOf(resource))?.id;
  const live = (recorded ? await getRuntime(stack, recorded) : undefined) ?? (await findRuntimeByName(stack, stack.name("runtime", resource.name, RUNTIME_NAME_MAX)));
  if (live?.agentRuntimeArn && live.agentRuntimeId) stack.record(stepOf(resource), { arn: live.agentRuntimeArn, id: live.agentRuntimeId });
  return live;
}

async function roleSpecFor(stack: AgentCoreStack, runtime: RuntimeSpec, spec: Project["spec"]): Promise<RoleSpec> {
  const partition = partitionFor(stack.scope.region);
  const additional = await loadAdditionalPolicies(runtime.additionalPolicies, join(stack.scope.rootPath, runtime.codeLocation));
  return {
    roleName: executionRoleName(stack.scope, "runtime", runtime.name),
    description: `Execution role for AgentCore runtime ${runtime.name} (project ${stack.scope.projectName}, target ${stack.scope.targetName})`,
    tags: stack.tags(),
    inlinePolicies: {
      [RUNTIME_POLICY_NAME]: runtimeExecutionPolicy({ partition, region: stack.scope.region, account: stack.scope.account, memoryArns: memoryArns(stack, spec) }),
      ...additional.inlinePolicies,
    },
    managedPolicyArns: additional.managedPolicyArns,
  };
}

export const runtimeHandlers: KindHandlers = {
  poll(stack, resource, spec): Statuser {
    return async () => {
      const runtime = runtimeSpec(spec, resource.name);
      const live = await locate(stack, resource);
      if (!live) return { status: Status.NotStarted };
      const report = fromServiceStatus(live.status, { statusReason: live.failureReason });
      if (report.status !== Status.Successful) return report;
      // Without a staged artifact (status/invoke paths) READY is as far as we can see.
      if (!stack.artifacts.has(runtime.name)) return { status: Status.Successful };
      const expectedRole = runtime.executionRoleArn ?? roleArnOf(partitionFor(stack.scope.region), stack.scope.account, executionRoleName(stack.scope, "runtime", runtime.name));
      const drift = runtimeDrift(live, desiredRequest(stack, runtime, spec, expectedRole));
      if (drift) return { status: Status.Outdated, detail: drift };
      if (!runtime.executionRoleArn) {
        const policyDrift = await roleDrift(stack.clients.iam(stack.options()), stack.scope, await roleSpecFor(stack, runtime, spec));
        if (policyDrift) return { status: Status.Outdated, detail: `execution role: ${policyDrift}` };
      }
      return { status: Status.Successful };
    };
  },
  create(stack, resource, spec, options?: Options): Doer {
    return async (ctx) => {
      const runtime = runtimeSpec(spec, resource.name);
      if (!stack.artifacts.has(runtime.name)) throw new ProjectStateError(`no code artifact was staged for runtime '${runtime.name}'`);
      const control = stack.clients.control(stack.options());
      const roleArn = runtime.executionRoleArn ?? (await ensureRole(stack.clients.iam(stack.options()), stack.scope, await roleSpecFor(stack, runtime, spec))).arn;
      const request = desiredRequest(stack, runtime, spec, roleArn);
      const existing = await locate(stack, resource);
      if (existing?.agentRuntimeId) {
        ctx.report(`Updating runtime ${existing.agentRuntimeId}`);
        await withRolePropagationRetry(() => control.send(new UpdateAgentRuntimeCommand({ agentRuntimeId: existing.agentRuntimeId!, ...request })), { sleep: options?.sleep });
        return;
      }
      const name = stack.name("runtime", runtime.name, RUNTIME_NAME_MAX);
      ctx.report(`Creating runtime ${name}`);
      const created = await withRolePropagationRetry(
        () => control.send(new CreateAgentRuntimeCommand({ agentRuntimeName: name, ...request, tags: stack.tags(runtime.tags) })),
        { sleep: options?.sleep },
      );
      if (created.agentRuntimeArn && created.agentRuntimeId) stack.record(stepOf(resource), { arn: created.agentRuntimeArn, id: created.agentRuntimeId });
    };
  },
  remove(stack, resource): Doer {
    return async (ctx) => {
      const id = stack.outputsOf(stepOf(resource))?.id;
      if (!id) return;
      ctx.report(`Deleting runtime ${id}`);
      try {
        await stack.clients.control(stack.options()).send(new DeleteAgentRuntimeCommand({ agentRuntimeId: id }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    };
  },
  pollGone(stack, resource): Statuser {
    return async () => {
      const id = stack.outputsOf(stepOf(resource))?.id;
      if (!id) return { status: Status.Successful };
      const live = await getRuntime(stack, id);
      if (live) {
        if (live.status === "DELETING") return { status: Status.Waiting, detail: "DELETING" };
        return { status: Status.NotStarted };
      }
      await deleteRole(stack.clients.iam(stack.options()), stack.scope, executionRoleName(stack.scope, "runtime", resource.name));
      stack.forget(stepOf(resource));
      return { status: Status.Successful };
    };
  },
};
```

Fix the `runtime:` cast to the SDK's enum type (`runtime.runtimeVersion as AgentManagedRuntimeType`, imported from the control client package). `stack.scope.rootPath` and `stack.artifacts` come from Task 8; if you are implementing this task first, add both to `stack.ts` now (see Task 8 Step 1) and fix `stack.test.ts`/`plan.test.ts` scopes.

- [ ] **Step 3: Run the tests**

Run: `bun test src/core/project/backends/imperative/agentcore/runtime.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/project/backends/imperative/agentcore/runtime.ts src/core/project/backends/imperative/agentcore/runtime.test.ts src/core/project/backends/imperative/agentcore/stack.ts src/core/project/backends/imperative/agentcore/stack.test.ts src/core/project/backends/imperative/agentcore/plan.test.ts
git commit -m "feat(imperative): runtime create, update, drift, poll and delete handlers"
```

---

### Task 7: Runtime endpoint kind handlers

**Files:**

- Create: `src/core/project/backends/imperative/agentcore/endpoint.ts`
- Test: `src/core/project/backends/imperative/agentcore/endpoint.test.ts`

**Interfaces:**

- Consumes: `stepName` from `../naming`; the parent runtime's id from `stack.outputsOf(stepName("runtime", resource.parent))`.
- Produces: `export const endpointHandlers: KindHandlers`.
- SDK shapes: `CreateAgentRuntimeEndpointRequest { agentRuntimeId, name, agentRuntimeVersion?, description?, tags? }`; `UpdateAgentRuntimeEndpointRequest { agentRuntimeId, endpointName, agentRuntimeVersion?, description? }`; `GetAgentRuntimeEndpointRequest { agentRuntimeId, endpointName }`; `GetAgentRuntimeEndpointResponse { liveVersion?, targetVersion?, agentRuntimeEndpointArn, agentRuntimeArn, description?, status, failureReason?, name, id }`; `DeleteAgentRuntimeEndpointRequest { agentRuntimeId, endpointName }`; statuses as the runtime's.

- [ ] **Step 1: Write the failing tests**

`endpoint.test.ts` (same harness; `spec.runtimes[0].endpoints = { prod: { version: 2, description: "prod" } }`; `resource = { kind: "runtime-endpoint", name: "prod", parent: "agent" }`; `recorded = { runtime: { agent: { id: "rt-1", arn: "...", updatedAt: "t" } } }`):

```ts
describe("poll", () => {
  test("throws when the parent runtime has no id", ...);                 // stack without recorded runtime → rejects /runtime 'agent'/
  test("NotStarted when GetAgentRuntimeEndpoint is not found", ...);       // input { agentRuntimeId: "rt-1", endpointName: "prod" }
  test("records arn and id, maps CREATING to Waiting", ...);
  test("READY on the declared version is Successful", ...);               // { status:"READY", liveVersion:"2", description:"prod" }
  test("READY on another version is Outdated", ...);                      // targetVersion "1"
  test("a different description is Outdated", ...);
});
describe("create", () => {
  test("creates with runtime id, name, version string, description and tags", ...);  // CreateAgentRuntimeEndpointCommand; agentRuntimeVersion "2"; no clientToken
  test("updates when the endpoint is already recorded", ...);                       // UpdateAgentRuntimeEndpointCommand { agentRuntimeId, endpointName, agentRuntimeVersion, description }
});
describe("remove and pollGone", () => {
  test("remove deletes by runtime id and endpoint name, tolerating not found", ...);
  test("pollGone is NotStarted while READY, Waiting while DELETING, Successful when gone", ...);
  test("pollGone is Successful when the parent runtime is already gone", ...);      // no recorded runtime → Successful without calls
});
```

Write each body in full. Run and confirm "module not found".

- [ ] **Step 2: Implement**

`endpoint.ts`:

```ts
import {
  CreateAgentRuntimeEndpointCommand, DeleteAgentRuntimeEndpointCommand, GetAgentRuntimeEndpointCommand, UpdateAgentRuntimeEndpointCommand,
  type GetAgentRuntimeEndpointResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { ProjectStateError } from "../../../../../errors";
import type { Project } from "../../../../../handlers/project/types";
import { stepOf, type DeclaredResource } from "../inventory";
import { stepName } from "../naming";
import { Status, type Doer, type Statuser } from "../plan/plan";
import { fromServiceStatus } from "../status";
import type { KindHandlers } from "./notImplemented";
import type { AgentCoreStack } from "./stack";

const isNotFound = (error: unknown) =>
  (error as { name?: string })?.name === "ResourceNotFoundException" || (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;

function endpointSpec(spec: Project["spec"], resource: DeclaredResource) {
  const runtime = spec.runtimes.find((r) => r.name === resource.parent);
  const endpoint = runtime?.endpoints?.[resource.name];
  if (!runtime || !endpoint) throw new ProjectStateError(`endpoint '${resource.name}' of runtime '${resource.parent}' is not declared in agentcore.json`);
  return endpoint;
}

function parentRuntimeId(stack: AgentCoreStack, resource: DeclaredResource, { required }: { required: boolean }): string | undefined {
  const id = resource.parent === undefined ? undefined : stack.outputsOf(stepName("runtime", resource.parent))?.id;
  if (!id && required) throw new ProjectStateError(`runtime '${resource.parent}' has no deployed id yet; endpoint '${resource.name}' cannot be created`);
  return id;
}

async function getEndpoint(stack: AgentCoreStack, agentRuntimeId: string, endpointName: string): Promise<GetAgentRuntimeEndpointResponse | undefined> {
  try {
    return await stack.clients.control(stack.options()).send(new GetAgentRuntimeEndpointCommand({ agentRuntimeId, endpointName }));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export const endpointHandlers: KindHandlers = {
  poll(stack, resource, spec): Statuser {
    return async () => {
      const desired = endpointSpec(spec, resource);
      const runtimeId = parentRuntimeId(stack, resource, { required: true })!;
      const live = await getEndpoint(stack, runtimeId, resource.name);
      if (!live) return { status: Status.NotStarted };
      if (live.agentRuntimeEndpointArn && live.id) stack.record(stepOf(resource), { arn: live.agentRuntimeEndpointArn, id: live.id });
      const report = fromServiceStatus(live.status, { statusReason: live.failureReason });
      if (report.status !== Status.Successful) return report;
      const version = live.targetVersion ?? live.liveVersion;
      if (version !== String(desired.version)) return { status: Status.Outdated, detail: `points at version ${version}, want ${desired.version}` };
      if ((live.description ?? undefined) !== (desired.description ?? undefined)) return { status: Status.Outdated, detail: "description differs" };
      return { status: Status.Successful };
    };
  },
  create(stack, resource, spec): Doer {
    return async (ctx) => {
      const desired = endpointSpec(spec, resource);
      const runtimeId = parentRuntimeId(stack, resource, { required: true })!;
      const control = stack.clients.control(stack.options());
      const common = { agentRuntimeId: runtimeId, agentRuntimeVersion: String(desired.version), ...(desired.description !== undefined && { description: desired.description }) };
      if (await getEndpoint(stack, runtimeId, resource.name)) {
        ctx.report(`Updating endpoint ${resource.name} of runtime ${runtimeId}`);
        await control.send(new UpdateAgentRuntimeEndpointCommand({ ...common, endpointName: resource.name }));
        return;
      }
      ctx.report(`Creating endpoint ${resource.name} of runtime ${runtimeId}`);
      const created = await control.send(new CreateAgentRuntimeEndpointCommand({ ...common, name: resource.name, tags: stack.tags() }));
      if (created.agentRuntimeEndpointArn && created.id) stack.record(stepOf(resource), { arn: created.agentRuntimeEndpointArn, id: created.id });
    };
  },
  remove(stack, resource): Doer {
    return async (ctx) => {
      const runtimeId = parentRuntimeId(stack, resource, { required: false });
      if (!runtimeId) return;
      ctx.report(`Deleting endpoint ${resource.name} of runtime ${runtimeId}`);
      try {
        await stack.clients.control(stack.options()).send(new DeleteAgentRuntimeEndpointCommand({ agentRuntimeId: runtimeId, endpointName: resource.name }));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    };
  },
  pollGone(stack, resource): Statuser {
    return async () => {
      const runtimeId = parentRuntimeId(stack, resource, { required: false });
      if (!runtimeId) { stack.forget(stepOf(resource)); return { status: Status.Successful }; }
      const live = await getEndpoint(stack, runtimeId, resource.name);
      if (live) {
        if (live.status === "DELETING") return { status: Status.Waiting, detail: "DELETING" };
        return { status: Status.NotStarted };
      }
      stack.forget(stepOf(resource));
      return { status: Status.Successful };
    };
  },
};
```

- [ ] **Step 3: Run the tests**

Run: `bun test src/core/project/backends/imperative/agentcore/endpoint.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/project/backends/imperative/agentcore/endpoint.ts src/core/project/backends/imperative/agentcore/endpoint.test.ts
git commit -m "feat(imperative): runtime endpoint handlers"
```

---

### Task 8: Wire the kinds into the stack, plan, support gate and backend

**Files:**

- Modify: `src/core/project/backends/imperative/agentcore/stack.ts` (`StackScope.rootPath`, `artifacts`)
- Modify: `src/core/project/backends/imperative/agentcore/plan.ts` (`HANDLERS`)
- Modify: `src/core/project/backends/imperative/support.ts`, `support.test.ts`
- Modify: `src/core/project/backends/imperative.ts`, `imperative.test.ts`
- Modify: `src/core/project/backends/imperative/agentcore/stack.test.ts`, `plan.test.ts` (scopes gain `rootPath`)

**Interfaces:**

- Produces: `StackScope = NamingScope & { account: string; region: string; rootPath: string }`; `AgentCoreStack.artifacts: Map<string, CodeArtifact>`; `SUPPORTED_KINDS = {runtime, runtime-endpoint, memory}`; `ImperativeBackendConfig` gains `packager?: CodeZipPackager`, `runner?: ProcessRunner`, `checkTool?: (tool, hint) => Promise<void>`; `ImperativeBackend.build()` packages; `deploy()` stages artifacts.

- [ ] **Step 1: Stack**

In `stack.ts` add `rootPath: string` to `StackScope` with the comment `/** Absolute project root; kinds resolve codeLocation-relative files (additionalPolicies) against it. */`, and the field

```ts
  /** Uploaded CodeZip per runtime name, staged by the backend before the plan runs. */
  readonly artifacts = new Map<string, CodeArtifact>();
```

Add `rootPath: "/project"` to every scope literal in `stack.test.ts` and `plan.test.ts`. In `imperative.ts`, add `rootPath: project.rootPath` where `scope` is built.

- [ ] **Step 2: Handlers**

In `agentcore/plan.ts` import `memoryHandlers`, `runtimeHandlers`, `endpointHandlers` and set `runtime: runtimeHandlers`, `"runtime-endpoint": endpointHandlers`, `memory: memoryHandlers` in `HANDLERS`. Leave every other kind `notImplemented`.

- [ ] **Step 3: Support gate, tests first**

Extend `support.test.ts`:

```ts
test("supports runtime, runtime-endpoint and memory", () => {
  expect([...SUPPORTED_KINDS].sort()).toEqual(["memory", "runtime", "runtime-endpoint"]);
});
test.each([
  ["a Node runtime version", { runtimes: [{ ...codeZipRuntime, runtimeVersion: "NODE_22" }] }, /NODE_22/],
  ["an authorizer", { runtimes: [{ ...codeZipRuntime, authorizerType: "CUSTOM_JWT", authorizerConfiguration: {} }] }, /authorizer/],
  ["filesystem configurations", { runtimes: [{ ...codeZipRuntime, filesystemConfigurations: [{}] }] }, /filesystemConfigurations/],
  ["connections", { runtimes: [{ ...codeZipRuntime, connections: [{}] }] }, /connections/],
  ["memory stream delivery", { memories: [{ name: "m", eventExpiryDuration: 3, strategies: [], streamDeliveryResources: { resources: [] } }] }, /streamDeliveryResources/],
])("refuses %s before any AWS call", (_label, partial, pattern) => {
  expect(() => assertImperativelyDeployable(projectWith(partial), SUPPORTED_KINDS)).toThrow(pattern);
  expect(() => assertImperativelyDeployable(projectWith(partial), SUPPORTED_KINDS)).toThrow(NotImplementedError);
});
test("a CodeZip Python runtime with a memory and an endpoint passes", () => {
  expect(() => assertImperativelyDeployable(projectWith({ runtimes: [{ ...codeZipRuntime, endpoints: { prod: { version: 1 } } }], memories: [memory] }), SUPPORTED_KINDS)).not.toThrow();
});
```

(`codeZipRuntime`, `memory` and `projectWith` are the fixtures the existing file uses; reuse or add them.) Update the phase 1 test that asserted an empty `SUPPORTED_KINDS`. Then implement in `support.ts`:

```ts
export const SUPPORTED_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>(["runtime", "runtime-endpoint", "memory"]);

function unsupportedRuntimeFeature(runtime: Project["spec"]["runtimes"][number]): string | undefined {
  if (runtime.runtimeVersion?.startsWith("NODE_")) return `runtimeVersion ${runtime.runtimeVersion} (Node.js CodeZip runtimes)`;
  if (runtime.authorizerConfiguration || runtime.authorizerType) return "an authorizer (authorizerType / authorizerConfiguration)";
  if (runtime.filesystemConfigurations?.length) return "filesystemConfigurations";
  if (runtime.connections && Object.keys(runtime.connections).length > 0) return "connections";
  return undefined;
}
```

and, inside `assertImperativelyDeployable` after the container check and before the kind check:

```ts
  for (const runtime of project.spec.runtimes) {
    const feature = unsupportedRuntimeFeature(runtime);
    if (feature) {
      throw new NotImplementedError(
        `Project '${project.name}' cannot be deployed imperatively: runtime '${runtime.name}' uses ${feature}, ` +
          `which imperative deploy does not support yet. ${CDK_ESCAPE_HATCH}`,
      );
    }
  }
  const streaming = project.spec.memories.find((memory) => memory.streamDeliveryResources);
  if (streaming) {
    throw new NotImplementedError(
      `Project '${project.name}' cannot be deployed imperatively: memory '${streaming.name}' declares streamDeliveryResources, ` +
        `which imperative deploy does not support yet. ${CDK_ESCAPE_HATCH}`,
    );
  }
```

Check the actual shape of `connections` in `ProjectRuntimeSchema` (array or record) and test the truthy case accordingly.

- [ ] **Step 4: Backend tests first**

In `imperative.test.ts` the existing fixtures pass `handlers` fakes and `supportedKinds`; keep that. Add a `packager` fake and an `s3` fake to the backend config in the shared `backend()` helper:

```ts
const packaged: string[] = [];
const packager: CodeZipPackager = async ({ codeDir, buildDir, report }) => {
  packaged.push(codeDir);
  report?.("Resolved 1 package");
  return { zipPath: join(buildDir, "code.zip"), sizeBytes: 3, sha256: "deadbeef" };
};
const s3 = fakeClient({ HeadBucketCommand: () => ({}), HeadObjectCommand: () => { throw sdkError("NotFound", 404); }, PutObjectCommand: () => ({}) });
// clients.s3 = () => s3 as unknown as S3Client; uploadArtifact reads the zip from disk: have the packager fake write it
```

New tests:

```ts
test("build packages every CodeZip runtime and uploads nothing", async () => {
  // project with two CodeZip runtimes; collect events from backend.build(project)
  // expect packaged to equal both code dirs (rootPath/codeLocation), events to contain task-start/task-done with id "package:<runtime>",
  // and s3.sent to be empty
});
test("deploy packages before provisioning credentials and uploads before the plan runs", async () => {
  // order-recording fakes: packager pushes "package", provisionCredentials pushes "provision", s3 PutObject pushes "upload", runtime handler create pushes "create"
  // expect order ["package", "provision", "upload", "create"]
  // expect PutObjectCommand Key === "orders/staging/agent/deadbeef.zip", Bucket === "agentcore-cli-111122223333-us-west-2"
  // expect the runtime handler saw stack.artifacts.get("agent") === { bucket, key, sha256: "deadbeef", sizeBytes: 3 }
});
test("deploy skips the upload when the object already exists", ...);   // HeadObjectCommand → {} ; no PutObjectCommand; still records artifact
test("a packaging failure stops the deploy before credentials are provisioned", ...); // packager throws → rejects; provisionCredentials never called; s3.sent empty
test("a teardown deploy does not package or touch S3", ...);           // spec with no resources, ledger with a runtime → confirmTeardown called; packaged empty; s3.sent empty
```

Run: `bun test src/core/project/backends/imperative.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 5: Backend implementation**

`imperative.ts` additions:

```ts
import { join } from "node:path";
import type { ProcessRunner } from "../../../io/exec";
import { requireTool, runProcess } from "../../../io/exec";
import { artifactBucketName, artifactKey, ensureArtifactBucket, uploadArtifact, type CodeArtifact } from "./imperative/artifacts";
import { ownershipTags } from "./imperative/naming";
import { packagePythonCodeZip, type CodeZipPackager, type PackagedCode } from "./imperative/packaging/python";

// config
  packager?: CodeZipPackager;
  runner?: ProcessRunner;
  checkTool?: (tool: string, installHint: string) => Promise<void>;

// fields + constructor
  private readonly packager: CodeZipPackager;
  private readonly runner: ProcessRunner;
  private readonly checkTool: (tool: string, installHint: string) => Promise<void>;
    this.packager = config.packager ?? packagePythonCodeZip;
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    assertImperativelyDeployable(project, this.supportedKinds);
    yield* this.packageRuntimes(project);
  }

  /** Packages every CodeZip runtime under agentcore/.cli/build/<runtime>/; yields one task per runtime. */
  private async *packageRuntimes(project: Project): AsyncGenerator<ProjectEvent, Map<string, PackagedCode>> {
    const packaged = new Map<string, PackagedCode>();
    for (const runtime of project.spec.runtimes) {
      if (runtime.build !== "CodeZip") continue;
      const id = `package:${runtime.name}`;
      yield { type: "task-start", id, title: `Packaging runtime '${runtime.name}'` };
      const lines: string[] = [];
      try {
        const result = await this.packager({
          codeDir: join(project.rootPath, runtime.codeLocation),
          runtimeVersion: runtime.runtimeVersion ?? "",
          buildDir: join(project.rootPath, "agentcore", ".cli", "build", runtime.name),
          run: this.runner,
          checkTool: this.checkTool,
          report: (line) => lines.push(line),
        });
        // Lines are buffered because a generator cannot yield from inside the callback.
        for (const line of lines) yield { type: "task-output", id, line };
        yield { type: "task-output", id, line: `${(result.sizeBytes / 1024 / 1024).toFixed(1)} MiB, sha256 ${result.sha256.slice(0, 12)}` };
        yield { type: "task-done", id };
        packaged.set(runtime.name, result);
      } catch (error) {
        for (const line of lines) yield { type: "task-output", id, line };
        yield { type: "task-failed", id, message: error instanceof Error ? error.message : String(error) };
        throw error;
      }
    }
    return packaged;
  }

  private async *stageArtifacts(
    plans: Plans, packaged: Map<string, PackagedCode>, target: AwsDeploymentTarget, credentials: AwsCredentials,
  ): AsyncGenerator<ProjectEvent, void> {
    if (packaged.size === 0) return;
    const s3 = this.clients.s3({ region: target.region, credentials });
    const bucket = artifactBucketName(target.account, target.region);
    yield { type: "step", message: `Uploading code to s3://${bucket}` };
    const { created } = await ensureArtifactBucket(s3, { bucket, region: target.region, tags: ownershipTags(plans.stack.scope) });
    if (created) yield { type: "output", line: `Created bucket ${bucket} (public access blocked)` };
    for (const [name, code] of packaged) {
      const key = artifactKey(plans.stack.scope, name, code.sha256);
      const { uploaded } = await uploadArtifact(s3, { bucket, key, zipPath: code.zipPath });
      yield { type: "output", line: `${name}: ${uploaded ? "uploaded" : "already present"} ${key}` };
      const artifact: CodeArtifact = { bucket, key, sha256: code.sha256, sizeBytes: code.sizeBytes };
      plans.stack.artifacts.set(name, artifact);
    }
  }
```

In `deploy()`:

- after the `hasCdkBinding` check and `const recorded = ...`, before `provisionCredentials`: `const packaged = yield* this.packageRuntimes(project);`
- after the `plans.declared.length === 0` block (so teardowns never touch S3) and before the Transaction Search block: `yield* this.stageArtifacts(plans, packaged, target, credentials);`
- add `rootPath: project.rootPath` to the scope literal.

`AwsCredentials` is imported from `../../types`. If the `progress` driver drops `task-output` lines that arrive after `task-start` without a live TTY, that is fine; the plain path prints them.

- [ ] **Step 6: Verify**

Run: `bun run typecheck && bun test src/core/project/backends && bun run lint:check`
Expected: PASS, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/core/project/backends/imperative.ts src/core/project/backends/imperative.test.ts src/core/project/backends/imperative/
git commit -m "feat(imperative): stage CodeZip artifacts and register runtime, endpoint and memory kinds"
```

---

### Task 9: `project create --managed-by`

**Files:**

- Modify: `src/handlers/project/types.ts` (`CreateProjectInputBase`)
- Modify: `src/handlers/project/create/index.ts`
- Modify: `src/core/project/templates/project.ts` (`createProjectTree`)
- Modify: `src/core/project/manager.tsx` (`create`, `checkCreateDependencies`)
- Test: `src/handlers/project/create/index.test.ts`, `src/core/project/templates/project.test.ts` (if present; else the manager test that covers create)

**Interfaces:**

- Produces: `CreateProjectInputBase.managedBy?: ManagedBy` (default `"CDK"`); `createProjectTree(config, { projectName, managedBy? }, options?)`; flag `--managed-by <CDK|Imperative>`.

- [ ] **Step 1: Handler tests first**

In `create/index.test.ts`, following the file's existing fixtures (`TestGlobalConfigAccessor`, the fake project manager that records `create` calls):

```ts
test("--managed-by Imperative is refused while the flag is off", async () => {
  const { run, manager } = setup({ globalConfig: { ...DEFAULT_GLOBAL_CONFIG, "imperative-deploy": false } });
  await expect(run(["--name", "orders", "--template", "empty", "--managed-by", "Imperative"])).rejects.toThrow(/agentcore config imperative-deploy true/);
  expect(manager.calls).toHaveLength(0);
});
test("--managed-by Imperative is passed to the manager when the flag is on", async () => {
  const { run, manager } = setup({ globalConfig: { ...DEFAULT_GLOBAL_CONFIG, "imperative-deploy": true } });
  await run(["--name", "orders", "--template", "empty", "--managed-by", "Imperative"]);
  expect(manager.calls[0]!.input.managedBy).toBe("Imperative");
});
test("managedBy defaults to CDK", async () => {
  const { run, manager } = setup();
  await run(["--name", "orders", "--template", "empty"]);
  expect(manager.calls[0]!.input.managedBy).toBe("CDK");
});
```

Adapt `setup(...)`/`manager.calls` to the names the file already uses.

- [ ] **Step 2: Handler**

`types.ts`:

```ts
import type { ManagedBy } from "../../projectSchemas/project";
  /** Which backend deploys the project; scaffolds the CDK app only for "CDK". Default "CDK". */
  managedBy?: ManagedBy;
```

`create/index.ts`: import `GlobalConfigAccessorKey` from `../../../router` and `ManagedBySchema` from `../../../projectSchemas/project`; add the flag

```ts
      flag(
        "managed-by",
        "how the project is deployed: CDK (CloudFormation via the AgentCore CDK app) or Imperative (direct AWS API calls; requires 'agentcore config imperative-deploy true')",
        ManagedBySchema,
      ),
```

and in `handle`, before `assertProjectPathFits`:

```ts
      const managedBy = flags["managed-by"];
      if (managedBy === "Imperative") {
        const globalConfig = await ctx.require(GlobalConfigAccessorKey).get();
        if (!globalConfig["imperative-deploy"]) {
          throw new InputValidationError(
            "--managed-by Imperative requires imperative deploy to be enabled. Run 'agentcore config imperative-deploy true' first.",
          );
        }
      }
      if (!flags["skip-install"] && managedBy === "CDK") { assertProjectPathFits(...) }   // the Windows path limit only bites the CDK node_modules
```

and add `managedBy` to `base`.

- [ ] **Step 3: Template and manager**

`templates/project.ts`: signature `input: { projectName: string; managedBy?: ManagedBy }`; `managedBy: input.managedBy ?? "CDK"` in the JSON; include the `cdk` directory node only when `managedBy !== "Imperative"`:

```ts
    FsTreeNode.createDirectory("agentcore", [
      ...(managedBy === "Imperative" ? [] : [await FsTreeNode.fromAssetSource({ assetSource: config.assetSource }, { assetDir: "cdk" })]),
      FsTreeNode.createFile("agentcore.json", ...),
```

`manager.tsx` `create()`: pass `managedBy: input.managedBy` into `createProjectTree`; guard the npm step:

```ts
    if (!input.skipInstall) {
      if (input.managedBy !== "Imperative") {
        yield { type: "step", message: "Installing CDK dependencies with npm" };
        yield* this.run(NPM_INSTALL, join(destination, "agentcore", "cdk"), npmProgressLine);
      }
      if (scaffoldRuntimeInput) { ... unchanged ... }
    }
```

`checkCreateDependencies`: require `npm` only when `input.managedBy !== "Imperative"`.

Add manager-level tests next to the existing create tests (the file that asserts the `npm install` command today): "an Imperative project has managedBy Imperative, no agentcore/cdk directory, and runs no npm command"; "a CDK project is unchanged".

- [ ] **Step 4: Verify and commit**

Run: `bun run typecheck && bun test src/handlers/project/create src/core/project && bun run lint:check`
Expected: PASS.

```bash
git add src/handlers/project/types.ts src/handlers/project/create/index.ts src/handlers/project/create/index.test.ts src/core/project/templates/project.ts src/core/project/manager.tsx src/core/project/manager.test.tsx
git commit -m "feat(project): create --managed-by Imperative scaffolds without the CDK app"
```

(Adjust the test file names to the ones you touched.)

---

### Task 10: End-to-end golden path

**Files:**

- Modify: `e2eTest/constants.ts` (`TAGS.IMPERATIVE`)
- Create: `e2eTest/project/imperative.test.ts`

**Interfaces:**

- Consumes: `CliRunner`, `parseResult`, `E2E_PREFIX`, `TAGS`; the CLI built at `AGENTCORE_CLI_PATH`; AWS credentials in the environment for the target account.
- The runtime created by `project create --template agent-python-strands` is named `agent` (`DEFAULT_CREATE_RUNTIME_NAME`) with memory `agentMemory`.

- [ ] **Step 1: Tag**

```ts
export const TAGS = {
  RUNTIME: "runtime",
  IMPERATIVE: "imperative",
} as const;
```

- [ ] **Step 2: Test**

`e2eTest/project/imperative.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import z from "zod";
import { E2E_PREFIX, TAGS } from "../constants";
import { CliRunner, parseResult } from "../helpers/run";

const TIMEOUT_MS = { CREATE: 3 * 60 * 1000, DEPLOY: 15 * 60 * 1000, INVOKE: 3 * 60 * 1000, TEARDOWN: 10 * 60 * 1000 };

const ProjectCreatedSchema = z.object({ project: z.object({ path: z.string() }) });
const DeployResponseSchema = z.object({ message: z.string() });
const StatusSchema = z.object({
  resources: z.array(z.object({ resourceType: z.string(), name: z.string(), deploymentState: z.string() })),
});
const InvokeSchema = z.object({ statusCode: z.number().int().min(200).max(299), body: z.string().min(1), complete: z.literal(true) });

describe("imperative deploy golden path", { sequential: true, tags: [TAGS.IMPERATIVE] }, () => {
  const cli = new CliRunner();
  const projectName = `${E2E_PREFIX}imp${Date.now().toString(36)}`;
  let projectRoot: string;
  let projectDir: string;

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "agentcore-e2e-imperative-"));
    parseResult(z.literal(true), await cli.run(["config", "imperative-deploy", "true", "--json"], projectRoot));
    const created = parseResult(
      ProjectCreatedSchema,
      await cli.run(["project", "create", "--name", projectName, "--template", "agent-python-strands", "--managed-by", "Imperative", "--skip-git", "--json"], projectRoot),
    );
    projectDir = created.project.path;
  }, TIMEOUT_MS.CREATE);

  afterAll(async () => {
    await cli.run(["config", "imperative-deploy", "false", "--json"], projectRoot);
  });

  test("deploys a runtime and its memory", { timeout: TIMEOUT_MS.DEPLOY }, async () => {
    const deployed = parseResult(DeployResponseSchema, await cli.run(["project", "deploy", "--yes", "--json"], projectDir));
    expect(deployed.message).toContain("Deployed project");
  });

  test("reports every resource as deployed", async () => {
    const status = parseResult(StatusSchema, await cli.run(["project", "status", "--json"], projectDir));
    const byName = Object.fromEntries(status.resources.map((r) => [`${r.resourceType}:${r.name}`, r.deploymentState]));
    expect(byName["runtime:agent"]).toBe("deployed");
    expect(byName["memory:agentMemory"]).toBe("deployed");
  });

  test("invokes the runtime", { timeout: TIMEOUT_MS.INVOKE }, async () => {
    const response = parseResult(
      InvokeSchema,
      await cli.run(["project", "invoke", "runtime", "--name", "agent", "--session-id", `${projectName}-session-0000000000000000`, "--payload", JSON.stringify({ prompt: "Reply with a short greeting." }), "--json"], projectDir),
    );
    expect(response.body.trim().length).toBeGreaterThan(0);
  });

  test("a second deploy converges without changes", { timeout: TIMEOUT_MS.DEPLOY }, async () => {
    const deployed = parseResult(DeployResponseSchema, await cli.run(["project", "deploy", "--yes", "--json"], projectDir));
    expect(deployed.message).toContain("Deployed project");
  });

  test("removing every resource and deploying tears the target down", { timeout: TIMEOUT_MS.TEARDOWN }, async () => {
    parseResult(z.object({}).passthrough(), await cli.run(["project", "remove", "all", "--yes", "--json"], projectDir));
    const result = parseResult(DeployResponseSchema, await cli.run(["project", "deploy", "--yes", "--json"], projectDir));
    expect(result.message.toLowerCase()).toMatch(/removed|torn down|tore down|deleted/);
  });
});
```

Check the exact `--json` output of `agentcore config <key> <value>` (it renders the coerced value, so `true`), of `project status --json` (`{ resources: [...] }` per `status/index.ts`), of `project remove all --json`, and the session id length rule for `project invoke runtime` (the existing templates test is the reference) and adjust the schemas.

- [ ] **Step 3: Run it against the test account**

```bash
bun run build
ada credentials update --account 998846730471 --provider isengard --role Admin --once   # or export the printed credentials
AGENTCORE_CLI_PATH="node $PWD/dist/index.js" bun run test:e2e -- --tagsFilter='imperative'
```

Expected: all five tests pass; afterwards `aws bedrock-agentcore-control list-agent-runtimes` shows no `e2eimp…` runtime and `aws iam list-roles` shows no `e2eimp…_runtime_role`. Fix whatever breaks (this is where the real service disagrees with the plan: policy actions, propagation timing, status names) and fold the fix into the owning module with a unit test.

- [ ] **Step 4: Commit**

```bash
git add e2eTest/constants.ts e2eTest/project/imperative.test.ts
git commit -m "test(e2e): imperative deploy golden path (create, deploy, status, invoke, teardown)"
```

---

### Task 11: Verify, push, open the stacked PR

- [ ] **Step 1: Full verification**

```bash
bun run typecheck && bun test && bun run lint:check
git ls-files -z | grep -zv '^CLAUDE.md$' | xargs -0 bunx prettier --check
```

Expected: 0 failures; prettier clean on tracked files. Compare the test count against the phase 1 tip (3686 / 253) and record the new numbers in the PR body.

- [ ] **Step 2: Push and open the PR on the fork**

```bash
git push -u origin feat/imperative-deploy-runtime-memory
gh pr create --repo notgitika/agentcore-cli --base feat/imperative-deploy-engine --head feat/imperative-deploy-runtime-memory \
  --title "feat(imperative): CodeZip runtimes, endpoints and memories deploy end to end (phase 2)" --body-file /tmp/pr2-body.md
```

The body lists: what lands (packaging, artifacts, IAM, three kinds, staging pass, `--managed-by`), the e2e evidence (account, region, runtime and memory ids created and deleted, invoke response), test counts, the deviations from L3 kept on purpose (unconditioned memory namespace grant; no `clientToken`), and the stack (`#6 → #7 → this`).

- [ ] **Step 3: Docs**

Upload this plan to the Artifactory cluster `56917e73-8451-461b-9df2-7420ab9aa03d` (the design doc and the phase 0 and 1 plans already live there) and note the artifact id in the PR body. Do not add docs commits to the code branch.
