import { ConfigIO, JobNotFoundError, serializeResult } from '../../../lib';
import { createJobEngine } from '../../operations/jobs';
import { printInsightsDetail, printInsightsHistory } from '../../operations/jobs/insights/format';
import { runCliCommand } from '../../telemetry/cli-command-run';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import type { Command } from '@commander-js/extra-typings';

export const registerInsights = (program: Command) => {
  const cmd = program.command('insights').description(COMMAND_DESCRIPTIONS.insights);

  cmd
    .command('history')
    .description('List insights jobs (running jobs are refreshed from the service)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { json?: boolean }) => {
      requireProject();
      return runCliCommand('job.history', !!cliOptions.json, async () => {
        const engine = createJobEngine(new ConfigIO());
        const records = await engine.list({ type: 'insights' });
        if (cliOptions.json) {
          console.log(
            JSON.stringify({
              success: true,
              insights: records.map(r => serializeResult({ success: true, ...r })),
            })
          );
        } else {
          printInsightsHistory(records);
        }
        return { job_type: 'insights' };
      });
    });

  cmd
    .command('results')
    .description('View results of an insights job')
    .requiredOption('-i, --id <id>', 'Insights job ID to view')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; json?: boolean }) => {
      requireProject();
      return runCliCommand('job.get', !!cliOptions.json, async () => {
        const engine = createJobEngine(new ConfigIO());
        const record = await engine.get('insights', cliOptions.id);
        if (!record) {
          throw new JobNotFoundError(`Insights job "${cliOptions.id}" not found.`);
        }
        if (cliOptions.json) {
          console.log(JSON.stringify(serializeResult({ success: true, ...record })));
        } else {
          printInsightsDetail(record);
        }
        return { job_type: 'insights' };
      });
    });
};
