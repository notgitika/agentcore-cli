# Imperative deploy: codebase context and prior art

- Date: 2026-09-24
- Branch: `refactor` (`upstream/refactor` at `326bc9ef`), worktree `/Volumes/workplace/agentcore/.worktrees/imperative-deploy`
- Status: research complete, design not started
- Companions: `docs/superpowers/specs/2026-09-24-imperative-deploy-design.md` (written after the design is approved in chat), `docs/superpowers/plans/` (written after the spec is approved)

## 1. Goal

Add a second `ProjectBackend` that deploys a project by calling AWS APIs directly
(Bedrock AgentCore control plane, IAM, S3) instead of synthesizing CloudFormation
and driving the CDK Toolkit. Everything lands behind a new global-config feature
flag. Work proceeds in phases: types, relationships and the execution engine
first; per-resource steps later, stubbed as not-implemented until then.

## 2. Prior art: LightPress (`AlricheyWPPlayground`)

A Go proof of concept (2022) that stands up a WordPress stack on Lightsail using
only Lightsail APIs. Four files: `plan/plan.go` (engine), `lightpress/lightpress.go`
(the graph and the Lightsail calls), `cmd/lp/main.go`, `README.md`.

### 2.1 Model

```go
type Status string // NOT_STARTED | WAITING | SUCCESSFUL | FAILED

type Step struct {
    Name   string
    Do     func(context.Context) error            // mutate
    Status func(context.Context) (Status, error)  // observe
    Next   []*Step                                 // downstream steps
}

type Plan struct { Name string; Steps []*Step }
```

### 2.2 Execution (`plan.go`)

1. `validate()`: every step has `Do` and `Status`; a visit counter over 100 is
   treated as a cycle. The same walk computes each step's in-degree
   (`expectedCallCount`).
2. `Execute()`: parallel BFS. Roots are queued; every dequeued step runs in its
   own goroutine. A step with several parents only runs once its in-degree
   reaches zero (join semantics).
3. Per step (`run()`), loop: call `Status`.
   - `NOT_STARTED` → call `Do`, then poll again. If `Status` still says
     `NOT_STARTED` after `Do` a second time → `ErrStepNotStarted`.
   - `WAITING` → sleep 1s, poll again.
   - `SUCCESSFUL` → enqueue `Next`.
   - `FAILED` → return error.
4. On any step error: steps already started finish, no new steps start, the
   plan returns "completed with errors". No rollback.

### 2.3 Properties the README claims

Idempotent (same inputs, same result, no error), self-healing (deleted parts are
recreated on the next run), fault tolerant (kill and restart resumes; no
rollback of progress), customizable.

### 2.4 What to borrow

- The observe-then-act reconcile loop per resource, where `Status` is both the
  existence check and the readiness waiter.
- A DAG with join semantics and explicit dependencies between resources.
- Resumability: re-running the deploy converges without undoing earlier work.
- The "apply did not take effect" guard after `Do`.

### 2.5 What not to copy

- Cross-step values travel in an untyped shared `map[string]string`
  (`w.data["hostedZone"]`). Outputs need typed contracts.
- Not-found is detected by substring matching on error messages.
- `Status` only checks existence (plus one hand-rolled origin check), so a
  changed property never triggers an update.
- No delete or orphan handling at all.
- Unbounded goroutines, a racy `isError` flag, a fixed 1s sleep, no per-step
  timeout, logging straight to stderr.

## 3. How deploy works today on `refactor`

### 3.1 Call chain

`src/index.ts` → `src/handlers/index.tsx` → `src/handlers/project/index.ts`
(`withProject` resolves the enclosing project) →
`src/handlers/project/deploy/index.ts` → `FsProjectManager.deploy`
(`src/core/project/manager.tsx:971`) → `CdkBackend.deploy`
(`src/core/project/backends/cdk.ts:261`).

The deploy handler settles the teardown question before the progress UI mounts
(`resolveTeardownDecision`, deploy/index.ts:144), reads the global config for
`transactionSearch`, and drains the generator through `runWithProgress`
(`src/tui/progress.tsx:129`). Progress goes to stderr; stdout stays machine
readable; `--json` forces the plain path.

### 3.2 The seam: `ProjectBackend` (verbatim, `src/core/project/backends/types.ts`)

```ts
export type DeployBackendInput = {
  /** Fully resolved account and region selected from aws-targets.json. */
  target: AwsDeploymentTarget;
  /** Requests approval after synthesis identifies a teardown. */
  confirmTeardown: TeardownConfirmationHandler;
  /** Whether to enable CloudWatch Transaction Search on deploy (global config). */
  transactionSearch?: boolean;
};

export type ResolveDeployedResourcesBackendInput = { target: AwsDeploymentTarget };
export type ResolveProjectResourcesBackendInput = { target: AwsDeploymentTarget };

/** Builds the deployable artifacts owned by a project's selected backend. */
export interface ProjectBackend {
  build(project: Project): AsyncGenerator<ProjectEvent, void>;
  deploy(project: Project, input: DeployBackendInput): AsyncGenerator<ProjectEvent, DeployResult>;
  resolveDeployedResources(
    project: Project,
    input: ResolveDeployedResourcesBackendInput,
  ): Promise<ResolvedDeployedResource[]>;
  /**
   * Reports every resource the project declares against the target, including the
   * ones it has not deployed.
   *
   * TODO: merge resolveDeployedResources and resolveProjectResources; the two are
   * similar enough that one resolver should serve both invoke and status.
   */
  resolveProjectResources(
    project: Project,
    input: ResolveProjectResourcesBackendInput,
  ): Promise<ResolvedProjectResource[]>;
}
```

