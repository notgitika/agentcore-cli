# CLI Commands Reference

All commands support non-interactive (scriptable) usage with flags. Use `--json` for machine-readable output.

## Project Lifecycle

### create

Create a new AgentCore project.

```bash
# Interactive wizard
agentcore create

# Fully non-interactive with defaults
agentcore create --name MyProject --defaults

# Custom configuration
agentcore create \
  --name MyProject \
  --framework Strands \
  --model-provider Bedrock \
  --memory shortTerm \
  --output-dir ./projects

# Skip agent creation
agentcore create --name MyProject --no-agent

# Preview without creating
agentcore create --name MyProject --defaults --dry-run
```

| Flag                   | Description                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| `--name <name>`        | Project name (alphanumeric, max 23 chars)                                        |
| `--defaults`           | Use defaults (Python, Strands, Bedrock, no memory)                               |
| `--no-agent`           | Skip agent creation                                                              |
| `--language <lang>`    | `Python` or `TypeScript`                                                         |
| `--framework <fw>`     | `Strands`, `LangChain_LangGraph`, `GoogleADK`, `OpenAIAgents`                    |
| `--model-provider <p>` | `Bedrock`, `Anthropic`, `OpenAI`, `Gemini`                                       |
| `--build <type>`       | `CodeZip` (default) or `Container` (see [Container Builds](container-builds.md)) |
| `--api-key <key>`      | API key for non-Bedrock providers                                                |
| `--memory <opt>`       | `none`, `shortTerm`, `longAndShortTerm`                                          |
| `--output-dir <dir>`   | Output directory                                                                 |
| `--skip-git`           | Skip git initialization                                                          |
| `--skip-python-setup`  | Skip venv setup                                                                  |
| `--dry-run`            | Preview without creating                                                         |
| `--json`               | JSON output                                                                      |

### deploy

Deploy infrastructure to AWS.

```bash
agentcore deploy
agentcore deploy -y --progress        # Auto-confirm with progress
agentcore deploy -v --json            # Verbose JSON output
```

| Flag            | Description           |
| --------------- | --------------------- |
| `-y, --yes`     | Auto-confirm prompts  |
| `--progress`    | Real-time progress    |
| `-v, --verbose` | Resource-level events |
| `--json`        | JSON output           |

### status

Check deployment status.

```bash
agentcore status
agentcore status --agent MyAgent
```

| Flag                      | Description         |
| ------------------------- | ------------------- |
| `--agent <name>`          | Specific agent      |
| `--agent-runtime-id <id>` | Specific runtime ID |

### validate

Validate configuration files.

```bash
agentcore validate
agentcore validate -d ./my-project
```

| Flag                     | Description       |
| ------------------------ | ----------------- |
| `-d, --directory <path>` | Project directory |

---

## Resource Management

### add agent

Add an agent to the project.

```bash
# Create new agent from template
agentcore add agent \
  --name MyAgent \
  --framework Strands \
  --model-provider Bedrock \
  --memory shortTerm

# Bring your own code
agentcore add agent \
  --name MyAgent \
  --type byo \
  --code-location ./my-agent \
  --entrypoint main.py \
  --language Python \
  --framework Strands \
  --model-provider Bedrock
```

| Flag                     | Description                                                                      |
| ------------------------ | -------------------------------------------------------------------------------- |
| `--name <name>`          | Agent name                                                                       |
| `--type <type>`          | `create` (default) or `byo`                                                      |
| `--build <type>`         | `CodeZip` (default) or `Container` (see [Container Builds](container-builds.md)) |
| `--language <lang>`      | `Python`, `TypeScript`, `Other` (BYO)                                            |
| `--framework <fw>`       | Agent framework                                                                  |
| `--model-provider <p>`   | Model provider                                                                   |
| `--api-key <key>`        | API key for non-Bedrock                                                          |
| `--memory <opt>`         | Memory option (create only)                                                      |
| `--code-location <path>` | Code path (BYO only)                                                             |
| `--entrypoint <file>`    | Entry file (BYO only)                                                            |
| `--json`                 | JSON output                                                                      |

