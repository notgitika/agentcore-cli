import { getErrorMessage } from '../../errors';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { handleProjectStatus, handleRuntimeLookup, loadStatusConfig } from './action';
import { DEPLOYMENT_STATE_COLORS, DEPLOYMENT_STATE_LABELS } from './constants';
import type { Command } from '@commander-js/extra-typings';
import { Box, Text, render } from 'ink';

export const registerStatus = (program: Command) => {
  program
    .command('status')
    .alias('s')
    .description(COMMAND_DESCRIPTIONS.status)
    .option('--agent-runtime-id <id>', 'Look up a specific agent runtime by ID')
    .option('--target <name>', 'Select deployment target')
    .action(async (cliOptions: { agentRuntimeId?: string; target?: string }) => {
      requireProject();

      try {
        const context = await loadStatusConfig();

        // Direct runtime lookup by ID
        if (cliOptions.agentRuntimeId) {
          const result = await handleRuntimeLookup(context, {
            agentRuntimeId: cliOptions.agentRuntimeId,
            targetName: cliOptions.target,
          });

          if (!result.success) {
            render(<Text color="red">{result.error}</Text>);
            return;
          }

          const runtimeStatus = result.runtimeStatus ? `Runtime status: ${result.runtimeStatus}` : '';

          render(
            <Text>
              AgentCore Status - {result.runtimeId} (target: {result.targetName})
              {runtimeStatus ? ` - ${runtimeStatus}` : ''}
            </Text>
          );
          return;
        }

        // Default path: show all resource types with deployment state
        const result = await handleProjectStatus(context, {
          targetName: cliOptions.target,
        });

        if (!result.success) {
          render(<Text color="red">{result.error}</Text>);
          return;
        }

        const agents = result.resources.filter(r => r.resourceType === 'agent');
        const credentials = result.resources.filter(r => r.resourceType === 'credential');
        const memories = result.resources.filter(r => r.resourceType === 'memory');
        const gateways = result.resources.filter(r => r.resourceType === 'gateway');

        render(
          <Box flexDirection="column">
            <Text bold>
              AgentCore Status (target: {result.targetName}
              {result.targetRegion ? `, ${result.targetRegion}` : ''})
            </Text>

            {agents.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Agents</Text>
                {agents.map(entry => (
                  <Text key={`${entry.resourceType}-${entry.name}`}>
                    {'  '}
                    {entry.name}:{' '}
                    <Text color={DEPLOYMENT_STATE_COLORS[entry.deploymentState] ?? 'gray'}>
                      {DEPLOYMENT_STATE_LABELS[entry.deploymentState] ?? entry.deploymentState}
                    </Text>
                    {entry.detail && <Text> - Runtime: {entry.detail}</Text>}
                    {entry.identifier && <Text dimColor> ({entry.identifier})</Text>}
                    {entry.error && <Text color="red"> - Error: {entry.error}</Text>}
                  </Text>
                ))}
              </Box>
            )}

            {memories.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Memories</Text>
                {memories.map(entry => (
                  <Text key={`${entry.resourceType}-${entry.name}`}>
                    {'  '}
                    {entry.name}:{' '}
                    <Text color={DEPLOYMENT_STATE_COLORS[entry.deploymentState] ?? 'gray'}>
                      {DEPLOYMENT_STATE_LABELS[entry.deploymentState] ?? entry.deploymentState}
                    </Text>
                    {entry.detail && <Text dimColor> ({entry.detail})</Text>}
                  </Text>
                ))}
              </Box>
            )}

            {credentials.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Credentials</Text>
                {credentials.map(entry => (
                  <Text key={`${entry.resourceType}-${entry.name}`}>
                    {'  '}
                    {entry.name}:{' '}
                    <Text color={DEPLOYMENT_STATE_COLORS[entry.deploymentState] ?? 'gray'}>
                      {DEPLOYMENT_STATE_LABELS[entry.deploymentState] ?? entry.deploymentState}
                    </Text>
                    {entry.detail && <Text dimColor> ({entry.detail})</Text>}
                    {entry.identifier && <Text dimColor> ({entry.identifier})</Text>}
                  </Text>
                ))}
              </Box>
            )}

            {gateways.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Gateways</Text>
                {gateways.map(entry => (
                  <Text key={`${entry.resourceType}-${entry.name}`}>
                    {'  '}
                    {entry.name}:{' '}
                    <Text color={DEPLOYMENT_STATE_COLORS[entry.deploymentState] ?? 'gray'}>
                      {DEPLOYMENT_STATE_LABELS[entry.deploymentState] ?? entry.deploymentState}
                    </Text>
                    {entry.detail && <Text dimColor> ({entry.detail})</Text>}
                    {entry.identifier && <Text dimColor> ({entry.identifier})</Text>}
                  </Text>
                ))}
              </Box>
            )}

            {result.resources.length === 0 && <Text dimColor>No resources configured.</Text>}
          </Box>
        );
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });
};