Return types (`src/handlers/project/types.ts`):

```ts
export type ProjectEvent = ProgressEvent; // { type: "step" | "output" | "warning" ... }

export type DeployResult = {
  outputs: Record<string, string>; // backend-specific; callers render, never index
  tornDown?: boolean;
};

export type ResolvedDeployedResource = {
  resourceType: ProjectInvokableResource; // "runtime" | "harness"
  name: string;
  id: string;
  target: AwsDeploymentTarget;
  credentialProvider: AwsCredentialProvider;
};

export type DeployableResource =
  | "runtime"
  | "harness"
  | "memory"
  | "knowledge-base"
  | "credential"
  | "evaluator"
  | "online-eval"
  | "gateway"
  | "gateway-target"
  | "policy-engine"
  | "policy"
  | "config-bundle"
  | "payment-manager"
  | "payment-connector"
  | "runtime-endpoint";

export type ResolvedProjectResource = {
  resourceType: DeployableResource;
  name: string;
  children?: ResolvedProjectResource[];
} & (
  | { deploymentState: "deployed"; arn: string }
  | { deploymentState: "deployed"; id: string }
  | { deploymentState: "local-only" }
);
```

### 3.3 Backend selection and manager wiring

- `ManagedBySchema = z.enum(["CDK"]).default("CDK")` in
  `src/projectSchemas/project.ts:16`; `spec.managedBy` selects the backend.
- `FsProjectManager` holds `backends: Partial<Record<ManagedBy, ProjectBackend>>`
  and defaults to `{ CDK: new CdkBackend({...}) }` (manager.tsx:168).
  `backendFor(project)` throws `ProjectStateError("... declares an unsupported
backend: ...")` for an unknown value (manager.tsx:1160).
- `FsProjectManager.deploy` resolves the named target from
  `agentcore/aws-targets.json` (synthesizing `default` from STS + region on
  first deploy, never a named target) and hands the backend a fully resolved
  `AwsDeploymentTarget`. The backend owns everything after that.
- `CoreClient` (`src/core/index.tsx:133`) constructs the manager with
  `identity: this.identity` and an `enableTransactionSearch` closure over
  `this.observability`. The manager currently has no access to global config.

### 3.4 `CdkBackend.deploy`, step by step (`cdk.ts:261`)

1. `Verifying AWS account` — resolve credentials via toolkit-lib's aws-cli
   compatible chain, `GetCallerIdentity`, refuse if account ≠ target.account.
2. `ensureCdkDependencies` — `agentcore/cdk/node_modules` exists, `npm` on PATH.
3. Read `deployed-state.json`; compute `orphanedCredentials(recorded, spec)`.
4. `provisionCredentials` (imperative, see 3.6); write results to state.
5. `synthesize` — `npm run cdk -- synth --quiet --output agentcore/cdk/cdk.out`.
6. `stackArtifactForTarget` — the one stack tagged `agentcore:target-name=<t>`.
7. `countDeployableResources === 0` → `teardown` (confirm, `cdk destroy`,
   remove credentials, remove target state, return `{ tornDown: true }`).
8. `Enabling CloudWatch Transaction Search` (best effort, skipped on error).
9. Bootstrap probe: `CDKToolkit` stack, `BootstrapVersion >= 30`, bootstrap if
   absent or outdated.
10. `Deploying <artifact>` via `@aws-cdk/toolkit-lib` in process
    (`cdk/toolkit.ts:191`); ioHost lines become `output` events.
11. Record `stackArn` in state; `removeCredentials(orphaned)`;
    `reportPaymentConnectorAuthorizationUrls`; return `{ outputs }`.

`build` = steps 2 and 5 only. Nothing in the CLI zips code, builds images, or
pushes to ECR; all of that happens inside the CDK app (section 6).

`resolveDeployedResources` / `resolveProjectResources` (cdk.ts:482, 516):
`DescribeStacks` on the recorded stack ARN and match `Outputs[].ExportName`
(payments by `OutputKey`); credentials come from the state file.

### 3.5 Deployed state file (`src/core/project/backends/cdk/deployedState.ts`)

- Path `agentcore/.cli/deployed-state.json`, committed to git (the scaffolded
  `.gitignore` keeps this one file). Written atomically (temp + rename).
- Shape (every level `.passthrough()` so unknown keys survive a rewrite):

```ts
DeployedStateSchema = { targets: Record<string, TargetState> }
TargetState = { stackArn?: string; resources?: ResourceState }
ResourceState = { credentials?: Record<string, CredentialState>; stackName?: string }
CredentialState = { credentialProviderArn: string; clientSecretArn?: string; authorizerType?: ... }
```

- `updateTargetState(json, root, targetName, patch)` merges shallowly, one level
  deep under `resources` (a resource map in the patch replaces that kind
  wholesale). `removeTargetState` drops a target. Sequential use only.
- The published `@aws/agentcore-cdk` `DeployedStateSchema` additionally allows
  `runtimes`, `memories`, `mcp`, `policyEngines`, `policies`, `configBundles`,
  `externallyManaged` under `resources`, but no construct reads them today. This
  is a ready-made place for an imperative backend to record per-resource IDs.

### 3.6 Existing imperative precedent: credential providers (`cdk/credentials.ts`)

Already fully imperative and the closest thing to the pattern we want:

- Provider name `${projectName}_${targetName}_${credentialName}`, max 128
  chars, validated for every credential before the first AWS call.
- Per credential: `Get*` (not-found → absent), then decide
  `Provision = { reuse } | { kind: "create" | "update"; write }`. All decisions
  are made before any write, so a missing secret fails before the first
  mutation.