### add memory

Add a memory resource. Memory is a top-level resource in the flat resource model.

```bash
agentcore add memory \
  --name SharedMemory \
  --strategies SEMANTIC,SUMMARIZATION \
  --expiry 30
```

| Flag                   | Description                                                               |
| ---------------------- | ------------------------------------------------------------------------- |
| `--name <name>`        | Memory name                                                               |
| `--description <desc>` | Description                                                               |
| `--strategies <types>` | Comma-separated: `SEMANTIC`, `SUMMARIZATION`, `USER_PREFERENCE`, `CUSTOM` |
| `--expiry <days>`      | Event expiry (default: 30)                                                |
| `--json`               | JSON output                                                               |

### add gateway

Add a gateway to the project. Gateways act as MCP-compatible proxies that route agent requests to backend tools.

```bash
# Interactive mode (select 'Gateway' from the menu)
agentcore add

# No authorization (development/testing)
agentcore add gateway --name MyGateway

# CUSTOM_JWT authorization (production)
agentcore add gateway \
  --name MyGateway \
  --authorizer-type CUSTOM_JWT \
  --discovery-url https://idp.example.com/.well-known/openid-configuration \
  --allowed-audience my-api \
  --allowed-clients my-client-id \
  --agent-client-id agent-client-id \
  --agent-client-secret agent-client-secret
```

| Flag                             | Description                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| `--name <name>`                  | Gateway name                                                 |
| `--description <desc>`           | Gateway description                                          |
| `--authorizer-type <type>`       | `NONE` (default) or `CUSTOM_JWT`                             |
| `--discovery-url <url>`          | OIDC discovery URL (required for CUSTOM_JWT)                 |
| `--allowed-audience <values>`    | Comma-separated allowed audiences (required for CUSTOM_JWT)  |
| `--allowed-clients <values>`     | Comma-separated allowed client IDs (required for CUSTOM_JWT) |
| `--allowed-scopes <scopes>`      | Comma-separated allowed scopes (optional for CUSTOM_JWT)     |
| `--agent-client-id <id>`         | Agent OAuth client ID for Bearer token auth (CUSTOM_JWT)     |
| `--agent-client-secret <secret>` | Agent OAuth client secret (CUSTOM_JWT)                       |
| `--json`                         | JSON output                                                  |

### add gateway-target

Add a gateway target to the project. Targets are backend tools exposed through a gateway. Supports five target types:
`mcp-server`, `api-gateway`, `open-api-schema`, `smithy-model`, and `lambda-function-arn`.

```bash
# Interactive mode (select 'Gateway Target' from the menu)
agentcore add

# MCP Server endpoint
agentcore add gateway-target \
  --name WeatherTools \
  --type mcp-server \
  --endpoint https://mcp.example.com/mcp \
  --gateway MyGateway

# MCP Server with OAuth outbound auth
agentcore add gateway-target \
  --name SecureTools \
  --type mcp-server \
  --endpoint https://api.example.com/mcp \
  --gateway MyGateway \
  --outbound-auth oauth \
  --oauth-client-id my-client \
  --oauth-client-secret my-secret \
  --oauth-discovery-url https://auth.example.com/.well-known/openid-configuration

# API Gateway REST API
agentcore add gateway-target \
  --name PetStore \
  --type api-gateway \
  --rest-api-id abc123 \
  --stage prod \
  --tool-filter-path '/pets/*' \
  --tool-filter-methods GET,POST \
  --gateway MyGateway

# OpenAPI Schema (auto-derive tools from spec)
agentcore add gateway-target \
  --name PetStoreAPI \
  --type open-api-schema \
  --schema specs/petstore.json \
  --gateway MyGateway \
  --outbound-auth oauth \
  --credential-name MyOAuth

# Smithy Model (auto-derive tools from model)
agentcore add gateway-target \
  --name MyService \
  --type smithy-model \
  --schema models/service.json \
  --gateway MyGateway

# Lambda Function ARN
agentcore add gateway-target \
  --name MyLambdaTools \
  --type lambda-function-arn \
  --lambda-arn arn:aws:lambda:us-east-1:123456789012:function:my-func \
  --tool-schema-file tools.json \
  --gateway MyGateway
```

