import { spawn } from 'node:child_process';
import { join } from 'node:path';

/**
 * Result from running a CLI command.
 */
export interface RunResult {
  /** Stdout output with ANSI codes stripped */
  stdout: string;
  /** Stderr output */
  stderr: string;
  /** Process exit code */
  exitCode: number;
}

/**
 * Get the path to the CLI entry point.
 * Works from any test file location within the project.
 */
function getCLIPath(): string {
  // Navigate from src/test-utils to src/cli/index.ts
  return join(__dirname, '..', 'cli', 'index.ts');
}

/**
 * Run the AgentCore CLI with the given arguments.
 *
 * @param args - CLI arguments to pass
 * @param cwd - Working directory to run the command in
 * @returns Promise resolving to the command result
 *
 * @example
 * ```ts
 * const result = await runCLI(['create', '--name', 'MyProject', '--json'], testDir);
 * assert.strictEqual(result.exitCode, 0);
 * ```
 */
export async function runCLI(args: string[], cwd: string, skipInstall = true): Promise<RunResult> {
  const cliPath = getCLIPath();

  return new Promise(resolve => {
    const proc = spawn('bun', ['run', cliPath, ...args], {
      cwd,
      env: { ...process.env, INIT_CWD: undefined, ...(skipInstall ? { AGENTCORE_SKIP_INSTALL: '1' } : {}) },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => {
      stdout += data.toString();
    });

    proc.stderr.on('data', data => {
      stderr += data.toString();
    });

    proc.on('close', code => {
      // Strip ANSI escape codes from stdout
      stdout = stdout.replace(/\x1B\[\??\d*[a-zA-Z]/g, '').trim();
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
