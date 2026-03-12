import type { OnlineEvalExecutionStatus } from '../../aws/agentcore-control';
import { updateOnlineEvalExecutionStatus } from '../../aws/agentcore-control';
import { loadDeployedProjectConfig } from '../resolve-agent';
import type { OnlineEvalActionOptions } from './types';

export interface PauseResumeResult {
  success: boolean;
  error?: string;
  configId?: string;
  executionStatus?: string;
}

async function resolveOnlineEvalConfig(
  configName: string
): Promise<{ success: true; configId: string; region: string } | { success: false; error: string }> {
  const context = await loadDeployedProjectConfig();
  const targetNames = Object.keys(context.deployedState.targets);

  if (targetNames.length === 0) {
    return { success: false, error: 'No deployed targets found. Run `agentcore deploy` first.' };
  }

  const targetName = targetNames[0]!;
  const targetResources = context.deployedState.targets[targetName]?.resources;
  const deployedConfig = targetResources?.onlineEvalConfigs?.[configName];

  if (!deployedConfig) {
    return {
      success: false,
      error: `Online eval config "${configName}" not found in deployed state. Has it been deployed?`,
    };
  }

  const targetConfig = context.awsTargets.find(t => t.name === targetName);
  if (!targetConfig) {
    return { success: false, error: `Target config "${targetName}" not found in aws-targets.` };
  }

  return {
    success: true,
    configId: deployedConfig.onlineEvaluationConfigId,
    region: targetConfig.region,
  };
}

export async function handlePauseResume(
  options: OnlineEvalActionOptions,
  action: 'pause' | 'resume'
): Promise<PauseResumeResult> {
  const resolution = await resolveOnlineEvalConfig(options.name);
  if (!resolution.success) {
    return resolution;
  }

  const executionStatus: OnlineEvalExecutionStatus = action === 'pause' ? 'DISABLED' : 'ENABLED';

  try {
    const result = await updateOnlineEvalExecutionStatus({
      region: resolution.region,
      onlineEvaluationConfigId: resolution.configId,
      executionStatus,
    });

    return {
      success: true,
      configId: result.configId,
      executionStatus: result.executionStatus,
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
