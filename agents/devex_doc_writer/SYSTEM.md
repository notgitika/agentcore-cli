# DevEx Doc Writer Pipeline — System Design

**Version:** 1.0.0 **Status:** Draft (for team alignment) **Last updated:** 2026-05-05 **Author:** gitikavj@

---

## At a Glance

An autonomous pipeline that takes a feature request + structured inputs and produces a production-ready CLI DevEx
proposal + implementation plan — iteratively refined through human review until explicitly approved.

```
┌─────────────────┐      ┌────────────────────────┐      ┌──────────────────────┐
│  STRUCTURED     │      │  STAGE 1: DevEx Doc    │      │  STAGE 2: Impl Plan  │
│  INPUTS         │─────▶│  Writer + Review Loop  │─────▶│  Writer              │
│  (YAML)         │      │  (iterates until       │      │  (detailed tasks,    │
│                 │      │   APPROVED)            │      │   file paths, deps)  │
└─────────────────┘      └────────────────────────┘      └──────────────────────┘
                                    │                              │
                                    ▼                              ▼
                           Human reviews,              Feeds into feature_builder
                           asks questions,             (executor agent from PR #1124)
                           agent explains &            OR human applies directly
                           revises
```

**What makes this "frontier" vs. a simple template filler:**

- The agent _already knows_ the CLI/CDK architecture via pre-indexed knowledge snapshots — no cloning, no cold start
- It produces opinionated proposals grounded in actual codebase patterns — cites real file paths, follows existing
  primitives
- It defends its design decisions when challenged, citing constraints, precedent, and tradeoffs
- It identifies what it _cannot_ solve — surfaces questions requiring product/architecture decisions rather than
  hallucinating
- It iterates in a conversation loop until the human types `APPROVED` — not a one-shot generator
- After approval, publishes to Quip for broader team review; changes cascade back through the pipeline
- It respects repo sensitivity (private vs public) and never leaks pre-GA service info

**Audience for the DevEx doc output:** Service team, design team, product. Implementation details in appendix.

**Platform:** Kiro CLI, Codex, or any agentic coding environment. Not locked to a specific tool.

