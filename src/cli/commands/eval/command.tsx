import {
  getEvaluator,
  getOnlineEvaluationConfig,
  listEvaluators,
  listOnlineEvaluationConfigs,
  updateOnlineEvalConfig,
} from '../../aws/agentcore-control';
import type { OnlineEvalExecutionStatus } from '../../aws/agentcore-control';
import { detectRegion } from '../../aws/region';
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

  // ── WI-7: Evaluator Discovery Commands ──────────────────────────────

  evalCmd
    .command('list-evaluators')
    .description('List available evaluators (built-in and custom)')
    .option('--region <region>', 'AWS region')
    .option('--max-results <n>', 'Maximum number of results')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: { region?: string; maxResults?: string; json?: boolean }) => {
      try {
        const region = cliOptions.region ?? (await detectRegion()).region;
        const result = await listEvaluators({
          region,
          maxResults: cliOptions.maxResults ? parseInt(cliOptions.maxResults, 10) : undefined,
        });

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
          return;
        }

        if (result.evaluators.length === 0) {
          console.log('No evaluators found.');
          return;
        }

        console.log(`\n${'ID'.padEnd(45)} ${'Name'.padEnd(30)} ${'Type'.padEnd(10)} ${'Level'.padEnd(12)} Status`);
        console.log('─'.repeat(110));

        for (const e of result.evaluators) {
          console.log(
            `${e.evaluatorId.padEnd(45)} ${e.evaluatorName.padEnd(30)} ${e.evaluatorType.padEnd(10)} ${(e.level ?? '—').padEnd(12)} ${e.status}`
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
    .command('get-evaluator')
    .description('Get details of a specific evaluator')
    .argument('<evaluatorId>', 'Evaluator ID')
    .option('--region <region>', 'AWS region')
    .option('--json', 'Output as JSON')
    .action(async (evaluatorId: string, cliOptions: { region?: string; json?: boolean }) => {
      try {
        const region = cliOptions.region ?? (await detectRegion()).region;
        const result = await getEvaluator({ region, evaluatorId });

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log(`\nEvaluator: ${result.evaluatorName}`);
        console.log(`ID: ${result.evaluatorId}`);
        console.log(`ARN: ${result.evaluatorArn}`);
        console.log(`Level: ${result.level}`);
        console.log(`Status: ${result.status}`);
        if (result.description) {
          console.log(`Description: ${result.description}`);
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

  // ── WI-8: Online Eval Config Inspection Commands ────────────────────

  evalCmd
    .command('list-online')
    .description('List online evaluation configs')
    .option('--region <region>', 'AWS region')
    .option('--max-results <n>', 'Maximum number of results')
    .option('--json', 'Output as JSON')
    .action(async (cliOptions: { region?: string; maxResults?: string; json?: boolean }) => {
      try {
        const region = cliOptions.region ?? (await detectRegion()).region;
        const result = await listOnlineEvaluationConfigs({
          region,
          maxResults: cliOptions.maxResults ? parseInt(cliOptions.maxResults, 10) : undefined,
        });

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
          return;
        }

        if (result.configs.length === 0) {
          console.log('No online eval configs found.');
          return;
        }

        console.log(`\n${'ID'.padEnd(50)} ${'Name'.padEnd(30)} ${'Status'.padEnd(18)} Execution`);
        console.log('─'.repeat(115));

        for (const c of result.configs) {
          const failSuffix = c.failureReason ? ` (${c.failureReason})` : '';
          console.log(
            `${c.configId.padEnd(50)} ${c.configName.padEnd(30)} ${c.status.padEnd(18)} ${c.executionStatus}${failSuffix}`
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
    .command('get-online')
    .description('Get details of a specific online evaluation config')
    .argument('<configId>', 'Online evaluation config ID')
    .option('--region <region>', 'AWS region')
    .option('--json', 'Output as JSON')
    .action(async (configId: string, cliOptions: { region?: string; json?: boolean }) => {
      try {
        const region = cliOptions.region ?? (await detectRegion()).region;
        const result = await getOnlineEvaluationConfig({ region, configId });

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
          return;
        }

        console.log(`\nOnline Eval Config: ${result.configName}`);
        console.log(`ID: ${result.configId}`);
        console.log(`ARN: ${result.configArn}`);
        console.log(`Status: ${result.status}`);
        console.log(`Execution: ${result.executionStatus}`);
        if (result.description) {
          console.log(`Description: ${result.description}`);
        }
        if (result.failureReason) {
          console.log(`Failure: ${result.failureReason}`);
        }
        if (result.outputLogGroupName) {
          console.log(`Log Group: ${result.outputLogGroupName}`);
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

  // ── WI-9: Online Eval Config Update ─────────────────────────────────

  evalCmd
    .command('update-online')
    .description('Update a deployed online evaluation config')
    .argument('<configId>', 'Online evaluation config ID')
    .option('--status <status>', 'Set execution status (ENABLED or DISABLED)')
    .option('--description <text>', 'Set config description')
    .option('--region <region>', 'AWS region')
    .option('--json', 'Output as JSON')
    .action(
      async (
        configId: string,
        cliOptions: { status?: string; description?: string; region?: string; json?: boolean }
      ) => {
        try {
          if (!cliOptions.status && cliOptions.description === undefined) {
            const error = 'At least one of --status or --description is required';
            if (cliOptions.json) {
              console.log(JSON.stringify({ success: false, error }));
            } else {
              render(<Text color="red">{error}</Text>);
            }
            process.exit(1);
          }

          if (cliOptions.status && !['ENABLED', 'DISABLED'].includes(cliOptions.status)) {
            const error = `Invalid status "${cliOptions.status}". Must be ENABLED or DISABLED.`;
            if (cliOptions.json) {
              console.log(JSON.stringify({ success: false, error }));
            } else {
              render(<Text color="red">{error}</Text>);
            }
            process.exit(1);
          }

          const region = cliOptions.region ?? (await detectRegion()).region;
          const result = await updateOnlineEvalConfig({
            region,
            onlineEvaluationConfigId: configId,
            executionStatus: cliOptions.status as OnlineEvalExecutionStatus | undefined,
            description: cliOptions.description,
          });

          if (cliOptions.json) {
            console.log(JSON.stringify(result));
            return;
          }

          console.log(`Updated online eval config "${configId}"`);
          console.log(`  Status: ${result.status}`);
          console.log(`  Execution: ${result.executionStatus}`);
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
