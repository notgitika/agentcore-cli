# Harness Custom JWT Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Custom JWT inbound authentication to the harness resource, matching the existing agent/gateway pattern.

**Architecture:** Reuses all existing shared auth components (schemas, TUI JWT config flow, CLI validation, auth-utils). The harness schema gains `authorizerType` and `authorizerConfiguration` fields. The TUI adds an "Auth" entry to the advanced settings multi-select. The CLI adds the standard auth flags. The deploy layer already accepts `authorizerConfiguration` on CreateHarness/UpdateHarness — it just needs to be populated from the spec.

**Tech Stack:** TypeScript, Zod, React/Ink (TUI), Commander (CLI)

---

### Task 1: Add auth fields to HarnessSpec schema

**Files:**
- Modify: `src/schema/schemas/primitives/harness.ts:1-262`

- [ ] **Step 1: Write the failing test**

Create a test that validates a harness spec with auth fields:

```typescript
// In a new file: src/schema/schemas/primitives/__tests__/harness-auth.test.ts
import { HarnessSpecSchema } from '../harness';
import { describe, expect, it } from 'vitest';

describe('HarnessSpec auth fields', () => {
  const baseSpec = {
    name: 'testHarness',
    model: { provider: 'bedrock', modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0' },
    tools: [],
    skills: [],
  };

  it('accepts CUSTOM_JWT with valid authorizerConfiguration', () => {
    const result = HarnessSpecSchema.safeParse({
      ...baseSpec,
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts AWS_IAM without authorizerConfiguration', () => {
    const result = HarnessSpecSchema.safeParse({
      ...baseSpec,
      authorizerType: 'AWS_IAM',
    });
    expect(result.success).toBe(true);
  });

  it('accepts spec without authorizerType (defaults to SigV4)', () => {
    const result = HarnessSpecSchema.safeParse(baseSpec);
    expect(result.success).toBe(true);
  });

  it('rejects CUSTOM_JWT without authorizerConfiguration', () => {
    const result = HarnessSpecSchema.safeParse({
      ...baseSpec,
      authorizerType: 'CUSTOM_JWT',
    });
    expect(result.success).toBe(false);
  });

  it('rejects AWS_IAM with authorizerConfiguration', () => {
    const result = HarnessSpecSchema.safeParse({
      ...baseSpec,
      authorizerType: 'AWS_IAM',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects authorizerConfiguration without authorizerType', () => {
    const result = HarnessSpecSchema.safeParse({
      ...baseSpec,
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/schema/schemas/primitives/__tests__/harness-auth.test.ts`
Expected: FAIL — `authorizerType` and `authorizerConfiguration` are not recognized fields.

- [ ] **Step 3: Add auth fields to HarnessSpecSchema**

In `src/schema/schemas/primitives/harness.ts`, add the import and fields:

```typescript
// Add to imports at top of file:
import { AuthorizerConfigSchema, RuntimeAuthorizerTypeSchema } from '../auth';

// Add these two fields inside the HarnessSpecSchema z.object(), after the `tags` field:
    authorizerType: RuntimeAuthorizerTypeSchema.optional(),
    authorizerConfiguration: AuthorizerConfigSchema.optional(),
```

Then add validation to the existing `superRefine` block (alongside the containerUri/networkMode checks):

```typescript
    if (data.authorizerType === 'CUSTOM_JWT' && !data.authorizerConfiguration?.customJwtAuthorizer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authorizerConfiguration with customJwtAuthorizer is required when authorizerType is CUSTOM_JWT',
        path: ['authorizerConfiguration'],
      });
    }
    if (data.authorizerType !== 'CUSTOM_JWT' && data.authorizerConfiguration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authorizerConfiguration is only allowed when authorizerType is CUSTOM_JWT',
        path: ['authorizerConfiguration'],
      });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/schema/schemas/primitives/__tests__/harness-auth.test.ts`
Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schema/schemas/primitives/harness.ts src/schema/schemas/primitives/__tests__/harness-auth.test.ts
git commit -m "feat(harness): add authorizerType and authorizerConfiguration to HarnessSpec schema"
```

---

### Task 2: Add auth to HarnessPrimitive add() and AddHarnessOptions

**Files:**
- Modify: `src/cli/primitives/HarnessPrimitive.ts:1-385`
- Modify: `src/cli/primitives/__tests__/HarnessPrimitive.test.ts`

- [ ] **Step 1: Write the failing test**

Add tests to the existing `src/cli/primitives/__tests__/HarnessPrimitive.test.ts`:

```typescript
// Add import at top:
import type { RuntimeAuthorizerType } from '../../../schema';

