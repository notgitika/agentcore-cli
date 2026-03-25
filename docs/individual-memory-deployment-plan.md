# Individual Memory Deployment — CLI Plan

## Problem

The CLI currently blocks deployment when no agents are defined:

```
// preflight.ts:83-93
if (!projectSpec.agents || projectSpec.agents.length === 0) {
  // ... only allows through if isTeardownDeploy
  throw new Error(
    'No agents defined in project. Add at least one agent with "agentcore add agent" before deploying.'
  );
}
```

A user cannot `agentcore create --no-agent`, then `agentcore add memory`, then `agentcore deploy`. The schema already
supports top-level memories without agents, and the CDK constructs handle it — the CLI just needs to get out of the way.

## User Flow (Target State)

```bash
agentcore create --no-agent --name my-memory-project
cd my-memory-project
agentcore add memory
agentcore deploy
# => Deploys only memory resources, no agents
# => User can later: agentcore add agent && agentcore deploy
```

---

## Changes Required

### 1. Update preflight validation to allow memory-only deployments

**File:** `src/cli/operations/deploy/preflight.ts`

The current check at line 83 rejects any project with zero agents (unless it's a teardown). Change this to allow
deployment when _any_ deployable resources exist (agents OR memories OR credentials with identity providers).

```typescript
// OLD
if (!projectSpec.agents || projectSpec.agents.length === 0) {
  // ... teardown check ...
  throw new Error('No agents defined in project...');
}

// NEW
const hasDeployableResources = (projectSpec.agents?.length ?? 0) > 0 || (projectSpec.memories?.length ?? 0) > 0;

if (!hasDeployableResources) {
  let hasExistingStack = false;
  try {
    const deployedState = await configIO.readDeployedState();
    hasExistingStack = Object.keys(deployedState.targets).length > 0;
  } catch {
    // No deployed state file
  }
  if (!hasExistingStack) {
    throw new Error(
      'No resources defined in project. Add an agent with "agentcore add agent" ' +
        'or a memory with "agentcore add memory" before deploying.'
    );
  }
  isTeardownDeploy = true;
}
```

Also skip `validateRuntimeNames()` and `validateContainerAgents()` when there are no agents (they already handle empty
arrays, but making it explicit is cleaner).

### 2. Parse memory outputs from CloudFormation stack

**File:** `src/cli/cloudformation/outputs.ts`

Add a `parseMemoryOutputs` function alongside `parseAgentOutputs`:

```typescript
export function parseMemoryOutputs(outputs: StackOutputs, memoryNames: string[]): Record<string, MemoryDeployedState> {
  const memories: Record<string, MemoryDeployedState> = {};

  // Map PascalCase memory names to original names
  const memoryIdMap = new Map(memoryNames.map(name => [toPascalId(name), name]));

  const outputsByMemory: Record<string, { memoryId?: string; memoryArn?: string }> = {};

  // Match pattern: ApplicationMemory{MemoryName}Memory{Id|Arn}Output
  const outputPattern = /^ApplicationMemory(.+?)Memory(Id|Arn)Output/;

  for (const [key, value] of Object.entries(outputs)) {
    const match = outputPattern.exec(key);
    if (!match) continue;

    const logicalMemory = match[1];
    const outputType = match[2];
    if (!logicalMemory || !outputType) continue;

    const memoryName = memoryIdMap.get(logicalMemory) ?? logicalMemory;
    outputsByMemory[memoryName] ??= {};

    if (outputType === 'Id') {
      outputsByMemory[memoryName].memoryId = value;
    } else if (outputType === 'Arn') {
      outputsByMemory[memoryName].memoryArn = value;
    }
  }

  for (const [memoryName, memoryOutputs] of Object.entries(outputsByMemory)) {
    if (memoryOutputs.memoryId && memoryOutputs.memoryArn) {
      memories[memoryName] = {
        memoryId: memoryOutputs.memoryId,
        memoryArn: memoryOutputs.memoryArn,
      };
    }
  }

  return memories;
}
```

### 3. Update `buildDeployedState` to include memory state

**File:** `src/cli/cloudformation/outputs.ts`

```typescript
export function buildDeployedState(
  targetName: string,
  stackName: string,
  agents: Record<string, AgentCoreDeployedState>,
  existingState?: DeployedState,
  identityKmsKeyArn?: string,
  memories?: Record<string, MemoryDeployedState> // NEW
): DeployedState {
  const targetState: TargetDeployedState = {
    resources: {
      agents: Object.keys(agents).length > 0 ? agents : undefined,
      memories: memories && Object.keys(memories).length > 0 ? memories : undefined,
      stackName,
      identityKmsKeyArn,
    },
  };
  // ...
}
```

### 4. Update deploy action to parse and persist memory state

**File:** `src/cli/commands/deploy/actions.ts`

In `handleDeploy()`, after deployment succeeds, parse memory outputs alongside agent outputs:

```typescript
// Get stack outputs and persist state
startStep('Persist deployment state');
const outputs = await getStackOutputs(target.region, stackName);

const agentNames = context.projectSpec.agents.map(a => a.name);
const agents = parseAgentOutputs(outputs, agentNames, stackName);

const memoryNames = (context.projectSpec.memories ?? []).map(m => m.name);
const memories = parseMemoryOutputs(outputs, memoryNames);

const existingState = await configIO.readDeployedState().catch(() => undefined);
const deployedState = buildDeployedState(target.name, stackName, agents, existingState, identityKmsKeyArn, memories);
await configIO.writeDeployedState(deployedState);
```

### 5. Update `nextSteps` to be context-aware

**File:** `src/cli/commands/deploy/actions.ts`

When only memories are deployed (no agents), `agentcore invoke` doesn't make sense. Make next steps conditional:

```typescript
const hasAgents = context.projectSpec.agents.length > 0;
const nextSteps = hasAgents ? ['agentcore invoke', 'agentcore status'] : ['agentcore add agent', 'agentcore status'];
```

### 6. Update `agentcore status` to show memory resources

**File:** `src/cli/commands/status/` (command handler)

The status command should display deployed memory resources. When checking deployed state, also show memory IDs/ARNs.
This is an additive change — show memory info when `resources.memories` exists in deployed state.

### 7. Update TUI deploy screen for memory-only feedback

**File:** `src/cli/commands/deploy/` (TUI components)

The TUI deploy screen should show appropriate messaging when deploying memory-only:

- Progress steps still apply (validate, build, synth, deploy)
- Success message should mention memories deployed, not just agents
- The "invoke" suggestion should be conditional

### 8. Update deployed-state schema (mirror CDK changes)

**File:** `src/schema/schemas/deployed-state.ts`

Add the same `MemoryDeployedState` schema as the CDK package (schemas are duplicated across packages per CLAUDE.md):

```typescript
export const MemoryDeployedStateSchema = z.object({
  memoryId: z.string().min(1),
  memoryArn: z.string().min(1),
});

export type MemoryDeployedState = z.infer<typeof MemoryDeployedStateSchema>;

// Update DeployedResourceStateSchema
export const DeployedResourceStateSchema = z.object({
  agents: z.record(z.string(), AgentCoreDeployedStateSchema).optional(),
  memories: z.record(z.string(), MemoryDeployedStateSchema).optional(), // NEW
  mcp: McpDeployedStateSchema.optional(),
  externallyManaged: ExternallyManagedStateSchema.optional(),
  stackName: z.string().optional(),
  identityKmsKeyArn: z.string().optional(),
});
```

### 9. Update `agentcore create --no-agent` flow

**File:** `src/cli/commands/create/action.ts`

Currently `--no-agent` creates a project with empty arrays. This already works. But the messaging after create should
suggest `agentcore add memory` as a valid next step (not just `agentcore add agent`).

### 10. Consider: Allow `agentcore add memory` to prompt for deployment

This is optional/future — after adding a memory, the CLI could suggest `agentcore deploy` if the user has a deployment
target configured. Currently it only suggests this after `add agent`.

---

## Files to Modify

| File                                     | Change                                                    | Effort  |
| ---------------------------------------- | --------------------------------------------------------- | ------- |
| `src/cli/operations/deploy/preflight.ts` | Allow memory-only deploys                                 | Small   |
| `src/cli/cloudformation/outputs.ts`      | Add `parseMemoryOutputs`, update `buildDeployedState`     | Medium  |
| `src/cli/commands/deploy/actions.ts`     | Parse memory outputs, conditional next steps              | Small   |
| `src/schema/schemas/deployed-state.ts`   | Add `MemoryDeployedState`, update `DeployedResourceState` | Small   |
| `src/schema/index.ts`                    | Export new types                                          | Trivial |
| `src/cli/commands/status/`               | Show memory resources in status                           | Small   |
| `src/cli/commands/deploy/` (TUI)         | Context-aware messaging                                   | Small   |

## Files NOT changed

- `src/cli/operations/memory/create-memory.ts` — already works correctly
- `src/cli/operations/memory/generate-memory-files.ts` — only relevant when agents exist
- `src/cli/commands/create/` — `--no-agent` flow already works
- `src/assets/cdk/bin/cdk.ts` — CDK entry point doesn't need changes
- `src/assets/cdk/lib/cdk-stack.ts` — `AgentCoreApplication` already handles empty agents

---

## Testing

1. **E2E: Memory-only deploy**

   ```bash
   agentcore create --no-agent --name memtest
   cd memtest
   agentcore add memory  # add a short-term memory
   agentcore deploy -y
   # Verify: stack created, memory resources exist, deployed-state.json has memories
   ```

2. **E2E: Memory-only then add agent**

   ```bash
   # ... after memory-only deploy ...
   agentcore add agent
   agentcore deploy -y
   # Verify: stack updated, both agent and memory in deployed-state.json
   # Memory still accessible, no orphaned resources
   ```

3. **Unit test: Preflight allows memory-only**
   - Mock project with `agents: [], memories: [{ ... }]`
   - Verify `validateProject()` does NOT throw
   - Verify `isTeardownDeploy` is `false`

4. **Unit test: Preflight still blocks empty projects**
   - Mock project with `agents: [], memories: []`
   - Verify `validateProject()` throws appropriate error

5. **Unit test: parseMemoryOutputs**
   - Mock CloudFormation outputs with memory patterns
   - Verify correct parsing into `MemoryDeployedState`

6. **Unit test: buildDeployedState with memories**
   - Verify deployed state includes both agents and memories sections

7. **Snapshot tests** — May need updating if CDK template assets change

---

## Rollout Considerations

- **Backwards compatibility**: Existing projects with agents + memories continue to work unchanged. The deployed-state
  schema change is additive (new optional `memories` field).
- **Schema sync**: `deployed-state.ts` changes must be reflected in both `agentcore-cli` and
  `agentcore-l3-cdk-constructs` packages.
- **CDK package dependency**: The CDK package needs per-memory outputs before the CLI can parse them. Ship CDK changes
  first or together.

---

## Complexity Assessment

**Medium.** The core change (preflight validation) is trivial. The supporting work (output parsing, state tracking, UX
messaging) requires touching several files but each change is small and well-contained. No architectural changes needed
— the design already supports this, we just need to remove the artificial gate and add plumbing.
