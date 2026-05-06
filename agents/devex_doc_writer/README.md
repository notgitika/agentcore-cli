# DevEx Doc Writer Pipeline

An autonomous agent pipeline that generates CLI DevEx proposals and implementation plans for new AgentCore features —
grounded in the actual codebase, iteratively refined through human review.

The system is **archetype-driven**: different feature types (new resource, scope widening, new command, etc.) route
through the same pipeline engine but use different input schemas, templates, biases, and self-review criteria. Adding a
new archetype is adding a markdown file — not changing the pipeline.

---

## Archetypes

Not all features are the same shape. The pipeline adapts based on what you're building:

| Archetype                  | When to use                                                                             | Example                                              | Status               |
| -------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------- |
| **New Resource**           | Adding a new service resource with its own schema, primitive, and CDK construct         | Config Bundles, Datasets, Harness                    | **P0 — implemented** |
| **Scope Widening**         | Expanding what existing CLI surfaces can do (new deploy target, build type, auth model) | Terraform support, Node.js CodeZip, Container builds | **P0 — implemented** |
| **New Command**            | Adding a new top-level verb to the CLI                                                  | `agentcore migrate`, `agentcore audit`               | P1 — planned         |
| **Ecosystem Integration**  | Integrating a new external framework or tool                                            | New agent framework template, new container runtime  | P1 — planned         |
| **Cross-cutting Refactor** | CLI-wide architecture changes that touch many surfaces                                  | Auth model overhaul, partition expansion             | P1 — planned         |

Each archetype defines:

- **What inputs are required** (API surface? Trust policy? Affected commands? Coexistence model?)
- **Which template to fill** (different sections per archetype)
- **Archetype-specific biases** (e.g., "coexistence over replacement" for scope widening)
- **Extra self-review checks** (e.g., "backwards compatibility proven" for scope widening)

The pipeline engine (knowledge refresh, review loop, tenets, task graph schema) is shared across all archetypes.

---

## How It Works

```
You provide YAML inputs    →    Agent writes a DevEx doc    →    You review & iterate    →    APPROVED
                                                                                                │
                                                                                                ▼
                                                                                    Agent writes impl plan
                                                                                                │
                                                                                                ▼
                                                                                    feature_builder executes
```

The pipeline has two stages. Each stage loops until you type `APPROVED`:

**Stage 1 — DevEx Doc:** Takes your feature description, API surface, IAM requirements, and produces a full proposal
(developer journeys, TUI wireframes, schema changes, codebase impact, deploy flow, phased implementation).