| Flag                              | Description                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--name <name>`                   | Target name                                                                                                   |
| `--description <desc>`            | Target description                                                                                            |
| `--type <type>`                   | Target type (required): `mcp-server`, `api-gateway`, `open-api-schema`, `smithy-model`, `lambda-function-arn` |
| `--endpoint <url>`                | MCP server endpoint URL (mcp-server)                                                                          |
| `--language <lang>`               | Implementation language: Python, TypeScript, Other (mcp-server)                                               |
| `--host <host>`                   | Compute host: Lambda or AgentCoreRuntime (mcp-server)                                                         |
| `--gateway <name>`                | Gateway to attach target to                                                                                   |
| `--outbound-auth <type>`          | `oauth`, `api-key`, or `none` (varies by target type)                                                         |
| `--credential-name <name>`        | Existing credential name for outbound auth                                                                    |
| `--oauth-client-id <id>`          | OAuth client ID (creates credential inline)                                                                   |
| `--oauth-client-secret <secret>`  | OAuth client secret (creates credential inline)                                                               |
| `--oauth-discovery-url <url>`     | OAuth discovery URL (creates credential inline)                                                               |
| `--oauth-scopes <scopes>`         | OAuth scopes, comma-separated                                                                                 |
| `--rest-api-id <id>`              | API Gateway REST API ID (api-gateway)                                                                         |
| `--stage <stage>`                 | API Gateway stage name (api-gateway)                                                                          |
| `--tool-filter-path <path>`       | Filter API paths, supports wildcards (api-gateway)                                                            |
| `--tool-filter-methods <methods>` | Comma-separated HTTP methods to expose (api-gateway)                                                          |
| `--schema <path>`                 | Path to schema file, relative to project root (open-api-schema, smithy-model)                                 |
| `--schema-s3-account <account>`   | AWS account for S3-hosted schema (open-api-schema, smithy-model)                                              |
| `--lambda-arn <arn>`              | Lambda function ARN (lambda-function-arn)                                                                     |
| `--tool-schema-file <path>`       | Tool schema file, relative to project root or absolute path (lambda-function-arn)                             |
| `--json`                          | JSON output                                                                                                   |

> **Note**: `smithy-model` and `lambda-function-arn` use IAM role auth and do not support `--outbound-auth`.
> `open-api-schema` requires `--outbound-auth` (`oauth` or `api-key`). `api-gateway` supports `api-key` or `none`.
> `mcp-server` supports `oauth` or `none`.

### add identity

Add a credential to the project. Supports API key and OAuth credential types.

```bash
# API key credential
agentcore add identity \
  --name OpenAI \
  --api-key sk-...

# OAuth credential
agentcore add identity \
  --name MyOAuthProvider \
  --type oauth \
  --discovery-url https://idp.example.com/.well-known/openid-configuration \
  --client-id my-client-id \
  --client-secret my-client-secret \
  --scopes read,write
```

| Flag                       | Description                      |
| -------------------------- | -------------------------------- |
| `--name <name>`            | Credential name                  |
| `--type <type>`            | `api-key` (default) or `oauth`   |
| `--api-key <key>`          | API key value (api-key type)     |
| `--discovery-url <url>`    | OAuth discovery URL (oauth type) |
| `--client-id <id>`         | OAuth client ID (oauth type)     |
| `--client-secret <secret>` | OAuth client secret (oauth type) |
| `--scopes <scopes>`        | OAuth scopes, comma-separated    |
| `--json`                   | JSON output                      |

### add evaluator

Add a custom LLM-as-a-Judge evaluator. See [Evaluations](evals.md) for full details.

```bash
agentcore add evaluator \
  --name ResponseQuality \
  --level SESSION \
  --model us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --instructions "Evaluate the response quality. Context: {context}" \
  --rating-scale 1-5-quality
