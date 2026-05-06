# {{feature_name}}: CLI DevEx Proposal

**Author:** {{service_team_contact}} **Date:** {{date}} **Status:** Draft **References:** {{external_docs_url}},
{{design_doc_url}}

---

## What is {{feature_name}}?

<!-- 2-3 paragraphs. Problem + what devs get. No implementation details yet. -->

{{feature_description}}

---

## Scope

**In scope:**

- Changes to existing commands ({{affected_commands_list}})
- Configuration schema changes
- Detection and prerequisites
- Templates for new projects
- Migration path for existing projects

**Out of scope:** {{scope_constraints}}

---

## Current State

{{current_description}}

**Key files today:** {{#each current_key_files}}

- `{{this}}` {{/each}}

**Current developer experience:**

```bash
{{current_user_experience}}
```

---

## Target State

{{target_description}}

**Target developer experience:**

```bash
{{target_user_experience}}
```

---

## Coexistence Model

**Model:** {{coexistence_model}}

| Dimension        | Existing Path        | New Path        |
| ---------------- | -------------------- | --------------- |
| Triggered by     | {{existing_trigger}} | {{new_trigger}} |
| Configuration    | {{existing_config}}  | {{new_config}}  |
| Deploy mechanism | {{existing_deploy}}  | {{new_deploy}}  |
| State tracking   | {{existing_state}}   | {{new_state}}   |

**Backwards compatible:** {{backwards_compatible}}

{{coexistence_explanation}}

---

## Developer Journeys

### 1/ New project with {{feature_name}}

**User story:** A developer creating a new AgentCore project wants to use {{feature_slug}} from the start.

**CLI experience:**

```bash
agentcore create
# TUI now offers {{feature_slug}} option during setup
```

**TUI experience:**

```
Create AgentCore Project

✓ Name → ✓ Framework → ● {{choice_step}} → ○ Confirm

╭──────────────────────────────────────────────────────╮
│ Select {{choice_label}}                               │
│                                                       │
│ ❯ {{existing_option}} — {{existing_description}}       │
│   {{new_option}} — {{new_description}}                 │
╰──────────────────────────────────────────────────────╯

↑↓ navigate · Enter select · Esc back
```

**Under the hood:**

1. User selection writes `{{config_field}}: "{{new_value}}"` to agentcore.json
2. Templates vended for the new path
3. Project structure created with {{new_option}}-specific files

**What we build:**

- [ ] New option in create wizard
- [ ] Template files for {{new_option}} path
- [ ] Config field in schema

---

### 2/ Existing project opting in

**User story:** A developer with an existing CDK-based project wants to switch to {{feature_slug}}.

**CLI experience:**

```bash
# Manual opt-in: edit agentcore.json
# Set {{config_field}}: "{{new_value}}"

# Or via CLI command (if applicable):
agentcore {{opt_in_command}}
```

**Under the hood:**

1. Validate {{new_option}} prerequisites are met ({{user_prerequisites}})
2. Update `{{config_field}}` in agentcore.json
3. {{migration_steps}}

**What we build:**

- [ ] Prerequisite validation
- [ ] Config migration logic
- [ ] Clear error messages for missing prerequisites

---

### 3/ Existing project — unchanged (proves backwards compat)

**User story:** A developer with an existing project who does NOT opt in experiences zero changes.

**CLI experience:**

```bash
# Everything works exactly as before
agentcore deploy    # still uses {{existing_option}}
agentcore status    # still reads {{existing_state}}
```

**Under the hood:**

1. `{{config_field}}` defaults to `"{{existing_value}}"` if absent
2. All existing code paths unchanged
3. No new dependencies introduced for the default path

**Callout:** This is critical. If an existing project breaks after this change ships, it's a regression.

---

### 4/ {{operational_journey}} (if applicable)

---

## Affected Commands

| Command | Change Type | Description | Backwards Compatible |
| ------- | ----------- | ----------- | -------------------- |

{{#each affected_commands}} | `agentcore {{command}}` | {{change_type}} | {{description}} | {{backwards_compatible}} |
{{/each}}

---

## Schema Changes

### In `agentcore.json`:

```json
{
  "name": "MyProject",
  "managedBy": "CDK",
  "{{config_field}}": "{{new_value}}",
  {{additional_schema_fields}}
}
```

**Default value:** `"{{existing_value}}"` (if field absent, existing behavior preserved)

### Zod schema change:

```typescript
// In AgentCoreProjectSpecSchema:
{{config_field}}: z.enum([{{enum_values}}]).default('{{existing_value}}'),
```

### In `deployed-state.json` (if applicable):

```typescript
{
  {
    deployed_state_changes;
  }
}
```

---

## Detection & Prerequisites

### External Tool Detection

```typescript
// How the CLI checks for {{external_tool}}:
{
  {
    detection_code;
  }
}
```

### Version Check

```typescript
// Minimum version: {{external_tool_version}}
{
  {
    version_check_code;
  }
}
```

### Error Messages

| Scenario        | Message                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Tool not found  | `"{{external_tool}} not found. Install it: {{install_instructions}}"`                           |
| Version too old | `"{{external_tool}} {{detected_version}} is not supported. Minimum: {{external_tool_version}}"` |
| Misconfigured   | `"{{misconfigured_message}}"`                                                                   |

---

## Codebase Changes

### New Files

| File | Purpose |
| ---- | ------- |

{{#each new_files}} | `{{path}}` | {{purpose}} | {{/each}}

### Modified Files

| File | Change |
| ---- | ------ |

{{#each modified_files}} | `{{path}}` | {{change}} | {{/each}}

---

## Architecture: Where It Branches

### Dispatch Point

```
{{dispatch_diagram}}
```

**Pattern:** {{design_pattern}} (e.g., Strategy, Adapter)

**Precedent in the codebase:** {{precedent}}

### Deploy Flow Change

```
Current:                                New:
  1. Preflight validation                 1. Preflight validation
  2. Identity providers                   2. Identity providers
  3. OAuth2 providers                     3. OAuth2 providers
  4. CDK synth + deploy                   4. {{new_step_4}}
  5. Parse outputs → state                5. Parse outputs → state
  6. Post-deploy                          6. Post-deploy
```

---

## Architectural Decisions

| #   | Decision            | Choice                         | Rationale                               |
| --- | ------------------- | ------------------------------ | --------------------------------------- |
| 1   | Coexistence model   | {{coexistence_model}}          | {{coexistence_rationale}}               |
| 2   | Configuration level | Project-level (agentcore.json) | Persistent choice, not per-command flag |
| 3   | Detection strategy  | {{detection_strategy}}         | {{detection_rationale}}                 |

{{#each additional_decisions}} | {{@index + 4}} | {{decision}} | {{choice}} | {{rationale}} | {{/each}}

---

## Implementation Phases

### Phase 1: Foundation + Detection (independently shippable)

- [ ] Config schema change (new field with default — no behavior change)
- [ ] External tool detection utility
- [ ] Version check logic
- [ ] Error messages for missing/incompatible tool
- [ ] Unit tests: schema validation, detection, version check
- [ ] **Ship note:** After this lands, existing projects unchanged. Just the schema field and detection infra.

### Phase 2: Core Implementation (independently shippable)

- [ ] New code path ({{new_option}} provider/adapter)
- [ ] Dispatch logic at the branch point
- [ ] {{new_option}}-specific templates/assets
- [ ] Integration tests: new path works end-to-end
- [ ] **Ship note:** After this lands, `{{config_field}}: "{{new_value}}"` in config activates the new path.

### Phase 3: Creation Flow Integration (independently shippable)

- [ ] `agentcore create` TUI offers new option
- [ ] Templates vended for new path projects
- [ ] Snapshot tests for new templates
- [ ] **Ship note:** After this lands, new projects can choose {{new_option}} at creation time.

### Phase 4: Polish + Migration (independently shippable)

- [ ] Opt-in mechanism for existing projects
- [ ] Migration validation (existing → new)
- [ ] Documentation updates (commands.md, configuration.md)
- [ ] Edge case error handling
- [ ] **Ship note:** After this lands, existing projects can switch.

---

## Testing Strategy

### Existing Test Preservation

- All existing tests MUST pass without modification after Phase 1-3
- Run full test suite on every PR: `npm test`, `npm run typecheck`, `npm run lint`
- Any existing test failure is a regression, not a "needs update"

### New Test Matrix

| Scenario            | {{existing_option}} | {{new_option}}       |
| ------------------- | ------------------- | -------------------- |
| Create project      | ✓ (unchanged)       | ✓ (new)              |
| Deploy              | ✓ (unchanged)       | ✓ (new path)         |
| Status              | ✓ (unchanged)       | ✓ (new state source) |
| Remove + redeploy   | ✓                   | ✓                    |
| Missing tool        | N/A                 | ✓ (clear error)      |
| Wrong version       | N/A                 | ✓ (clear error)      |
| Switch existing→new | ✓                   | ✓                    |

### Integration / E2E

- Deploy with {{new_option}} to allowlisted account
- Verify resources created correctly
- Verify state tracking works
- Verify switching between options

---

## Open Questions

| #   | Question | For | Context |
| --- | -------- | --- | ------- |

{{#each open_questions}} | {{@index + 1}} | {{question}} | {{for}} | {{context}} | {{/each}}

---

## Escalation Required

{{#each escalation_items}}

- **{{title}}:** {{description}} {{/each}} {{#unless escalation_items}} None — all decisions within agent scope.
  {{/unless}}

---

## Appendix

### Side-by-Side Config Examples

**Existing path (unchanged):**

```json
{{existing_config_example}}
```

**New path:**

```json
{{new_config_example}}
```

### Full Detection Logic

<!-- Complete detection code with all edge cases -->

### Template Diff

<!-- What's different between existing templates and new templates -->
