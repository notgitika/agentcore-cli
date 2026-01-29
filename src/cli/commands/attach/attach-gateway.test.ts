import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('attach gateway command', () => {
  let testDir: string;
  let projectDir: string;
  const agentName = 'TestAgent';
  const gatewayName = 'TestGateway';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-attach-gateway-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'AttachGatewayProj';
    let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);

    // Add agent
    result = await runCLI(
      [
        'add',
        'agent',
        '--name',
        agentName,
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

    // Add gateway
    result = await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], projectDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create gateway: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires agent flag', async () => {
      const result = await runCLI(['attach', 'gateway', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--agent'), `Error: ${json.error}`);
    });

    it('requires gateway flag', async () => {
      const result = await runCLI(['attach', 'gateway', '--agent', agentName, '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--gateway'), `Error: ${json.error}`);
    });
  });

  describe('attach operations', () => {
    it('attaches gateway to agent', async () => {
      const result = await runCLI(
        ['attach', 'gateway', '--agent', agentName, '--gateway', gatewayName, '--json'],
        projectDir
      );

      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.agentName, agentName);
      assert.strictEqual(json.gatewayName, gatewayName);

      // Verify in agentcore.json
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentName);
      const mcpProvider = agent?.mcpProviders?.find((p: { gatewayName?: string }) => p.gatewayName === gatewayName);
      assert.ok(mcpProvider, 'MCPProvider should be on agent');
      assert.strictEqual(mcpProvider.type, 'AgentCoreGateway');
    });

    it('rejects non-existent agent', async () => {
      const result = await runCLI(
        ['attach', 'gateway', '--agent', 'NonExistent', '--gateway', gatewayName, '--json'],
        projectDir
      );

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`);
    });
  });
});
