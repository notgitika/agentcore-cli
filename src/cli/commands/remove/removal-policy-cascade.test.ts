import { runCLI } from '../../../test-utils/index.js';
import { afterAll, beforeAll, describe, it } from 'bun:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('removal policy cascade', () => {
  let testDir: string;
  let projectDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-removal-policy-cascade-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('memory cascade', () => {
    it('removes memory and cleans up user references with cascade', async () => {
      // Create fresh project
      const projectName = `MemCascadeProj${Date.now()}`;
      let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
      assert.strictEqual(result.exitCode, 0);
      const projDir = join(testDir, projectName);

      // Add owner and user agents
      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'Owner',
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
          'User',
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

      // Add memory with user
      result = await runCLI(
        [
          'add',
          'memory',
          '--name',
          'SharedMem',
          '--strategies',
          'SEMANTIC',
          '--owner',
          'Owner',
          '--users',
          'User',
          '--json',
        ],
        projDir
      );
      assert.strictEqual(result.exitCode, 0);

      // Remove memory with cascade
      result = await runCLI(['remove', 'memory', '--name', 'SharedMem', '--policy', 'cascade', '--json'], projDir);
      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}`);

      // Verify memory is removed from both agents
      const projectSpec = JSON.parse(await readFile(join(projDir, 'agentcore/agentcore.json'), 'utf-8'));
      const owner = projectSpec.agents.find((a: { name: string }) => a.name === 'Owner');
      const user = projectSpec.agents.find((a: { name: string }) => a.name === 'User');

      const ownerHasMem = owner?.memoryProviders?.some((m: { name: string }) => m.name === 'SharedMem');
      const userHasMem = user?.memoryProviders?.some((m: { name: string }) => m.name === 'SharedMem');

      assert.ok(!ownerHasMem, 'Owner should not have memory');
      assert.ok(!userHasMem, 'User should not have memory');
    });
  });

  describe('identity cascade', () => {
    it('removes identity and cleans up user references with cascade', async () => {
      // Create fresh project
      const projectName = `IdCascadeProj${Date.now()}`;
      let result = await runCLI(['create', '--name', projectName, '--no-agent'], testDir);
      assert.strictEqual(result.exitCode, 0);
      const projDir = join(testDir, projectName);

      // Add owner and user agents
      result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'Owner',
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
          'User',
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

      // Add identity with user
      result = await runCLI(
        [
          'add',
          'identity',
          '--name',
          'SharedId',
          '--type',
          'ApiKeyCredentialProvider',
          '--api-key',
          'test-key',
          '--owner',
          'Owner',
          '--users',
          'User',
          '--json',
        ],
        projDir
      );
      assert.strictEqual(result.exitCode, 0);

      // Remove identity with cascade
      result = await runCLI(['remove', 'identity', '--name', 'SharedId', '--policy', 'cascade', '--json'], projDir);
      assert.strictEqual(result.exitCode, 0, `stdout: ${result.stdout}`);

      // Verify identity is removed from both agents
      const projectSpec = JSON.parse(await readFile(join(projDir, 'agentcore/agentcore.json'), 'utf-8'));
      const owner = projectSpec.agents.find((a: { name: string }) => a.name === 'Owner');
      const user = projectSpec.agents.find((a: { name: string }) => a.name === 'User');

      const ownerHasId = owner?.identityProviders?.some((i: { name: string }) => i.name === 'SharedId');
      const userHasId = user?.identityProviders?.some((i: { name: string }) => i.name === 'SharedId');

      assert.ok(!ownerHasId, 'Owner should not have identity');
      assert.ok(!userHasId, 'User should not have identity');
    });
  });
});
