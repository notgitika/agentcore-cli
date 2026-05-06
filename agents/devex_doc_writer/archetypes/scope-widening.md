# Archetype: Scope Widening

**Priority:** P0 **Examples:** Terraform support, Node.js CodeZip, new auth model (CUSTOM_JWT), Container build support,
new container runtime (Finch/Podman), multi-region deploy

---

## When This Applies

You're expanding what an existing CLI surface can do — not adding a new resource type. The feature:

- Does NOT get its own new array in `agentcore.json` (usually)
- Does NOT get a new primitive class (usually)
- DOES touch existing commands, deploy flow, build system, or configuration
- DOES require coexistence with the current approach (backwards compat)
- DOES affect multiple existing files across several layers

**The key difference from New Resource:** New Resource is additive (new schema, new primitive, new construct). Scope
Widening is multiplicative (existing surfaces gain new capabilities, existing patterns branch into variants).

**Historical examples already shipped:**

- Container build type (added alongside CodeZip)
- CUSTOM_JWT authorizer (added alongside AWS_IAM)
- VPC network mode (added alongside PUBLIC)
- Finch/Podman container runtimes (added alongside Docker)

---

## Input Specification

Inputs split into two categories:

- **User Provides:** Feature-specific facts that can't be derived from the codebase — current/target architecture,
  affected surfaces, external tool requirements, coexistence model.
- **Agent Proposes:** Architecture decisions derivable from codebase patterns + the user's inputs. Proposed with
  explicit reasoning, confirmed or corrected by the user.

### User Provides (Required Contract)

These fields are feature-specific and can't be derived from the codebase. The agent NEVER assumes values for these — if
missing, it asks.

#### 1. Feature Identity

| Field                  | Type   | Description             | Example                                                                                               |
| ---------------------- | ------ | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `feature_name`         | string | Human-readable name     | "Terraform Deploy Support"                                                                            |
| `feature_slug`         | string | Kebab-case identifier   | `terraform-deploy`                                                                                    |
| `feature_description`  | string | Problem + what devs get | "Developers can deploy AgentCore projects using Terraform as an alternative to CDK/CloudFormation..." |
| `service_team`         | string | Owning team             | "AgentCore CLI"                                                                                       |
| `service_team_contact` | string | Alias for decisions     | "gitikavj@"                                                                                           |

#### 2. Target Repository & Sensitivity

Same as New Resource archetype — see `new-resource.md` section 2.

#### 3. AWS Account & Environment

| Field                    | Type         | Description                    | Example          |
| ------------------------ | ------------ | ------------------------------ | ---------------- |
| `allowlisted_account_id` | string       | For testing                    | `"123456789012"` |
| `allowlisted_regions`    | string[]     | Where to test                  | `["us-west-2"]`  |
| `external_dependencies`  | Dependency[] | Tools/services this depends on | See below        |

#### 4. Current Architecture

| Field                     | Type     | Description                                      | Example                                                               |
| ------------------------- | -------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| `current_description`     | string   | How it works today (1-2 paragraphs)              | "Deploy currently uses CDK to synthesize CloudFormation templates..." |
| `current_key_files`       | string[] | The files/directories this feature touches today | `["src/cli/cdk/", "src/cli/operations/deploy/", "src/assets/cdk/"]`   |
| `current_user_experience` | string   | What the developer does today (CLI commands)     | "`agentcore deploy` synths CDK and runs `cdk deploy`"                 |

#### 5. Target Architecture

| Field                  | Type    | Description                                                                                                            | Example                                                                                                                |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `target_description`   | string  | How it should work after (1-2 paragraphs)                                                                              | "Developer chooses Terraform or CDK at project creation. `agentcore deploy` dispatches to the appropriate provider..." |
| `coexistence_model`    | enum    | How old and new coexist: `user_chooses_one` (per project), `stacked` (new builds on old), `migration` (old deprecated) | `"user_chooses_one"`                                                                                                   |
| `backwards_compatible` | boolean | Do existing projects break? Must be true unless there's a migration plan.                                              | `true`                                                                                                                 |
| `migration_plan`       | string  | Required if backwards_compatible=false. How existing users transition.                                                 |                                                                                                                        |

