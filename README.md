# AgentCore CLI

`agentcore` is a command-line tool and interactive terminal UI (TUI) for
**[Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/)**, the platform for building
and running production AI agents ([documentation](https://docs.aws.amazon.com/bedrock-agentcore/)).

It gives you two ways to work, from the same package:

- **A scriptable CLI** — flag-driven commands with JSON output (`--json`) for coding agents,
  scripts, and CI.
- **An interactive TUI** — guided flows for creating projects, browsing resources, and chatting
  with agents.

```bash
agentcore               # launch the interactive TUI
agentcore status --json # scriptable, machine-readable output
```

Using the AgentCore APIs directly means calling several services, setting up execution roles, and
handling streamed responses. `agentcore` takes care of those details so you can create, deploy, and
invoke agents from your terminal.

## Installation

You need Node.js 20.12 or later and AWS credentials configured as for the AWS CLI. Python templates
also need [`uv`](https://docs.astral.sh/uv/getting-started/installation/).

```bash
npm install -g @aws/agentcore
```

If the Python-based Bedrock AgentCore Starter Toolkit is installed, uninstall it: both provide an
`agentcore` command.

## Quick Start

A project holds either kind of agent, or both:

- A **Harness** is a managed agent you configure in YAML — model, system prompt, tools, skills — and
  AgentCore runs for you.
- A **Runtime** is agent code you own, scaffolded from a template and deployed for you.

Create a project, add a Harness to it, deploy it, and send a prompt:

```bash
agentcore create --name MyProject
cd MyProject
agentcore add harness --name MyAssistant
agentcore deploy
agentcore invoke --harness MyAssistant --prompt "Hey, what can you do for me?"
```

To start from code you own instead, pick a template (`agentcore create --help` lists them):

```bash
agentcore create --name MyAgent --template agent-python-strands
```

`agentcore create --template` scaffolds the template with its default model provider (Amazon
Bedrock for the model-backed templates). To use another provider, run `agentcore create` with no
flags: for templates that take a model provider (`agent-python-strands` and its `-container`
variant, `a2a-python-strands`, `agui-python-strands`, `agent-typescript-strands`) the wizard asks
for the provider (Amazon Bedrock, Anthropic, OpenAI, an OpenAI-compatible endpoint, Gemini, or
LiteLLM, which is Python-only), the model id, and an API-key file. The API key is kept in
`agentcore/.env.local` and provisioned as an AgentCore Identity credential on deploy.

To bring your own code into a project instead, add a runtime for it:

```bash
agentcore add runtime --name search --language python   # or --language typescript
```

`add runtime` doesn't generate code. It creates `app/search/` with a `README.md` and an
`AGENTS.md` describing what the code has to provide for the chosen `--protocol` (`HTTP` by
default, or `MCP`, `A2A`, `AGUI`), and registers the runtime in `agentcore.json` with starting
values (a CodeZip build on the latest Python or Node.js, entrypoint `main.py` or `main.js`). If
`app/search/` already exists, your files are left alone and only the missing docs are added.

`agentcore dev`, `agentcore build`, and `agentcore deploy` then update `agentcore.json` from the
code and print what changed. Adding a `Dockerfile` to the folder switches the runtime to a
container build. `requires-python` in `pyproject.toml` or `engines.node` in `package.json`
constrains the runtime version: it changes only when the range excludes the current one, and then
to the highest version the range allows. The Python entrypoint comes from `[tool.agentcore]
entrypoint` in `pyproject.toml`; TypeScript is always bundled from `main.ts` (a `package.json`
`"main"` of `main.ts` or `main.js` agrees with that, and any other value is ignored with a
warning). Where the code doesn't say, the value in `agentcore.json` is kept.

Run `agentcore create` outside any existing project.

## Projects

`create` makes a directory holding `agentcore/agentcore.json`, the spec that declares the project's
resources, and `agentcore/cdk/`, the AWS CDK app that deploys them. Deployment targets — an account
and region each — live in `agentcore/aws-targets.json`. Project commands find the project by walking
up from the current directory.

`agentcore dev` runs runtimes locally or deploys harnesses and prints invoke guidance.
Use `--mode browser` for Agent Inspector, `--skip-deploy` to reuse deployed harnesses,
and `--agent <name>` to choose an agent in mixed projects.

## Commands

| Command                                                          | Purpose                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `create`, `add`, `remove`, `export`, `migrate`                   | Create a project, add or remove its resources, export a resource to code, migrate a v0 project |
| `dev`, `build`, `deploy`, `status`                               | Run locally, build, deploy, and check what is deployed                                         |
| `invoke`, `logs`, `traces`                                       | Talk to deployed agents and inspect their logs and traces                                      |
| `runtime`, `harness`, `gateway`, `memory`, `identity`, `payment` | Inspect and manage deployed resources, with or without a project                               |
| `eval`                                                           | Evaluate agents, manage datasets and configurations, and run experiments                       |
| `feedback`, `config`, `update`                                   | Send feedback, read and write CLI settings, update the CLI                                     |

In a terminal, a command run without flags opens its interactive flow; pass flags and it runs
non-interactively. `--help` on any command lists its subcommands and flags, and the
[command reference](command.md) has them all.

Global flags, available on every command:

| Flag       | Purpose                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `--region` | AWS region. Resolved from this flag, then `AWS_REGION`, `AWS_DEFAULT_REGION`, the active profile, then `us-east-1`. |
| `--json`   | Emit JSON instead of opening the TUI.                                                                               |
| `--debug`  | Debug logging.                                                                                                      |

## Extending the CDK app

`agentcore/cdk/` has two source files. `bin/cdk.ts` reads the project once
(`readAgentCoreProject`), makes one stack per deployment target
(`resolveTargetStacks`) and turns `agentcore.json` into the application's props
(`transformAgentCoreJson`). All three come from `@aws/agentcore-cdk`, so that
logic is updated through the library rather than changes to your CDK app.

`lib/cdk-stack.ts` instantiates one `AgentCoreApplication`. This is the file you
edit to add your own resources. Runtimes and harnesses implement `iam.IGrantable`,
so you can pass them to a resource's CDK grant methods to give your agents access.
Use `addEnvironmentVariable` to pass resource names, ARNs, or endpoints to your agent.

This example gives the generated runtime named `agent` access to a table:

```ts
import { AgentCoreApplication, type AgentCoreApplicationProps } from "@aws/agentcore-cdk";
import { Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export interface AgentCoreStackProps extends StackProps {
  application: AgentCoreApplicationProps;
}

export class AgentCoreStack extends Stack {
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);
    this.application = new AgentCoreApplication(this, "Application", props.application);

    const orders = new dynamodb.Table(this, "Orders", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
    });
    const agent = this.application.runtime("agent");
    orders.grantReadWriteData(agent);
    agent.addEnvironmentVariable("ORDERS_TABLE", orders.tableName);
  }
}
```

For a Harness, use `this.application.harness("<name>")` instead.

Run `agentcore deploy` to apply your changes. The names passed to
`runtime()` or `harness()` must match the names in your project.

If you use an existing execution role through `executionRoleArn`, CDK cannot
change its permissions. You'll need to add the required permissions to that role
yourself.

Note that `agentcore status` reports only the resources `agentcore.json`
declares, not the ones you add in the stack.

## Documentation

- [Command reference](command.md): every command and flag.
- [Harness project configuration](docs/harness-project-configuration.md): Harness YAML, prompts, tools, skills, and environment settings.
- [China regions](docs/china-regions.md): what is available there and how the restrictions are enforced.
- [Amazon Bedrock AgentCore documentation](https://docs.aws.amazon.com/bedrock-agentcore/): service guides and API references.
- [Contributing](CONTRIBUTING.md): development, builds, architecture, and testing.
- [Security](SECURITY.md) · [License](LICENSE): Apache-2.0.

## Local container builds

Use the normal `--build` option to select where a Dockerfile image is built:

```bash
agentcore add runtime --name orders --language python \
  --build container-local --dockerfile Dockerfile

agentcore add harness --name assistant \
  --build container-local --dockerfile Dockerfile
```

The Runtime entry in `agentcore/agentcore.json` uses a top-level build value:

```json
{
  "name": "orders",
  "build": "Container-local",
  "codeLocation": "app/orders",
  "entrypoint": "main.py",
  "dockerfile": "Dockerfile"
}
```

Harnesses use the same top-level selector in `app/<name>/harness.yaml`:

```yaml
build: Container-local
dockerfile: Dockerfile
```

`Container` continues to use CodeBuild. A harness Dockerfile without a `build` selector also uses
CodeBuild. `CodeZip` remains the default Runtime packaging. A prebuilt harness image cannot be
combined with build, Dockerfile, context, or build-argument settings.

Both add commands accept `--build-context-path` (relative to the project root) and
`--custom-docker-build-args` (a JSON object). Without a context override, the supplied Dockerfile is
copied to the new resource directory. With an override, the Dockerfile path is relative to that
context. Persisted settings are `buildContextPath` and `customDockerBuildArgs`.

`agentcore build` validates, synthesizes, and stages the context and asset manifest. During
`agentcore deploy`, CDK Toolkit builds and publishes missing Linux ARM64 image assets to the target
environment's bootstrap ECR repository before deploying the workload. The local builder must be
installed, its daemon accessible, and Linux ARM64 support configured. `CDK_DOCKER` can select a
Docker-compatible executable, for example `CDK_DOCKER=finch agentcore deploy`. If the builder cannot
report ARM64 support through Docker's `buildx inspect`, the CLI runs a small, uncached ARM64 execution
test build before deployment. This test uses no base image or network access, exports only to a
temporary directory, and removes that directory afterward. It does not tag or publish an image,
install emulation, or provision a builder. The test build has a 60-second timeout. Runtime
development continues to use its local container runner; Harness
development uses the selected deployment build mode when it deploys.

Context filtering applies the existing exclusion baseline, then the context's `.dockerignore`,
then force-keeps the Dockerfile and its parent directories. User negations can re-include baseline
paths. Dockerfile-specific ignore files are rejected. Build arguments are nonsecret configuration:
asset manifests and image layers can contain their values, even though the CLI redacts them from
terminal output and debug logs.

Included source, Dockerfile, platform, and build-argument changes produce a new image asset.
Unchanged images already published to the target can be reused. Pin base-image digests and dependency
lockfiles; update those tracked files and deploy to pick up an upstream security fix. A repeated
deploy does not refresh an unchanged published asset, regardless of Docker's layer cache. Forcing a
rebuild of unchanged inputs is outside this release.

Each target uses its own shared bootstrap repository and publishing credentials. Pull permissions
cover that repository, including other workloads' images. This path provides no dedicated workload
repository or KMS key. The standard bootstrap repository uses AES256 encryption; it does not enable
scan-on-push by default. Repository and registry scanning settings govern scanning. Customers must
accept these settings and repository-wide pull access. Custom KMS encryption requires separate
qualification of the repository's KMS grants and key policy.

Supported repository lifecycle policies retain tagged workload images. Environment owners must
preserve images referenced by active versions and any versions retained for rollback, together with
their pull permissions. CDK publishes and reuses assets; it does not provide workload-specific rollback
retention. Avoid garbage collection of referenced image assets. Destroying a project leaves the shared
bootstrap repository intact. Automated image cleanup is outside this feature.

The first release supports `Container-local` only for new workloads, including additions to existing
projects. Switching an already-deployed workload into or out of this mode is unsupported. The CLI
reads the target's deployed CloudFormation template and rejects these changes before provisioning
credentials, bootstrapping, or publishing assets. Editing configuration or deleting local deployed
state does not enable a migration. Keep the deployed build mode or add a workload with a new name.
Deployment credentials need `cloudformation:DescribeStacks` and `cloudformation:GetTemplate` access
to the selected target's stack so these checks can run before deployment changes.

Dependency downloads use the builder's network. Workstation credentials are not automatically
available inside Dockerfile `RUN` instructions. This release supports dependencies supplied in the
context or downloaded without injecting build-time secrets. Base-image registry authentication uses
the builder's registry credentials. For a private package, an authenticated download before deployment
can place a wheel or npm package in the context for installation during the build. Do not copy
credentials into the context or pass them through build arguments. BuildKit secrets and secret
injection into private pip/npm installation are deferred.

Compatibility note: Harness CodeBuild context staging now uses the same filters as Runtime staging.
The first deployment after upgrading can rebuild a Harness image because its staged context changed.
Projects selecting `Container-local` must install a CDK package that supports the selector.
For testing the companion PR before publication, build and pack that CDK checkout, then install its
tarball in the project's `agentcore/cdk/` directory. Publish the companion CDK package before releasing
this CLI change; release preparation verifies its local-build support before updating the vended pin.
