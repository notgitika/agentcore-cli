import { runCLI } from '../../../test-utils/index.js';
import { describe, it } from 'bun:test';
import assert from 'node:assert';

describe('dev command', () => {
  describe('--help', () => {
    it('shows all options', async () => {
      const result = await runCLI(['dev', '--help']);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('--port'), 'Should show --port option');
      assert.ok(result.stdout.includes('--agent'), 'Should show --agent option');
      assert.ok(result.stdout.includes('--invoke'), 'Should show --invoke option');
      assert.ok(result.stdout.includes('--stream'), 'Should show --stream option');
      assert.ok(result.stdout.includes('--logs'), 'Should show --logs option');
      assert.ok(result.stdout.includes('8080'), 'Should show default port');
    });
  });

  describe('requires project context', () => {
    it('exits with error when run outside project', async () => {
      const result = await runCLI(['dev']);

      assert.strictEqual(result.exitCode, 1);
      assert.ok(
        result.stdout.toLowerCase().includes('project') || result.stderr.toLowerCase().includes('project'),
        `Should mention project requirement, got: ${result.stdout}`
      );
    });
  });

  describe('flag validation', () => {
    it('rejects invalid port number', async () => {
      const result = await runCLI(['dev', '--port', 'abc']);

      assert.strictEqual(result.exitCode, 1);
    });

    it('rejects negative port number', async () => {
      const result = await runCLI(['dev', '--port', '-1']);

      assert.strictEqual(result.exitCode, 1);
    });

    it('stream flag is documented in help', async () => {
      const result = await runCLI(['dev', '--help']);

      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('--stream'), 'Should show --stream option');
      assert.ok(result.stdout.includes('--invoke'), 'Should show --invoke option');
    });
  });
});
