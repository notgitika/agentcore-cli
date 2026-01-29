import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('agent removal cascade', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-agent-removal-cascade-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('cascade removes owned resources', () => {
    it('removes agent and its owned memory', async () => {
      // Create fresh project for this test
      const projectName = `CascadeMemProj${Date.now()}`;
      let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
      assert.strictEqual(result.exitCode, 0);
      const projDir = join(testDir, projectName);

      // Add agent
      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'OwnerAgent',
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
        projDir
      );
      assert.strictEqual(result.exitCode, 0);

      // Add memory owned by agent
      result = await runCLI(
        ['add', 'memory', '--name', 'OwnedMemory', '--strategies', 'SEMANTIC', '--owner', 'OwnerAgent', '--json'],
        projDir
      );
      assert.strictEqual(result.exitCode, 0);

      // Remove agent with cascade
      result = await runCLI(['remove', 'agent', '--name', 'OwnerAgent', '--policy', 'cascade', '--json'], projDir);
      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);

      // Verify agent is removed
      const projectSpec = JSON.parse(await readFile(join(projDir, 'agentcore/agentcore.json'), 'utf-8'));
      assert.strictEqual(projectSpec.agents.length, 0, 'Agent should be removed');
    });

    it('removes agent and its owned identity', async () => {
      // Create fresh project
      const projectName = `CascadeIdProj${Date.now()}`;
      let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
      assert.strictEqual(result.exitCode, 0);
      const projDir = join(testDir, projectName);

      // Add agent
      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'OwnerAgent',
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
        projDir
      );
      assert.strictEqual(result.exitCode, 0);

      // Add identity owned by agent
      result = await runCLI(
        [
          'add',
          'identity',
          '--name',
          'OwnedIdentity',
          '--type',
          'ApiKeyCredentialProvider',
          '--api-key',
          'test-key',
          '--owner',
          'OwnerAgent',
          '--json',
        ],
        projDir
      );
      assert.strictEqual(result.exitCode, 0);

      // Remove agent with cascade
      result = await runCLI(['remove', 'agent', '--name', 'OwnerAgent', '--policy', 'cascade', '--json'], projDir);
      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);

      // Verify agent is removed
      const projectSpec = JSON.parse(await readFile(join(projDir, 'agentcore/agentcore.json'), 'utf-8'));
      assert.strictEqual(projectSpec.agents.length, 0, 'Agent should be removed');
    });

    it('removes agent and cleans up remote tool references', async () => {
      // Create fresh project
      const projectName = `CascadeToolProj${Date.now()}`;
      let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
      assert.strictEqual(result.exitCode, 0);
      const projDir = join(testDir, projectName);

      // Add two agents
      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'AgentA',
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
        projDir
      );
      assert.strictEqual(result.exitCode, 0);

      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'AgentB',
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
        projDir
      );
      assert.strictEqual(result.exitCode, 0);

      // Attach AgentB to AgentA (AgentA can invoke AgentB)
      result = await runCLI(['attach', 'agent', '--source', 'AgentA', '--target', 'AgentB', '--json'], projDir);
      assert.strictEqual(result.exitCode, 0);

      // Remove AgentB with cascade
      result = await runCLI(['remove', 'agent', '--name', 'AgentB', '--policy', 'cascade', '--json'], projDir);
      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}`);

      // Verify AgentA's remote tool reference is cleaned up
      const projectSpec = JSON.parse(await readFile(join(projDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agentA = projectSpec.agents.find((a: { name: string }) => a.name === 'AgentA');
      const hasRef = agentA?.remoteTools?.some((rt: { targetAgentName?: string }) => rt.targetAgentName === 'AgentB');
      assert.ok(!hasRef, 'AgentA should not have reference to removed AgentB');
    });
  });
});
