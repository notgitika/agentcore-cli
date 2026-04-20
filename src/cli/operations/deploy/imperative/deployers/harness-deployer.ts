/**
 * HarnessDeployer - Post-CDK imperative deployer for Harness resources.
 *
 * Runs after CDK deploy to create, update, or delete harness resources
 * via the SigV4 API client. Harness role ARNs are resolved from CDK
 * stack outputs, and harness specs are read from disk (harness.json).
 */
import type { HarnessDeployedState, HarnessSpec } from '../../../../../schema';
import { HarnessSpecSchema } from '../../../../../schema';
import type { CreateHarnessResult, Harness, UpdateHarnessOptions, UpdateHarnessResult } from '../../../../aws/agentcore-harness';
import { createHarness, deleteHarness, getHarness, updateHarness } from '../../../../aws/agentcore-harness';
import type { HarnessStatus } from '../../../../aws/agentcore-harness';
import { AgentCoreApiError } from '../../../../aws/api-client';
import { toPascalId } from '../../../../cloudformation/logical-ids';
import type { DeployPhase, ImperativeDeployContext, ImperativeDeployResult, ImperativeDeployer } from '../types';
import { mapHarnessSpecToCreateOptions } from './harness-mapper';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';

const ROLE_VALIDATION_RETRY_DELAYS_MS = [5_000, 10_000, 15_000, 20_000, 30_000];
const READY_POLL_INTERVAL_MS = 3_000;
const READY_POLL_MAX_ATTEMPTS = 40; // 2 minutes max

// ============================================================================
// Types
// ============================================================================

type HarnessDeployedStateMap = Record<string, HarnessDeployedState>;

// ============================================================================
// Deployer
// ============================================================================

export class HarnessDeployer implements ImperativeDeployer<HarnessDeployedStateMap> {
  readonly name = 'harness';
  readonly label = 'Harnesses';
  readonly phase: DeployPhase = 'post-cdk';

  shouldRun(context: ImperativeDeployContext): boolean {
    const projectHarnesses = context.projectSpec.harnesses;
    const hasProjectHarnesses = !!projectHarnesses && projectHarnesses.length > 0;

    const targetName = context.target.name;
    const deployedHarnesses = context.deployedState.targets?.[targetName]?.resources?.harnesses;
    const hasDeployedHarnesses = !!deployedHarnesses && Object.keys(deployedHarnesses).length > 0;

    return hasProjectHarnesses || hasDeployedHarnesses;
  }

