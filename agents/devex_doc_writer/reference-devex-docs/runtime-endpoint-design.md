# Runtime Endpoint Support in AgentCore CLI

## Problem

AgentCore runtimes support multiple endpoints, each associated with a different version. Today the CLI models a runtime
as a flat object with a single `runtimeVersion` that we deploy. There is no way for a user to register additional
endpoints or manage version-specific configurations for the same runtime.

## Proposal

Add a subcommand under `agentcore add` for managing runtime endpoints.

### CLI Commands

```bash
agentcore add runtime-endpoint \
  --runtime <my-runtime> \
  --endpoint <endpoint-name> \
  --version <version-number> \
  --description "optional description"
```

**Validation:**

- All 3 flags (`--runtime`, `--endpoint`, `--version`) are required.
- `--runtime` must reference an existing runtime in `agentcore.json` (no off-project runtimes for now — can be extended
  later with a `--runtime-arn` flag).
- `--endpoint` can be a new or existing endpoint name. Must follow API regex.
- `--version` is an integer. Cannot be higher than the latest runtime version. Must follow API regex.
- `--description` is optional.

`agentcore status` will show endpoints under each runtime.

```bash
agentcore remove runtime-endpoint <endpoint-name>
```

### Schema Change

Endpoints are stored as a dictionary on the runtime object in `agentcore.json`:

```json
{
  "runtimes": [
    {
      "name": "my-agent",
      "endpoints": {
        "prod": {
          "version": "3",
          "description": "Production traffic"
        },
        "canary": {
          "version": "4",
          "description": "Canary rollout"
        }
      }
    }
  ]
}
```

### Version Discovery

Users can check the current (latest) version for a runtime via `agentcore status`, which already shows deployed runtime
info. We will extend the status output to also display the latest version number alongside each runtime, so users know
which versions are valid when adding an endpoint.

### Deploy Behavior

**Default:** If a runtime has no `endpoints` configured, `agentcore deploy` deploys to a `DEFAULT` endpoint (same as
today — no change in behavior for existing users).

**With endpoints:** When endpoints are present, deploy updates the configured endpoints to point at the specified
versions. This happens automatically as part of the CDK synth — no extra flags needed at deploy time.

**Multi-runtime deploy config (advanced):** Instead of per-deploy flags (which get unwieldy as projects grow), we
support an optional deploy config file that maps runtimes and endpoints to versions:

```json
// deploy-config.json (passed via agentcore deploy --config deploy-config.json)
{
  "my-agent": {
    "prod": "3",
    "canary": "4"
  },
  "my-other-agent": {
    "prod": "1"
  }
}
```

This lets users deploy specific version combinations across multiple runtimes in a single command without juggling
flags. If no config file is passed, we use whatever is in `agentcore.json` endpoints.

### CDK Changes

The CDK stack reads `agentcore.json` and synthesizes CloudFormation. It will need to:

1. Read the `endpoints` dictionary from each runtime.
2. Map each entry to the appropriate AgentCore service API calls (create/update endpoint alias with version).

## Out of Scope

1. Endpoint-specific env vars or network config.
2. Promotion workflows.

If team thinks these also need to be addressed, let me know.
