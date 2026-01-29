import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { handleStopSession, loadStopSessionConfig } from './action';
import type { Command } from '@commander-js/extra-typings';
import { Box, Text, render } from 'ink';
import React from 'react';

export const registerStopSession = (program: Command) => {
  program
    .command('stop-session')
    .description(COMMAND_DESCRIPTIONS.stopSession ?? 'Stop an active runtime session')
    .option('--agent <name>', 'Select specific agent')
    .option('--target <name>', 'Select deployment target')
    .option('--session-id <id>', 'Session ID to stop (uses active session if not specified)')
    .action(async (cliOptions: { agent?: string; target?: string; sessionId?: string }) => {
      requireProject();

      try {
        const context = await loadStopSessionConfig();
        const result = await handleStopSession(context, {
          agentName: cliOptions.agent,
          targetName: cliOptions.target,
          sessionId: cliOptions.sessionId,
        });

        if (!result.success) {
          render(
            <Box flexDirection="column">
              <Text color="red">Failed to stop session</Text>
              <Text color="red">{result.error}</Text>
            </Box>
          );
          process.exit(1);
          return;
        }

        // Show success message
        const shortSessionId = result.sessionId ? result.sessionId.slice(0, 8) + '...' : 'unknown';

        render(
          <Box flexDirection="column">
            <Text color="green">Session stopped successfully</Text>
            <Text>
              Agent: <Text color="cyan">{result.agentName}</Text>
            </Text>
            <Text>
              Session: <Text color="magenta">{shortSessionId}</Text>
            </Text>
            <Text>
              Target: <Text color="yellow">{result.targetName}</Text>
            </Text>
            {result.statusCode === 404 && <Text dimColor>Note: Session was already stopped or expired</Text>}
          </Box>
        );
      } catch (error) {
        render(<Text color="red">Error: {(error as Error).message}</Text>);
        process.exit(1);
      }
    });
};