// Add inside describe('add()'):
    it('includes authorizerType and authorizerConfiguration when CUSTOM_JWT', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      const result = await primitive.add({
        name: 'jwtHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        authorizerType: 'CUSTOM_JWT' as RuntimeAuthorizerType,
        jwtConfig: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
        },
      });

      expect(result.success).toBe(true);
      expect(mockWriteHarnessSpec).toHaveBeenCalledWith(
        'jwtHarness',
        expect.objectContaining({
          authorizerType: 'CUSTOM_JWT',
          authorizerConfiguration: {
            customJwtAuthorizer: {
              discoveryUrl: 'https://example.com/.well-known/openid-configuration',
              allowedAudience: ['aud1'],
            },
          },
        })
      );
    });

    it('does not include auth fields when authorizerType is AWS_IAM', async () => {
      mockReadProjectSpec.mockResolvedValue(JSON.parse(JSON.stringify(baseProject)));

      await primitive.add({
        name: 'iamHarness',
        modelProvider: 'bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        authorizerType: 'AWS_IAM' as RuntimeAuthorizerType,
      });

      const writtenSpec = mockWriteHarnessSpec.mock.calls[0]![1];
      expect(writtenSpec.authorizerType).toBeUndefined();
      expect(writtenSpec.authorizerConfiguration).toBeUndefined();
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/primitives/__tests__/HarnessPrimitive.test.ts`
Expected: FAIL — `jwtConfig` is not a property of `AddHarnessOptions`.

- [ ] **Step 3: Add auth to AddHarnessOptions and add() method**

In `src/cli/primitives/HarnessPrimitive.ts`:

Add imports at top:
```typescript
import type { HarnessModelProvider, HarnessSpec, NetworkMode, RuntimeAuthorizerType } from '../../schema';
import { buildAuthorizerConfigFromJwtConfig, createManagedOAuthCredential } from './auth-utils';
import type { JwtConfigOptions } from './auth-utils';
```

Note: Replace the existing `HarnessModelProvider, HarnessSpec, NetworkMode` import from `../../schema` — just add `RuntimeAuthorizerType` to it.

Add fields to `AddHarnessOptions`:
```typescript
  authorizerType?: RuntimeAuthorizerType;
  jwtConfig?: JwtConfigOptions;
```

In the `add()` method, update the `harnessSpec` construction (after the `lifecycleConfig` spread on line 101):
```typescript
        ...(options.authorizerType === 'CUSTOM_JWT' &&
          options.jwtConfig && {
            authorizerType: 'CUSTOM_JWT' as const,
            authorizerConfiguration: buildAuthorizerConfigFromJwtConfig(options.jwtConfig),
          }),
```

After writing the harness spec and project spec (after `await this.writeProjectSpec(project, configIO);` on line 128), add the managed OAuth credential creation:
```typescript
      if (options.authorizerType === 'CUSTOM_JWT' && options.jwtConfig?.clientId && options.jwtConfig?.clientSecret) {
        await createManagedOAuthCredential(
          options.name,
          options.jwtConfig,
          spec => this.writeProjectSpec(spec, configIO),
          () => this.readProjectSpec(configIO)
        );
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/primitives/__tests__/HarnessPrimitive.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/primitives/HarnessPrimitive.ts src/cli/primitives/__tests__/HarnessPrimitive.test.ts
git commit -m "feat(harness): wire Custom JWT auth into HarnessPrimitive add()"
```

---

### Task 3: Add auth to harness CLI flags

**Files:**
- Modify: `src/cli/primitives/HarnessPrimitive.ts:226-356` (registerCommands)
- Modify: `src/cli/commands/add/types.ts`
- Modify: `src/cli/commands/add/validate.ts`

- [ ] **Step 1: Add AddHarnessOptions type to CLI types**

In `src/cli/commands/add/types.ts`, add after the existing interfaces:

```typescript
export interface AddHarnessCliOptions {
  name?: string;
  modelProvider?: string;
  modelId?: string;
  apiKeyArn?: string;
  container?: string;
  memory?: boolean;
  maxIterations?: number;
  maxTokens?: number;
  timeout?: number;
  truncationStrategy?: string;
  networkMode?: string;
  subnets?: string;
  securityGroups?: string;
  idleTimeout?: number;
  maxLifetime?: number;
  authorizerType?: string;
  discoveryUrl?: string;
  allowedAudience?: string;
  allowedClients?: string;
  allowedScopes?: string;
  customClaims?: string;
  clientId?: string;
  clientSecret?: string;
  json?: boolean;
}
```

- [ ] **Step 2: Add validateAddHarnessOptions to validate.ts**

In `src/cli/commands/add/validate.ts`, add:

```typescript
import type { AddHarnessCliOptions } from './types';

// Add at the end of file:
export function validateAddHarnessOptions(options: AddHarnessCliOptions): ValidationResult {
  if (!options.name) {
    return { valid: false, error: '--name is required' };
  }

  if (options.authorizerType) {
    const authResult = RuntimeAuthorizerTypeSchema.safeParse(options.authorizerType);
    if (!authResult.success) {
      return { valid: false, error: 'Invalid authorizer type. Use AWS_IAM or CUSTOM_JWT' };
    }

    if (options.authorizerType === 'CUSTOM_JWT') {
      const jwtResult = validateJwtAuthorizerOptions(options);
      if (!jwtResult.valid) return jwtResult;
    }
  }

  if (options.clientId && options.authorizerType !== 'CUSTOM_JWT') {
    return { valid: false, error: 'OAuth client credentials are only valid with CUSTOM_JWT authorizer' };
  }

  return { valid: true };
}
```

- [ ] **Step 3: Add auth flags to registerCommands**

In `src/cli/primitives/HarnessPrimitive.ts`, in `registerCommands()`, add these options after `--max-lifetime`:

```typescript
      .option('--authorizer-type <type>', 'Authorizer type: AWS_IAM or CUSTOM_JWT')
      .option('--discovery-url <url>', 'OIDC discovery URL (for CUSTOM_JWT)')
      .option('--allowed-audience <audience>', 'Comma-separated allowed audiences (for CUSTOM_JWT)')
      .option('--allowed-clients <clients>', 'Comma-separated allowed client IDs (for CUSTOM_JWT)')
      .option('--allowed-scopes <scopes>', 'Comma-separated allowed scopes (for CUSTOM_JWT)')
      .option('--custom-claims <json>', 'Custom claim validations as JSON array (for CUSTOM_JWT)')
      .option('--client-id <id>', 'OAuth client ID for fetching harness bearer tokens')
      .option('--client-secret <secret>', 'OAuth client secret for fetching harness bearer tokens')
```

Update the `cliOptions` type in the action handler to add the auth fields:

```typescript
          authorizerType?: string;
          discoveryUrl?: string;
          allowedAudience?: string;
          allowedClients?: string;
          allowedScopes?: string;
          customClaims?: string;
          clientId?: string;
          clientSecret?: string;
```

Add validation before the `this.add()` call — after the name check and before parsing options. Import `validateAddHarnessOptions` from `../commands/add/validate` and `RuntimeAuthorizerTypeSchema`, `CustomClaimValidation` from `../../schema`:

```typescript
              // Validate harness-specific options (auth)
              const { validateAddHarnessOptions } = await import('../commands/add/validate');
              const validation = validateAddHarnessOptions(cliOptions);
              if (!validation.valid) {
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error: validation.error }));
                } else {
                  console.error(validation.error);
                }
                process.exit(1);
              }