- Existing provider with a different vendor → `ProjectStateError` (refuses to
  adopt an unrelated resource with the same name).
- Writes run in order; `created` is recorded before each create call; on error
  `rollback` deletes only what this run created, newest first, reporting rather
  than throwing on a failed delete.
- `orphanedCredentials(recorded, declared)` finds recorded providers the spec no
  longer declares; the deploy deletes them after the stack update; teardown
  deletes declared plus orphaned.
- Narrowed dependency type `CredentialProviderCalls = Pick<CoreIdentityClient, ...>`
  so tests fake six calls, not ten.

### 3.7 Transaction Search (`src/core/observability/client.ts`, imperative, reusable)

`ApplicationSignals.StartDiscovery`, `Logs.PutResourcePolicy`
(`TransactionSearchXRayAccess`), `XRay.UpdateTraceSegmentDestination`
(CloudWatchLogs), `XRay.UpdateIndexingRule` (100%). Skipped when already
active. Called by the manager-provided closure with the target's credentials.

### 3.8 Progress event contract (`src/tui/progress.tsx`)

```ts
export type ProgressEvent =
  | { type: "step"; message: string } // starts a step and completes the previous one
  | { type: "output"; line: string } // belongs to the current step (tail of 5 lines)
  | { type: "warning"; message: string };
```

The model is strictly linear: a new `step` marks the previous one done. Nothing
supports concurrent steps. `withOutputEvents` (`src/core/project/events.ts`)
bridges push-style line sources into the pull-based generator.

### 3.9 Core client, sub-clients, factories

- `CoreClient` (`src/core/index.tsx`) implements `AwsClients`: cached SDK
  clients per `{ region, endpoint }` per credentials identity for `control`
  (`BedrockAgentCoreControlClient`), `data`, `iam`, `logs`, `xray`,
  `applicationSignals`. CloudFormation has a separate factory type.
- Sub-clients (`src/core/{identity,memory,runtime,gateway,harness,policy,eval,payment}.tsx`)
  take `Pick<AwsClients, ...>` and expose one method per operation:
  `this.clients.control(toClientConfig(options)).send(new XCommand(input))`.
  Every method takes a trailing `CoreOptions = { region, endpointUrl?, credentials? }`.
- Handler-facing interfaces live in `src/handlers/<feature>/types.tsx`
  (e.g. `CoreIdentityClient`); `src/core/*.tsx` implement them.
- Production factories in `src/core/factories.tsx` are one-liners so the test
  fixture layer can reuse them in record mode.
- There is no shared retry, waiter, or polling helper anywhere in the CLI.

### 3.10 Testing conventions

- `bun test`, tests colocated as `*.test.ts(x)`. `createSilentLogger` and other
  helpers in `src/testing/`.
- Hand-written fakes over narrowed interfaces (see `CredentialProviderCalls`).
- Golden-file record/replay at the SDK `.send()` seam (`src/testing/fixtures.tsx`):
  `RECORD=1 bun test` hits live AWS through the real factories and writes
  `<dir>/<Operation>.<inputHash>.json`; plain `bun test` replays. `clientToken`
  is stripped from the fixture key. `settle(ms)` sleeps only while recording.
- No `aws-sdk-client-mock`.

### 3.11 Feature flag mechanism (`src/globalConfig/`)

Confirmed: commit `07352883 feat(gateway): gate imperative mutations behind
config (#2368)` added the pattern.

```ts
// types.tsx
export const globalConfigFileSchema = z.object({
  "imperative-mutation-commands": z.boolean().optional(),
  telemetry: z.object({ enabled, endpoint, audit }).optional(),
  installationId: z.uuid().optional(),
  transactionSearch: z.boolean().optional(),
});
// config.tsx: DEFAULT_GLOBAL_CONFIG sets "imperative-mutation-commands": false;
// applyOverrides merges field by field.
```

Consumers read the resolved config once at startup
(`src/handlers/gateway/index.tsx:19`) and pass a boolean down to router
factories, which register mutation handlers only when it is true. Handlers can
also read it from context via `GlobalConfigAccessorKey` (deploy handler does
for `transactionSearch`). A new flag means: schema field, default, `applyOverrides`
line, config tests, and threading the boolean to where the backend map is built.

## 4. Project resource model

`ProjectSpecSchema` (`src/projectSchemas/project.ts`): `name` (≤23,
`^[A-Za-z][A-Za-z0-9]{0,22}$`), `version: 2`, `managedBy`, `tags?`, and the
collections `runtimes`, `memories`, `knowledgeBases`, `credentials`,
`evaluators`, `onlineEvalConfigs`, `agentCoreGateways`, `toolRuntimes?`,
`policyEngines`, `configBundles`, `harnesses`, `payments?`. Cross-references are
validated in `superRefine` (gateway → policy engine, gateway httpRuntime target →
runtime and endpoint, connector → knowledge base, payment connector → credential).

Runtime (`src/projectSchemas/runtime.ts`): `name` (≤48,
`^[a-zA-Z][a-zA-Z0-9_]{0,47}$`), `build: "CodeZip" | "Container"`,
`entrypoint` (`main.py[:handler]` or `.ts/.js`), `codeLocation`, `dockerfile?`,
`buildContextPath?`, `customDockerBuildArgs?`, `runtimeVersion` (required for
CodeZip: `PYTHON_3_10..3_14`, `NODE_18/20/22`), `envVars?`, `networkMode?`
(`PUBLIC | VPC`) + `networkConfig?`, `instrumentation.enableOtel` (default true),
`protocol?` (`HTTP | MCP | A2A | AGUI`), `requestHeaderAllowlist?`,
`executionRoleArn?`, `additionalPolicies?`, `authorizerType?` +
`authorizerConfiguration?`, `tags?`, `lifecycleConfiguration?`,
`filesystemConfigurations?`, `endpoints?: Record<name, { version, description? }>`,
`connections?`.