#### 6. Affected Surfaces

| Field                   | Type              | Description                            | Example                                                        |
| ----------------------- | ----------------- | -------------------------------------- | -------------------------------------------------------------- |
| `affected_commands`     | AffectedCommand[] | Which existing commands change and how | See below                                                      |
| `affected_schema`       | AffectedSchema[]  | Which config files change              | See below                                                      |
| `affected_deploy_flow`  | string            | How the deploy pipeline changes        | "Step 4 branches: CDK path (existing) or Terraform path (new)" |
| `affected_build_system` | string            | Optional: if build/packaging changes   |                                                                |

#### 7. External Tool/Service

| Field                   | Type     | Description                                  | Example                                                  |
| ----------------------- | -------- | -------------------------------------------- | -------------------------------------------------------- |
| `external_tool`         | string   | Optional: external tool being integrated     | "Terraform"                                              |
| `external_tool_version` | string   | Optional: minimum version                    | ">=1.5.0"                                                |
| `external_docs_url`     | string   | Optional: reference docs                     | "https://developer.hashicorp.com/terraform"              |
| `user_prerequisites`    | string[] | What the user must have installed/configured | `["terraform CLI installed", "AWS provider configured"]` |

#### 8. Closest Analogue

| Field                             | Type   | Description                                 | Example                                                                                                          |
| --------------------------------- | ------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `closest_scope_widening_analogue` | string | Previous scope widening that's most similar | "Container build type addition"                                                                                  |
| `analogue_rationale`              | string | Why                                         | "Both add a new deploy provider choice at project level, both coexist with existing, both need template changes" |

---

### Sub-Schemas

#### AffectedCommand

```yaml
AffectedCommand:
  command: string # "agentcore deploy"
  change_type: enum # "new_flag" | "new_behavior" | "branching_logic" | "new_subcommand"
  description: string # "Adds --provider flag or reads from project config"
  backwards_compatible: boolean
```

#### AffectedSchema

```yaml
AffectedSchema:
  file: string # "agentcore.json" or "deployed-state.json"
  change_type: enum # "new_field" | "new_enum_value" | "new_section" | "type_widening"
  description: string # "Add 'deployProvider' field to project root: 'cdk' | 'terraform'"
```

#### Dependency

```yaml
Dependency:
  name: string # "terraform"
  type: enum # "cli_tool" | "npm_package" | "aws_service" | "runtime"
  version_constraint: string # ">=1.5.0"
  optional: boolean # true if feature degrades gracefully without it
  detection: string # How CLI checks if it's available: "which terraform"
```

---

### Agent Proposes (Inferred — Presented with Reasoning for Confirmation)

Nothing is silently assumed. The agent proposes with rationale, the user confirms or overrides.

| Field                     | How Inferred                                  | Example                                                                              |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `implementation_approach` | From coexistence_model + affected surfaces    | "Strategy pattern: deploy dispatches to CDKProvider or TerraformProvider"            |
| `new_files`               | From affected surfaces + analogue             | `["src/cli/operations/deploy/terraform-provider.ts"]`                                |
| `modified_files`          | From affected_commands + affected_schema      | `["src/cli/operations/deploy/deploy.ts", "src/schema/schemas/agentcore-project.ts"]` |
| `feature_detection`       | From external_tool + user_prerequisites       | "Check `which terraform` at deploy time, error with install guidance"                |
| `rollback_strategy`       | From backwards_compatible + coexistence_model | "User switches back by changing `deployProvider` in config"                          |

---

## Input Validation Rules

