import { parseTimeString } from '../../../lib/utils';
import { searchLogs, streamLogs } from '../../aws/cloudwatch';
import { loadDeployedProjectConfig, resolveAgent } from '../resolve-agent';

export interface LogsEvalOptions {
  agent?: string;
  since?: string;
  until?: string;
  lines?: string;
  json?: boolean;
  follow?: boolean;
}

export interface LogsEvalResult {
  success: boolean;
  error?: string;
}

function formatLogLine(event: { timestamp: number; message: string }, json: boolean): string {
  if (json) {
    return JSON.stringify({ timestamp: new Date(event.timestamp).toISOString(), message: event.message });
  }
  const ts = new Date(event.timestamp).toISOString();
  return `${ts}  ${event.message}`;
}

/**
 * Resolve the online eval config log group names for a given agent.
 * Online eval results are written to: /aws/bedrock-agentcore/evaluations/results/{onlineEvalConfigId}
 */
function resolveEvalLogGroups(
  context: ReturnType<typeof loadDeployedProjectConfig> extends Promise<infer T> ? T : never,
  agentName: string,
  targetName: string
): string[] {
  const { project, deployedState } = context;
  const targetResources = deployedState.targets[targetName]?.resources;

  // Find online eval configs that monitor this agent
  const matchingConfigs = (project.onlineEvalConfigs ?? []).filter(c => c.agents.includes(agentName));

  const logGroups: string[] = [];
  for (const config of matchingConfigs) {
    const deployed = targetResources?.onlineEvalConfigs?.[config.name];
    if (deployed?.onlineEvaluationConfigId) {
      logGroups.push(`/aws/bedrock-agentcore/evaluations/results/${deployed.onlineEvaluationConfigId}`);
    }
  }

  return logGroups;
}

export async function handleLogsEval(options: LogsEvalOptions): Promise<LogsEvalResult> {
  const context = await loadDeployedProjectConfig();
  const agentResult = resolveAgent(context, { agent: options.agent });

  if (!agentResult.success) {
    return { success: false, error: agentResult.error };
  }

  const { agent } = agentResult;

  const logGroups = resolveEvalLogGroups(context, agent.agentName, agent.targetName);

  if (logGroups.length === 0) {
    return {
      success: false,
      error: `No deployed online eval configs found for agent '${agent.agentName}'. Add one with 'agentcore add online-eval' and deploy.`,
    };
  }

  const isJson = options.json ?? false;
  const isFollow = options.follow ?? (!options.since && !options.until);

  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);

  try {
    // Query all matching log groups
    for (const logGroupName of logGroups) {
      if (!isFollow) {
        const startTimeMs = options.since ? parseTimeString(options.since) : Date.now() - 3_600_000;
        const endTimeMs = options.until ? parseTimeString(options.until) : Date.now();
        const limit = options.lines ? parseInt(options.lines, 10) : undefined;

        try {
          for await (const event of searchLogs({
            logGroupName,
            region: agent.region,
            startTimeMs,
            endTimeMs,
            limit,
          })) {
            console.log(formatLogLine(event, isJson));
          }
        } catch (err: unknown) {
          const errorName = (err as { name?: string })?.name;
          if (errorName === 'ResourceNotFoundException') {
            // Log group exists in config but not yet in CloudWatch — skip
            continue;
          }
          throw err;
        }
      } else {
        console.error(`Streaming eval logs for ${agent.agentName} from ${logGroupName}... (Ctrl+C to stop)`);

        try {
          for await (const event of streamLogs({
            logGroupName,
            region: agent.region,
            accountId: agent.accountId,
            abortSignal: ac.signal,
          })) {
            console.log(formatLogLine(event, isJson));
          }
        } catch (err: unknown) {
          const errorName = (err as { name?: string })?.name;
          if (errorName === 'ResourceNotFoundException') {
            console.error(`Log group ${logGroupName} not found yet — waiting for online eval results...`);
            continue;
          }
          throw err;
        }
      }
    }

    return { success: true };
  } catch (err: unknown) {
    const errorName = (err as { name?: string })?.name;

    if (errorName === 'AbortError' || ac.signal.aborted) {
      return { success: true };
    }

    throw err;
  } finally {
    process.removeListener('SIGINT', onSignal);
  }
}
