import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('deploy --help', () => {
  it('shows verbose option', async () => {
    const result = await runCLI(['deploy', '--help']);
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.stdout.includes('--verbose'), 'Should show --verbose option');
    assert.ok(result.stdout.includes('resource-level'), 'Should describe resource-level events');
  });

  it('shows all deploy options', async () => {
    const result = await runCLI(['deploy', '--help']);
    assert.ok(result.stdout.includes('--target'));
    assert.ok(result.stdout.includes('--yes'));
    assert.ok(result.stdout.includes('--progress'));
    assert.ok(result.stdout.includes('--json'));
  });
});

describe('deploy command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-deploy-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project with agent and target
    const projectName = 'DeployTestProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add an agent
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        'TestAgent',
        '--language',
        'Python',
        '--framework',
        'Strands',
        '--model-provider',
        'Bedrock',
        '--memory',
        'none',
        '--json',
      ],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create agent: ${result.stdout} ${result.stderr}`);
    }

    // Add a target
    result = await runCLI(
      ['add', 'target', '--name', 'test-target', '--account', '123456789012', '--region', 'us-east-1', '--json'],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create target: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('accepts deploy without target (TUI mode)', async () => {
      // Without --target, deploy goes to TUI mode
      // We can't fully test TUI, but we can verify it doesn't crash immediately
      const result = await runCLI(['deploy', '--target', 'test-target', '--json'], projectDir);
      // This will fail because we don't have AWS credentials, but it validates the target exists
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      // Error should be about AWS/CDK, not about target not found
      assert.ok(!json.error.includes('not found'), `Should find target, got: ${json.error}`);
    });
  });

  describe('target validation', () => {
    it('rejects non-existent target', async () => {
      const result = await runCLI(['deploy', '--target', 'nonexistent', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`);
    });
  });
});