```

Add auth fields to the `this.add()` call:

```typescript
                authorizerType: cliOptions.authorizerType
                  ? (cliOptions.authorizerType as RuntimeAuthorizerType)
                  : undefined,
                jwtConfig: cliOptions.authorizerType === 'CUSTOM_JWT'
                  ? {
                      discoveryUrl: cliOptions.discoveryUrl!,
                      allowedAudience: cliOptions.allowedAudience?.split(',').map(s => s.trim()),
                      allowedClients: cliOptions.allowedClients?.split(',').map(s => s.trim()),
                      allowedScopes: cliOptions.allowedScopes?.split(',').map(s => s.trim()),
                      customClaims: cliOptions.customClaims
                        ? (JSON.parse(cliOptions.customClaims) as CustomClaimValidation[])
                        : undefined,
                      clientId: cliOptions.clientId,
                      clientSecret: cliOptions.clientSecret,
                    }
                  : undefined,
```

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run src/cli/primitives/__tests__/HarnessPrimitive.test.ts`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/cli/primitives/HarnessPrimitive.ts src/cli/commands/add/types.ts src/cli/commands/add/validate.ts
git commit -m "feat(harness): add Custom JWT CLI flags and validation"
```

---

### Task 4: Add auth to harness TUI types and advanced settings

**Files:**
- Modify: `src/cli/tui/screens/harness/types.ts:1-112`

- [ ] **Step 1: Add auth entries to types**

In `src/cli/tui/screens/harness/types.ts`:

Add import:
```typescript
import type { HarnessModelProvider, NetworkMode, RuntimeAuthorizerType } from '../../../../schema';
```

Replace the existing `HarnessModelProvider, NetworkMode` import with this combined one.

Add `'authorizerType' | 'jwtConfig'` to the `AddHarnessStep` union:
```typescript
export type AddHarnessStep =
  | 'name'
  | 'model-provider'
  | 'api-key-arn'
  | 'container'
  | 'container-uri'
  | 'container-dockerfile'
  | 'advanced'
  | 'memory'
  | 'authorizerType'
  | 'jwtConfig'
  | 'network-mode'
  | 'subnets'
  | 'security-groups'
  | 'idle-timeout'
  | 'max-lifetime'
  | 'max-iterations'
  | 'max-tokens'
  | 'timeout'
  | 'truncation-strategy'
  | 'confirm';
