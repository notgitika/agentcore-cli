import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('remove command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-remove-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'RemoveTestProj';
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
    it('requires name for JSON output', async () => {
      const result = await runCLI(['remove', 'agent', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--name'), `Error should mention --name: ${json.error}`);
    });
  });

  describe('remove target', () => {
    it('rejects non-existent target', async () => {
      const result = await runCLI(['remove', 'target', '--name', 'nonexistent', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
    });

    it('removes existing target', async () => {
      const result = await runCLI(['remove', 'target', '--name', 'test-target', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 0);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);

      // Verify target is removed from schema
      const targets = JSON.parse(await readFile(join(projectDir, 'agentcore', 'aws-targets.json'), 'utf-8'));
      assert.strictEqual(targets.length, 0, 'Target should be removed from schema');
    });
  });

  describe('remove agent', () => {
    it('rejects non-existent agent', async () => {
      const result = await runCLI(['remove', 'agent', '--name', 'nonexistent', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
    });

    it('removes existing agent', async () => {
      const result = await runCLI(['remove', 'agent', '--name', 'TestAgent', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 0);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);

      // Verify agent is removed from schema
      const schema = JSON.parse(await readFile(join(projectDir, 'agentcore', 'agentcore.json'), 'utf-8'));
      assert.strictEqual(schema.agents.length, 0, 'Agent should be removed from schema');
    });
  });
});