Targets (`src/projectSchemas/aws-targets.ts`): `{ name, description?, account,
region }`; name `^[a-zA-Z][a-zA-Z0-9]*$` ≤64; region from the AgentCore region
enum; `default` is the only target synthesized on demand. The schema comment
says "the target is the middle segment of every deployed resource name", but
the L3 library only does that for credential providers (section 6.9).

Scaffolded project layout: `agentcore/agentcore.json`, `agentcore/aws-targets.json`,
`agentcore/.env.local` (secrets), `agentcore/.cli/deployed-state.json`,
`agentcore/.cache/` (packaging staging), `agentcore/cdk/` (vended CDK app:
`bin/cdk.ts`, `lib/cdk-stack.ts`, `package.json` pinning `@aws/agentcore-cdk`),
`app/<runtime>/` (agent code).

## 5. Control-plane SDK surface (`@aws-sdk/client-bedrock-agentcore-control` 3.1115)

Create/Get/Update/Delete/List exist for: AgentRuntime, AgentRuntimeEndpoint,
Memory, Gateway, GatewayTarget, GatewayRule, GatewayRateLimit, PolicyEngine,
Policy, Evaluator, OnlineEvaluationConfig, ConfigurationBundle, Harness,
HarnessEndpoint, PaymentManager, PaymentConnector, ApiKey/Oauth2/Payment
CredentialProvider, WorkloadIdentity, CapacityProvider, Dataset, Registry,
Browser, CodeInterpreter. Also `SynchronizeGatewayTargets`, `Tag/UntagResource`,
`ListTagsForResource`, `Put/Get/DeleteResourcePolicy`.

Waiters shipped: `waitForMemoryCreated`, `waitForPolicyActive/Deleted`,
`waitForPolicyEngineActive/Deleted`, `waitForPolicyGenerationCompleted`. Nothing
for runtimes, endpoints, gateways, targets, harnesses, evaluators, bundles,
payments. Polling is our job.

Lifecycle status enums are not uniform across kinds:

| Kind                                      | In progress                                                        | Converged | Failed                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| AgentRuntime, AgentRuntimeEndpoint        | CREATING, UPDATING, DELETING                                       | READY     | CREATE_FAILED, UPDATE_FAILED                                                                                                      |
| Harness, HarnessEndpoint, PaymentManager  | CREATING, UPDATING, DELETING                                       | READY     | CREATE_FAILED, UPDATE_FAILED, DELETE_FAILED                                                                                       |
| Memory                                    | CREATING, UPDATING, DELETING                                       | ACTIVE    | FAILED                                                                                                                            |
| Gateway                                   | CREATING, UPDATING, DELETING                                       | READY     | FAILED, UPDATE_UNSUCCESSFUL                                                                                                       |
| GatewayTarget                             | CREATING, UPDATING, DELETING, SYNCHRONIZING, *_PENDING_AUTH        | READY     | FAILED, UPDATE_UNSUCCESSFUL, SYNCHRONIZE_UNSUCCESSFUL                                                                             |
| PolicyEngine, Policy, ConfigurationBundle | CREATING, UPDATING, DELETING                                       | ACTIVE    | CREATE_FAILED, UPDATE_FAILED, DELETE_FAILED                                                                                       |
| Evaluator                                 | CREATING, UPDATING, DELETING                                       | ACTIVE    | CREATE_FAILED, UPDATE_FAILED                                                                                                      |
| OnlineEvaluationConfig                    | CREATING, UPDATING, DELETING                                       | ACTIVE    | CREATE_FAILED, UPDATE_FAILED, ERROR                                                                                               |
| PaymentConnector                          | CREATING, PROVISIONING, PENDING_AUTHENTICATION, UPDATING, DELETING | READY     | CREATE_FAILED, UPDATE_FAILED, DELETE_FAILED, AUTHENTICATION_FAILED, AUTHENTICATION_EXPIRED, AWS_MARKETPLACE_SUBSCRIPTION_REQUIRED |

A per-kind normalizer to a common `absent | pending | ready | failed` is
required.

## 6. What the CDK path provisions per resource

Source: inventory of the `@aws/agentcore-cdk` L3 library at
`/Volumes/workplace/agentcore/cdk` (branch `fix/gateway-target-role-policy-dependency`,
0.1.0-alpha.45 plus commit 856c75c). Caveat: the vended CDK app pins
`@aws/agentcore-cdk@1.0.0-rc.2` and imports `readAgentCoreProject`,
`resolveTargetStacks`, `transformAgentCoreJson`, which exist only on
`origin/pr-354`. Deltas that change provisioned infrastructure are marked
pr-354.

### 6.1 Stack shape and inputs

One stack per target: `AgentCore-<project>-<target>` (`_` → `-`), env from
aws-targets, stack tags `agentcore:project-name` and `agentcore:target-name`
(propagate to every taggable resource). The stack reads
`deployed-state.json` only for
`targets.<t>.resources.credentials.<name>.{credentialProviderArn, clientSecretArn}`.
Creation order in `AgentCoreApplication`: memories → knowledge bases →
evaluators → policy engines → datasets → (capacity providers) → agent
environments → config bundles → harnesses → online eval configs → MCP
(gateways) → payments.

### 6.2 Runtime (`AgentCoreRuntime.ts`, `AgentEnvironment.ts`)