```

| Flag                      | Description                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| `--name <name>`           | Evaluator name                                                             |
| `--level <level>`         | `SESSION`, `TRACE`, or `TOOL_CALL`                                         |
| `--model <model>`         | Bedrock model ID for the LLM judge                                         |
| `--instructions <text>`   | Evaluation prompt with placeholders (e.g. `{context}`)                     |
| `--rating-scale <preset>` | `1-5-quality`, `1-3-simple`, `pass-fail`, `good-neutral-bad`, or custom    |
| `--config <path>`         | Config JSON file (overrides `--model`, `--instructions`, `--rating-scale`) |
| `--json`                  | JSON output                                                                |

### add online-eval

Add an online eval config for continuous agent monitoring.

```bash
agentcore add online-eval \
  --name QualityMonitor \
  --agent MyAgent \
  --evaluator ResponseQuality Builtin.Faithfulness \
  --sampling-rate 10
```

| Flag                         | Description                                   |
| ---------------------------- | --------------------------------------------- |
| `--name <name>`              | Config name                                   |
| `-a, --agent <name>`         | Agent to monitor                              |
| `-e, --evaluator <names...>` | Evaluator name(s), `Builtin.*` IDs, or ARNs   |
| `--evaluator-arn <arns...>`  | Evaluator ARN(s)                              |
| `--sampling-rate <rate>`     | Percentage of requests to evaluate (0.01–100) |
| `--enable-on-create`         | Enable immediately after deploy               |
| `--json`                     | JSON output                                   |

### remove

Remove resources from project.

```bash
agentcore remove agent --name MyAgent --force
agentcore remove memory --name SharedMemory
agentcore remove identity --name OpenAI
agentcore remove evaluator --name ResponseQuality
agentcore remove online-eval --name QualityMonitor
agentcore remove gateway --name MyGateway
agentcore remove gateway-target --name WeatherTools

# Reset everything
agentcore remove all --force
agentcore remove all --dry-run  # Preview
```

| Flag            | Description               |
| --------------- | ------------------------- |
| `--name <name>` | Resource name             |
| `--force`       | Skip confirmation         |
| `--dry-run`     | Preview (remove all only) |
| `--json`        | JSON output               |

---

## Development

### dev

Start local development server.

```bash
agentcore dev
agentcore dev --agent MyAgent --port 3000
agentcore dev --logs                      # Non-interactive
agentcore dev --invoke "Hello" --stream   # Direct invoke
```

| Flag                    | Description                     |
| ----------------------- | ------------------------------- |
| `-p, --port <port>`     | Port (default: 8080)            |
| `-a, --agent <name>`    | Agent to run                    |
| `-i, --invoke <prompt>` | Invoke running server           |
| `-s, --stream`          | Stream response (with --invoke) |
| `-l, --logs`            | Non-interactive stdout logging  |

### invoke

Invoke local or deployed agents.

```bash
agentcore invoke "What can you do?"
agentcore invoke --prompt "Hello" --stream
agentcore invoke --agent MyAgent
agentcore invoke --session-id abc123      # Continue session
agentcore invoke --new-session            # Fresh session
agentcore invoke --json                   # JSON output
```

| Flag                | Description               |
| ------------------- | ------------------------- |
| `--prompt <text>`   | Prompt text               |
| `--agent <name>`    | Specific agent            |
| `--session-id <id>` | Continue specific session |
| `--new-session`     | Start fresh session       |
| `--stream`          | Stream response           |
| `--json`            | JSON output               |

---

## Evaluations

See [Evaluations](evals.md) for the full guide on evaluators, scoring, and online monitoring.

### run evals

Run on-demand evaluation against historical agent traces.

```bash
# Project mode
agentcore run evals --agent MyAgent --evaluator ResponseQuality --days 7

# Standalone mode (no project required)
agentcore run evals \
  --agent-arn arn:aws:...:runtime/abc123 \
  --evaluator-arn arn:aws:...:evaluator/eval123 \
  --region us-east-1
