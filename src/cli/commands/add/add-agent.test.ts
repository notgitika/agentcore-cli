import { exists, runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('add agent command', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-add-agent-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });

    // Create a project first
    const projectName = 'TestProj';
    const result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create project: ${result.stdout} ${result.stderr}`);
    }
    projectDir = join(testDir, projectName);
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('create path', () => {
    it('creates agent with valid inputs', async () => {
      const agentName = `Agent${Date.now()}`;
      const result = await runCLI(
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

      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}, stderr: ${result.stderr}`);

      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.agentName, agentName);

      // Verify agent code exists
      assert.ok(await exists(join(projectDir, 'app', agentName)), 'Agent code should exist');

      // Verify agent in agentcore.json
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentName);
      assert.ok(agent, 'Agent should be in agentcore.json');
    });

    it('requires all create path options', async () => {
      const result = await runCLI(['add', 'agent', '--name', 'Incomplete', '--json'], projectDir);

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('required'), `Error should mention required: ${json.error}`);
    });

    it('validates framework', async () => {
      const result = await runCLI(
        [
          'add',
          'agent',
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
        projectDir
      );

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('Invalid framework'), `Error: ${json.error}`);
    });

    it('rejects TypeScript for create path', async () => {
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'TSAgent',
          '--language',
          'TypeScript',
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

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('Python'), `Error should mention Python: ${json.error}`);
    });

    it('validates framework/model compatibility', async () => {
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'BadCombo',
          '--language',
          'Python',
          '--framework',
          'OpenAIAgents',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
          '--json',
        ],
        projectDir
      );

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('does not support'), `Error: ${json.error}`);
    });

    it('rejects duplicate agent name', async () => {
      const agentName = 'DupeAgent';

      // First creation should succeed
      const first = await runCLI(
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
      assert.strictEqual(first.exitCode, 0, `First should succeed: ${first.stdout}`);

      // Second creation should fail
      const second = await runCLI(
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

      assert.strictEqual(second.exitCode, 1);
      const json = JSON.parse(second.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('already exists'), `Error: ${json.error}`);
    });
  });

  describe('BYO path', () => {
    it('registers BYO agent', async () => {
      const agentName = `ByoAgent${Date.now()}`;
      const codeDir = 'existing-agent';

      // Create existing code directory
      await mkdir(join(projectDir, codeDir), { recursive: true });
      await writeFile(join(projectDir, codeDir, 'main.py'), '# existing code\n');

      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          agentName,
          '--type',
          'byo',
          '--code-location',
          codeDir,
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--json',
        ],
        projectDir
      );

      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}`);

      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.agentName, agentName);

      // Verify agent in agentcore.json with correct codeLocation
      const projectSpec = JSON.parse(await readFile(join(projectDir, 'agentcore/agentcore.json'), 'utf-8'));
      const agent = projectSpec.agents.find((a: { name: string }) => a.name === agentName);
      assert.ok(agent, 'Agent should be in agentcore.json');
      assert.ok(agent.runtime.codeLocation.includes(codeDir), `codeLocation should reference ${codeDir}`);
    });

    it('requires code-location for BYO path', async () => {
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'NoByo',
          '--type',
          'byo',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--json',
        ],
        projectDir
      );

      assert.strictEqual(result.exitCode, 1);
      const json = JSON.parse(result.stdout);
      assert.strictEqual(json.success, false);
      assert.ok(json.error.includes('code-location'), `Error: ${json.error}`);
    });
  });
});
