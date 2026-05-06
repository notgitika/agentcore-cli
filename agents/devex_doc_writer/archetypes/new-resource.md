# Archetype: New Resource

**Priority:** P0 **Examples:** Configuration Bundles, Datasets, Harness, any new AgentCore service primitive

---

## When This Applies

A new service capability that maps to a new resource type in the CLI:

- Has its own CRUD API operations (Create, Get, Update, Delete, List)
- Gets a new array in `agentcore.json`
- Gets a new primitive class in `src/cli/primitives/`
- Gets a CDK construct (if CFN support exists) or imperative deploy step
- Gets deployed state tracking in `deployed-state.json`

If you're not adding a new resource type to the schema — if you're instead expanding what an existing surface can do —
see `scope-widening.md`.

---

## Input Specification

Inputs are split into two categories:

- **User Provides:** Feature-specific facts that can't be derived from the codebase — API operations, trust policies,
  account info, service details. These come from outside the repo (service team docs, API models, IAM requirements).
- **Agent Proposes:** Architecture decisions derivable from codebase patterns + the user's inputs. The agent proposes
  these _with reasoning_ ("since cfn_support=true and the closest analogue uses CDK, I propose deploy_strategy: cdk").
  The user confirms or corrects.

This isn't about knowledge gaps — CLI engineers know the architecture. It's about making the agent's assumptions
explicit and correctable rather than silently baked into the output.

### User Provides (Required Contract)

These fields are feature-specific and can't be derived from the codebase. The agent NEVER assumes values for these — if
missing, it asks.

#### 1. Feature Identity

| Field                  | Type   | Description                            | Example                        |
| ---------------------- | ------ | -------------------------------------- | ------------------------------ |
| `feature_name`         | string | Human-readable name                    | "Configuration Bundles"        |
| `feature_slug`         | string | Kebab-case for paths, commands         | `config-bundle`                |
| `feature_description`  | string | 1-3 paragraphs. Problem + dev benefit. | "Configuration bundles let..." |
| `service_team`         | string | Owning team                            | "AgentCore Control Plane"      |
| `service_team_contact` | string | Alias for decisions/questions          | "tjariy@"                      |

#### 2. Target Repository & Sensitivity

| Field                 | Type   | Description                        | Example              |
| --------------------- | ------ | ---------------------------------- | -------------------- |
| `target_repo`         | enum   | `public` or `private`              | `"private"`          |
| `target_cdk_repo`     | enum   | `public` or `private`              | `"public"`           |
| `sensitivity_level`   | enum   | `public` or `internal`             | `"internal"`         |
| `public_feature_name` | string | Required if internal + public repo | `"resource-bundles"` |

#### 3. AWS Account & Environment

| Field                       | Type     | Description                    | Example                                       |
| --------------------------- | -------- | ------------------------------ | --------------------------------------------- |
| `allowlisted_account_id`    | string   | 12-digit AWS account           | `"123456789012"`                              |
| `allowlisted_regions`       | string[] | Where service is available     | `["us-west-2"]`                               |
| `sdk_available`             | boolean  | SDK includes operations?       | `true`                                        |
| `sdk_package_name`          | string   | Required if sdk_available=true | `"@aws-sdk/client-bedrock-agentcore-control"` |
| `service_endpoint_override` | string   | Optional: beta/gamma endpoint  |                                               |

#### 4. API Surface

| Field                      | Type        | Description                                                          | Example                       |
| -------------------------- | ----------- | -------------------------------------------------------------------- | ----------------------------- |
| `api_source`               | enum        | `smithy_model`, `dev_guide_url`, `openapi_spec`, `inline_operations` | `"smithy_model"`              |
| `api_reference`            | string      | URL or local file path                                               |                               |
| `control_plane_service`    | string      | Service identifier                                                   | `"bedrock-agentcore-control"` |
| `control_plane_operations` | Operation[] | CRUD operations                                                      | See below                     |
| `data_plane_service`       | string      | Optional: if async ops                                               | `"bedrock-agentcore"`         |
| `data_plane_operations`    | Operation[] | Optional                                                             |                               |
| `status_enum`              | StatusFlow  | Optional: state machine for async                                    |                               |

#### 5. IAM & Trust Policy

| Field                  | Type              | Description                                    | Example                             |
| ---------------------- | ----------------- | ---------------------------------------------- | ----------------------------------- |
| `trust_policy`         | JSON              | AssumeRolePolicyDocument for auto-created role | See example below                   |
| `service_principal`    | string            | CDK: `new iam.ServicePrincipal(...)`           | `"bedrock-agentcore.amazonaws.com"` |
| `required_permissions` | PolicyStatement[] | Identity policy → `role.addToPolicy()`         |                                     |

#### 6. CloudFormation Support

| Field               | Type     | Description               | Example                                 |
| ------------------- | -------- | ------------------------- | --------------------------------------- |
| `cfn_support`       | boolean  | CFN support exists today? | `true`                                  |
| `cfn_resource_type` | string   | Required if true          | `"AWS::BedrockAgentCore::ConfigBundle"` |
| `cfn_outputs`       | string[] | Required if true          | `["ConfigBundleId", "ConfigBundleArn"]` |

