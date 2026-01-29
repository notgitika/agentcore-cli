import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('attach agent command', () => {
  let testDir: string;
  let projectDir: string;
  const agentA = 'AgentA';
  const agentB = 'AgentB';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-attach-agent-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'AttachProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add AgentA
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

    // Add AgentB
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
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires source flag', async () => {
      const result = await runCLI(['attach', 'agent', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--source'), `Error: ${json.error}`);
    });

    it('requires target flag', async () => {
      const result = await runCLI(['attach', 'agent', '--source', agentA, '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--target'), `Error: ${json.error}`);
    });
  });

  describe('attach operations', () => {
    it('attaches agent to agent', async () => {
      const result = await runCLI(['attach', 'agent', '--source', agentA, '--target', agentB, '--json'], projectDir);

      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.sourceAgent, agentA);
      assert.strictEqual(json.targetAgent, agentB);

      // Verify in agentcore.json
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentA);
      const remoteTool = agent?.remoteTools?.find((t: { name: string }) => t.name === `invoke${agentB}`);
      assert.ok(remoteTool, 'Remote tool should be on source agent');
      assert.strictEqual(remoteTool.type, 'AgentCoreAgentInvocation');
      assert.strictEqual(remoteTool.targetAgentName, agentB);
    });

    it('uses custom name', async () => {
      const customName = `custom${Date.now()}`;
      const result = await runCLI(
        ['attach', 'agent', '--source', agentA, '--target', agentB, '--name', customName, '--json'],
        projectDir
      );

      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}, stderr: ${result.stderr}`);

      // Verify custom name
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentA);
      const remoteTool = agent?.remoteTools?.find((t: { name: string }) => t.name === customName);
      assert.ok(remoteTool, `Remote tool with name ${customName} should exist`);
    });

    it('rejects self-attachment', async () => {
      const result = await runCLI(['attach', 'agent', '--source', agentA, '--target', agentA, '--json'], projectDir);

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(
        json.error.toLowerCase().includes('itself') || json.error.toLowerCase().includes('same'),
        `Error: ${json.error}`
      );
    });

    it('rejects non-existent source', async () => {
      const result = await runCLI(
        ['attach', 'agent', '--source', 'NonExistent', '--target', agentB, '--json'],
        projectDir
      );

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('not found') || json.error.includes('NonExistent'), `Error: ${json.error}`);
    });
  });
});
