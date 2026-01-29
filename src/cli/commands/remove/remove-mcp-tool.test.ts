import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('remove mcp-tool command', () => {
  let testDir: string;
  let projectDir: string;
  const agentName = 'TestAgent';
  const gatewayName = 'TestGateway';
  const runtimeToolName = 'RuntimeTool';
  const gatewayToolName = 'GatewayTool';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-remove-mcp-tool-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create project
    const projectName = 'RemoveMcpToolProj';
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

    // Add mcp-runtime tool
    result = await runCLI(
      [
        'add',
        'mcp-tool',
        '--name',
        runtimeToolName,
        '--language',
        'Python',
        '--exposure',
        'mcp-runtime',
        '--agents',
        agentName,
        '--json',
      ],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create runtime tool: ${result.stdout} ${result.stderr}`);
    }

    // Add behind-gateway tool
    result = await runCLI(
      [
        'add',
        'mcp-tool',
        '--name',
        gatewayToolName,
        '--language',
        'Python',
        '--exposure',
        'behind-gateway',
        '--gateway',
        gatewayName,
        '--host',
        'Lambda',
        '--json',
      ],
      projectDir
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create gateway tool: ${result.stdout} ${result.stderr}`);
    }
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('requires name flag', async () => {
      const result = await runCLI(['remove', 'mcp-tool', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('--name'), `Error: ${json.error}`);
    });

    it('rejects non-existent tool', async () => {
      const result = await runCLI(['remove', 'mcp-tool', '--name', 'nonexistent', '--json'], projectDir);
      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.toLowerCase().includes('not found'), `Error: ${json.error}`);
    });
  });

  describe('remove mcp-runtime tool', () => {
    it('removes mcp-runtime tool and cleans up agent references', async () => {
      // Add a temp tool to remove
      const tempTool = `temp-rt-${Date.now()}`;
      await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          tempTool,
          '--language',
          'Python',
          '--exposure',
          'mcp-runtime',
          '--agents',
          agentName,
          '--json',
        ],
        projectDir
      );

      const result = await runCLI(['remove', 'mcp-tool', '--name', tempTool, '--json'], projectDir);
      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);

      // Verify tool is removed from mcp.json
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      const tool = mcpSpec.mcpRuntimeTools?.find((t: { name: string }) => t.name === tempTool);
      assert.ok(!tool, 'Tool should be removed from mcpRuntimeTools');

      // Verify agent reference is cleaned up
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentName);
      const hasRef = agent?.remoteTools?.some((rt: { mcpRuntimeName?: string }) => rt.mcpRuntimeName === tempTool);
      assert.ok(!hasRef, 'Agent should not have reference to removed tool');
    });
  });

  describe('remove behind-gateway tool', () => {
    it('removes behind-gateway tool from gateway targets', async () => {
      // Add a temp tool to remove
      const tempTool = `temp-gw-${Date.now()}`;
      await runCLI(
        [
          'add',
          'mcp-tool',
          '--name',
          tempTool,
          '--language',
          'Python',
          '--exposure',
          'behind-gateway',
          '--gateway',
          gatewayName,
          '--host',
          'Lambda',
          '--json',
        ],
        projectDir
      );

      const result = await runCLI(['remove', 'mcp-tool', '--name', tempTool, '--json'], projectDir);
      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}`);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);

      // Verify tool is removed from gateway targets
      const mcpSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/mcp.json'), 'utf-8'));
      const gateway = mcpSpec.agentCoreGateways?.find((g: { name: string }) => g.name === gatewayName);
      const target = gateway?.targets?.find((t: { name: string }) => t.name === tempTool);
      assert.ok(!target, 'Tool should be removed from gateway targets');
    });
  });
});