#### 7. Developer Experience

| Field               | Type     | Description             | Example                   |
| ------------------- | -------- | ----------------------- | ------------------------- |
| `cli_verb`          | string   | Primary verb            | `"add"`                   |
| `additional_verbs`  | string[] | Optional: beyond CRUD   | `["run", "pause"]`        |
| `tui_flow`          | boolean  | Needs TUI wizard?       | `true`                    |
| `supports_remove`   | boolean  | Removable?              | `true`                    |
| `scope_constraints` | string[] | Optional: v1 exclusions | `["no dashboard for v1"]` |

#### 8. Closest Analogue

| Field                        | Type   | Description            | Example                              |
| ---------------------------- | ------ | ---------------------- | ------------------------------------ |
| `closest_primitive_analogue` | string | Most similar primitive | `"evaluator"`                        |
| `analogue_rationale`         | string | Why this match         | "Both schema-first, cross-refs, CDK" |

---

### Agent Proposes (Inferred — Presented with Reasoning for Confirmation)

After loading knowledge, the agent proposes these values with explicit rationale. The user confirms, corrects, or
overrides. Nothing is silently assumed.

| Field                        | How Inferred                                  | Example                                    |
| ---------------------------- | --------------------------------------------- | ------------------------------------------ |
| `schema_location`            | From analogue + standalone vs nested          | `"top_level_array"`                        |
| `schema_key`                 | From feature_slug, camelCased                 | `"configBundles"`                          |
| `deploy_strategy`            | `cfn_support=true` → `"cdk"`                  | `"cdk"`                                    |
| `deploy_dependencies`        | From cross-resource analysis                  | `["agent"]`                                |
| `tui_steps`                  | From API input shape (group fields logically) | `["Name", "Config", "Confirm"]`            |
| `remove_has_dependencies`    | From referenced_by analysis                   | `true`                                     |
| `references_other_resources` | From API input fields that look like names    | `[{field: "agentName", target: "agents"}]` |
| `cross_resource_permissions` | From trust policy + permissions analysis      |                                            |
| `resource_name_constraints`  | From API docs regex                           |                                            |

---

### Sub-Schemas

#### Operation

```yaml
Operation:
  name: string # "CreateConfigBundle"
  http_method: string # POST
  http_path: string # "/configuration-bundles"
  input_shape: string # Key fields (brief is fine)
  output_shape: string # Key fields
  is_async: boolean # Returns 202?
  notes: string # Constraints, limits
```

#### StatusFlow

```yaml
StatusFlow:
  states: string[]
  transitions:
    - from: 'PENDING'
      to: ['IN_PROGRESS', 'FAILED']
  terminal_states: string[]
  poll_operation: string
```

#### PolicyStatement

```yaml
PolicyStatement:
  actions: string[] # ["bedrock-agentcore:GetConfigBundle"]
  resources: string[] # ARN patterns with ${partition}, ${region}, ${account}
  conditions: object # Optional
  description: string # Why needed
```

