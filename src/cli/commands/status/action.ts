import { ConfigIO } from '../../../lib';
import type {
  AgentCoreMcpSpec,
  AgentCoreProjectSpec,
  AwsDeploymentTargets,
  DeployedResourceState,
  DeployedState,
} from '../../../schema';
import { getAgentRuntimeStatus } from '../../aws';
import { getErrorMessage } from '../../errors';
import type { ResourceDeploymentState } from './constants';

export type { ResourceDeploymentState };

export interface ResourceStatusEntry {
  resourceType: 'agent' | 'memory' | 'credential' | 'gateway';
  name: string;
  deploymentState: ResourceDeploymentState;
  identifier?: string;
  detail?: string;
  error?: string;
}

export interface ProjectStatusResult {
  success: boolean;
  projectName: string;
  targetName: string;
  targetRegion?: string;
  resources: ResourceStatusEntry[];
  error?: string;
}

export interface StatusContext {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
  mcpSpec?: AgentCoreMcpSpec;
}

export interface RuntimeLookupResult {
  success: boolean;
  targetName?: string;
  runtimeId?: string;
  runtimeStatus?: string;
  error?: string;
}

/**
 * Loads configuration required for status check.
 * Gracefully handles missing deployed-state by returning empty targets.
 */
export async function loadStatusConfig(configIO: ConfigIO = new ConfigIO()): Promise<StatusContext> {
  const [project, awsTargets, deployedState, mcpSpec] = await Promise.all([
    configIO.readProjectSpec(),
    configIO.readAWSDeploymentTargets(),
    configIO.configExists('state')
      ? configIO.readDeployedState()
      : (Promise.resolve({ targets: {} }) as Promise<DeployedState>),
    configIO.configExists('mcp') ? configIO.readMcpSpec() : Promise.resolve(undefined),
  ]);

  return { project, deployedState, awsTargets, mcpSpec };
}

/**
 * Diffs a set of local resources against deployed resources, producing status entries.
 * Shared logic for all resource types (agents, credentials, memories, gateways).
 */
function diffResourceSet<TLocal extends { name: string }, TDeployed>({
  resourceType,
  localItems,
  deployedRecord,
  getIdentifier,
  getLocalDetail,
}: {
  resourceType: ResourceStatusEntry['resourceType'];
  localItems: TLocal[];
  deployedRecord: Record<string, TDeployed>;
  getIdentifier: (deployed: TDeployed) => string | undefined;
  getLocalDetail?: (item: TLocal) => string | undefined;
}): ResourceStatusEntry[] {
  const entries: ResourceStatusEntry[] = [];
  const localNames = new Set(localItems.map(item => item.name));

  for (const item of localItems) {
    const deployed = deployedRecord[item.name];
    entries.push({
      resourceType,
      name: item.name,
      deploymentState: deployed ? 'deployed' : 'local-only',
      identifier: deployed ? getIdentifier(deployed) : undefined,
      detail: getLocalDetail?.(item),
    });
  }

  for (const [name, deployed] of Object.entries(deployedRecord)) {
    if (!localNames.has(name)) {
      entries.push({
        resourceType,
        name,
        deploymentState: 'pending-removal',
        identifier: getIdentifier(deployed),
      });
    }
  }

  return entries;
}

