# {{feature_name}}: CLI DevEx Proposal

**Author:** {{service_team_contact}} **Date:** {{date}} **Status:** Draft **References:** {{api_reference}},
{{design_doc_url}}

---

## What is {{feature_name}}?

<!-- 2-3 paragraphs. Write for someone who has never seen this service capability.
     What problem does it solve? What does the developer get?
     No CLI specifics yet — just the concept. -->

{{feature_description}}

---

## Scope

**In scope:**

- CLI commands (add, remove, deploy integration)
- TUI wizard flow
- Schema changes (agentcore.json, deployed-state.json)
- CDK construct / imperative deploy step
- Cross-resource validation

**Out of scope:** {{scope_constraints}}

- Console experience
- Service internals
- SDK helpers (unless CLI wraps them)

---

## Positioning in the CLI

|                  | What               | CLI command                       | Deploy mechanism    | Has TUI          |
| ---------------- | ------------------ | --------------------------------- | ------------------- | ---------------- |
| Closest existing | {{analogue_label}} | `agentcore add {{analogue_kind}}` | {{analogue_deploy}} | {{analogue_tui}} |
| **This feature** | {{feature_name}}   | `agentcore add {{feature_slug}}`  | {{deploy_strategy}} | {{tui_flow}}     |

---

## Developer Journeys

### 1/ Create a {{feature_slug}}

**User story:** A developer wants to add a {{feature_slug}} to their AgentCore project so that [benefit].

**CLI experience:**

```bash
# Non-interactive
agentcore add {{feature_slug}} \
  --name my-{{feature_slug}} \
  --{{primary_flag}} value \
  --{{secondary_flag}} value

# Interactive (launches TUI wizard)
agentcore add {{feature_slug}}
```

**TUI experience:**

```
Add {{feature_name}}

✓ Name → ● {{tui_step_2}} → ○ {{tui_step_3}} → ○ Confirm

╭──────────────────────────────────────────────────────╮
│ {{tui_step_2}}                                        │
│                                                       │
│ ❯ Option A — description                              │
│   Option B — description                              │
│   Option C — description                              │
╰──────────────────────────────────────────────────────╯

↑↓ navigate · Enter select · Esc back
```

**Under the hood:**

1. Validate input against `{{PascalName}}Schema` (local, no API call)
2. Check for name uniqueness within project
3. Write new entry to `agentcore.json` → `{{schema_key}}[]`
4. Print success message with next steps

**What we build:**

- [ ] `{{PascalName}}Schema` Zod validation
- [ ] `{{PascalName}}Primitive.add()` implementation
- [ ] TUI wizard screens ({{tui_steps_count}} steps)
- [ ] CLI flag parsing in `registerCommands()`

---

### 2/ Remove a {{feature_slug}}

**User story:** A developer wants to remove a {{feature_slug}} they no longer need.

**CLI experience:**

```bash
# Non-interactive
agentcore remove {{feature_slug}} --name my-{{feature_slug}}

# Interactive (shows list of removable resources)
agentcore remove {{feature_slug}}
```

**Under the hood:**

1. Check if any other resources reference this {{feature_slug}}
2. If referenced: warn and require `--force` or confirmation
3. Remove from `agentcore.json`
4. Print success message

**What we build:**

- [ ] `{{PascalName}}Primitive.remove()` with dependency checking
- [ ] `{{PascalName}}Primitive.getRemovable()` for TUI list
- [ ] `{{PascalName}}Primitive.previewRemove()` for confirmation screen

---

### 3/ Deploy ({{feature_slug}} goes live)

**User story:** A developer runs `agentcore deploy` and their {{feature_slug}} is created in AWS.

**CLI experience:**

```bash
agentcore deploy
```

**Under the hood:**

1. Preflight validation reads {{schema_key}} from agentcore.json
2. {{deploy_mechanism_description}}
3. CFN/API returns {{cfn_outputs}} → written to deployed-state.json
4. Success message with resource ARN

**What we build:**

- [ ] CDK construct / imperative deploy step
- [ ] IAM execution role with trust policy
- [ ] deployed-state.json population

---

### 4/ {{data_plane_journey_title}} (if applicable)

<!-- Only include if data_plane_operations exist -->

---

## API Surface

### Control Plane (`{{control_plane_service}}`)

