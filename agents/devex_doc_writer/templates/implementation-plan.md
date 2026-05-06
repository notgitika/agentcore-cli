# {{feature_name}}: Implementation Plan

**Author:** {{service_team_contact}} **Date:** {{date}} **Status:** Draft **Source:** DevEx Proposal
v{{devex_doc_version}} (approved {{approval_date}}) **Archetype:** {{archetype}}

---

## Summary

{{summary_paragraph}}

**Phases:** {{total_phases}} **Estimated total size:** {{total_size_estimate}} **Target repos:** {{target_repos}}

---

## Prerequisites

Before implementation begins, these must be true:

- [ ] DevEx proposal approved (APPROVED keyword received)
- [ ] SDK package available: `{{sdk_package_name}}` (or endpoint override configured)
- [ ] Account {{allowlisted_account_id}} allowlisted in {{allowlisted_regions}}
- [ ] Trust policy confirmed with {{service_team}} {{#if cfn_support}}
- [ ] CFN resource type `{{cfn_resource_type}}` available in target regions {{/if}} {{#each additional_prerequisites}}
- [ ] {{this}} {{/each}}

---

## Phase 1: {{phase_1_name}}

**Goal:** {{phase_1_goal}} **Ship note:** {{phase_1_ship_note}} **Branch:** `feat/{{feature_slug}}-phase-1`

### Tasks

| #   | Task | File(s) | Depends On | Size | Verification |
| --- | ---- | ------- | ---------- | ---- | ------------ |

{{#each phase_1_tasks}} | {{task_id}} | {{title}} | `{{primary_file}}` | {{depends_on}} | {{size}} | {{verification}} |
{{/each}}

### Phase 1 Verification Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (new + existing)
- [ ] `npm run lint` passes
- [ ] `npm run format:check` passes {{#each phase_1_verification}}
- [ ] {{this}} {{/each}}

### Definition of Done

{{phase_1_dod}}

---

## Phase 2: {{phase_2_name}}

**Goal:** {{phase_2_goal}} **Ship note:** {{phase_2_ship_note}} **Branch:** `feat/{{feature_slug}}-phase-2` **Depends
on:** Phase 1 merged

### Tasks

| #   | Task | File(s) | Depends On | Size | Verification |
| --- | ---- | ------- | ---------- | ---- | ------------ |

{{#each phase_2_tasks}} | {{task_id}} | {{title}} | `{{primary_file}}` | {{depends_on}} | {{size}} | {{verification}} |
{{/each}}

### Phase 2 Verification Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (new + existing)
- [ ] `npm run lint` passes
- [ ] `npm run format:check` passes {{#each phase_2_verification}}
- [ ] {{this}} {{/each}}

### Definition of Done

{{phase_2_dod}}

---

## Phase 3: {{phase_3_name}}

**Goal:** {{phase_3_goal}} **Ship note:** {{phase_3_ship_note}} **Branch:** `feat/{{feature_slug}}-phase-3` **Depends
on:** Phase 2 merged

### Tasks

| #   | Task | File(s) | Depends On | Size | Verification |
| --- | ---- | ------- | ---------- | ---- | ------------ |

{{#each phase_3_tasks}} | {{task_id}} | {{title}} | `{{primary_file}}` | {{depends_on}} | {{size}} | {{verification}} |
{{/each}}

### Phase 3 Verification Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (new + existing) {{#each phase_3_verification}}
- [ ] {{this}} {{/each}}

### Definition of Done

{{phase_3_dod}}

---

{{#if phase_4_name}}

## Phase 4: {{phase_4_name}}

**Goal:** {{phase_4_goal}} **Ship note:** {{phase_4_ship_note}} **Branch:** `feat/{{feature_slug}}-phase-4` **Depends
on:** Phase 3 merged

### Tasks

| #   | Task | File(s) | Depends On | Size | Verification |
| --- | ---- | ------- | ---------- | ---- | ------------ |

{{#each phase_4_tasks}} | {{task_id}} | {{title}} | `{{primary_file}}` | {{depends_on}} | {{size}} | {{verification}} |
{{/each}}

### Phase 4 Verification Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes {{#each phase_4_verification}}
- [ ] {{this}} {{/each}}

### Definition of Done

{{phase_4_dod}}

---

{{/if}}

## Cross-Cutting Concerns

These apply to ALL phases — not repeated per phase but verified at the end:

- [ ] **Partition support:** All ARN construction uses `arnPrefix(region)` from `src/cli/aws/partition.ts`
- [ ] **Tags:** Resource supports `TagsSchema` and tags flow through to deployed CloudFormation resources
- [ ] **Error messages:** All user-facing errors are clear, actionable, and include remediation steps
- [ ] **Snapshot tests:** Run `npm run test:update-snapshots` if any `src/assets/` files changed
- [ ] **Documentation:** Update `docs/commands.md` and `docs/configuration.md` {{#each additional_cross_cutting}}
- [ ] {{this}} {{/each}}

---

## Task Dependency Graph

```
{{dependency_graph_ascii}}
```

**Critical path:** {{critical_path}}

**Parallelizable within phases:** {{#each parallelizable_tasks}}

- Phase {{phase}}: Tasks {{tasks}} can run in parallel {{/each}}

---

## Size Estimates

| Size | Definition                                    | Count        |
| ---- | --------------------------------------------- | ------------ |
| S    | < 50 lines changed, single file               | {{count_s}}  |
| M    | 50-200 lines, 1-3 files                       | {{count_m}}  |
| L    | 200-500 lines, 3-5 files                      | {{count_l}}  |
| XL   | 500+ lines or complex multi-file coordination | {{count_xl}} |

**Total tasks:** {{total_tasks}} **Estimated effort:** {{effort_estimate}}

---

## Risk Register

| #   | Risk | Likelihood | Impact | Mitigation |
| --- | ---- | ---------- | ------ | ---------- |

{{#each risks}} | {{@index + 1}} | {{description}} | {{likelihood}} | {{impact}} | {{mitigation}} | {{/each}}

---

## Testing Plan Per Phase

### Phase 1 Tests

| Test Type | What to Test | File |
| --------- | ------------ | ---- |

{{#each phase_1_tests}} | {{type}} | {{description}} | `{{file}}` | {{/each}}

### Phase 2 Tests

| Test Type | What to Test | File |
| --------- | ------------ | ---- |

{{#each phase_2_tests}} | {{type}} | {{description}} | `{{file}}` | {{/each}}

### Phase 3 Tests

| Test Type | What to Test | File |
| --------- | ------------ | ---- |

{{#each phase_3_tests}} | {{type}} | {{description}} | `{{file}}` | {{/each}}

### Integration Tests (after all phases)

| Scenario | Expected Result | Account | Region |
| -------- | --------------- | ------- | ------ |

{{#each integration_tests}} | {{scenario}} | {{expected}} | {{allowlisted_account_id}} | {{region}} | {{/each}}

---

## PR Strategy

| Phase | Branch                          | PR Title                                               | Reviewers      |
| ----- | ------------------------------- | ------------------------------------------------------ | -------------- |
| 1     | `feat/{{feature_slug}}-phase-1` | `feat({{feature_slug}}): add schema and primitive`     | CLI team       |
| 2     | `feat/{{feature_slug}}-phase-2` | `feat({{feature_slug}}): add CDK construct and deploy` | CLI + CDK team |
| 3     | `feat/{{feature_slug}}-phase-3` | `feat({{feature_slug}}): add TUI wizard`               | CLI team       |

{{#if phase_4_name}} | 4 | `feat/{{feature_slug}}-phase-4` | `feat({{feature_slug}}): add {{phase_4_name_short}}` | CLI
team | {{/if}}

**Commit style:** `feat({{feature_slug}}): description` for features, `test({{feature_slug}}): description` for tests

---

## Resolved Decisions

Decisions made during the DevEx review that affect implementation:

| #   | Decision | Resolution | From |
| --- | -------- | ---------- | ---- |

{{#each resolved_decisions}} | {{@index + 1}} | {{decision}} | {{resolution}} | DevEx doc v{{version}} | {{/each}}

---

## Notes for the Executor Agent

<!-- Guidance for the feature_builder agent that consumes this plan -->

- Follow the task dependency graph strictly — do not start a task before its dependencies are complete
- Each phase is a separate PR. Do not combine phases.
- Run the phase verification checklist before creating the PR
- If a task requires clarification not covered here, check the approved DevEx doc first
- If still unclear, surface as a blocker rather than guessing
- Size estimates are guidelines. If a task grows beyond its estimate, split it rather than shipping a massive diff.