```

Add auth fields to `AddHarnessConfig`:
```typescript
export interface AddHarnessConfig {
  name: string;
  modelProvider: HarnessModelProvider;
  modelId: string;
  apiKeyArn?: string;
  skipMemory?: boolean;
  containerMode?: ContainerMode;
  containerUri?: string;
  dockerfilePath?: string;
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  truncationStrategy?: 'sliding_window' | 'summarization';
  networkMode?: NetworkMode;
  subnets?: string[];
  securityGroups?: string[];
  idleTimeout?: number;
  maxLifetime?: number;
  authorizerType?: RuntimeAuthorizerType;
  jwtConfig?: {
    discoveryUrl: string;
    allowedAudience?: string[];
    allowedClients?: string[];
    allowedScopes?: string[];
    customClaims?: import('../../../../schema').CustomClaimValidation[];
    clientId?: string;
    clientSecret?: string;
  };
}
```

Add step labels for the new steps in `HARNESS_STEP_LABELS`:
```typescript
  authorizerType: 'Auth',
  jwtConfig: 'JWT Config',
```

Add `'auth'` to `ADVANCED_SETTING_OPTIONS`:
```typescript
export const ADVANCED_SETTING_OPTIONS = [
  { id: 'memory', title: 'Memory', description: 'Enable or disable persistent memory' },
  { id: 'auth', title: 'Auth', description: 'Inbound authorization configuration' },
  { id: 'network', title: 'Network', description: 'VPC configuration' },
  { id: 'lifecycle', title: 'Lifecycle', description: 'Idle timeout and max lifetime' },
  { id: 'execution', title: 'Execution limits', description: 'Iterations, tokens, timeout' },
  { id: 'truncation', title: 'Truncation', description: 'Context management strategy' },
] as const;
```

The `AdvancedSetting` type is derived from this array so `'auth'` is automatically included.

- [ ] **Step 2: Add authorizer type options constant**

Add at the bottom of types.ts:

```typescript
export const AUTHORIZER_TYPE_OPTIONS = [
  { id: 'AWS_IAM' as const, title: 'AWS IAM (SigV4)', description: 'Default — authenticate with IAM credentials' },
  { id: 'CUSTOM_JWT' as const, title: 'Custom JWT', description: 'Authenticate with a bearer token (OIDC)' },
] as const;
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/screens/harness/types.ts
git commit -m "feat(harness): add auth step types and advanced setting entry"
```

---

### Task 5: Wire auth into the harness wizard hook

**Files:**
- Modify: `src/cli/tui/screens/harness/useAddHarnessWizard.ts:1-306`

- [ ] **Step 1: Update ADVANCED_SETTING_ORDER and SETTING_TO_FIRST_STEP**

```typescript
const ADVANCED_SETTING_ORDER: AdvancedSetting[] = ['memory', 'auth', 'network', 'lifecycle', 'execution', 'truncation'];

