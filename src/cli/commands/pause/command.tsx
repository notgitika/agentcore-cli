import { getErrorMessage } from '../../errors';
import { handlePauseResume } from '../../operations/eval';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

function registerOnlineEvalSubcommand(parent: Command, action: 'pause' | 'resume') {
  const description = action === 'pause' ? 'Pause a deployed online eval config' : 'Resume a paused online eval config';
  const pastTense = action === 'pause' ? 'Paused' : 'Resumed';

  parent
    .command('online-eval')
    .description(description)
    .argument('<name>', 'Online eval config name')
    .option('--json', 'Output as JSON')
    .action(async (name: string, cliOptions: { json?: boolean }) => {
      requireProject();

      try {
        const result = await handlePauseResume({ name, json: cliOptions.json }, action);

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
        } else if (result.success) {
          console.log(`${pastTense} online eval config "${name}" (status: ${result.executionStatus})`);
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
}

export const registerPause = (program: Command) => {
  const pauseCmd = program.command('pause').description(COMMAND_DESCRIPTIONS.pause);
  registerOnlineEvalSubcommand(pauseCmd, 'pause');
};

export const registerResume = (program: Command) => {
  const resumeCmd = program.command('resume').description(COMMAND_DESCRIPTIONS.resume);
  registerOnlineEvalSubcommand(resumeCmd, 'resume');
};