**Where this lives:** `agents/devex_doc_writer/` in the `agents/` framework (PR #1124).

**The full pipeline end-to-end:**

```
Inputs (YAML) → Archetype Routing → DevEx Doc Writer → [Review Loop] → APPROVED
    → Publish to Quip → [Team Comments] → re-enter if changes needed
        → Implementation Plan Writer → [Review Loop] → APPROVED
            → feature_builder (executor, PR #1124) → Code + PRs
```

---

## Table of Contents

1. [Archetypes](#archetypes)
2. [Architecture & How It Fits](#architecture--how-it-fits)
3. [Knowledge Strategy](#knowledge-strategy)
4. [Workflow: Iterative Review Loop](#workflow-iterative-review-loop)
5. [Universal Tenets](#universal-tenets)
6. [Universal Biases](#universal-biases)
7. [Self-Review Checklist (Base)](#self-review-checklist-base)
8. [Task Graph Schema (Stage 2 Contract)](#task-graph-schema-stage-2-contract)
9. [Knowledge Snapshot Refresh (refresh.ts)](#knowledge-snapshot-refresh-refreshts)
10. [Failure Modes & Recovery](#failure-modes--recovery)
11. [Success Metrics](#success-metrics)
12. [Change Cascade](#change-cascade)

---

## Archetypes

Not all features are the same shape. The pipeline adapts its inputs, template, and self-review based on the feature
archetype.

| Archetype                  | Examples                                                             | Priority | Doc                                    |
| -------------------------- | -------------------------------------------------------------------- | -------- | -------------------------------------- |
| **New Resource**           | Config Bundles, Datasets, Harness                                    | P0       | `archetypes/new-resource.md`           |
| **Scope Widening**         | Terraform support, Node.js CodeZip, new auth model, Container builds | P0       | `archetypes/scope-widening.md`         |
| **New Command Verb**       | `agentcore migrate`, `agentcore audit`                               | P1       | `archetypes/new-command.md`            |
| **Ecosystem Integration**  | New framework template, new container runtime (Finch/Podman)         | P1       | `archetypes/ecosystem-integration.md`  |
| **Cross-cutting Refactor** | Auth model overhaul, partition expansion, CLI-wide UX revamp         | P1       | `archetypes/cross-cutting-refactor.md` |

### Archetype Routing

At the start of the pipeline, the agent identifies which archetype applies. It can be:

- **Declared by user:** `archetype: "new_resource"` in the input YAML
- **Inferred by agent:** Based on the presence/absence of fields (has `control_plane_operations`? → new resource. Has
  `current_architecture`/`target_architecture`? → scope widening.)

If ambiguous, the agent asks before proceeding.

### What's Shared vs. Per-Archetype

| Shared (this doc)     | Per-Archetype                  |
| --------------------- | ------------------------------ |
| Review loop mechanics | Input schema (what's required) |
| Universal tenets      | Archetype-specific biases      |
| Knowledge strategy    | Which template sections apply  |
| Task graph schema     | Impl plan phase shape          |
| Failure modes         | Self-review extensions         |
| Success metrics       | Quick start examples           |
| Sensitivity rules     |                                |
| Change cascade        |                                |

---

## Architecture & How It Fits

### In the `agents/` Framework

```
agents/
├── core/                              # shared infra (from PR #1124)
│   ├── harness_client.py
│   ├── parsing.py
│   └── config.py
│
├── knowledge/                         # pre-indexed codebase knowledge
│   ├── cli-architecture-snapshot.yaml
│   ├── cdk-architecture-snapshot.yaml
│   ├── refresh.ts                     # ts-morph script to regenerate
│   ├── tsconfig.json
│   ├── package.json                   # deps: ts-morph, yaml
│   ├── extractors/
│   │   ├── primitives.ts
│   │   ├── schema.ts
│   │   ├── deploy-flow.ts
│   │   └── commands.ts
│   └── reference-devex-docs/          # 2-3 canonical docs for style calibration
│       ├── eval-feature-overview.md
│       └── runtime-endpoint-design.md
│
├── devex_doc_writer/                  # the pipeline
│   ├── SYSTEM.md                      # THIS FILE — shared engine
│   ├── archetypes/
│   │   ├── new-resource.md            # P0
│   │   ├── scope-widening.md          # P0
│   │   ├── new-command.md             # P1
│   │   ├── ecosystem-integration.md   # P1
│   │   └── cross-cutting-refactor.md  # P1
│   ├── prompts/
│   │   ├── writer.md                  # writer + responder (single persona)
│   │   └── self_reviewer.md           # checklist pass
│   └── inputs/
│       └── schema.yaml                # combined schema (all archetypes)
│
├── impl_plan_writer/                  # Stage 2
│   ├── main.py
│   └── prompts/
│       └── planner.md
│
├── feature_builder/                   # existing (PR #1124) — consumes Stage 2
│   ├── main.py
│   └── prompts/
```

### v1 Scope Decisions

| Decision                | Choice                                              | Rationale                                            |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Review loop platform    | Interactive session (Kiro/Codex)                    | No polling, webhooks, or async orchestration needed  |
| Agent personas          | Single writer+responder + separate self-review pass | Three personas over-engineered for v1                |
| Generic orchestration   | No `staged_authoring` abstraction for now           | Build specific workflow first, extract pattern later |
| Quip posting            | Manual (agent outputs markdown, user pastes)        | QuipEditor MCP automates later                       |
| Feedback classification | None — treat all feedback as conversation           | Real comments are compound                           |

### Relationship to `feature_builder`

```
devex_doc_writer (Stage 1) → produces DevEx doc
    ↓ (human types APPROVED)
    ↓ → publishes to Quip for broader team
impl_plan_writer (Stage 2) → produces implementation plan + task_graph.json
    ↓ (human types APPROVED)
feature_builder (PR #1124) → consumes task_graph.json, executes code changes
```

---

## Knowledge Strategy

### Problem

The agent needs deep knowledge of the CLI and CDK codebases to write grounded proposals. Cloning fresh is slow. Full
codebase in prompt is too expensive.

### Solution: Structured Snapshot + Selective Reads

```
agents/knowledge/
├── cli-architecture-snapshot.yaml    # auto-generated, version-controlled
├── cdk-architecture-snapshot.yaml    # auto-generated, version-controlled
├── refresh.ts                        # ts-morph script
└── reference-devex-docs/             # canonical docs for style calibration
```

**Critical:** The snapshot is regenerated at invocation time (not just on CI merge). The CI version is a cache — the
source of truth is always the live codebase.

### What the Snapshot Contains

```yaml
schema_version: 1
generated_at: '2026-05-05T10:00:00Z'
commit: 'abc123'
repo: 'aws/agentcore-cli'

primitives:
  - name: 'AgentPrimitive'
    file: 'src/cli/primitives/AgentPrimitive.ts'
    resources_managed: ['agents']
    schema_key: 'agents'
    supports_tui: true
    supports_remove: true
    has_cross_references: false
  - name: 'EvaluatorPrimitive'
    file: 'src/cli/primitives/EvaluatorPrimitive.ts'
    resources_managed: ['evaluators']
    schema_key: 'evaluators'
    supports_tui: true
    supports_remove: true
    has_cross_references: true
    references: ['agents (via agentName)']

schema_shape:
  agentcore_json:
    top_level_arrays:
      - key: 'agents'
        schema_file: 'src/schema/schemas/agent-env.ts'
      - key: 'memories'
        schema_file: 'src/schema/schemas/primitives/memory.ts'
      - key: 'credentials'
        schema_file: 'src/schema/schemas/primitives/credential.ts'
      - key: 'evaluators'
        schema_file: 'src/schema/schemas/primitives/evaluator.ts'
      - key: 'onlineEvalConfigs'
        schema_file: 'src/schema/schemas/primitives/online-evaluation-config.ts'
      - key: 'gateways'
        schema_file: 'src/schema/schemas/mcp.ts'
      - key: 'gatewayTargets'
        schema_file: 'src/schema/schemas/mcp.ts'
      - key: 'policyEngines'
        schema_file: 'src/schema/schemas/primitives/policy-engine.ts'
      - key: 'policies'
        schema_file: 'src/schema/schemas/primitives/policy.ts'
    cross_field_validations:
      - source: 'onlineEvalConfigs[].agentName'
        target: 'agents[].name'
        rule: 'must_exist'
      - source: 'onlineEvalConfigs[].evaluatorNames[]'
        target: 'evaluators[].name'
        rule: 'must_exist'
      - source: 'policies[].engineName'
        target: 'policyEngines[].name'
        rule: 'must_exist'

  deployed_state:
    file: 'src/schema/schemas/deployed-state.ts'
    resource_types:
      - key: 'runtimes'
        fields: ['runtimeId', 'runtimeArn', 'roleArn']
      - key: 'memories'
        fields: ['memoryId', 'memoryArn']
      - key: 'credentials'
        fields: ['credentialProviderArn']
      - key: 'evaluators'
        fields: ['evaluatorId', 'evaluatorArn']
      - key: 'onlineEvalConfigs'
        fields: ['onlineEvaluationConfigId', 'onlineEvaluationConfigArn', 'executionStatus']
      - key: 'policyEngines'
        fields: ['policyEngineId', 'policyEngineArn']
      - key: 'policies'
        fields: ['policyId', 'policyArn', 'engineName']
      - key: 'runtimeEndpoints'
        fields: ['endpointId', 'endpointArn']

deploy_flow:
  file: 'src/cli/operations/deploy/'
  steps:
    1: 'Preflight validation (schema parse, credentials check, target resolution)'
    2: 'IMPERATIVE: Create/update API key providers (pre-deploy-identity.ts)'
    3: 'IMPERATIVE: Create/update OAuth2 providers (pre-deploy-identity.ts)'
    4: 'CDK synth + deploy (CloudFormation via CDK toolkit)'
    5: 'Parse CFN outputs → build deployed-state.json'
    6: 'Post-deploy: setup transaction search'

commands:
  verbs:
    - name: 'create'
      has_tui: true
    - name: 'add'
      nouns:
        [
          'agent',
          'memory',
          'credential',
          'evaluator',
          'online-eval',
          'gateway',
          'gateway-target',
          'policy-engine',
          'policy',
        ]
      has_tui: true
    - name: 'remove'
      nouns:
        [
          'agent',
          'memory',
          'credential',
          'evaluator',
          'online-eval',
          'gateway',
          'gateway-target',
          'policy-engine',
          'policy',
          'all',
        ]
    - name: 'deploy'
    - name: 'status'
    - name: 'dev'
    - name: 'invoke'
    - name: 'run eval'
    - name: 'logs'
    - name: 'package'
    - name: 'validate'

iam_patterns:
  service_principal: 'bedrock-agentcore.amazonaws.com'
  lambda_principal: 'lambda.amazonaws.com'
  role_creation: 'CDK: new iam.Role({ assumedBy: new iam.ServicePrincipal(AGENTCORE_SERVICE_PRINCIPAL) })'
  existing_role_support: 'executionRoleArn on agent schema allows BYO role'
  partition_utility: 'src/cli/aws/partition.ts — arnPrefix(), serviceEndpoint(), dnsSuffix()'

code_style:
  rules:
    - 'No inline imports'
    - '{ success: boolean, error?: string } for results'
    - 'Existing types before inline'
    - 'Constants in closest subdirectory'
    - 'Never hardcode arn:aws:'
    - 'Tags via TagsSchema on all resources'
  tui_patterns:
    - 'Screen → Flow → Wizard hook → Operation hook → Primitive'
    - 'MAX_CONTENT_WIDTH = 60'
    - "SelectList uses wrap='wrap'"
```

### When Selective Reads Happen

After loading the snapshot, read actual source only when:

1. **Analogue source** — to understand exact lifecycle patterns
2. **Analogue CDK construct** — IAM role creation, resource properties
3. **Specific schema files** — cross-references need detail beyond snapshot
4. **Reference DevEx docs** — voice/style calibration

### Analogue Validation

The agent does NOT blindly trust the user's analogue choice. It validates:

- Does the analogue's shape match the new feature's API shape?
- If poor match, proposes alternative with explanation before proceeding.

### Why Not Knowledge Bases / AgentCore Memory

| Approach                     | Pros                                     | Cons                                 |
| ---------------------------- | ---------------------------------------- | ------------------------------------ |
| Structured snapshot (chosen) | Deterministic, auditable, fast, no infra | Stale between refreshes              |
| AgentCore Memory             | Semantic search, rationale storage       | Infra dependency, hallucination risk |
| Knowledge Base (RAG)         | Good for large corpus                    | Overkill for structured data         |

Decision: snapshot for architecture facts. Memory add-on later for team decisions/rationale history.

---

## Workflow: Iterative Review Loop

This is universal across all archetypes. The template and inputs change — the loop doesn't.

```
┌─────────────────────────────────────────────────────────────────┐
│  TRIGGER                                                         │
│  • Interactive session: user provides input YAML                 │
│  • GH Action: issue labeled "feature-proposal" with YAML body    │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  ARCHETYPE ROUTING                                                │
│  • Declared in YAML, or inferred from field presence              │
│  • If ambiguous: ask user                                         │
│  • Loads archetype-specific input schema + template               │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  VALIDATE INPUTS                                                  │
│  • Check required fields per archetype                            │
│  • If insufficient: exit with clear error listing what's missing  │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  REFRESH & LOAD KNOWLEDGE                                         │
│  • Run refresh.ts to regenerate snapshot from current codebase    │
│  • Read both snapshots                                            │
│  • Validate analogue choice (if applicable)                       │
│  • Selective reads based on archetype needs                       │
│  • Read reference-devex-docs/ for style                           │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  PROPOSE INFERRED DECISIONS                                       │
│  • Agent proposes values it can infer (per archetype definition)  │
│  • Human confirms or corrects before writing begins               │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  WRITE PHASE                                                      │
│  • Fills template (archetype-specific sections)                   │
│  • Applies universal tenets + archetype biases                    │
│  • Generates rough impl plan skeleton                             │
│  • Flags "Escalation Required" items it cannot resolve            │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  SELF-REVIEW (separate pass)                                      │
│  • Base checklist + archetype extensions                          │
│  • If ≥2 critical failures: revises internally (max 2 loops)      │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
╔══════════════════════════════════════════════════════════════════════╗
║  ITERATIVE REVIEW CONVERSATION                                       ║
║                                                                      ║
║  Agent presents: devex_doc.md + impl_plan_skeleton.md                ║
║                                                                      ║
║  Human provides feedback as natural conversation. Agent reads the    ║
║  full message, addresses all parts:                                  ║
║  • Change requests → revise, explain what changed                    ║
║  • Questions ("why X?") → explain rationale with evidence            ║
║  • Disagreements → present tradeoffs, cite both sides                ║
║  • New constraints → incorporate, note in Decisions table            ║
║                                                                      ║
║  Each revision: version bump, update callout at top, update          ║
║  skeleton if affected.                                               ║
║                                                                      ║
║  EXIT: Human types "APPROVED" (exact keyword).                       ║
║                                                                      ║
║  Staleness: 7-day ping. 14-day archive. User can resume anytime.     ║
╚══════════════════════════════════════════════════════════════════════╝
                       │ (APPROVED)
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  PUBLISH                                                          │
│  • Agent outputs final markdown                                   │
│  • User pastes to Quip (v2: auto-publish via QuipEditor MCP)     │
│  • If Quip feedback → user re-enters, agent revises               │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  STAGE 2: Implementation Plan Writer                              │
│  • Expands skeleton → full plan + task_graph.json                 │
│  • Same review loop (APPROVED to exit)                            │
│  • Output feeds feature_builder OR human implements               │
└──────────────────────────────────────────────────────────────────┘
```

---

## Universal Tenets

These apply to ALL archetypes. Priority order — when they conflict, higher wins.

1. **Developer ergonomics over API parity.** CLI is not a 1:1 API wrapper. Combine operations, hide complexity, surface
   what matters.
2. **Consistency over novelty.** New features feel like existing features. Same patterns, same conventions.
3. **Explicit over implicit.** Flag names, config fields, error messages are unambiguous.
4. **Local-first validation.** All schema/config validation happens locally before API calls. Zod superRefine catches
   errors on disk.
5. **Additive only per phase.** No phase requires removing/renaming from a prior phase.
6. **Security by default.** Auto-created roles are least-privilege. Never grant `*` without justification.
7. **Sensitivity-aware.** Never leak pre-GA info into public repos.
8. **Know your limits.** The agent identifies what it CANNOT solve — product direction, cross-team alignment, codebase
   refactors beyond feature scope — and surfaces these as "Escalation Required" items. Never silently assumes or
   hallucinates answers to architectural questions.

---

## Universal Biases

These are defaults across all archetypes. Individual archetypes can extend (never contradict).

1. **Verb-first commands.** `agentcore [verb] [noun]` always.
2. **Short resource/command names.** `config-bundle` not `configuration-bundle`.
3. **Cite precedent.** Every design choice references an existing codebase pattern.
4. **Partition-aware from day one.** Never hardcode `arn:aws:`.
5. **Config-driven tagging.** Resources support `TagsSchema`.
6. **Independently shippable phases.** Every phase leaves the CLI releasable.

---

## Self-Review Checklist (Base)

Base checklist runs for ALL archetypes. Archetype docs add their own extensions.

| #   | Check                          | Critical? | What Passes                                                 |
| --- | ------------------------------ | --------- | ----------------------------------------------------------- |
| 1   | **Verb-first commands**        | Yes       | All commands follow `agentcore [verb] [noun]`               |
| 2   | **Real flags, not pseudocode** | Yes       | Every CLI example uses `--flag-name value` syntax           |
| 3   | **Codebase grounded**          | Yes       | File paths reference actual repo paths                      |
| 4   | **Pattern cited**              | No        | At least one "Precedent:" reference                         |
| 5   | **Open questions honest**      | Yes       | Unknowns in table, not buried                               |
| 6   | **No marketing language**      | No        | Zero "powerful", "seamless", "elegant", "robust"            |
| 7   | **Phases are shippable**       | Yes       | Each phase lands independently                              |
| 8   | **Escalations surfaced**       | Yes       | Things agent can't solve are explicitly listed, not assumed |
| 9   | **Sensitivity respected**      | Yes       | No internal names/IDs in public-destined artifacts          |

**Threshold:** ≥2 Critical items fail → agent revises internally (max 2 loops).

---

## Task Graph Schema (Stage 2 Contract)

`task_graph.json` is the machine-readable contract between Stage 2 and `feature_builder`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "feature_slug": { "type": "string" },
    "feature_name": { "type": "string" },
    "archetype": { "type": "string" },
    "total_phases": { "type": "integer" },
    "phases": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "phase_id": { "type": "string", "pattern": "^phase-[0-9]+$" },
          "name": { "type": "string" },
          "description": { "type": "string" },
          "tasks": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "task_id": { "type": "string", "pattern": "^[0-9]+\\.[0-9]+$" },
                "title": { "type": "string" },
                "description": { "type": "string" },
                "files": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "path": { "type": "string" },
                      "action": { "enum": ["create", "modify", "delete"] },
                      "description": { "type": "string" }
                    },
                    "required": ["path", "action"]
                  }
                },
                "depends_on": { "type": "array", "items": { "type": "string" } },
                "size": { "enum": ["S", "M", "L", "XL"] },
                "verification": { "type": "array", "items": { "type": "string" } }
              },
              "required": ["task_id", "title", "files", "depends_on", "size"]
            }
          },
          "phase_verification": { "type": "array", "items": { "type": "string" } },
          "definition_of_done": { "type": "string" }
        },
        "required": ["phase_id", "name", "tasks", "phase_verification"]
      }
    },
    "cross_cutting_concerns": { "type": "array", "items": { "type": "string" } },
    "risks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "description": { "type": "string" },
          "likelihood": { "enum": ["low", "medium", "high"] },
          "impact": { "enum": ["low", "medium", "high"] },
          "mitigation": { "type": "string" }
        }
      }
    }
  },
  "required": ["feature_slug", "archetype", "phases"]
}
```

### Example Task Node

```json
{
  "task_id": "1.3",
  "title": "Create ConfigBundlePrimitive class",
  "description": "Implement add/remove lifecycle following EvaluatorPrimitive pattern",
  "files": [
    { "path": "src/cli/primitives/ConfigBundlePrimitive.ts", "action": "create" },
    { "path": "src/cli/primitives/__tests__/ConfigBundlePrimitive.test.ts", "action": "create" }
  ],
  "depends_on": ["1.1", "1.2"],
  "size": "M",
  "verification": ["npm run typecheck", "npm test -- --testPathPattern=ConfigBundle"]
}
```

---

## Knowledge Snapshot Refresh (`refresh.ts`)

### Why TypeScript

The CLI repo requires Node.js. `ts-morph` gives accurate AST parsing. No Python dependency needed.

### Structure

```
agents/knowledge/
├── refresh.ts           # main entry — orchestrates extractors
├── tsconfig.json
├── package.json         # deps: ts-morph, yaml
└── extractors/
    ├── primitives.ts    # registry.ts → primitive metadata
    ├── schema.ts        # agentcore-project.ts → shape
    ├── deploy-flow.ts   # deploy/ → step order
    └── commands.ts      # commands/ → verb/noun structure
