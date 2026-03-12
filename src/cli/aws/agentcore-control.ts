import { getCredentialProvider } from './account';
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  UpdateOnlineEvaluationConfigCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

export interface GetAgentRuntimeStatusOptions {
  region: string;
  runtimeId: string;
}

export interface AgentRuntimeStatusResult {
  runtimeId: string;
  status: string;
}

/**
 * Fetch the status of an AgentCore Runtime by runtime ID.
 */
export async function getAgentRuntimeStatus(options: GetAgentRuntimeStatusOptions): Promise<AgentRuntimeStatusResult> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new GetAgentRuntimeCommand({
    agentRuntimeId: options.runtimeId,
  });

  const response = await client.send(command);

  if (!response.status) {
    throw new Error(`No status returned for runtime ${options.runtimeId}`);
  }

  return {
    runtimeId: options.runtimeId,
    status: response.status,
  };
}

// ============================================================================
// Online Eval Config
// ============================================================================

export type OnlineEvalExecutionStatus = 'ENABLED' | 'DISABLED';

export interface UpdateOnlineEvalStatusOptions {
  region: string;
  onlineEvaluationConfigId: string;
  executionStatus: OnlineEvalExecutionStatus;
}

export interface UpdateOnlineEvalStatusResult {
  configId: string;
  executionStatus: string;
  status: string;
}

/**
 * Update the execution status of an online evaluation config (pause/resume).
 */
export async function updateOnlineEvalExecutionStatus(
  options: UpdateOnlineEvalStatusOptions
): Promise<UpdateOnlineEvalStatusResult> {
  const client = new BedrockAgentCoreControlClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new UpdateOnlineEvaluationConfigCommand({
    onlineEvaluationConfigId: options.onlineEvaluationConfigId,
    executionStatus: options.executionStatus,
  });

  const response = await client.send(command);

  return {
    configId: response.onlineEvaluationConfigId ?? options.onlineEvaluationConfigId,
    executionStatus: response.executionStatus ?? options.executionStatus,
    status: response.status ?? 'UNKNOWN',
  };
}
