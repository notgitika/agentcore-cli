import { getErrorMessage } from '../../errors';
import { handleRunEval } from '../../operations/eval';
import type { RunEvalOptions } from '../../operations/eval';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

function formatRunOutput(result: Awaited<ReturnType<typeof handleRunEval>>): void {
  if (!result.run) return;

  const { run } = result;
  console.log(`\nEval Run: ${run.runId}`);
  console.log(`Agent: ${run.agent} | Sessions: ${run.sessionCount} | Lookback: ${run.lookbackDays}d\n`);

  for (const r of run.results) {
    const score = r.aggregateScore.toFixed(2);
    const errors = r.sessionScores.filter(s => s.errorMessage).length;
    const errorSuffix = errors > 0 ? ` (${errors} errors)` : '';
    console.log(`  ${r.evaluator}: ${score}${errorSuffix}`);
  }

  if (result.filePath) {
    console.log(`\nResults saved to: ${result.filePath}`);
  }
}

export const registerRun = (program: Command) => {
  const runCmd = program.command('run').description(COMMAND_DESCRIPTIONS.run);

  runCmd
    .command('eval')
    .description('Run on-demand evaluation of agent traces')
    .option('-a, --agent <name>', 'Agent to evaluate')
    .option('-e, --evaluator <names...>', 'Evaluator name(s) or Builtin.* IDs')
    .option('--evaluator-arn <arns...>', 'Evaluator ARN(s) to use directly')
    .option('--days <days>', 'Lookback window in days', '7')
    .option('--output <path>', 'Custom output file path for results')
    .option('--json', 'Output as JSON')
    .action(
      async (cliOptions: {
        agent?: string;
        evaluator?: string[];
        evaluatorArn?: string[];
        days: string;
        output?: string;
        json?: boolean;
      }) => {
        requireProject();

        if (!cliOptions.evaluator && !cliOptions.evaluatorArn) {
          const error = 'At least one --evaluator or --evaluator-arn is required';
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            render(<Text color="red">{error}</Text>);
          }
          process.exit(1);
        }

        const options: RunEvalOptions = {
          agent: cliOptions.agent,
          evaluator: cliOptions.evaluator ?? [],
          evaluatorArn: cliOptions.evaluatorArn,
          days: parseInt(cliOptions.days, 10),
          output: cliOptions.output,
          json: cliOptions.json,
        };

        try {
          const result = await handleRunEval(options);

          if (cliOptions.json) {
            console.log(JSON.stringify(result));
          } else if (result.success) {
            formatRunOutput(result);
          } else {
            formatRunOutput(result);
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