1. `current_key_files` must all exist in the snapshot (validates we're talking about real code)
2. `coexistence_model` required — no scope widening lands without a coexistence story
3. If `backwards_compatible=false`: `migration_plan` is required
4. `affected_commands` must reference real existing commands (checked against snapshot)
5. `affected_schema` changes must not conflict with existing field names
6. If `external_tool`: `user_prerequisites` should describe how CLI detects availability
7. `closest_scope_widening_analogue` should map to a known historical change (agent validates)

---

## Archetype-Specific Biases

These extend the universal biases from SYSTEM.md:

7. **Coexistence over replacement.** Never deprecate the existing path in v1. Both old and new must work. Deprecation is
   a separate, later decision.
8. **Detection over assumption.** If the feature depends on an external tool, the CLI detects its presence and fails
   with clear guidance. Never assume it's installed.
9. **Configuration over flags for persistent choices.** If the user picks "Terraform" once, that goes in config
   (`agentcore.json`). Don't make them pass `--provider terraform` every time.
10. **Same commands, branching internals.** `agentcore deploy` still works — it dispatches to the right provider
    internally. Don't add `agentcore deploy-terraform` as a separate command.
11. **Template at creation, not retrofit.** New projects get the new option at `agentcore create` time. Existing
    projects can opt-in via config change, but don't auto-migrate.

---

## Self-Review Extensions

In addition to the 9-point base checklist (SYSTEM.md), scope-widening docs are checked for:

| #   | Check                              | Critical? | What Passes                                                             |
| --- | ---------------------------------- | --------- | ----------------------------------------------------------------------- |
| S1  | **Backwards compatibility proven** | Yes       | Existing projects work unchanged without any action                     |
| S2  | **Coexistence model explicit**     | Yes       | How old + new coexist is stated clearly (not implied)                   |
| S3  | **Affected commands listed**       | Yes       | Every command that changes behavior is identified                       |
| S4  | **Migration path defined**         | No        | If user wants to switch from old to new (or back), steps are documented |
| S5  | **Detection/prerequisites shown**  | Yes       | How CLI detects external deps + error message if missing                |
| S6  | **Blast radius bounded**           | Yes       | List of modified files is complete; no hidden impacts                   |
| S7  | **Existing tests don't break**     | No        | Strategy for ensuring existing test suite still passes                  |

---

## Template Sections

For this archetype, the DevEx doc includes these sections (in order):

1. **What is [Feature]?** — 2-3 paragraphs, problem + benefit
2. **Scope** — in/out, explicitly what's NOT changing
3. **Current State** — how it works today (commands, flow, architecture)
4. **Target State** — how it works after (commands, flow, architecture)
5. **Coexistence Model** — how old and new live together, user's choice mechanism
6. **Developer Journeys** — numbered scenarios:
   - New project with the new capability
   - Existing project opting in
   - Existing project that doesn't change (proves backwards compat)
7. **Affected Commands** — table: command, what changes, backwards compat?
8. **Schema Changes** — what fields change/add in agentcore.json, deployed-state.json
9. **Detection & Prerequisites** — how CLI checks for external deps, error messages
10. **Codebase Changes** — New Files + Modified Files tables (these tend to be heavy on "Modified")
11. **How It Fits: Architecture** — where the branching point is, which pattern (strategy, adapter, etc.)
12. **Deploy Flow Change** — current numbered flow vs new numbered flow (side by side)
13. **Architectural Decisions** — table with rationale
14. **Implementation Phases** — independently shippable
15. **Testing Strategy** — existing test preservation, new test matrix (N variants × M scenarios)
16. **Open Questions** — table
17. **Appendix** — full config examples for old path + new path side by side

---

## Implementation Plan Shape (Stage 2)

Scope Widening features typically follow this phase pattern:

```
Phase 1: Foundation + Detection
  • External tool detection utility (if applicable)
  • Configuration schema change (new field/enum)
  • Project-level config validation
  • No behavior change yet — just the ability to declare intent
  • Tests: schema validation, detection logic

Phase 2: Core Implementation
  • The new code path (e.g., TerraformProvider)
  • Integration point (e.g., deploy dispatcher branches)
  • Template/assets for new path (e.g., Terraform templates)
  • Tests: new path works end-to-end

Phase 3: Creation Flow Integration
  • `agentcore create` offers the new option
  • Templates vended for new path
  • TUI wizard updated (if applicable)
  • Tests: create flow, template snapshots

Phase 4: Polish + Migration
  • Opt-in mechanism for existing projects
  • Documentation updates
  • Error messages for edge cases (wrong version, missing tool, etc.)
  • Tests: migration path, error scenarios
```

Key difference from New Resource: Phase 1 is about _declaring intent without behavior change_ (safe to merge early),
then Phase 2 adds the behavior.

---

## Quick Start Example

```yaml
archetype: 'scope_widening'

feature_name: 'Terraform Deploy Support'
feature_slug: 'terraform-deploy'
feature_description: |
  Developers can deploy AgentCore projects using Terraform as an alternative
  to CDK/CloudFormation. This gives teams already using Terraform a native
  integration path without requiring CDK expertise.
service_team: 'AgentCore CLI'
service_team_contact: 'gitikavj@'

target_repo: 'private'
target_cdk_repo: 'public'
sensitivity_level: 'internal'

allowlisted_account_id: '123456789012'
allowlisted_regions: ['us-west-2']
external_dependencies:
  - name: 'terraform'
    type: 'cli_tool'
    version_constraint: '>=1.5.0'
    optional: false
    detection: 'which terraform && terraform version'

current_description: |
  Deploy uses CDK to synthesize CloudFormation templates and deploy via
  the CDK toolkit. All resources (runtimes, memories, credentials, etc.)
  are modeled as CDK constructs in @aws/agentcore-l3-cdk-constructs.
current_key_files:
  - 'src/cli/cdk/'
  - 'src/cli/operations/deploy/'
  - 'src/assets/cdk/'
  - 'agentcore-l3-cdk-constructs (separate repo)'
current_user_experience: |
  `agentcore deploy` synths the CDK app and runs `cdk deploy`.
  Resources are defined in agentcore.json, translated to CDK constructs.

target_description: |
  Developer chooses Terraform or CDK at project creation time (or opts in
  later via config). `agentcore deploy` dispatches to the appropriate
  provider. Both produce the same deployed-state.json output format.
coexistence_model: 'user_chooses_one'
backwards_compatible: true

affected_commands:
  - command: 'agentcore create'
    change_type: 'new_behavior'
    description: 'Asks deploy provider preference (CDK or Terraform)'
    backwards_compatible: true
  - command: 'agentcore deploy'
    change_type: 'branching_logic'
    description: 'Dispatches to CDK or Terraform provider based on project config'
    backwards_compatible: true
  - command: 'agentcore status'
    change_type: 'new_behavior'
    description: 'Reads state from terraform.tfstate or CFN outputs depending on provider'
    backwards_compatible: true

affected_schema:
  - file: 'agentcore.json'
    change_type: 'new_field'
    description: "Add 'deployProvider' field at project root: 'cdk' | 'terraform' (default: 'cdk')"
  - file: 'deployed-state.json'
    change_type: 'new_field'
    description: "Add 'stateBackend' field: 'cloudformation' | 'terraform-local' | 'terraform-s3'"

affected_deploy_flow: |
  Step 4 branches:
    CDK path (existing): CDK synth + cdk deploy
    Terraform path (new): Generate .tf files from schema → terraform init → terraform apply
  Steps 1-3 and 5-6 remain the same regardless of provider.

external_tool: 'terraform'
external_tool_version: '>=1.5.0'
external_docs_url: 'https://developer.hashicorp.com/terraform'
user_prerequisites:
  - 'terraform CLI installed (>=1.5.0)'
  - 'AWS provider for Terraform configured'

closest_scope_widening_analogue: 'Container build type addition'
analogue_rationale: |
  Both add a new provider choice at project level. Container added a new
  build type (CodeZip vs Container) that branches the packaging and deploy
  logic. Terraform adds a new deploy provider that branches the deploy
  logic. Both coexist, user chooses at create time.
```

---

## Differences from New Resource at a Glance

| Dimension          | New Resource               | Scope Widening                              |
| ------------------ | -------------------------- | ------------------------------------------- |
| Schema change      | New array added            | Existing fields gain new values/options     |
| Primitive          | New class created          | No new primitive (usually)                  |
| Deploy flow        | New step added             | Existing step branches                      |
| CDK construct      | New construct              | Existing constructs gain variants           |
| Backwards compat   | Always (additive)          | Must be proven (not automatic)              |
| Risk profile       | Low (isolated)             | Higher (touches shared code paths)          |
| Testing burden     | New tests for new resource | New tests + verify all old tests still pass |
| Typical file count | 8-12 new files             | 3-5 new + 10-15 modified                    |