const SETTING_TO_FIRST_STEP: Record<AdvancedSetting, AddHarnessStep> = {
  memory: 'memory',
  auth: 'authorizerType',
  network: 'network-mode',
  lifecycle: 'idle-timeout',
  execution: 'max-iterations',
  truncation: 'truncation-strategy',
};
```

- [ ] **Step 2: Add auth steps to allSteps computation**

In the `allSteps` useMemo, add after the `memory` block and before the `network` block:

```typescript
    if (advancedSettings.includes('auth')) {
      steps.push('authorizerType');
      if (config.authorizerType === 'CUSTOM_JWT') {
        steps.push('jwtConfig');
      }
    }
```

Update the useMemo dependency array to include `config.authorizerType`:
```typescript
  }, [config.modelProvider, config.containerMode, config.networkMode, config.authorizerType, advancedSettings]);
```

- [ ] **Step 3: Add auth setter callbacks**

Import `RuntimeAuthorizerType` at the top:
```typescript
import type { HarnessModelProvider, NetworkMode, RuntimeAuthorizerType } from '../../../../schema';
```

Add import for JwtConfig:
```typescript
import type { JwtConfig } from '../../components/jwt-config/useJwtConfigFlow';
```

Add these callbacks inside `useAddHarnessWizard()`, after `setMemoryEnabled`:

```typescript
  const setAuthorizerType = useCallback(
    (authorizerType: RuntimeAuthorizerType) => {
      setConfig(c => ({ ...c, authorizerType, jwtConfig: undefined }));
      if (authorizerType === 'CUSTOM_JWT') {
        setStep('jwtConfig');
      } else {
        const next = getNextAdvancedStep(advancedSettings, 'auth');
        setStep(next ?? 'confirm');
      }
    },
    [advancedSettings]
  );

  const setJwtConfig = useCallback(
    (jwtConfig: JwtConfig) => {
      setConfig(c => ({ ...c, jwtConfig }));
      const next = getNextAdvancedStep(advancedSettings, 'auth');
      setStep(next ?? 'confirm');
    },
    [advancedSettings]
  );
```

- [ ] **Step 4: Add to return object**

Add `setAuthorizerType` and `setJwtConfig` to the return object:

```typescript
  return {
    config,
    step,
    steps: allSteps,
    currentIndex,
    advancedSettings,
    goBack,
    setName,
    setModelProvider,
    setApiKeyArn,
    setContainerMode,
    setContainerUri,
    setDockerfilePath,
    setAdvancedSettings,
    setMemoryEnabled,
    setAuthorizerType,
    setJwtConfig,
    setNetworkMode,
    setSubnets,
    setSecurityGroups,
    setIdleTimeout,
    setMaxLifetime,
    setMaxIterations,
    setMaxTokens,
    setTimeoutSeconds,
    setTruncationStrategy,
    reset,
  };
```

- [ ] **Step 5: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/screens/harness/useAddHarnessWizard.ts
git commit -m "feat(harness): wire auth steps into harness wizard flow"
```

---

### Task 6: Render auth UI in AddHarnessScreen

**Files:**
- Modify: `src/cli/tui/screens/harness/AddHarnessScreen.tsx:1-422`

- [ ] **Step 1: Add imports**