| Operation | HTTP | Input | Output | Notes |
| --------- | ---- | ----- | ------ | ----- |

{{#each control_plane_operations}} | `{{name}}` | `{{http_method}} {{http_path}}` | {{input_shape}} | {{output_shape}} |
{{notes}} | {{/each}}

### Data Plane (`{{data_plane_service}}`) — if applicable

| Operation | HTTP | Input | Output | Notes |
| --------- | ---- | ----- | ------ | ----- |

{{#each data_plane_operations}} | `{{name}}` | `{{http_method}} {{http_path}}` | {{input_shape}} | {{output_shape}} |
{{notes}} | {{/each}}

**Status values:** (if async)

```
{{status_flow_diagram}}
```

---

## CLI Command ↔ API Mapping

| CLI Command                         | API Operation          | Notes                       |
| ----------------------------------- | ---------------------- | --------------------------- |
| `agentcore add {{feature_slug}}`    | — (local only)         | Writes to agentcore.json    |
| `agentcore deploy`                  | `Create{{PascalName}}` | Via {{deploy_strategy}}     |
| `agentcore remove {{feature_slug}}` | — (local only)         | Removes from agentcore.json |
| `agentcore status`                  | `Get{{PascalName}}`    | Reads deployed state        |

{{#each additional_command_mappings}} | `{{cli_command}}` | `{{api_operation}}` | {{notes}} | {{/each}}

---

## Schema Changes

### In `agentcore.json`:

```json
{
  "name": "MyProject",
  "managedBy": "CDK",
  "runtimes": [...],
  "{{schema_key}}": [
    {
      "name": "my-{{feature_slug}}",
      {{schema_example_fields}}
    }
  ]
}
```

### Zod schema (`src/schema/schemas/primitives/{{feature_slug}}.ts`):

```typescript
import { z } from 'zod';
import { TagsSchema } from './tags';

export const {{PascalName}}NameSchema = z
  .string()
  .min(1, 'Name is required')
  .max({{name_max_length}})
  .regex(
    {{name_regex}},
    '{{name_regex_description}}'
  );

export const {{PascalName}}Schema = z.object({
  name: {{PascalName}}NameSchema,
  {{zod_fields}}
  tags: TagsSchema.optional(),
});

export type {{PascalName}} = z.infer<typeof {{PascalName}}Schema>;
```

### Cross-field validation (in `agentcore-project.ts`):

```typescript
// In AgentCoreProjectSpecSchema.superRefine:
{
  {
    cross_field_validation_code;
  }
}
```

### In `deployed-state.json`:

```typescript
export const {{PascalName}}DeployedStateSchema = z.object({
  {{slug}}Id: z.string().min(1),
  {{slug}}Arn: z.string().min(1),
  {{additional_deployed_state_fields}}
});

export type {{PascalName}}DeployedState = z.infer<typeof {{PascalName}}DeployedStateSchema>;
```

---

## Codebase Changes

### New Files

| File                                                                 | Purpose                                |
| -------------------------------------------------------------------- | -------------------------------------- |
| `src/schema/schemas/primitives/{{feature_slug}}.ts`                  | Zod schema + types                     |
| `src/cli/primitives/{{PascalName}}Primitive.ts`                      | Primitive class (add/remove lifecycle) |
| `src/cli/primitives/__tests__/{{PascalName}}Primitive.test.ts`       | Unit tests                             |
| `src/cli/tui/screens/{{feature_slug}}/AddScreen.tsx`                 | TUI wizard (if tui_flow)               |
| `src/cli/tui/screens/{{feature_slug}}/useAdd{{PascalName}}Wizard.ts` | Wizard hook                            |

{{#each additional_new_files}} | `{{path}}` | {{purpose}} | {{/each}}

### Modified Files

| File                                      | Change                                              |
| ----------------------------------------- | --------------------------------------------------- |
| `src/schema/schemas/agentcore-project.ts` | Add `{{schema_key}}` array + cross-field validation |
| `src/schema/schemas/deployed-state.ts`    | Add `{{PascalName}}DeployedStateSchema`             |
| `src/cli/primitives/registry.ts`          | Register `{{camelName}}Primitive` singleton         |
| `src/cli/commands/remove/types.ts`        | Add `'{{feature_slug}}'` to `ResourceType` union    |

{{#each additional_modified_files}} | `{{path}}` | {{change}} | {{/each}}

---

## How It Fits in the CLI Architecture

### Key Decision: CDK vs Imperative

**Decision:** {{deploy_strategy}}

**Rationale:** {{deploy_rationale}}

**Precedent in the codebase:** {{deploy_precedent}}

### Deploy Flow Change

```
Current deploy flow:
  1. Preflight validation
  2. IMPERATIVE: Create/update API key providers (pre-deploy-identity.ts)
  3. IMPERATIVE: Create/update OAuth2 providers (pre-deploy-identity.ts)
  4. CDK synth + deploy (CloudFormation)
  5. Parse CFN outputs → build deployed-state.json
  6. Post-deploy: setup transaction search

New deploy flow:
  {{new_deploy_flow}}
```

### Execution Role

**Trust policy:**

```json
{{trust_policy}}
```

**Identity-based policy (attached to role):**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {{#each required_permissions}}
    {
      "Effect": "Allow",
      "Action": {{actions}},
      "Resource": {{resources}}
    }{{#unless @last}},{{/unless}}
    {{/each}}
  ]
}
```

---

## Architectural Decisions

| #   | Decision         | Choice                     | Rationale                     |
| --- | ---------------- | -------------------------- | ----------------------------- |
| 1   | Deploy mechanism | {{deploy_strategy}}        | {{deploy_rationale_short}}    |
| 2   | Schema location  | {{schema_location}}        | {{schema_location_rationale}} |
| 3   | Name constraints | {{name_regex_description}} | Matches API validation        |

{{#each additional_decisions}} | {{@index + 4}} | {{decision}} | {{choice}} | {{rationale}} | {{/each}}

---

## Implementation Phases

### Phase 1: Schema + Primitive (independently shippable)

- [ ] Zod schema in `src/schema/schemas/primitives/{{feature_slug}}.ts`
- [ ] Add to `agentcore-project.ts` (array + cross-field validation)
- [ ] Add to `deployed-state.ts`
- [ ] `{{PascalName}}Primitive` class (add + remove)
- [ ] Register in `registry.ts`
- [ ] Wire into add/remove commands
- [ ] Unit tests for schema + primitive
- [ ] Snapshot test update (if assets change)

### Phase 2: CDK Construct + Deploy (independently shippable)

- [ ] CDK construct in `@aws/agentcore-l3-cdk-constructs`
- [ ] IAM role with trust policy + permissions
- [ ] Integration into deploy flow
- [ ] deployed-state.json population from outputs
- [ ] Deploy integration tests

### Phase 3: TUI + Polish (independently shippable)

- [ ] TUI wizard screens
- [ ] Wizard hook (step logic)
- [ ] Operation hook (API interaction)
- [ ] TUI snapshot tests

{{#if has_data_plane}}

### Phase 4: Data Plane Operations (independently shippable)

- [ ] Data plane command(s)
- [ ] Status polling / streaming
- [ ] Output formatting
- [ ] Data plane tests {{/if}}

---

## Testing Strategy

### Unit Tests

- Schema validation: valid inputs, invalid inputs, edge cases, cross-field rules
- Primitive: add (happy path, duplicate name, referential integrity), remove (clean, with dependents)
- Operations: mock SDK calls, verify request shapes

### Snapshot Tests

- Update if any files in `src/assets/` are modified

### Integration / E2E

- Deploy to allowlisted account ({{allowlisted_account_id}} in {{allowlisted_regions}})
- Verify resource created with correct properties
- Verify deployed-state.json populated
- Verify remove + redeploy works cleanly

---

## Open Questions

| #   | Question | For | Context |
| --- | -------- | --- | ------- |

{{#each open_questions}} | {{@index + 1}} | {{question}} | {{for}} | {{context}} | {{/each}}

---

## Escalation Required

<!-- Items the agent cannot resolve — product decisions, cross-team alignment, refactors -->

{{#each escalation_items}}

- **{{title}}:** {{description}} {{/each}} {{#unless escalation_items}} None — all decisions within agent scope.
  {{/unless}}

---

## Appendix

### Full TUI Mockups

<!-- Detailed ASCII mockups for each wizard step -->

### IAM Policy Document

<!-- Complete IAM policy for the execution role -->

### Full API Response Shapes

<!-- Complete input/output shapes from the API model -->
