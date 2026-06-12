import { ConfigIO } from '../../../lib';
import type { HarnessSpec } from '../../../schema';
import { ValidationError } from '@/lib/errors/types';
import type { Result } from '@/lib/result';

export interface AddSkillOptions {
  harness: string;
  path?: string;
  s3?: string;
  git?: string;
  gitPath?: string;
  credentialName?: string;
  username?: string;
}

function getSkillKey(skill: HarnessSpec['skills'][number]): string {
  if ('s3Uri' in skill) return `s3:${skill.s3Uri}`;
  if ('gitUrl' in skill) return `git:${skill.gitUrl}`;
  return `path:${skill.path}`;
}

export async function handleAddSkill(
  options: AddSkillOptions
): Promise<Result<{ harnessName: string; skillSource: string }>> {
  const { harness } = options;

  const gitOnlyFlags = [
    options.gitPath && '--git-path',
    options.credentialName && '--credential',
    options.username && '--username',
  ].filter(Boolean);

  if (gitOnlyFlags.length > 0 && !options.git) {
    return {
      success: false,
      error: new ValidationError(`${gitOnlyFlags.join(', ')} can only be used with --git`),
    };
  }

  const sourceCount = [options.path, options.s3, options.git].filter(Boolean).length;
  if (sourceCount !== 1) {
    return {
      success: false,
      error: new ValidationError('Exactly one of --path, --s3, or --git is required'),
    };
  }

  if (options.s3 && !options.s3.startsWith('s3://')) {
    return { success: false, error: new ValidationError('--s3 must be an S3 URI starting with s3://') };
  }

  if (options.git && !options.git.startsWith('https://')) {
    return { success: false, error: new ValidationError('--git must be an HTTPS URL starting with https://') };
  }

  const configIO = new ConfigIO();

  let harnessSpec: HarnessSpec;
  try {
    harnessSpec = await configIO.readHarnessSpec(harness);
  } catch {
    return {
      success: false,
      error: new ValidationError(
        `Harness '${harness}' not found. Check the name or run 'agentcore add harness' first.`
      ),
    };
  }

  let skillEntry: HarnessSpec['skills'][number];
  let skillSource: string;

  if (options.path) {
    skillEntry = { path: options.path };
    skillSource = options.path;
  } else if (options.s3) {
    skillEntry = { s3Uri: options.s3 };
    skillSource = options.s3;
  } else {
    skillEntry = {
      gitUrl: options.git!,
      ...(options.gitPath && { path: options.gitPath }),
      ...(options.credentialName && {
        auth: {
          credentialName: options.credentialName,
          ...(options.username && { username: options.username }),
        },
      }),
    };
    skillSource = options.git!;
  }

  const newKey = getSkillKey(skillEntry);
  const isDuplicate = harnessSpec.skills.some(s => getSkillKey(s) === newKey);
  if (isDuplicate) {
    return {
      success: false,
      error: new ValidationError(`Skill '${skillSource}' already exists in harness '${harness}'`),
    };
  }

  harnessSpec.skills.push(skillEntry);
  await configIO.writeHarnessSpec(harness, harnessSpec);

  return { success: true, harnessName: harness, skillSource };
}