Add to the imports section:

```typescript
import type { RuntimeAuthorizerType } from '../../../../schema';
import { JwtConfigInput, useJwtConfigFlow } from '../../components/jwt-config';
import { AUTHORIZER_TYPE_OPTIONS } from './types';
```

- [ ] **Step 2: Add JWT config flow hook**

After the `const wizard = useAddHarnessWizard();` line, add:

```typescript
  const jwtFlow = useJwtConfigFlow({
    onComplete: jwtConfig => wizard.setJwtConfig(jwtConfig),
    onBack: () => wizard.goBack(),
  });
```

- [ ] **Step 3: Add authorizer type items and navigation**

After the existing `useMemo` blocks for items, add:

```typescript
  const authorizerTypeItems: SelectableItem[] = useMemo(
    () => AUTHORIZER_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );
```

Add step boolean flags (alongside the existing ones):

```typescript
  const isAuthorizerTypeStep = wizard.step === 'authorizerType';
  const isJwtConfigStep = wizard.step === 'jwtConfig';
```

Add navigation hook (after the existing `useListNavigation` blocks):

```typescript
  const authorizerTypeNav = useListNavigation({
    items: authorizerTypeItems,
    onSelect: item => wizard.setAuthorizerType(item.id as RuntimeAuthorizerType),
    onExit: () => wizard.goBack(),
    isActive: isAuthorizerTypeStep,
  });
```

- [ ] **Step 4: Update helpText computation**

Update the helpText logic to include the new steps. Add `isAuthorizerTypeStep` to the navigate-select branch, and add a jwt-config branch:

```typescript
  const helpText = isAdvancedStep
    ? 'Space toggle · Enter confirm · Esc back'
    : isJwtConfigStep
      ? jwtFlow.subStep === 'constraintPicker'
        ? HELP_TEXT.MULTI_SELECT
        : jwtFlow.subStep === 'customClaims'
          ? jwtFlow.claimsManagerMode === 'add' || jwtFlow.claimsManagerMode === 'edit'
            ? '↑/↓ field · ←/→ cycle · Enter next/save · Esc cancel'
            : 'Navigate · Enter select · Esc back'
          : HELP_TEXT.TEXT_INPUT
      : isModelProviderStep || isMemoryStep || isContainerStep || isNetworkModeStep || isTruncationStrategyStep || isAuthorizerTypeStep
        ? HELP_TEXT.NAVIGATE_SELECT
        : isConfirmStep
          ? HELP_TEXT.CONFIRM_CANCEL
          : HELP_TEXT.TEXT_INPUT;
```

- [ ] **Step 5: Add auth rendering in the Panel**

Add after the `{isMemoryStep && ...}` block and before the `{isNetworkModeStep && ...}` block:

```tsx
        {isAuthorizerTypeStep && (
          <WizardSelect
            title="Select authorizer type"
            description="How will clients authenticate to this harness?"
            items={authorizerTypeItems}
            selectedIndex={authorizerTypeNav.selectedIndex}
          />
        )}

        {isJwtConfigStep && (
          <JwtConfigInput
            subStep={jwtFlow.subStep}
            steps={jwtFlow.steps}
            selectedConstraints={jwtFlow.selectedConstraints}
            customClaims={jwtFlow.customClaims}
            discoveryUrl={jwtFlow.discoveryUrl}
            audience={jwtFlow.audience}
            clients={jwtFlow.clients}
            scopes={jwtFlow.scopes}
            onDiscoveryUrl={jwtFlow.handlers.handleDiscoveryUrl}
            onConstraintsPicked={jwtFlow.handlers.handleConstraintsPicked}
            onAudience={jwtFlow.handlers.handleAudience}
            onClients={jwtFlow.handlers.handleClients}
            onScopes={jwtFlow.handlers.handleScopes}
            onCustomClaimsDone={jwtFlow.handlers.handleCustomClaimsDone}
            onClientId={jwtFlow.handlers.handleClientId}
            onClientIdSkip={jwtFlow.handlers.handleClientIdSkip}
            onClientSecret={jwtFlow.handlers.handleClientSecret}
            onBack={jwtFlow.goBack}
            onClaimsManagerModeChange={jwtFlow.handlers.handleClaimsManagerModeChange}
          />
        )}
```

