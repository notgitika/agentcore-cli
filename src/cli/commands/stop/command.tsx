import { ConfigIO } from '../../../lib';
import { updateABTest } from '../../aws/agentcore-ab-tests';
import { getErrorMessage } from '../../errors';
import { createJobEngine } from '../../operations/jobs';
import { runCliCommand } from '../../telemetry/cli-command-run';
import { COMMAND_DESCRIPTIONS } from '../../tui/copy';
import { requireProject } from '../../tui/guards';
import { resolveABTestId } from '../pause/command';
import { getRegion } from '../shared/region-utils';
import type { Command } from '@commander-js/extra-typings';

export const registerStop = (program: Command) => {
  const stopCmd = program.command('stop').description(COMMAND_DESCRIPTIONS.stop);

  // AB test stop is still name-based + direct-API here; the AB-test job migration
  // re-points it to engine.stop('ab-test', id) on the ab-test branch.
  stopCmd
    .command('ab-test')
    .description('[preview] Stop a deployed A/B test permanently')
    .argument('<name>', 'AB test name')
    .option('--region <region>', 'AWS region')
    .option('--json', 'Output as JSON')
    .action(async (name: string, cliOptions: { region?: string; json?: boolean }) => {
      try {
        const region = await getRegion(cliOptions.region);
        const { abTestId, error } = await resolveABTestId(name, region);
        if (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            console.error(error);
          }
          process.exit(1);
        }

        const result = await updateABTest({ region, abTestId, executionStatus: 'STOPPED' });

        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, ...result }));
        } else {
          console.log(`Stopped AB test "${name}" (execution: ${result.executionStatus})`);
        }
        process.exit(0);
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          console.error(`Error: ${getErrorMessage(error)}`);
        }
        process.exit(1);
      }
    });

  stopCmd
    .command('batch-evaluation')
    .description('[preview] Stop a running batch evaluation')
    .requiredOption('-i, --id <id>', 'Batch evaluation ID to stop')
    .option('--region <region>', 'AWS region (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .action((cliOptions: { id: string; region?: string; json?: boolean }) => {
      requireProject();

      return runCliCommand('stop.job', !!cliOptions.json, async () => {
        const engine = createJobEngine(new ConfigIO());
        const result = await engine.stop('batch-evaluation', cliOptions.id);
        if (!result.success) {
          throw result.error;
        }
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: true, id: cliOptions.id }));
        } else {
          console.log(`\n✓ Batch evaluation ${cliOptions.id} stop requested.\n`);
        }
        return { job_type: 'batch-evaluation' };
      });
    });
};
