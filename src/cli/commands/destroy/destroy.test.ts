import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('destroy command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-destroy-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project with agent and target
    const projectName = 'DestroyTestProj';
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
    it('requires --target flag for CLI mode', async () => {
      const result = await runCLI(['destroy', '--target', 'test-target', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.toLowerCase().includes('not found') || json.error.toLowerCase().includes('not deployed'));
    });

    it('shows JSON error for whitespace-only target', async () => {
      const result = await runCLI(['destroy', '--target', '   ', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--target'), `Error should mention target: ${json.error}`);
    });
  });

  describe('target discovery', () => {
    it('returns error for non-existent target', async () => {
      const result = await runCLI(['destroy', '--target', 'nonexistent', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(
        json.error.toLowerCase().includes('not found') || json.error.toLowerCase().includes('not deployed'),
        `Error should indicate target not found: ${json.error}`
      );
    });

    it('returns error for target that exists but is not deployed', async () => {
      const result = await runCLI(['destroy', '--target', 'test-target', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(
        json.error.toLowerCase().includes('not found') || json.error.toLowerCase().includes('not deployed'),
        `Error should indicate not deployed: ${json.error}`
      );
    });
  });

  describe('command registration', () => {
    it('command is registered and works', async () => {
      const result = await runCLI(['destroy', '--target', 'nonexistent', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
    });

    it('alias x works', async () => {
      const result = await runCLI(['x', '--help'], projectDir);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('destroy') || result.stdout.includes('Destroy'), 'Alias should work');
    });
  });
});
