import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('attach identity command', () => {
  let testDir: string;
  let projectDir: string;
  const agentA = 'AgentA';
  const agentB = 'AgentB';
  const testId = 'TestId';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-attach-identity-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'AttachIdProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add AgentA (owner)
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agentA,
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
      throw new Error(`Failed to create AgentA: ${result.stdout} ${result.stderr}`);
    }

    // Add AgentB (will attach identity to this one)
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agentB,
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
      throw new Error(`Failed to create AgentB: ${result.stdout} ${result.stderr}`);
    }

    // Add identity owned by AgentA
    result = await runCLI(
      [
        'add',
        'identity',
        '--name',
        testId,
        '--type',
        'ApiKeyCredentialProvider',
        '--api-key',
        'test-key-123',
        '--owner',
        agentA,
        '--json',
      ],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create TestId: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires agent flag', async () => {
      const result = await runCLI(['attach', 'identity', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--agent'), `Error: ${json.error}`);
    });

    it('requires identity flag', async () => {
      const result = await runCLI(['attach', 'identity', '--agent', agentB, '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--identity'), `Error: ${json.error}`);
    });
  });

  describe('attach operations', () => {
    it('attaches identity to agent', async () => {
      const result = await runCLI(
        ['attach', 'identity', '--agent', agentB, '--identity', testId, '--json'],
        projectDir
      );

      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.agentName, agentB);
      assert.strictEqual(json.identityName, testId);

      // Verify in agentcore.json
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentB);
      const identity = agent?.identityProviders?.find((i: { name: string }) => i.name === testId);
      assert.ok(identity, 'Identity should be on agent');
      assert.strictEqual(identity.relation, 'use');
    });

    it('rejects non-existent agent', async () => {
      const result = await runCLI(
        ['attach', 'identity', '--agent', 'NonExistent', '--identity', testId, '--json'],
        projectDir
      );

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('not found') || json.error.includes('NonExistent'), `Error: ${json.error}`);
    });
  });
});