- [ ] **Step 6: Add auth to confirm screen fields**

In the `confirmFields` useMemo, add after the `dockerfilePath` block:

```typescript
    if (wizard.config.authorizerType) {
      const authLabel = AUTHORIZER_TYPE_OPTIONS.find(o => o.id === wizard.config.authorizerType)?.title ?? wizard.config.authorizerType;
      fields.push({ label: 'Auth', value: authLabel });
    }

    if (wizard.config.authorizerType === 'CUSTOM_JWT' && wizard.config.jwtConfig) {
      fields.push({ label: 'Discovery URL', value: wizard.config.jwtConfig.discoveryUrl });
      if (wizard.config.jwtConfig.allowedAudience?.length) {
        fields.push({ label: 'Allowed Audience', value: wizard.config.jwtConfig.allowedAudience.join(', ') });
      }
      if (wizard.config.jwtConfig.allowedClients?.length) {
        fields.push({ label: 'Allowed Clients', value: wizard.config.jwtConfig.allowedClients.join(', ') });
      }
      if (wizard.config.jwtConfig.allowedScopes?.length) {
        fields.push({ label: 'Allowed Scopes', value: wizard.config.jwtConfig.allowedScopes.join(', ') });
      }
      if (wizard.config.jwtConfig.customClaims?.length) {
        fields.push({ label: 'Custom Claims', value: `${wizard.config.jwtConfig.customClaims.length} claim(s) configured` });
      }
      if (wizard.config.jwtConfig.clientId) {
        fields.push({ label: 'OAuth Client ID', value: wizard.config.jwtConfig.clientId });
      }
    }
```

- [ ] **Step 7: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/tui/screens/harness/AddHarnessScreen.tsx
git commit -m "feat(harness): render auth UI in AddHarnessScreen"
```

---

### Task 7: Wire auth through harness deploy layer (mapper + deployer)

**Files:**
- Modify: `src/cli/operations/deploy/imperative/deployers/harness-mapper.ts:42-120`
- Modify: `src/cli/operations/deploy/imperative/deployers/harness-deployer.ts:108-143`

- [ ] **Step 1: Write the failing test**

Add to `src/cli/operations/deploy/imperative/deployers/__tests__/harness-mapper.test.ts`:

```typescript
// Add a test for auth configuration mapping:
  it('maps authorizerConfiguration from harness spec', async () => {
    const spec = {
      ...baseHarnessSpec,
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: 'https://example.com/.well-known/openid-configuration',
          allowedAudience: ['aud1'],
        },
      },
    };

    const result = await mapHarnessSpecToCreateOptions({
      harnessSpec: spec as any,
      harnessDir: '/tmp/test',
      executionRoleArn: 'arn:aws:iam::123456789012:role/test',
      region: 'us-east-1',
    });

    expect(result.authorizerConfiguration).toEqual({
      customJWTAuthorizer: {
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        allowedAudience: ['aud1'],
      },
    });
  });
```

Note: The API wire format uses `customJWTAuthorizer` (capital JWT) while the schema uses `customJwtAuthorizer` (camelCase). The mapper needs to transform the casing. Check the Smithy model field name — it's `customJWTAuthorizer`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/operations/deploy/imperative/deployers/__tests__/harness-mapper.test.ts`
Expected: FAIL — `authorizerConfiguration` is not included in the result.

- [ ] **Step 3: Add auth mapping to harness-mapper**

In `src/cli/operations/deploy/imperative/deployers/harness-mapper.ts`, in the `mapHarnessSpecToCreateOptions` function, add after the tags block (around line 117):

```typescript
  // Authorizer configuration
  if (harnessSpec.authorizerConfiguration?.customJwtAuthorizer) {
    const jwt = harnessSpec.authorizerConfiguration.customJwtAuthorizer;
    result.authorizerConfiguration = {
      customJWTAuthorizer: {
        discoveryUrl: jwt.discoveryUrl,
        ...(jwt.allowedAudience && { allowedAudience: jwt.allowedAudience }),
        ...(jwt.allowedClients && { allowedClients: jwt.allowedClients }),
        ...(jwt.allowedScopes && { allowedScopes: jwt.allowedScopes }),
        ...(jwt.customClaims && { customClaims: jwt.customClaims }),
      },
    };
  }
```