```

| Flag                         | Description                               |
| ---------------------------- | ----------------------------------------- |
| `-a, --agent <name>`         | Agent name from project                   |
| `--agent-arn <arn>`          | Agent runtime ARN (standalone mode)       |
| `-e, --evaluator <names...>` | Evaluator name(s) or `Builtin.*` IDs      |
| `--evaluator-arn <arns...>`  | Evaluator ARN(s) (use with `--agent-arn`) |
| `--region <region>`          | AWS region (required with `--agent-arn`)  |
| `-s, --session-id <id>`      | Evaluate a specific session               |
| `-t, --trace-id <id>`        | Evaluate a specific trace                 |
| `--days <days>`              | Lookback window in days (default: 7)      |
| `--output <path>`            | Custom output file path                   |
| `--json`                     | JSON output                               |

### evals history

View past on-demand eval run results.

```bash
agentcore evals history
agentcore evals history --agent MyAgent --limit 5 --json
```

| Flag                  | Description          |
| --------------------- | -------------------- |
| `-a, --agent <name>`  | Filter by agent name |
| `-n, --limit <count>` | Max runs to display  |
| `--json`              | JSON output          |

### pause online-eval

Pause a deployed online eval config.

```bash
agentcore pause online-eval QualityMonitor
agentcore pause online-eval --arn arn:aws:...:online-eval-config/abc123
```

| Flag                | Description                                        |
| ------------------- | -------------------------------------------------- |
| `[name]`            | Config name from project (not needed with `--arn`) |
| `--arn <arn>`       | Online eval config ARN (standalone mode)           |
| `--region <region>` | AWS region override                                |
| `--json`            | JSON output                                        |

### resume online-eval

Resume a paused online eval config.

```bash
agentcore resume online-eval QualityMonitor
agentcore resume online-eval --arn arn:aws:...:online-eval-config/abc123
```

| Flag                | Description                                        |
| ------------------- | -------------------------------------------------- |
| `[name]`            | Config name from project (not needed with `--arn`) |
| `--arn <arn>`       | Online eval config ARN (standalone mode)           |
| `--region <region>` | AWS region override                                |
| `--json`            | JSON output                                        |

### logs evals

Stream or search online eval logs.

```bash
agentcore logs evals --agent MyAgent --since 1h
agentcore logs evals --follow --json
```

| Flag                  | Description                                   |
| --------------------- | --------------------------------------------- |
| `-a, --agent <name>`  | Filter by agent                               |
| `--since <time>`      | Start time (e.g. `1h`, `30m`, `2d`, ISO 8601) |
| `--until <time>`      | End time                                      |
| `-n, --lines <count>` | Maximum log lines                             |
| `-f, --follow`        | Stream in real-time                           |
| `--json`              | JSON Lines output                             |

---

## Utilities

### package

Package agent artifacts without deploying.

```bash
agentcore package
agentcore package --agent MyAgent
agentcore package -d ./my-project
```

| Flag                     | Description            |
| ------------------------ | ---------------------- |
| `-d, --directory <path>` | Project directory      |
| `-a, --agent <name>`     | Package specific agent |

### update

Check for CLI updates.

```bash
agentcore update           # Check and install
```

---

## Common Patterns

### CI/CD Pipeline

```bash
# Validate and deploy with auto-confirm
agentcore validate
agentcore deploy -y --json
```

### Scripted Project Setup

```bash
agentcore create --name MyProject --defaults
cd MyProject
agentcore add memory --name SharedMemory --strategies SEMANTIC
agentcore deploy -y
```

### Gateway Setup

```bash
agentcore add gateway --name MyGateway
agentcore add gateway-target \
  --name WeatherTools \
  --type mcp-server \
  --endpoint https://mcp.example.com/mcp \
  --gateway MyGateway
agentcore deploy -y
```

### JSON Output for Automation

All commands with `--json` output structured data:

```bash
agentcore status --json | jq '.agents[0].runtimeArn'
agentcore invoke "Hello" --json | jq '.response'
```
