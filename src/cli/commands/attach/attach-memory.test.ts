import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('attach memory command', () => {
  let testDir: string;
  let projectDir: string;
  const agentA = 'AgentA';
  const agentB = 'AgentB';
  const testMem = 'TestMem';
  const readOnlyMem = 'ReadOnlyMem';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-attach-memory-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'AttachMemProj';
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

    // Add AgentB (will attach memory to this one)
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

    // Add memory owned by AgentA
    result = await runCLI(
      ['add', 'memory', '--name', testMem, '--strategies', 'SEMANTIC', '--owner', agentA, '--json'],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create TestMem: ${result.stdout} ${result.stderr}`);
    }

    // Add second memory for access level test
    result = await runCLI(
      ['add', 'memory', '--name', readOnlyMem, '--strategies', 'SEMANTIC', '--owner', agentA, '--json'],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create ReadOnlyMem: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires agent flag', async () => {
      const result = await runCLI(['attach', 'memory', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--agent'), `Error: ${json.error}`);
    });

    it('requires memory flag', async () => {
      const result = await runCLI(['attach', 'memory', '--agent', agentB, '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--memory'), `Error: ${json.error}`);
    });

    it('validates access value', async () => {
      const result = await runCLI(
        ['attach', 'memory', '--agent', agentB, '--memory', testMem, '--access', 'invalid', '--json'],
        projectDir
      );
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('read') || json.error.includes('access'), `Error: ${json.error}`);
    });
  });

  describe('attach operations', () => {
    it('attaches memory to agent', async () => {
      const result = await runCLI(['attach', 'memory', '--agent', agentB, '--memory', testMem, '--json'], projectDir);

      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.agentName, agentB);
      assert.strictEqual(json.memoryName, testMem);

      // Verify in agentcore.json
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentB);
      const memory = agent?.memoryProviders?.find((m: { name: string }) => m.name === testMem);
      assert.ok(memory, 'Memory should be on agent');
      assert.strictEqual(memory.relation, 'use');
      assert.strictEqual(memory.access, 'readwrite');
    });

    it('uses specified access level', async () => {
      const result = await runCLI(
        ['attach', 'memory', '--agent', agentB, '--memory', readOnlyMem, '--access', 'read', '--json'],
        projectDir
      );

      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}, stderr: ${result.stderr}`);

      // Verify access level
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentB);
      const memory = agent?.memoryProviders?.find((m: { name: string }) => m.name === readOnlyMem);
      assert.strictEqual(memory?.access, 'read');
    });

    it('rejects non-existent agent', async () => {
      const result = await runCLI(
        ['attach', 'memory', '--agent', 'NonExistent', '--memory', testMem, '--json'],
        projectDir
      );

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('not found') || json.error.includes('NonExistent'), `Error: ${json.error}`);
    });
  });
});
