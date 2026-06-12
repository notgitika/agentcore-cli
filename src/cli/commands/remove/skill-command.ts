import { ConfigIO, findConfigRoot } from '../../../lib';
import type { HarnessSpec } from '../../../schema';
import { getErrorMessage } from '../../errors';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { ValidationError } from '@/lib/errors/types';
import type { Result } from '@/lib/result';
import type { Command } from '@commander-js/extra-typings';

export interface RemoveSkillOptions {
  harness: string;
  path?: string;
  s3?: string;
  git?: string;
}

function getSkillKey(skill: HarnessSpec['skills'][number]): string {
  if ('s3Uri' in skill) return `s3:${skill.s3Uri}`;
  if ('gitUrl' in skill) return `git:${skill.gitUrl}`;
  return `path:${skill.path}`;
}

export async function handleRemoveSkill(
  options: RemoveSkillOptions
): Promise<Result<{ harnessName: string; skillSource: string }>> {
  const { harness } = options;

  const sourceCount = [options.path, options.s3, options.git].filter(Boolean).length;
  if (sourceCount !== 1) {
    return {
      success: false,
      error: new ValidationError('Exactly one of --path, --s3, or --git is required to identify the skill'),
    };
  }

  const configIO = new ConfigIO();

  let harnessSpec: HarnessSpec;
  try {
    harnessSpec = await configIO.readHarnessSpec(harness);
  } catch {
    return { success: false, error: new ValidationError(`Harness '${harness}' not found.`) };
  }

  let targetKey: string;
  let skillSource: string;
  if (options.path) {
    targetKey = `path:${options.path}`;
    skillSource = options.path;
  } else if (options.s3) {
    targetKey = `s3:${options.s3}`;
    skillSource = options.s3;
  } else {
    targetKey = `git:${options.git!}`;
    skillSource = options.git!;
  }

  const idx = harnessSpec.skills.findIndex(s => getSkillKey(s) === targetKey);
  if (idx === -1) {
    return { success: false, error: new ValidationError(`Skill '${skillSource}' not found in harness '${harness}'`) };
  }

  harnessSpec.skills.splice(idx, 1);
  await configIO.writeHarnessSpec(harness, harnessSpec);

  return { success: true, harnessName: harness, skillSource };
}

export function registerRemoveSkill(removeCmd: Command): void {
  removeCmd
    .command('skill')
    .description('Remove a skill from a harness')
    .requiredOption('--harness <name>', 'Target harness name')
    .option('--path <path>', 'Path to an installed skill in the environment')
    .option('--s3 <uri>', 'S3 URI of skill to remove')
    .option('--git <url>', 'Git URL of skill to remove')
    .option('--json', 'Output as JSON')
    .action(async cliOptions => {
      if (!findConfigRoot()) {
        console.error('No agentcore project found. Run `agentcore create` first.');
        process.exit(1);
      }

      try {
        const result = await withCommandRunTelemetry('remove.skill', {}, () =>
          handleRemoveSkill({
            harness: cliOptions.harness,
            path: cliOptions.path,
            s3: cliOptions.s3,
            git: cliOptions.git,
          })
        );

        if (!result.success) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: result.error.message }));
          } else {
            console.error(result.error.message);
          }
          process.exit(1);
        }

        if (cliOptions.json) {
          console.log(
            JSON.stringify({ success: true, harnessName: result.harnessName, skillSource: result.skillSource })
          );
        } else {
          console.log(`Removed skill '${result.skillSource}' from harness '${result.harnessName}'.`);
          console.log(`Run 'agentcore deploy' to apply changes.`);
        }
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          console.error(getErrorMessage(error));
        }
        process.exit(1);
      }
    });
}