export function computeResourceStatuses(
  project: AgentCoreProjectSpec,
  resources: DeployedResourceState | undefined,
  mcpSpec?: AgentCoreMcpSpec
): ResourceStatusEntry[] {
  const agents = diffResourceSet({
    resourceType: 'agent',
    localItems: project.agents,
    deployedRecord: resources?.agents ?? {},
    getIdentifier: deployed => deployed.runtimeArn,
  });

  const credentials = diffResourceSet({
    resourceType: 'credential',
    localItems: project.credentials,
    deployedRecord: resources?.credentials ?? {},
    getIdentifier: deployed => deployed.credentialProviderArn,
    getLocalDetail: item => item.type?.replace('CredentialProvider', ''),
  });

  const memories = diffResourceSet({
    resourceType: 'memory',
    localItems: project.memories,
    deployedRecord: resources?.memories ?? {},
    getIdentifier: deployed => deployed.memoryArn,
    getLocalDetail: item => {
      if (!item.strategies?.length) return undefined;
      return item.strategies.map(s => s.type).join(', ');
    },
  });

  const gateways = diffResourceSet({
    resourceType: 'gateway',
    localItems: mcpSpec?.agentCoreGateways ?? [],
    deployedRecord: resources?.mcp?.gateways ?? {},
    getIdentifier: deployed => deployed.gatewayId,
    getLocalDetail: item => {
      const count = item.targets?.length ?? 0;
      return count > 0 ? `${count} target${count !== 1 ? 's' : ''}` : undefined;
    },
  });

  return [...agents, ...credentials, ...memories, ...gateways];
}

export async function handleProjectStatus(
  context: StatusContext,
  options: { targetName?: string } = {}
): Promise<ProjectStatusResult> {
  const { project, deployedState, awsTargets, mcpSpec } = context;

  const deployedTargetNames = Object.keys(deployedState.targets);
  const targetNames = deployedTargetNames.length > 0 ? deployedTargetNames : awsTargets.map(t => t.name);

  const selectedTargetName = options.targetName ?? targetNames[0];

  if (options.targetName && !targetNames.includes(options.targetName)) {
    return {
      success: false,
      projectName: project.name,
      targetName: options.targetName,
      resources: [],
      error:
        targetNames.length > 0
          ? `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}`
          : `Target '${options.targetName}' not found. No targets configured.`,
    };
  }

  const targetConfig = selectedTargetName ? awsTargets.find(t => t.name === selectedTargetName) : undefined;
  const targetResources = selectedTargetName ? deployedState.targets[selectedTargetName]?.resources : undefined;

  const resources = computeResourceStatuses(project, targetResources, mcpSpec);

  // Enrich deployed agents with live runtime status (parallel, entries replaced by index)
  if (targetConfig) {
    const agentStates = targetResources?.agents ?? {};

    await Promise.all(
      resources.map(async (entry, i) => {
        if (entry.resourceType !== 'agent' || entry.deploymentState !== 'deployed') return;

        const agentState = agentStates[entry.name];
        if (!agentState) return;

        try {
          const runtimeStatus = await getAgentRuntimeStatus({
            region: targetConfig.region,
            runtimeId: agentState.runtimeId,
          });
          resources[i] = { ...entry, detail: runtimeStatus.status };
        } catch (error) {
          resources[i] = { ...entry, error: getErrorMessage(error) };
        }
      })
    );
  }

  return {
    success: true,
    projectName: project.name,
    targetName: selectedTargetName ?? '',
    targetRegion: targetConfig?.region,
    resources,
  };
}

export async function handleRuntimeLookup(
  context: StatusContext,
  options: { agentRuntimeId: string; targetName?: string }
): Promise<RuntimeLookupResult> {
  const { awsTargets } = context;

  const targetNames = awsTargets.map(target => target.name);
  if (targetNames.length === 0) {
    return { success: false, error: 'No deployment targets found. Run `agentcore create` first.' };
  }

  const selectedTargetName = options.targetName ?? targetNames[0]!;

  if (options.targetName && !targetNames.includes(options.targetName)) {
    return { success: false, error: `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}` };
  }

  const targetConfig = awsTargets.find(target => target.name === selectedTargetName);

  if (!targetConfig) {
    return { success: false, error: `Target config '${selectedTargetName}' not found in aws-targets` };
  }

  try {
    const runtimeStatus = await getAgentRuntimeStatus({
      region: targetConfig.region,
      runtimeId: options.agentRuntimeId,
    });

    return {
      success: true,
      targetName: selectedTargetName,
      runtimeId: runtimeStatus.runtimeId,
      runtimeStatus: runtimeStatus.status,
    };
  } catch (error) {
    return { success: false, error: getErrorMessage(error) };
  }
}
