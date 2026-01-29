import { exists, runCLI } from '../src/test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function hasCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasNpm = hasCommand('npm');
const hasGit = hasCommand('git');

describe('integration: create without agent', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-integ-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.skipIf(!hasNpm || !hasGit)('creates project with real npm install and git init', async () => {
    const name = `IntegNoAgent${Date.now()}`;
    const result = await runCLI(['create', '--name', name, '--no-agent', '--json'], testDir, false);

    assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);

    const json = JSON.parse(result.stdout);
    assert.strictEqual(json.success, true);

    // Verify npm install ran (in CDK project directory)
    assert.ok(
      await exists(join(json.projectPath, 'agentcore', 'cdk', 'node_modules')),
      'agentcore/cdk/node_modules/ should exist'
    );

    // Verify git init ran
    assert.ok(await exists(join(json.projectPath, '.git')), '.git/ should exist');

    // Verify at least one commit
    const gitLog = execSync('git log --oneline', { cwd: json.projectPath, encoding: 'utf-8' });
    assert.ok(gitLog.trim().length > 0, 'Should have at least one commit');
  });
});