```

### Extractor Responsibilities

| Extractor        | Source File(s)                                    | Extracts                                                                |
| ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `primitives.ts`  | `src/cli/primitives/registry.ts` + each primitive | name, file, schema_key, supports_tui, supports_remove, cross_references |
| `schema.ts`      | `src/schema/schemas/agentcore-project.ts`         | top_level_arrays, cross_field_validations                               |
| `deploy-flow.ts` | `src/cli/operations/deploy/deploy.ts`             | step order, imperative vs CDK                                           |
| `commands.ts`    | `src/cli/commands/cli.ts`                         | verbs, nouns per verb                                                   |

### Invocation

```bash
# At pipeline start (ensures freshness)
cd agents/knowledge && npx tsx refresh.ts \
  --cli-root ../../ \
  --cdk-root ../../../agentcore-l3-cdk-constructs

# On CI (cache — runs on merge to main in both repos)
# .github/workflows/refresh-snapshot.yml
```

Output: deterministic YAML with `schema_version` field for prompt compatibility.

---

## Failure Modes & Recovery

| #   | Failure                       | Detection                   | Recovery                                       | User Notification                                                |
| --- | ----------------------------- | --------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| 1   | **API reference unreachable** | HTTP fetch fails            | Ask user for inline ops or local file          | "Cannot reach {url}. Provide API ops inline or as a local file." |
| 2   | **Snapshot refresh fails**    | refresh.ts exits non-zero   | Fall back to last committed snapshot + warn    | "Refresh failed. Using cached version from {date}."              |
| 3   | **Analogue file missing**     | File read 404               | Check snapshot for alternatives; ask user      | "{file} not found. Was it renamed? Alternatives: ..."            |
| 4   | **Feature slug collision**    | Validation against snapshot | Block, suggest alternatives                    | "{slug} collides with existing. Try: {alts}"                     |
| 5   | **Human abandons review**     | 7 days no interaction       | Ping. 14 days → archive.                       | "Inactive 7 days. Still working on it?"                          |
| 6   | **Self-review loops 3x**      | Internal counter            | Present best-effort with FAILED CHECKS visible | "Could not resolve: {items}. Presenting with issues flagged."    |
| 7   | **Sensitivity violation**     | Post-write scan             | Block publishing, flag                         | "Found sensitive content: {details}"                             |

---

## Success Metrics

| Metric                              | Target                                    | How to Measure                                 |
| ----------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| **Revision rounds before approval** | ≤ 3                                       | Count turns between first draft and APPROVED   |
| **File path accuracy**              | > 90% cited paths exist                   | Post-approval verification against repo        |
| **Active wall-clock time**          | < 2 hours input → approved doc            | Session duration minus wait time               |
| **Self-review first-pass rate**     | > 80% (≤1 internal loop)                  | Track internal revision count                  |
| **Escalation quality**              | 100% genuinely unresolvable               | CLI team audits: were escalations appropriate? |
| **Reviewer satisfaction**           | "Would use as-is to start implementation" | Ask after first 3 uses                         |

---

## Change Cascade

Changes can flow in any direction after approval:

```
DevEx Doc (Quip feedback) ──→ re-enter pipeline ──→ updated impl plan
                                                       │
Impl Plan (reviewer finds issue) ──→ user applies directly (no full regen)
                                                       │
Implementation (blocker) ──→ user updates plan ──→ optionally updates doc
```

The mechanism: user starts new session with updated doc or change description. Agent diffs against previous version and
propagates. Full regeneration only if fundamental approach changed.

---

## Sensitivity Rules (Universal)

| Rule                  | When `sensitivity_level = internal`                    |
| --------------------- | ------------------------------------------------------ |
| Public GH issues      | Never reference internal service names                 |
| Public commits        | Use `public_feature_name` only                         |
| DevEx doc destination | Private repo or Quip only                              |
| Artifacts             | No pre-GA API details, account IDs, endpoint overrides |

---

## Prerequisites

- PR #1124 (`agents/` framework) lands first — provides `core/`, `harness_client.py`, orchestration infra
- If delayed: this pipeline can run standalone with direct Harness invocation, but loses shared plumbing
