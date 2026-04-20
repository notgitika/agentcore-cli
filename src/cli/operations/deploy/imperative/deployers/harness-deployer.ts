/**
 * HarnessDeployer - Post-CDK imperative deployer for Harness resources.
 *
 * Runs after CDK deploy to create, update, or delete harness resources
 * via the SigV4 API client. Harness role ARNs are resolved from CDK
 * stack outputs, and harness specs are read from disk (harness.json).
 */
import type { HarnessDeployedState, HarnessSpec } from '../../../../../schema';
import { HarnessSpecSchema } from '../../../../../schema';
import type { CreateHarnessResult, UpdateHarnessOptions, UpdateHarnessResult } from '../../../../aws/agentcore-harness';
import { createHarness, deleteHarness, updateHarness } from '../../../../aws/agentcore-harness';
import { toPascalId } from '../../../../cloudformation/logical-ids';
import type { DeployPhase, ImperativeDeployContext, ImperativeDeployResult, ImperativeDeployer } from '../types';
import { mapHarnessSpecToCreateOptions } from './harness-mapper';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';

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
          resultState[entry.name] = {
            harnessId: updateResult.harness.harnessId,
            harnessArn: updateResult.harness.arn,
            roleArn: executionRoleArn,
            status: updateResult.harness.status,
            memoryArn: createOptions.memory?.memoryArn,
          };
          notes.push(`Updated harness "${entry.name}"`);
        } else {
          // Create new harness
          const createOptions = await mapHarnessSpecToCreateOptions({
            harnessSpec,
            harnessDir,
            executionRoleArn,
            region,
            deployedResources,
            cdkOutputs,
          });

          const createResult: CreateHarnessResult = await createHarness(createOptions);
          resultState[entry.name] = {
            harnessId: createResult.harness.harnessId,
            harnessArn: createResult.harness.arn,
            roleArn: executionRoleArn,
            status: createResult.harness.status,
            memoryArn: createOptions.memory?.memoryArn,
          };
          notes.push(`Created harness "${entry.name}"`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Failed to deploy harness "${entry.name}": ${message}` };
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