- `AWS::IAM::Role` (unless `executionRoleArn`): trust
  `bedrock-agentcore.amazonaws.com`, no conditions, CDK-generated name.
- Baseline policy statements (verbatim):

```
{ actions: ['bedrock:InvokeModel','bedrock:InvokeModelWithResponseStream','bedrock:CountTokens'],
  resources: [`arn:${partition}:bedrock:*::foundation-model/*`, `arn:${partition}:bedrock:*:${account}:inference-profile/*`] }
{ actions: ['xray:PutTraceSegments','xray:PutTelemetryRecords'], resources: ['*'] }
{ actions: ['logs:DescribeLogGroups'], resources: ['*'] }
{ actions: ['logs:CreateLogGroup','logs:CreateLogStream','logs:DescribeLogStreams','logs:PutLogEvents','logs:GetLogEvents','logs:FilterLogEvents','logs:PutResourcePolicy'],
  resources: [`arn:${partition}:logs:${region}:${account}:log-group:/aws/bedrock-agentcore/runtimes/*`] }
{ actions: ['bedrock-agentcore:GetConfigurationBundle','bedrock-agentcore:GetConfigurationBundleVersion','bedrock-agentcore:ListConfigurationBundles','bedrock-agentcore:ListConfigurationBundleVersions','bedrock-agentcore:CreateConfigurationBundle','bedrock-agentcore:UpdateConfigurationBundle','bedrock-agentcore:DeleteConfigurationBundle'],
  resources: ['arn:aws:bedrock-agentcore:*:*:configuration-bundle/*'] }
```

Container builds add `ecr:GetAuthorizationToken` on `*`,
`ecr:BatchGetImage/GetDownloadUrlForLayer/BatchCheckLayerAvailability` on the
repo, `kms:Decrypt` on the repo key. EFS and S3 Files mounts add the
corresponding `elasticfilesystem:*` / `s3files:*` statements. `additionalPolicies`
entries attach managed policy ARNs or inline documents from `.json` files.

- When the project has any credential: statements for
  `bedrock-agentcore:CreateWorkloadIdentity/GetWorkloadAccessTokenForUserId/GetApiKeyCredential/GetResourceApiKey/GetResourceOauth2Token`
  on `workload-identity-directory/*`, `token-vault/*`, `apikeycredentialprovider/*`,
  plus `secretsmanager:GetSecretValue` on `secret:bedrock-agentcore-identity!*`;
  env var `CREDENTIAL_<NAME>_NAME`.
- `AWS::BedrockAgentCore::Runtime`: `agentRuntimeName = ${project}_${agent}`;
  artifact `containerConfiguration.containerUri` or
  `codeConfiguration.code.s3.{bucket,prefix}` + `entryPoint` + `runtime`;
  `entryPoint = enableOtel && python ? ['opentelemetry-instrument', path] : [path]`;
  `networkConfiguration`, `protocolConfiguration` (non-HTTP only),
  `requestHeaderConfiguration`, `authorizerConfiguration`, `environmentVariables`,
  `lifecycleConfiguration`, `filesystemConfigurations`, `tags`. Depends on the
  role (so the policy attaches first) and on the container builder.
- Log group is created by the service:
  `/aws/bedrock-agentcore/runtimes/{RuntimeId}-{EndpointName}`.
- Env vars wired in: `agent.envVars[]`, `MEMORY_<NAME>_ID` per project memory,
  `AGENTCORE_GATEWAY_<NAME>_URL/_AUTH_TYPE[/_CREDENTIAL_PROVIDER]` per gateway,
  connection tokens, payment vars.
- Outputs `exportName(stack, agent, 'RuntimeId' | 'RuntimeArn' | 'RoleArn')`.

### 6.3 Runtime endpoint

One `AWS::BedrockAgentCore::RuntimeEndpoint` per `endpoints[name]` with
`{ agentRuntimeId, name, agentRuntimeVersion: String(version), description? }`.
No IAM. Export `Endpoint-<agent>-<name>-{Id,Arn}`.

### 6.4 CodeZip build (`bundling/zip/*.ts`, `lib/packaging/{python,node}.ts`)

Not CDK bundling: the L3 packs the zip locally then uploads it as a plain CDK
`Asset` to the bootstrap bucket. Python: `uv pip install -r <pyproject> --target
<staging> --python-version X.Y --python-platform <p> --only-binary :all:` trying
`aarch64-manylinux2014`, `aarch64-manylinux_2_28`, `aarch64-manylinux_2_34`; copy
source tree; fix shebangs; zip; 250 MB cap. Excludes `.git .venv __pycache__
.pytest_cache .DS_Store node_modules`. Node: esbuild `platform: node`,
`target: node<major>`. Staging under `agentcore/.cache/`. This code lives in the
L3 package, not the CLI.

### 6.5 Container build (`components/container/*.ts`)

Not `DockerImageAsset`. Per container runtime: source dir uploaded as an S3
`Asset` (dockerignore aware, `.env*` excluded); `AWS::KMS::Key` (rotation on,
DESTROY); `AWS::ECR::Repository` `<project>/<agent>` lowercased (DESTROY,
`emptyOnDelete`, keep 10 images, scan on push, KMS); one shared
`AWS::CodeBuild::Project` `<stack>-container-builder` per stack (ARM64 AL2023
image, privileged, 30 min, docker layer cache) with its own role; an
`AWS::Lambda::Function` + `AWS::CloudFormation::CustomResource`
`ContainerBuildTrigger` that starts the build with S3 source override and polls
`BatchGetBuilds` up to 14 min; image tag = asset hash (plus build-arg hash).
Buildspec: `docker login` → `docker build -t $IMAGE_URI -f $DOCKERFILE_PATH
$BUILD_ARG_FLAGS .` → `docker push`. Architecture is arm64 by virtue of the
build host. The Dockerfile comes from the user's code directory.

### 6.6 Memory (`AgentCoreMemory.ts`)

`AWS::IAM::Role` (trust `bedrock-agentcore.amazonaws.com`, empty unless stream
delivery). `AWS::BedrockAgentCore::Memory` `name = ${project}_${memory}`,
`eventExpiryDuration`, `memoryStrategies` (SEMANTIC/SUMMARIZATION/USER_PREFERENCE/
CUSTOM/EPISODIC, each named `${memory}_${Type}` by default with
`namespaceTemplates`), `memoryExecutionRoleArn`, `encryptionKeyArn?`, `tags?`.
Grants to every project runtime: `ListMemoryRecords/RetrieveMemoryRecords` on the
memory ARN conditioned on `bedrock-agentcore:namespace` and `namespacePath`
(templates `{...}` → `*`), plus `GetEvent, GetMemory, GetMemoryRecord, ListActors,
ListEvents, ListSessions, CreateEvent, DeleteEvent, DeleteMemoryRecord` on the
memory ARN. Env `MEMORY_<NAME>_ID`. Export `Memory-<name>-{Id,Arn}`.

### 6.7 Gateway and targets (`mcp/Gateway.ts`, `l3/AgentCoreMcp.ts`)

- `AWS::IAM::Role` (trust `bedrock-agentcore.amazonaws.com`). With a policy
  engine attached: `GetPolicyEngine, CheckAuthorizePermissions, AuthorizeAction,
PartiallyAuthorizeActions` on the engine ARN and `gateway/*`, plus
  `bedrock:InvokeGuardrailChecks` on `*`.
- `AWS::BedrockAgentCore::Gateway` `name = resourceName ?? ${project}-${gateway}`
  (hyphen), `authorizerType ?? 'NONE'`, `protocolType: 'MCP'`, `roleArn`,
  `protocolConfiguration.mcp.searchType: 'SEMANTIC'` unless disabled,
  `exceptionLevel: 'DEBUG'` optional, `PolicyEngineConfiguration { Arn, Mode }`
  via property override, depends on the engine.
- Outbound auth statements on the role for OAuth targets
  (`GetResourceOauth2Token, GetWorkloadAccessToken, GetWorkloadAccessTokenForJWT,
GetWorkloadAccessTokenForUserId` on `workload-identity-directory/default`,
  `.../workload-identity/<gatewayIdentifier>`, `token-vault/default`, provider
  ARNs; `secretsmanager:GetSecretValue` on client secret ARNs) and API key
  targets (`GetApiKeyCredential, GetResourceApiKey, GetWorkloadAccessToken` on
  `workload-identity-directory/*`, `token-vault/*`, `apikeycredentialprovider/*`;
  `secretsmanager:GetSecretValue` on `secret:bedrock-agentcore-identity!*`).
- Targets, all `AWS::BedrockAgentCore::GatewayTarget` with `name: target.name`
  (no prefix) and `gatewayIdentifier`:
  - `apiGateway`: `mcp.apiGateway { restApiId, stage, toolFilters, toolOverrides }`;
    role gets `execute-api:Invoke`.
  - `lambdaFunctionArn`: role gets `lambda:InvokeFunction` on the ARN and `:*`;
    tool schema from an `s3://` URI or a local file uploaded as an Asset;
    `mcp.lambda { lambdaArn, toolSchema.s3.uri }`. Depends on the role (the
    NoStack race fix).
  - `connector` `bedrock-knowledge-bases` and `web-search`: raw `CfnResource`
    (L1 lacks Connector), `CredentialProviderConfigurations: [GATEWAY_IAM_ROLE]`,
    role gets `bedrock:GetKnowledgeBase/Retrieve` per KB or
    `bedrock-agentcore:InvokeWebSearch` on `tool/web-search.v1`.
  - `mcpServer`: `mcp.mcpServer { endpoint }`; no dependency.
  - `passthrough`: raw `Http.Passthrough { Endpoint, ProtocolType, Stickiness }`
    with IAM/JWT/OAUTH/API_KEY credential forms; no dependency.
  - `httpRuntime`: raw `Http.AgentcoreRuntime { Arn, Qualifier? }`; role gets
    `bedrock-agentcore:InvokeAgentRuntime` on the runtime ARN and
    `/runtime-endpoint/*`.
  - `openApiSchema` / `smithyModel`: schema from S3 or local Asset; openApi
    requires OAUTH or API_KEY.
  - `lambda` compute: creates a Lambda role, packs a Python zip, creates
    `AWS::Lambda::Function` `<project>-<tool>` (ARM64), grants invoke to the
    gateway role, target `mcp.lambda` with inline tool schema.
  - `AgentCoreRuntime` compute: a full MCP-protocol runtime plus
    `mcp.mcpServer { endpoint: https://bedrock-agentcore.<region>.<suffix>/runtimes/<urlEncodedArn>/invocations?qualifier=DEFAULT }`.
- Credential provider configs on targets read
  `deployed-state.json` credentials by name; missing → throws.
- Gateway wiring into runtimes: env `AGENTCORE_GATEWAY_<NAME>_URL` and
  `_AUTH_TYPE`; AWS_IAM adds `bedrock-agentcore:InvokeGateway` on the gateway
  ARN to the runtime role; CUSTOM_JWT looks up credential `<gateway>-oauth`.
- Exports `Gateway-<name>-{Id,Arn,Url}`, `GatewayTarget-<target>-Id`.

### 6.8 Other kinds (condensed)

- Policy engine / policy: no IAM. Engine `name = ${project}_${engine}`; policy
  `name = <policy>` with `Definition.Policy.Statement` from the spec's Cedar
  statement; policy depends on engine. Exports `PolicyEngine-<name>-Arn`,
  `Policy-<engine>-<policy>-Arn`.
- Evaluator: `evaluatorName = ${project}_${name}`; LLM-as-judge is pure control
  plane; code-based needs a Lambda (managed variant creates role, Python 3.12
  ARM64 function, two `lambda:Permission`s for `bedrock-agentcore.amazonaws.com`).
- Online eval config: `${project}_${name}`; a role with ~10 statements over
  logs, `aws/spans`, bedrock invoke, cloudwatch query, lambda, and
  `bedrock-agentcore:GetOnlineEvaluationConfig/StartBatchEvaluation`; the config
  references evaluator IDs, log group names, service names `${project}_${agent}.<endpoint>`.
- Config bundle: `bundleName = ${project}${name}` (no separator); uses
  `CfnJson` (a singleton provider Lambda) to key components by runtime ARN.
- Knowledge base: Bedrock KB (`MANAGED`, titan embed v2) plus data sources plus
  a `bedrock.amazonaws.com` role with `aws:SourceAccount`/`aws:SourceArn`
  conditions. Different service.
- Payment manager: two roles (`ResourceRetrievalRole` for
  `bedrock-agentcore.amazonaws.com`, `ProcessPaymentRole` for the account root);
  `PaymentManager { Name: <name> (no prefix), AuthorizerType, RoleArn, ... }`;
  connector references the credential provider ARN from deployed state.
- Harness: role with explicit `roleName = ${project}_${harness}` and ~20 Sid'd
  statements (model invoke, mantle, ECR public, X-Ray, logs, metrics, workload
  identity, managed memory, gateway, browser, code interpreter, skills), trust
  conditioned on `aws:SourceAccount` and `aws:SourceArn`; raw
  `AWS::BedrockAgentCore::Harness` mapped from `harness.json`; optional
  container via the same CodeBuild pipeline.
- Capacity provider (pr-354 only): operator role + raw `CapacityProvider`.

### 6.9 Naming summary

Stack `AgentCore-<project>-<target>`; runtime, memory, evaluator, online-eval,
dataset, KB, policy engine, harness, capacity provider `<project>_<name>`;
policy `<name>`; gateway `<project>-<gateway>`; gateway target `<name>`; MCP
lambda `<project>-<tool>`; evaluator lambda `<project>-eval-<name>`; ECR repo
`<project>/<agent>`; CodeBuild `<stack>-container-builder`; config bundle
`<project><name>`; payment manager `<name>`; harness role `<project>_<harness>`
(the only explicitly named role); credential provider
`<project>_<target>_<credential>`. Only credential providers carry the target;
two targets in one account and region would collide on every other name.

### 6.10 Update, replacement, dependencies

- No `RemovalPolicy.RETAIN`. ECR repo and key are DESTROY with `emptyOnDelete`.
- createOnly (asserted in code): dataset name and schema type; bundle name and
  branch; harness name and network configuration; capacity provider name,
  permissions and compute configuration. Runtime name, memory name, gateway
  name are createOnly per the CFN schemas but not asserted; verify.
- Renaming a resource changes its logical ID, so CDK replaces it.
- Explicit dependencies: runtime → role; runtime → container builder; gateway →
  policy engine; most gateway targets → gateway role (and its DefaultPolicy);
  policy → engine; evaluator → managed lambda; online eval → role, runtime,
  endpoint; KB → role; data source → KB; payment connector → manager; harness →
  role. `mcpServer` and `passthrough` targets have no role dependency.

## 7. Leaks: CDK assumptions in backend-agnostic code

- `deployedState.ts` and `credentials.ts` live under `backends/cdk/` but both
  are backend-neutral (the state file is the natural home for imperative
  per-resource IDs; the provisioner is the imperative precedent).
- `CredentialProvisionInput.credentials` is typed `CdkCredentialProvider`
  (toolkit-lib's `SdkBaseConfig["credentialProvider"]`) rather than
  `AwsCredentials` from `src/core/types.tsx`.
- `resolveProjectResources` / `resolveDeployedResources` derive every ARN from
  CloudFormation Outputs by reimplementing the L3's `exportName`.
- The scaffolder (`src/core/project/templates/`) always vends `agentcore/cdk/`
  and `managedBy: "CDK"`; `project create` has no way to choose a backend.
- `ProjectManager.build` is documented as "Compile the project's CDK app and
  synthesize its CloudFormation templates" (`handlers/project/types.ts:459`).
- `declaresNothingDeployable` in the deploy handler mirrors the CDK
  zero-resource count; an imperative backend needs its own authoritative check.
- `FsProjectManager` has no access to global config, so a flag cannot yet decide
  which backends are registered.

## 8. Constraints and risks

- **Toolchain**: `refactor` pins `bun@1.4.0` (lockfile v3); the local bun is
  1.3.6 and cannot parse the lockfile. Upgrade needed before implementation.
- **Hidden infrastructure**: the CDK path relies on the bootstrap S3 bucket
  for CodeZip and schema uploads, and on a CodeBuild pipeline for containers.
  An imperative path has neither unless it creates them.
- **IAM propagation**: creating a role then immediately creating a runtime
  with it can fail validation; the engine needs retry-as-pending semantics.
- **Status inconsistency** across kinds (section 5) and the lack of SDK waiters
  for most kinds.
- **Progress UI is linear** (section 3.8); the prior art's parallel BFS does not
  map onto it without a wave-based or extended event model.
- **Name lengths**: adding the target to names (`<project>_<target>_<name>`)
  can exceed the 48-char limit for runtimes and memories; must be validated
  before the first AWS call, like the credential provisioner does.
- **No rollback**: CloudFormation rolls back a failed stack update; a
  reconcile-loop deploy leaves partial progress and relies on re-running.
- **State file** is a sequential read-modify-write; concurrent deploys of one
  project can lose updates (already true today).
- **L3 branch mismatch**: the checked-out L3 branch lacks exports the vended
  CDK app imports (they exist on `origin/pr-354`); irrelevant to the imperative
  path but worth knowing when reading L3 code.
- **Adoption**: same-named resources created outside the CLI (or by the CDK
  path) must not be silently adopted; the credential provisioner's vendor check
  is the precedent.

## 9. Open questions

See the chat message of 2026-09-24 for the numbered list and recommendations.
The answers are folded into the design spec.

## 10. Addenda from the deploy-pipeline report (received after sections 1 to 9)

### 10.1 Startup wiring makes the flag reachable

`src/index.ts` reads the global config (`globalConfigAccessor.get()`, line 61)
before constructing `CoreClient` (lines 68 to 78) and passes the resolved config
to `createRootHandler`. So a new flag can be handed to `CoreClientConfig` and
from there to `ProjectManagerConfig` to decide which backends are registered.
No handler-level plumbing is needed for the deploy path.

### 10.2 Existing imperative precedents to reuse or generalize

- `ensureDefaultExecutionRole(iam, harnessName, region)` in
  `src/core/executionRole.tsx:237`: `GetRole` → `CreateRole` on
  `NoSuchEntityException` → `PutRolePolicy` every time (policy is re-attached on
  each call, so it converges). Role name `AgentCoreHarness-<name>`. This is a
  reconcile step in all but name; generalize it for runtime, gateway and other
  roles.
- `retryWhileRoleUnassumable` in `src/core/harness.tsx:250` (module private):
  retries a `ValidationException` whose message matches `/role|assume|trust/i`,
  8 attempts, 2 s apart. This is the IAM propagation problem; fold it into the
  engine's pending semantics rather than copying it per step.
- `PolicyClient.generatePolicy` (`src/core/policy.tsx:36`) is an
  `AsyncGenerator<ProgressEvent, ...>` that uses an SDK waiter and maps
  `WaiterState.ABORTED / TIMEOUT / non-SUCCESS` to CLI errors. Sub-clients that
  yield progress events compose directly with `ProjectEvent`.
- `GatewayClient.updateGateway` (`src/core/gateway.tsx:223`) is a full
  read-modify-write: `GetGateway`, then rebuild the whole `UpdateGatewayRequest`
  from current plus patch. Update calls on this service replace, not merge.
- `TestCoreClient` already accepts `backends?: Partial<Record<ManagedBy, ProjectBackend>>`,
  so handler tests can register the imperative backend without new plumbing.

### 10.3 Control-plane mutations that exist versus are missing in `src/core`

| Kind                                                  | Create/Update/Delete in a sub-client today |
| ----------------------------------------------------- | ------------------------------------------ |
| Credential providers (API key, OAuth2, payment)       | yes (`IdentityClient`)                     |
| Gateway, gateway target, gateway rule                 | yes (`GatewayClient`)                      |
| Harness, harness endpoint                             | yes (`HarnessClient`)                      |
| Evaluator, online eval config, config bundle, dataset | yes (`EvalClient`)                         |
| Agent runtime, runtime endpoint                       | no (read and invoke only)                  |
| Memory                                                | no (read only)                             |
| Policy engine, policy                                 | no (only policy generation)                |
| Payment manager, connector                            | no (read only)                             |
| Knowledge base                                        | no                                         |

Phase 2 (runtime + memory) therefore adds runtime and memory mutations to the
existing sub-client interfaces, which also serves future imperative commands.

### 10.4 Local dev builders are runners, not packagers

`src/core/dev/codezip.ts` runs `uv run python <entrypoint>` on the host;
`src/core/dev/container.ts` builds with `docker | podman | finch` for `project
dev`. Neither produces a deployable zip with aarch64 wheels, so the CodeZip
packaging question (section 9 of the chat) is unchanged.

### 10.5 Memory env var naming needs a parity check

The CLI's `memoryEnvVarName()` (`src/projectSchemas/memory.ts:189`) returns
`AGENTCORE_MEMORY_<NAME>_ID`, and the scaffolded agent templates read exactly
that variable. The L3 inventory reports the construct injecting
`MEMORY_<NAME>_ID`. One side is stale or lives on a different branch. The
imperative backend must inject the names the generated code reads, which are
the CLI's helpers (`memoryEnvVarName`, `credentialEnvVarName`, and the gateway
naming in section 6.7), and a parity test should assert them.

### 10.6 Additional leaks

- `resolveAwsAccount` lives in `backends/cdk/environment.ts` and is imported by
  the manager; its `credentials` parameter is typed with toolkit-lib's
  `CdkCredentialProvider`.
- Credential resolution goes through toolkit-lib's AWS-CLI-compatible chain
  (`resolveCdkCredentials`, `cdk/toolkit.ts:159`). The imperative backend
  should accept an injected resolver returning the core `AwsCredentialProvider`;
  defaulting to the existing resolver keeps profile and SSO behavior identical
  without adding a dependency.
- `FsProjectManager.create` installs npm dependencies into `agentcore/cdk`
  (`manager.tsx:247`), and `project create` path-limit checks assume
  `agentcore/cdk/node_modules` exists.
