import { exists, runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('create command', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('--no-agent', () => {
    it('creates project structure', async () => {
      const name = `Proj${Date.now()}`;
      const result = await runCLI(['create', '--name', name, '--no-agent', '--json'], testDir);

      assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}, stdout: ${result.stdout}`);

      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.ok(await exists(json.projectPath), 'Project should exist');
      assert.ok(await exists(join(json.projectPath, 'agentcore')), 'agentcore/ should exist');
    });

    it('rejects reserved names', async () => {
      const result = await runCLI(['create', '--name', 'Test', '--no-agent', '--json'], testDir);

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('conflicts'));
    });
  });

  describe('with agent', () => {
    it('creates project with agent', async () => {
      const name = `Agent${Date.now()}`;
      const result = await runCLI(
        [
          'create',
          '--name',
          name,
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
        testDir
      );

      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}`);

      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.agentName, name);
      assert.ok(await exists(join(json.projectPath, 'app', name)));
    });

    it('requires all options without --no-agent', async () => {
      const result = await runCLI(['create', '--name', 'Incomplete', '--json'], testDir);

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
    });

    it('validates framework', async () => {
      const result = await runCLI(
        [
          'create',
          '--name',
          'BadFW',
          '--language',
          'Python',
          '--framework',
          'NotReal',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
          '--json',
        ],
        testDir
      );

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
    });
  });

  describe('--defaults', () => {
    it('creates project with defaults', async () => {
      const name = `Defaults${Date.now()}`;
      const result = await runCLI(['create', '--name', name, '--defaults', '--json'], testDir);

      assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.ok(await exists(join(testDir, name)));
    });
  });

  describe('--dry-run', () => {
    it('shows files without creating', async () => {
      const name = `DryRun${Date.now()}`;
      const result = await runCLI(['create', '--name', name, '--defaults', '--dry-run'], testDir);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('would create') || result.stdout.includes('Dry run'));
      assert.strictEqual(await exists(join(testDir, name)), false, 'Should not create directory');
    });
  });

  describe('--skip-git', () => {
    it('skips git initialization', async () => {
      const name = `NoGit${Date.now()}`;
      const result = await runCLI(['create', '--name', name, '--defaults', '--skip-git', '--json'], testDir);

      assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.strictEqual(await exists(join(testDir, name, '.git')), false, 'Should not have .git');
    });
  });

  describe('--output-dir', () => {
    it('creates in specified directory', async () => {
      const name = `OutDir${Date.now()}`;
      const customDir = join(testDir, 'custom-output');
      const result = await runCLI(
        ['create', '--name', name, '--defaults', '--output-dir', customDir, '--json'],
        testDir
      );

      assert.strictEqual(result.exitCode, 0, `stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.ok(await exists(join(customDir, name)), 'Should create in custom dir');
    });
  });
});