#### Trust Policy Example

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "${AWS::AccountId}" }
      }
    }
  ]
}
```

---

## Input Validation Rules

1. `feature_slug` must not collide with existing schema keys or commands
2. `trust_policy` must be valid JSON with Statement + Principal
3. `control_plane_operations` must include at least one mutating op (Create/Update/Delete) OR be explicitly read-only
4. `closest_primitive_analogue` must exist in snapshot
5. `allowlisted_account_id` must be 12 digits
6. `allowlisted_regions` must be valid AgentCore regions
7. If `cfn_support=true`: `cfn_resource_type` and `cfn_outputs` required
8. If `data_plane_operations` non-empty: `status_enum` recommended (warning)
9. If `sensitivity_level=internal` AND `target_repo=public`: `public_feature_name` required
10. If `sdk_available=false`: `service_endpoint_override` recommended (warning)

---

## Archetype-Specific Biases

These extend the universal biases from SYSTEM.md:

7. **CDK if CFN exists, imperative if not.** Never mix within a single resource. If CFN is promised but unavailable
   today: ship imperative now with documented CDK migration plan. Imperative code marked transitional.
8. **TUI for creation, flags for operations.** Creation flows (`agentcore add *`) have multi-field wizards. Operational
   commands are flags-only.
9. **Flat schemas over nested.** Unless cross-resource references demand nesting.
10. **Same service principal unless told otherwise.** Default `bedrock-agentcore.amazonaws.com`.

---

## Self-Review Extensions

In addition to the 9-point base checklist (SYSTEM.md), new-resource docs are checked for:

| #   | Check                          | Critical? | What Passes                                                     |
| --- | ------------------------------ | --------- | --------------------------------------------------------------- |
| R1  | **API coverage**               | Yes       | Every control plane operation mapped to a CLI command           |
| R2  | **Schema shown as JSON + Zod** | Yes       | Both `agentcore.json` example AND TypeScript Zod schema present |
| R3  | **Deployed state specified**   | Yes       | `deployed-state.json` additions defined with field names        |
| R4  | **CDK vs imperative decided**  | Yes       | Explicitly chosen with rationale + precedent                    |
| R5  | **Deploy flow shown**          | No        | Shows where new step inserts in numbered flow                   |
| R6  | **Cross-field validation**     | No        | If cross-references exist, superRefine rules described          |
| R7  | **TUI wireframes**             | No        | Multi-step flows have ASCII mockups                             |

---

## Template Sections

For this archetype, the DevEx doc includes these sections (in order):

1. **What is [Feature]?** — 2-3 paragraphs for someone unfamiliar
2. **Scope** — what's in, what's out
3. **Positioning in the CLI** — how relates to existing features (table)
4. **Developer Journeys** — numbered scenarios with CLI commands, TUI wireframes, "Under the hood:", "What we build:"
5. **API Surface** — control plane + data plane tables, status values
6. **CLI Command ↔ API Mapping** — table
7. **Schema Changes** — agentcore.json (JSON) + Zod + deployed-state.json
8. **Codebase Changes** — New Files table + Modified Files table
9. **How It Fits in the CLI Architecture** — CDK vs imperative, deploy flow, execution role
10. **Architectural Decisions** — table with rationale
11. **Implementation Phases** — independently shippable
12. **Testing Strategy** — unit, snapshot, integration
13. **Open Questions** — table
14. **Appendix** — TUI mockups, IAM policies, full API shapes (implementation detail here)

---

## Implementation Plan Shape (Stage 2)

New Resource features typically follow this phase pattern:

```
Phase 1: Schema + Primitive + Remove
  • Zod schema for the resource
  • Add to agentcore-project.ts (top-level array)
  • Deployed state schema additions
  • Primitive class (add + remove lifecycle)
  • Register in registry
  • Wire into add/remove commands
  • Unit tests

Phase 2: CDK Construct + Deploy
  • CDK construct in agentcore-l3-cdk-constructs
  • IAM role creation with trust policy
  • Required permissions
  • Integration into deploy flow (CDK or imperative step)
  • deployed-state.json population from CFN outputs
  • Deploy tests

Phase 3: TUI + Polish
  • TUI wizard screens (if tui_flow=true)
  • Wizard hook (step logic)
  • Operation hook
  • Snapshot tests for any new assets/templates

Phase 4: Data Plane Operations (if applicable)
  • Data plane commands (run, poll, get results)
  • Status tracking / polling logic
  • Streaming output (if async)

Phase 5: Advanced Features (per scope_constraints)
  • Whatever was deferred from v1
```

Not all phases apply to every resource. The impl plan writer picks the relevant ones.

---

## Quick Start Example

```yaml
archetype: 'new_resource'

feature_name: 'Configuration Bundles'
feature_slug: 'config-bundle'
feature_description: 'Package and version configuration parameters for agents'
service_team: 'AgentCore Control Plane'
service_team_contact: 'tjariy@'

target_repo: 'private'
target_cdk_repo: 'public'
sensitivity_level: 'internal'

allowlisted_account_id: '123456789012'
allowlisted_regions: ['us-west-2']
sdk_available: true
sdk_package_name: '@aws-sdk/client-bedrock-agentcore-control'

api_source: 'smithy_model'
api_reference: 'https://...'
control_plane_service: 'bedrock-agentcore-control'
control_plane_operations:
  - name: 'CreateConfigBundle'
    http_method: 'POST'
    http_path: '/configuration-bundles'
    input_shape: 'name, parameters[]'
    output_shape: 'configBundleId, configBundleArn, status'
    is_async: false
    notes: ''

trust_policy:
  Version: '2012-10-17'
  Statement:
    - Effect: 'Allow'
      Principal:
        Service: 'bedrock-agentcore.amazonaws.com'
      Action: 'sts:AssumeRole'
service_principal: 'bedrock-agentcore.amazonaws.com'
required_permissions:
  - actions: ['bedrock-agentcore:GetConfigBundle']
    resources: ['arn:${partition}:bedrock-agentcore:${region}:${account}:config-bundle/*']
    description: 'Runtime reads config bundles at invocation'

cfn_support: true
cfn_resource_type: 'AWS::BedrockAgentCore::ConfigBundle'
cfn_outputs: ['ConfigBundleId', 'ConfigBundleArn']

cli_verb: 'add'
tui_flow: true
supports_remove: true

closest_primitive_analogue: 'evaluator'
analogue_rationale: 'Schema-first resource with CDK deploy and cross-resource references'
```

After receiving this, the agent will:

1. Validate all fields
2. Refresh knowledge snapshot
3. Validate analogue choice (does `evaluator` shape match this feature?)
4. Propose inferred decisions (schema_key, deploy_strategy, tui_steps, etc.)
5. Ask user to confirm
6. Begin writing
