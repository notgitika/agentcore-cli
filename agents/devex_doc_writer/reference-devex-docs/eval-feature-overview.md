# AgentCore CLI — Evaluation Feature Overview

## What We Built

Full evaluation support in the AgentCore CLI, covering both **on-demand evaluation** (run evaluators against historical
agent traces) and **online evaluation management** (inspect, update, and monitor continuously-running evaluations).

---

## Capabilities

### On-Demand Evaluation (`agentcore run eval`)

Users can run any evaluator against their agent's historical traces with a single command. The CLI handles:

- **Span fetching** — Queries CloudWatch Logs Insights for OTel spans from the `aws/spans` log group, grouped by session
- **Evaluator level routing** — Automatically determines whether each evaluator operates at SESSION, TRACE, or TOOL_CALL
  level and sends the appropriate `evaluationTarget` (no target IDs, `traceIds`, or `spanIds` respectively)
- **Batching** — When a session has more than 10 trace/span IDs, the CLI batches evaluate calls to stay within API
  limits
- **Mixed-level runs** — Multiple evaluators with different levels can be used in a single invocation
- **Two input modes**:
  - **Project mode** — Resolves agent and evaluator from `agentcore.json` + `deployed-state.json`
  - **ARN mode** — Pass `--agent-arn` directly, no project needed. Useful for quick checks or CI pipelines
- **Filtering** — `--session-id` and `--trace-id` flags narrow evaluation to specific sessions or traces
- **Result storage** — Results are saved as JSON files in `agentcore/eval-results/` (project mode) or the current
  directory (ARN mode)

### Evaluator Discovery

Users can browse available evaluators in their account outside the project:

- **`eval list-evaluators`** — Lists all builtin and custom evaluators with their ID, name, type, level, and status
- **`eval get-evaluator`** — Shows full details of a specific evaluator including description

### Online Eval Config Management

Users can inspect and manage online (continuous) evaluation configs:

- **`eval list-online`** — Lists all online eval configs with status and execution state
- **`eval get-online`** — Shows full config details including output log group and failure reasons
- **`eval update-online`** — Update execution status (ENABLED/DISABLED) and description directly by config ID
- **`pause online-eval` / `resume online-eval`** — Convenience commands that resolve config name from the project's
  deployed state

### Online Eval Logs

- **`logs eval`** — Streams or searches evaluation result logs from CloudWatch. The log group name is fetched from the
  API (`GetOnlineEvaluationConfig`), with a convention-based fallback if the API call fails. Surfaces failure reasons
  when a config is in a failed state.

### Status Enrichment

- **`agentcore status`** — Now shows live status for deployed evaluators and online eval configs alongside agents,
  memories, and credentials. Evaluators show their level, type, and API status (e.g.,
  `SESSION — LLM-as-a-Judge — ACTIVE`). Online eval configs show their execution state (e.g., `ACTIVE (ENABLED)`).

### Schema Updates

- `OnlineEvaluationConfig` in `agentcore.json` now supports optional `description` (max 200 chars) and `enableOnCreate`
  (boolean) fields

---

## API Integration

| API                             | Used By                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `Evaluate`                      | `run eval` — core evaluation execution                                       |
| `GetEvaluator`                  | `run eval` (resolve custom evaluator levels), `eval get-evaluator`, `status` |
| `ListEvaluators`                | `eval list-evaluators`                                                       |
| `GetOnlineEvaluationConfig`     | `eval get-online`, `logs eval` (resolve log group), `status`                 |
| `ListOnlineEvaluationConfigs`   | `eval list-online`                                                           |
| `UpdateOnlineEvaluationConfig`  | `eval update-online`, `pause/resume online-eval`                             |
| CloudWatch Logs Insights        | `run eval` (fetch OTel spans from `aws/spans`)                               |
| CloudWatch Logs (search/stream) | `logs eval` (read evaluation result logs)                                    |

---

## Evaluator Levels

The CLI maintains a mapping of builtin evaluator levels and fetches levels for custom evaluators via `GetEvaluator`:

| Level         | What it evaluates                 | Builtins                                                                                                                                    |
| ------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **SESSION**   | Entire conversation               | GoalSuccessRate                                                                                                                             |
| **TRACE**     | Individual request-response pairs | Helpfulness, Correctness, Faithfulness, ResponseRelevance, Conciseness, Coherence, InstructionFollowing, Refusal, Harmfulness, Stereotyping |
| **TOOL_CALL** | Individual tool invocations       | ToolSelectionAccuracy, ToolParameterAccuracy                                                                                                |

Tool call spans are identified by the presence of `gen_ai.tool.name` or `tool.name` attributes in the OTel span data.

---

## Testing

- **Unit tests**: 150+ tests covering all eval operations, SDK wrappers, status enrichment, schema validation, and
  storage
- **Manual verification**: All commands tested end-to-end against account 998846730471 (us-east-1) with a deployed agent
  that had 14 sessions of trace data
