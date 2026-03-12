import { getErrorMessage } from '../../errors';
import { handleGetEvalRun, handleListEvalRuns } from '../../operations/eval';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

export const registerEval = (program: Command) => {
  const evalCmd = program.command('eval').description(COMMAND_DESCRIPTIONS.eval);

  evalCmd
    .command('list')
    .description('List past eval runs')
    .option('-a, --agent <name>', 'Filter by agent name')
    .option('-n, --limit <count>', 'Maximum number of runs to show')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { agent?: string; limit?: string; json?: boolean }) => {
      requireProject();

      try {
        const result = handleListEvalRuns({
          agent: cliOptions.agent,
          limit: cliOptions.limit ? parseInt(cliOptions.limit, 10) : undefined,
          json: cliOptions.json,
        });

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
          process.exit(result.success ? 0 : 1);
          return;
        }

        if (!result.success) {
          render(<Text color="red">{result.error}</Text>);
          process.exit(1);
        }

        const runs = result.runs ?? [];
        if (runs.length === 0) {
          console.log('No eval runs found. Run `agentcore run eval` to create one.');
          return;
        }

        console.log(
          `\n${'Run ID'.padEnd(42)} ${'Agent'.padEnd(20)} ${'Evaluators'.padEnd(30)} ${'Sessions'.padEnd(10)} Date`
        );
        console.log('─'.repeat(120));

        for (const run of runs) {
          const scores = run.results.map(r => `${r.evaluator}=${r.aggregateScore.toFixed(2)}`).join(', ');
          const date = new Date(run.timestamp).toLocaleDateString();
          console.log(
            `${run.runId.padEnd(42)} ${run.agent.padEnd(20)} ${scores.padEnd(30)} ${String(run.sessionCount).padEnd(10)} ${date}`
          );
        }
        console.log('');
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        }
        process.exit(1);
      }
    });

  evalCmd
    .command('get')
    .description('Get details of a specific eval run')
    .argument('<runId>', 'Eval run ID')
    .option('--sessions', 'Show per-session score breakdown')
    .option('--json', 'Output as JSON')
    .action(
      (
        runId: string,
        cliOptions: {
          sessions?: boolean;
          json?: boolean;
        }
      ) => {
        requireProject();

        try {
          const result = handleGetEvalRun({ runId, sessions: cliOptions.sessions, json: cliOptions.json });

          if (cliOptions.json) {
            console.log(JSON.stringify(result));
            process.exit(result.success ? 0 : 1);
            return;
          }

          if (!result.success) {
            render(<Text color="red">{result.error}</Text>);
            process.exit(1);
          }

          const run = result.run!;
          console.log(`\nEval Run: ${run.runId}`);
          console.log(`Agent: ${run.agent}`);
          console.log(`Date: ${new Date(run.timestamp).toISOString()}`);
          console.log(`Sessions: ${run.sessionCount} | Lookback: ${run.lookbackDays}d\n`);

          for (const r of run.results) {
            const errors = r.sessionScores.filter(s => s.errorMessage).length;
            console.log(`  ${r.evaluator}: ${r.aggregateScore.toFixed(2)}${errors > 0 ? ` (${errors} errors)` : ''}`);

            if (r.tokenUsage) {
              console.log(
                `    Tokens: ${r.tokenUsage.totalTokens} (in: ${r.tokenUsage.inputTokens}, out: ${r.tokenUsage.outputTokens})`
              );
            }

            if (cliOptions.sessions) {
              console.log('');
              for (const s of r.sessionScores) {
                const status = s.errorMessage
                  ? `ERROR: ${s.errorMessage}`
                  : `${s.value.toFixed(2)}${s.label ? ` (${s.label})` : ''}`;
                console.log(`    session=${s.sessionId}  ${status}`);
                if (s.explanation) {
                  console.log(`      ${s.explanation}`);
                }
              }
            }
            console.log('');
          }
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
