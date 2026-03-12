import { getErrorMessage } from '../../errors';
import { handlePauseResume } from '../../operations/eval';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

export const registerResume = (program: Command) => {
  const resumeCmd = program.command('resume').description(COMMAND_DESCRIPTIONS.resume);

  resumeCmd
    .command('online-eval')
    .description('Resume a paused online eval config')
    .argument('<name>', 'Online eval config name')
    .option('--json', 'Output as JSON')
    .action(async (name: string, cliOptions: { json?: boolean }) => {
      requireProject();

      try {
        const result = await handlePauseResume({ name, json: cliOptions.json }, 'resume');

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
        } else if (result.success) {
          console.log(`Resumed online eval config "${name}" (status: ${result.executionStatus})`);
        } else {
          render(<Text color="red">{result.error}</Text>);
        }

        process.exit(result.success ? 0 : 1);
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        }
        process.exit(1);
      }
    });
};