  async deploy(context: ImperativeDeployContext): Promise<ImperativeDeployResult<HarnessDeployedStateMap>> {
    const { projectSpec, target, configIO, deployedState, cdkOutputs } = context;
    const region = target.region;
    const targetName = target.name;
    const configRoot = configIO.getConfigRoot();
    const projectRoot = dirname(configRoot);

    const projectHarnesses = projectSpec.harnesses ?? [];
    const deployedHarnesses = deployedState.targets?.[targetName]?.resources?.harnesses ?? {};
    const resultState: HarnessDeployedStateMap = {};
    const notes: string[] = [];

    // Build set of harness names in current project spec
    const projectHarnessNames = new Set(projectHarnesses.map(h => h.name));

    // Create or update each harness in the project spec
    for (const entry of projectHarnesses) {
      // Harness path is relative to project root (like agent codeLocation)
      const harnessDir = join(projectRoot, entry.path);

      // Read harness.json from disk and validate
      let harnessSpec: HarnessSpec;
      try {
        const raw = await readFile(join(harnessDir, 'harness.json'), 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        const validated = HarnessSpecSchema.safeParse(parsed);
        if (!validated.success) {
          return {
            success: false,
            error: `Invalid harness.json for "${entry.name}": ${validated.error.message}`,
          };
        }
        harnessSpec = validated.data;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to read harness.json for "${entry.name}": ${message}` };
      }

      // Resolve role ARN from CDK outputs
      const roleArn = resolveRoleArn(entry.name, cdkOutputs);
      if (!roleArn) {
        return {
          success: false,
          error: `Could not find role ARN in CDK outputs for harness "${entry.name}". Expected output key starting with "ApplicationHarness${toPascalId(entry.name)}RoleArn".`,
        };
      }

      // Use executionRoleArn from harness spec if provided, otherwise use CDK output
      const executionRoleArn = harnessSpec.executionRoleArn ?? roleArn;

      const deployedResources = deployedState.targets?.[targetName]?.resources;
      const existingHarness = deployedHarnesses[entry.name];

      try {
        if (existingHarness) {
          // Update existing harness
          const createOptions = await mapHarnessSpecToCreateOptions({
            harnessSpec,
            harnessDir,
            executionRoleArn,
            region,
            deployedResources,
            cdkOutputs,
          });

          // Memory uses { optionalValue: null } to explicitly clear it when removed from config,
          // since the API treats an absent field as "no change" but null as "remove".
          // environmentArtifact uses undefined (omit) because container config is immutable
          // after creation — it cannot be cleared via update, only set on create.
          const updateOptions: UpdateHarnessOptions = {
            region,
            harnessId: existingHarness.harnessId,
            executionRoleArn: createOptions.executionRoleArn,
            model: createOptions.model,
            systemPrompt: createOptions.systemPrompt,
            tools: createOptions.tools,
            skills: createOptions.skills,
            allowedTools: createOptions.allowedTools,
            memory: createOptions.memory ? { optionalValue: createOptions.memory } : { optionalValue: null },
            truncation: createOptions.truncation,
            maxIterations: createOptions.maxIterations,
            maxTokens: createOptions.maxTokens,
            timeoutSeconds: createOptions.timeoutSeconds,
            environment: createOptions.environment,
            environmentArtifact: createOptions.environmentArtifact
              ? { optionalValue: createOptions.environmentArtifact }
              : undefined,
            environmentVariables: createOptions.environmentVariables,
            tags: createOptions.tags,
          };

          const updateResult: UpdateHarnessResult = await updateHarness(updateOptions);
          const finalHarness = await waitForReady(region, updateResult.harness);
          resultState[entry.name] = {
            harnessId: finalHarness.harnessId,
            harnessArn: finalHarness.arn,
            roleArn: executionRoleArn,
            status: finalHarness.status,
            agentRuntimeArn: extractRuntimeArn(finalHarness),
            memoryArn: createOptions.memory?.memoryArn,
          };
          notes.push(`Updated harness "${entry.name}"`);
        } else {
          // Create new harness (with retry for IAM role propagation delay)
          const createOptions = await mapHarnessSpecToCreateOptions({
            harnessSpec,
            harnessDir,
            executionRoleArn,
            region,
            deployedResources,
            cdkOutputs,
          });

          const createResult: CreateHarnessResult = await createWithRetry(createOptions);
          const finalHarness = await waitForReady(region, createResult.harness);
          resultState[entry.name] = {
            harnessId: finalHarness.harnessId,
            harnessArn: finalHarness.arn,
            roleArn: executionRoleArn,
            status: finalHarness.status,
            agentRuntimeArn: extractRuntimeArn(finalHarness),
            memoryArn: createOptions.memory?.memoryArn,
          };
          notes.push(`Created harness "${entry.name}"`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to deploy harness "${entry.name}": ${message}`, state: resultState };
      }
    }

    // Delete harnesses that exist in deployed state but not in project spec
    for (const [name, state] of Object.entries(deployedHarnesses)) {
      if (!projectHarnessNames.has(name)) {
        try {
          await deleteHarness({ region, harnessId: state.harnessId });
          notes.push(`Deleted harness "${name}"`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Failed to delete harness "${name}": ${message}` };
        }
      }
    }

    return { success: true, state: resultState, notes };
  }

  async teardown(context: ImperativeDeployContext): Promise<ImperativeDeployResult<HarnessDeployedStateMap>> {
    const { target, deployedState } = context;
    const region = target.region;
    const targetName = target.name;

    const deployedHarnesses = deployedState.targets?.[targetName]?.resources?.harnesses ?? {};
    const notes: string[] = [];

    for (const [name, state] of Object.entries(deployedHarnesses)) {
      try {
        await deleteHarness({ region, harnessId: state.harnessId });
        notes.push(`Deleted harness "${name}"`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to delete harness "${name}": ${message}` };
      }
    }

    return { success: true, state: {}, notes };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the IAM role ARN for a harness from CDK stack outputs.
 *
 * The CDK construct exports the role ARN with a key matching the pattern:
 *   ApplicationHarness{PascalName}RoleArn...
 */
function resolveRoleArn(harnessName: string, cdkOutputs?: Record<string, string>): string | undefined {
  if (!cdkOutputs) return undefined;

  const pascalName = toPascalId(harnessName);
  const prefix = `ApplicationHarness${pascalName}RoleArn`;

  for (const [key, value] of Object.entries(cdkOutputs)) {
    if (key.startsWith(prefix)) {
      return value;
    }
  }

  return undefined;
}

function isRoleValidationError(err: unknown): boolean {
  return err instanceof AgentCoreApiError && err.statusCode === 400 && err.errorBody.includes('Role validation failed');
}

async function createWithRetry(options: Parameters<typeof createHarness>[0]): Promise<CreateHarnessResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= ROLE_VALIDATION_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await createHarness(options);
    } catch (err) {
      if (!isRoleValidationError(err) || attempt === ROLE_VALIDATION_RETRY_DELAYS_MS.length) {
        throw err;
      }
      lastError = err;
      await sleep(ROLE_VALIDATION_RETRY_DELAYS_MS[attempt]!);
    }
  }
  throw lastError;
}

async function waitForReady(region: string, harness: Harness): Promise<Harness> {
  if (harness.status === 'READY' || harness.status === 'FAILED') return harness;

  for (let i = 0; i < READY_POLL_MAX_ATTEMPTS; i++) {
    await sleep(READY_POLL_INTERVAL_MS);
    const result = await getHarness({ region, harnessId: harness.harnessId });
    if (result.harness.status === 'READY' || result.harness.status === 'FAILED') return result.harness;
  }

  return harness;
}

function extractRuntimeArn(harness: Harness): string | undefined {
  return harness.environment?.agentCoreRuntimeEnvironment?.agentRuntimeArn;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
