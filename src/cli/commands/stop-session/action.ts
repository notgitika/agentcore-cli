import { ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../schema';
import { stopRuntimeSession as stopSession } from '../../aws';
import { clearSessionId } from '../../operations/session';

export interface StopSessionContext {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
}

/**
 * Loads configuration required for stop-session
 */
export async function loadStopSessionConfig(configIO: ConfigIO = new ConfigIO()): Promise<StopSessionContext> {
  return {
    project: await configIO.readProjectSpec(),
    deployedState: await configIO.readDeployedState(),
    awsTargets: await configIO.readAWSDeploymentTargets(),
  };
}

export interface StopSessionOptions {
  agentName?: string;
  targetName?: string;
  sessionId?: string;
}

export interface StopSessionResult {
  success: boolean;
  agentName?: string;
  targetName?: string;
  sessionId?: string;
  statusCode?: number;
  error?: string;
}

/**
 * Stop a runtime session for an agent
 */
export async function handleStopSession(
  context: StopSessionContext,
  options: StopSessionOptions = {}
): Promise<StopSessionResult> {
  const { project, deployedState, awsTargets } = context;

  // Resolve target
  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return { success: false, error: 'No deployed targets found. Run `agentcore deploy` first.' };
  }

  const selectedTargetName = options.targetName ?? targetNames[0]!;

  if (options.targetName && !targetNames.includes(options.targetName)) {
    return { success: false, error: `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}` };
  }

  const targetState = deployedState.targets[selectedTargetName];
  const targetConfig = awsTargets.find(t => t.name === selectedTargetName);

  if (!targetConfig) {
    return { success: false, error: `Target config '${selectedTargetName}' not found in aws-targets` };
  }

  if (project.agents.length === 0) {
    return { success: false, error: 'No agents defined in configuration' };
  }

  // Resolve agent
  const agentNames = project.agents.map(a => a.name);
  const agentSpec = options.agentName ? project.agents.find(a => a.name === options.agentName) : project.agents[0];

  if (options.agentName && !agentSpec) {
    return { success: false, error: `Agent '${options.agentName}' not found. Available: ${agentNames.join(', ')}` };
  }

  if (!agentSpec) {
    return { success: false, error: 'No agents defined in configuration' };
  }

  // Get the deployed state for this specific agent
  const agentState = targetState?.resources?.agents?.[agentSpec.name];

  if (!agentState) {
    return { success: false, error: `Agent '${agentSpec.name}' is not deployed to target '${selectedTargetName}'` };
  }

  // Determine which session ID to stop
  const sessionIdToStop = options.sessionId ?? agentState.sessionId;

  if (!sessionIdToStop) {
    return {
      success: false,
      error:
        'No session ID provided and no active session found. Use --session-id to specify a session, or invoke the agent first to create a session.',
    };
  }

  try {
    // Stop the runtime session
    const result = await stopSession({
      region: targetConfig.region,
      runtimeArn: agentState.runtimeArn,
      sessionId: sessionIdToStop,
    });

    // Clear the session ID from deployed state if it matches
    if (agentState.sessionId === sessionIdToStop) {
      await clearSessionId(agentSpec.name, selectedTargetName);
    }

    return {
      success: true,
      agentName: agentSpec.name,
      targetName: selectedTargetName,
      sessionId: result.sessionId ?? sessionIdToStop,
      statusCode: result.statusCode,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Check for ResourceNotFoundException - session may have already been stopped
    if (errorMessage.includes('ResourceNotFoundException') || errorMessage.includes('not found')) {
      // Still clear the session from deployed state
      if (agentState.sessionId === sessionIdToStop) {
        await clearSessionId(agentSpec.name, selectedTargetName);
      }

      return {
        success: true,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        sessionId: sessionIdToStop,
        statusCode: 404,
        error: 'Session not found (may have already been stopped or expired)',
      };
    }

    return {
      success: false,
      agentName: agentSpec.name,
      targetName: selectedTargetName,
      sessionId: sessionIdToStop,
      error: `Failed to stop session: ${errorMessage}`,
    };
  }
}
