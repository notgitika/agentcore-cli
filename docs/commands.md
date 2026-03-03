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

Add a gateway target to the project. Targets are backend tools exposed through a gateway as an external MCP server
endpoint.

```bash
# Interactive mode (select 'Gateway Target' from the menu)
agentcore add

# External MCP server endpoint
agentcore add gateway-target \
  --name WeatherTools \
  --source existing-endpoint \
  --endpoint https://mcp.example.com/mcp \
  --gateway MyGateway

# External endpoint with OAuth outbound auth
agentcore add gateway-target \
  --name SecureTools \
  --source existing-endpoint \
  --endpoint https://api.example.com/mcp \
  --gateway MyGateway \
  --outbound-auth oauth \
  --oauth-client-id my-client \
  --oauth-client-secret my-secret \
  --oauth-discovery-url https://auth.example.com/.well-known/openid-configuration
```

| Flag                             | Description                                     |
| -------------------------------- | ----------------------------------------------- |
| `--name <name>`                  | Target name                                     |
| `--description <desc>`           | Target description                              |
| `--source <source>`              | `existing-endpoint`                             |
| `--endpoint <url>`               | MCP server endpoint URL                         |
| `--gateway <name>`               | Gateway to attach target to                     |
| `--outbound-auth <type>`         | `oauth`, `api-key`, or `none`                   |
| `--credential-name <name>`       | Existing credential name for outbound auth      |
| `--oauth-client-id <id>`         | OAuth client ID (creates credential inline)     |
| `--oauth-client-secret <secret>` | OAuth client secret (creates credential inline) |
| `--oauth-discovery-url <url>`    | OAuth discovery URL (creates credential inline) |
| `--oauth-scopes <scopes>`        | OAuth scopes, comma-separated                   |
| `--json`                         | JSON output                                     |

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

### remove

Remove resources from project.

```bash
agentcore remove agent --name MyAgent --force
agentcore remove memory --name SharedMemory
agentcore remove identity --name OpenAI
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
  --source existing-endpoint \
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
