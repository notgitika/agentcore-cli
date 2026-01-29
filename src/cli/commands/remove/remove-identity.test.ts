import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('remove identity command', () => {
  let testDir: string;
  let projectDir: string;
  const ownerAgent = 'OwnerAgent';
  const userAgent = 'UserAgent';
  const identityName = 'TestIdentity';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-remove-identity-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'RemoveIdentityProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add owner agent
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        ownerAgent,
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
      throw new Error(`Failed to create owner agent: ${result.stdout} ${result.stderr}`);
    }

    // Add user agent
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        userAgent,
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
      throw new Error(`Failed to create user agent: ${result.stdout} ${result.stderr}`);
    }

    // Add identity
    result = await runCLI(
      [
        'add',
        'identity',
        '--name',
        identityName,
        '--type',
        'ApiKeyCredentialProvider',
        '--api-key',
        'test-key-123',
        '--owner',
        ownerAgent,
        '--json',
      ],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create identity: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires name flag', async () => {
      const result = await runCLI(['remove', 'identity', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--name'), `Error: ${json.error}`);
    });

    it('rejects non-existent identity', async () => {
      const result = await runCLI(['remove', 'identity', '--name', 'nonexistent', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`);
    });
  });

  describe('remove operations', () => {
    it('removes identity without users', async () => {
      // Add a temp identity to remove
      const tempId = `temp-id-${Date.now()}`;
      await runCLI(
        [
          'add',
          'identity',
          '--name',
          tempId,
          '--type',
          'ApiKeyCredentialProvider',
          '--api-key',
          'temp-key',
          '--owner',
          ownerAgent,
          '--json',
        ],
        projectDir
      );

      const result = await runCLI(['remove', 'identity', '--name', tempId, '--json'], projectDir);
      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);

      // Verify identity is removed from owner
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === ownerAgent);
      const identity = agent?.identityProviders?.find((i: { name: string }) => i.name === tempId);
      assert.ok(!identity, 'Identity should be removed from owner');
    });

    it('blocks removal when identity has users', async () => {
      // Attach identity to user agent
      await runCLI(['attach', 'identity', '--agent', userAgent, '--identity', identityName, '--json'], projectDir);

      // Try to remove - should fail with restrict policy
      const result = await runCLI(['remove', 'identity', '--name', identityName, '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(
        json.error.toLowerCase().includes('use') || json.error.toLowerCase().includes('attached'),
        `Error: ${json.error}`
      );
    });
  });
});
