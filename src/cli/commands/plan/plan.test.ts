import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('plan command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-plan-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project with agent and target
    const projectName = 'PlanTestProj';
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

  describe('target validation', () => {
    it('rejects non-existent target', async () => {
      const result = await runCLI(['plan', '--target', 'nonexistent', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('not found'), `Error should mention not found: ${json.error}`);
    });

    it('accepts valid target and returns plan result', async () => {
      const result = await runCLI(['plan', '--target', 'test-target', '--json'], projectDir);
      const json = JSON.parse(result.stdout);
      assert.ok(!json.error?.includes('not found'), `Should find target, got: ${json.error || 'success'}`);
    });
  });

  // Merged from plan-deploy.test.ts
  describe('--deploy flag', () => {
    it('command accepts --deploy flag', async () => {
      const result = await runCLI(['plan', '--target', 'test-target', '--deploy', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(!json.error.toLowerCase().includes('unknown option'), `Should accept --deploy flag: ${json.error}`);
    });

    it('plan without --deploy returns plan result only', async () => {
      const result = await runCLI(['plan', '--target', 'test-target', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 0);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.ok(json.stackNames, 'Should have stackNames');
      assert.strictEqual(json.outputs, undefined, 'Should not have outputs without --deploy');
    });

    it('requires --target for --deploy', async () => {
      const result = await runCLI(['plan', '--target', 'nonexistent', '--deploy', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.toLowerCase().includes('not found'), `Error should mention target not found: ${json.error}`);
    });

    it('attempts deploy after plan', async () => {
      const result = await runCLI(['plan', '--target', 'test-target', '--deploy', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.length > 0, 'Should have error message');
    });
  });
});