**Stage 2 — Implementation Plan:** Takes the approved doc and breaks it into ordered tasks with concrete file paths,
dependencies, size estimates, and verification checklists. Outputs `task_graph.json` that the `feature_builder` agent
(PR #1124) can execute.

---

## Components

### 1. Knowledge Snapshots (`agents/knowledge/`)

Pre-indexed YAML files describing the CLI and CDK architecture. Refreshed at pipeline start so the agent always works
from current state.

| File                             | What it captures                                                          |
| -------------------------------- | ------------------------------------------------------------------------- |
| `cli-architecture-snapshot.yaml` | Primitives, schema shape, deploy flow, commands, IAM patterns, code style |
| `cdk-architecture-snapshot.yaml` | CDK constructs, service principals                                        |
| `refresh.ts`                     | TypeScript script (ts-morph) that regenerates both snapshots              |

**Run manually:**

```bash
cd agents/knowledge && npm run refresh
```

The agent runs this automatically at pipeline start. CDK repo is auto-discovered from sibling dirs, `AGENTCORE_CDK_ROOT`
env var, or cloned from GitHub as fallback.

---

### 2. Input Spec (`agents/devex_doc_writer/inputs/schema.yaml`)

Formal schema defining what the pipeline needs. Two archetypes:

| Archetype        | When to use                                                                     | Key inputs                                                        |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `new_resource`   | Adding a new service resource (new primitive, schema array, CDK construct)      | API operations, trust policy, CFN type, analogue                  |
| `scope_widening` | Expanding existing CLI capabilities (new deploy target, build type, auth model) | Current/target architecture, affected commands, coexistence model |

You provide feature-specific facts that can't be derived from the codebase (API ops, trust policy, account info). The
agent proposes architecture decisions (schema location, deploy strategy, TUI steps) with explicit reasoning — you
confirm or override before it writes.

---

### 3. Templates (`agents/devex_doc_writer/templates/`)

Structured markdown templates with `{{variable}}` placeholders:

| Template                  | Used for                                    |
| ------------------------- | ------------------------------------------- |
| `new-resource-devex.md`   | DevEx proposals for new resource features   |
| `scope-widening-devex.md` | DevEx proposals for scope-widening features |
| `implementation-plan.md`  | Stage 2 impl plans (both archetypes)        |

---

### 4. Prompts (`agents/devex_doc_writer/prompts/`)

System prompts that define the agent's behavior:

| Prompt             | Role                                                                       |
| ------------------ | -------------------------------------------------------------------------- |
| `writer.md`        | The writer persona — voice, style, tenets, biases, workflow instructions   |
| `self_reviewer.md` | Quality gate — 14-point checklist run against the doc before human sees it |

---

### 5. Entry Point (`agents/devex_doc_writer/main.py`)

Orchestrates the pipeline:

```
main.py --input your-feature.yaml
  │
  ├─ 1. Parse & validate inputs (against schema.yaml)
  ├─ 2. Refresh knowledge snapshot (refresh.ts)
  ├─ 3. Load CLI + CDK snapshots
  ├─ 4. Validate analogue choice + check slug collisions
  ├─ 5. Assemble writer context (prompt + knowledge + inputs + template)
  └─ 6. Output: writer-context.md ready for LLM invocation
```

---

## End-to-End Usage

### Step 1: Write your input YAML

Use `examples/config-bundle-input.yaml` as a starting point. Fill in your feature's details:

```yaml
archetype: 'new_resource'
feature_name: 'My Feature'
feature_slug: 'my-feature'
feature_description: '...'
# ... (see examples/ or inputs/schema.yaml for all fields)
```

### Step 2: Run the pipeline

```bash
cd agents/devex_doc_writer

# Dry run — validates inputs, checks for collisions
python3 main.py --input your-input.yaml --dry-run

# Full run — generates writer context
python3 main.py --input your-input.yaml
```

### Step 3: Invoke the writer agent

**With Harness (when PR #1124 lands):**

```bash
# Automatic — main.py invokes Harness directly
python3 main.py --input your-input.yaml
# → enters interactive review loop
```

**Standalone (direct LLM — works today):**

```bash
# Pass output/writer-context.md as system prompt to Claude/Kiro/Codex
# The agent will:
#   1. Propose inferred decisions (wait for your confirmation)
#   2. Write the full DevEx doc
#   3. Self-review (fixes critical issues internally)
#   4. Present to you for review
```

### Step 4: Iterate

The agent responds to your feedback as natural conversation:

- "Change X to Y" → revises and explains what changed
- "Why did you pick CDK?" → explains rationale with codebase evidence
- "I disagree, use imperative" → presents tradeoffs, revises if you insist

### Step 5: Approve

Type `APPROVED` to lock the doc and proceed to Stage 2 (impl plan generation).

### Step 6: Publish

Copy the final markdown to Quip for broader team review. If Quip feedback requires changes, re-enter the pipeline — the
agent diffs and propagates.

---

## Design Principles

| #   | Tenet                                | Meaning                              |
| --- | ------------------------------------ | ------------------------------------ |
| 1   | Developer ergonomics over API parity | CLI is not a 1:1 wrapper             |
| 2   | Consistency over novelty             | New features feel like existing ones |
| 3   | Explicit over implicit               | Unambiguous names and messages       |
| 4   | Local-first validation               | Zod catches errors before API calls  |
| 5   | Additive only per phase              | No phase breaks a prior phase        |
| 6   | Security by default                  | Least-privilege roles                |
| 7   | Sensitivity-aware                    | No pre-GA leaks in public repos      |
| 8   | Know your limits                     | Agent escalates what it can't solve  |

---

## File Structure

```
agents/
├── devex_doc_writer/
│   ├── README.md                 ← you are here
│   ├── SYSTEM.md                 # Full design doc (for team alignment)
│   ├── main.py                   # Pipeline entry point
│   ├── archetypes/
│   │   ├── new-resource.md       # Archetype: new service resource
│   │   └── scope-widening.md     # Archetype: expand existing capability
│   ├── prompts/
│   │   ├── writer.md             # Writer agent persona
│   │   └── self_reviewer.md      # Quality gate checklist
│   ├── templates/
│   │   ├── new-resource-devex.md
│   │   ├── scope-widening-devex.md
│   │   └── implementation-plan.md
│   ├── inputs/
│   │   └── schema.yaml           # Input validation schema
│   ├── examples/
│   │   └── config-bundle-input.yaml
│   └── reference-devex-docs/     # Style calibration examples
│
├── knowledge/
│   ├── refresh.ts                # Snapshot generator
│   ├── extractors/               # AST-based codebase parsing
│   ├── cli-architecture-snapshot.yaml
│   └── cdk-architecture-snapshot.yaml
```

---

## Dependencies

| What         | Required for       | How to install                       |
| ------------ | ------------------ | ------------------------------------ |
| Python 3.10+ | main.py            | system                               |
| PyYAML       | input parsing      | `pip install pyyaml`                 |
| Node.js 18+  | knowledge refresh  | system                               |
| tsx          | running refresh.ts | `cd agents/knowledge && npm install` |
| ts-morph     | AST parsing        | (installed via npm above)            |

---

## What's Next

- **PR #1124 lands** → wire Harness invocation into main.py (replaces file output with interactive agent session)
- **Iterative review loop** → Harness session with human-in-the-loop (APPROVED exit)
- **QuipEditor MCP** → auto-publish approved docs to Quip
- **P1 archetypes** → new-command, ecosystem-integration, cross-cutting-refactor
- **Extractor tests** → unit tests for knowledge extractors