- [ ] **Step 4: Add auth to deployer update path**

In `src/cli/operations/deploy/imperative/deployers/harness-deployer.ts`, in the update path (around line 123-143), add `authorizerConfiguration` to the `updateOptions`:

```typescript
            authorizerConfiguration: createOptions.authorizerConfiguration
              ? { optionalValue: createOptions.authorizerConfiguration }
              : { optionalValue: null },
```

This uses the `{ optionalValue: null }` pattern to clear auth when it's removed from the spec, matching the `memory` pattern.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/cli/operations/deploy/imperative/deployers/__tests__/harness-mapper.test.ts`
Expected: PASS.

Run: `npx vitest run src/cli/operations/deploy/imperative/deployers/__tests__/harness-deployer.test.ts`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/cli/operations/deploy/imperative/deployers/harness-mapper.ts src/cli/operations/deploy/imperative/deployers/harness-deployer.ts src/cli/operations/deploy/imperative/deployers/__tests__/harness-mapper.test.ts
git commit -m "feat(harness): wire authorizerConfiguration through deploy layer"
```

---

### Task 8: Wire TUI onComplete to primitive (connect AddHarnessConfig to AddHarnessOptions)

**Files:**
- Modify: `src/cli/tui/screens/harness/AddHarnessFlow.tsx:45-71`
- Modify: `src/cli/tui/screens/create/useCreateFlow.ts:493-509`

There are two places where `AddHarnessConfig` is mapped to `harnessPrimitive.add()`:
1. `AddHarnessFlow.tsx:49-71` — the `agentcore add harness` TUI flow
2. `useCreateFlow.ts:493-509` — the `agentcore create` flow when creating a project with a harness

Both explicitly pass through every config field.

- [ ] **Step 1: Add auth fields to AddHarnessFlow.tsx**

In `src/cli/tui/screens/harness/AddHarnessFlow.tsx`, inside the `handleCreateComplete` callback, add these fields to the `harnessPrimitive.add()` call (after the `maxLifetime` line, around line 65):

```typescript
        authorizerType: config.authorizerType,
        jwtConfig: config.jwtConfig,
```

- [ ] **Step 2: Add auth fields to useCreateFlow.ts**

In `src/cli/tui/screens/create/useCreateFlow.ts`, inside the harness creation block (around line 509, after `maxLifetime: addHarnessConfig.maxLifetime,`), add:

```typescript
                authorizerType: addHarnessConfig.authorizerType,
                jwtConfig: addHarnessConfig.jwtConfig,
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/screens/harness/AddHarnessFlow.tsx src/cli/tui/screens/create/useCreateFlow.ts
git commit -m "feat(harness): connect TUI auth config to HarnessPrimitive"
```

---

### Task 9: Run full test suite and verify

- [ ] **Step 1: Run all harness-related tests**

```bash
npx vitest run --reporter=verbose src/schema/schemas/primitives/__tests__/harness-auth.test.ts src/cli/primitives/__tests__/HarnessPrimitive.test.ts src/cli/operations/deploy/imperative/deployers/__tests__/harness-mapper.test.ts src/cli/operations/deploy/imperative/deployers/__tests__/harness-deployer.test.ts
```

Expected: All PASS.

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Run linter**

```bash
npx eslint src/schema/schemas/primitives/harness.ts src/cli/primitives/HarnessPrimitive.ts src/cli/tui/screens/harness/ src/cli/operations/deploy/imperative/deployers/harness-mapper.ts src/cli/operations/deploy/imperative/deployers/harness-deployer.ts
```

Expected: PASS.

- [ ] **Step 4: Run the full unit test suite**

```bash
npm test
```

Expected: PASS (no regressions).

- [ ] **Step 5: Commit any fixes if needed**

```bash
git add -A
git commit -m "fix: address test/lint issues from harness auth implementation"
```
