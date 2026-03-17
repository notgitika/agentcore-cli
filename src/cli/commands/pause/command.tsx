import { getErrorMessage } from '../../errors';
import { handleDeleteOnlineEval, handlePauseResume } from '../../operations/eval';
import type { OnlineEvalActionOptions } from '../../operations/eval';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';
import * as readline from 'readline';

function registerOnlineEvalSubcommand(parent: Command, action: 'pause' | 'resume') {
  const description = action === 'pause' ? 'Pause a deployed online eval config' : 'Resume a paused online eval config';
  const pastTense = action === 'pause' ? 'Paused' : 'Resumed';

  parent
    .command('online-eval')
    .description(description)
    .argument('[name]', 'Online eval config name (from project config)')
    .option('--arn <arn>', 'Online eval config ARN (direct mode, bypasses project config)')
    .option('--region <region>', 'AWS region (used with --arn)')
    .option('--json', 'Output as JSON')
    .action(async (name: string | undefined, cliOptions: { arn?: string; region?: string; json?: boolean }) => {
      if (!cliOptions.arn && !name) {
        const error = 'Either a config name or --arn is required';
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error }));
        } else {
          render(<Text color="red">{error}</Text>);
        }
        process.exit(1);
      }

      if (!cliOptions.arn) {
        requireProject();
      }

      const options: OnlineEvalActionOptions = {
        name: name ?? '',
        arn: cliOptions.arn,
        region: cliOptions.region,
        json: cliOptions.json,
      };

      try {
        const result = await handlePauseResume(options, action);

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
        } else if (result.success) {
          const displayName = cliOptions.arn ? result.configId : name;
          console.log(`${pastTense} online eval config "${displayName}" (status: ${result.executionStatus})`);
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

function askConfirmation(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
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

export const registerStop = (program: Command) => {
  const stopCmd = program.command('stop').description(COMMAND_DESCRIPTIONS.stop);

  stopCmd
    .command('online-eval')
    .description('Delete a deployed online eval config')
    .argument('[name]', 'Online eval config name (from project config)')
    .option('--arn <arn>', 'Online eval config ARN (direct mode, bypasses project config)')
    .option('--region <region>', 'AWS region (used with --arn)')
    .option('--json', 'Output as JSON')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(
      async (
        name: string | undefined,
        cliOptions: { arn?: string; region?: string; json?: boolean; yes?: boolean }
      ) => {
        if (!cliOptions.arn && !name) {
          const error = 'Either a config name or --arn is required';
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            render(<Text color="red">{error}</Text>);
          }
          process.exit(1);
        }

        if (!cliOptions.arn) {
          requireProject();
        }

        const displayName = cliOptions.arn ?? name;

        if (!cliOptions.yes && !cliOptions.json) {
          const confirmed = await askConfirmation(
            `Are you sure you want to delete online eval config "${displayName}"? This action cannot be undone. (y/N) `
          );
          if (!confirmed) {
            console.log('Aborted.');
            process.exit(0);
          }
        }

        const options: OnlineEvalActionOptions = {
          name: name ?? '',
          arn: cliOptions.arn,
          region: cliOptions.region,
          json: cliOptions.json,
        };

        try {
          const result = await handleDeleteOnlineEval(options);

          if (cliOptions.json) {
            console.log(JSON.stringify(result));
          } else if (result.success) {
            console.log(`Deleted online eval config "${displayName}" (status: ${result.status})`);
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
      }
    );
};
