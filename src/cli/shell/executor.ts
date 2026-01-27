import { wrapCommandWithShellConfig } from './shell-wrapper';
import type { ShellExecutor, ShellExecutorCallbacks } from './types';
import { type ChildProcess, spawn } from 'node:child_process';

const MAX_OUTPUT_LINES = 2000;

/**
 * Spawns a shell command and streams output via callbacks.
 * Returns an executor handle for process control.
 */
export function spawnShellCommand(command: string, callbacks: ShellExecutorCallbacks): ShellExecutor {
  const { onOutput, onComplete, onError } = callbacks;

  let stdoutBuffer = '';
  let stderrBuffer = '';

  const processChunk = (buffer: string, data: Buffer): string => {
    const combined = buffer + data.toString();
    const lines = combined.split(/\r?\n/);
    const remaining = lines.pop() ?? '';
    if (lines.length > 0) {
      onOutput(lines);
    }
    return remaining;
  };

  const flushBuffers = () => {
    const remaining: string[] = [];
    if (stdoutBuffer) {
      remaining.push(stdoutBuffer);
      stdoutBuffer = '';
    }
    if (stderrBuffer) {
      remaining.push(stderrBuffer);
      stderrBuffer = '';
    }
    if (remaining.length > 0) {
      onOutput(remaining);
    }
  };

  let child: ChildProcess;
  try {
    // Wrap command to load shell config (aliases, PATH, etc.)
    const { executable, args } = wrapCommandWithShellConfig(command);
    child = spawn(executable, args, {
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (err) {
    onError(`Failed to spawn: ${(err as Error).message}`);
    onComplete(1);
    // Return a dummy executor
    return {
      child: null as unknown as ChildProcess,
      kill: () => {
        // No-op: process already failed to spawn
      },
    };
  }

  child.stdout?.on('data', (data: Buffer) => {
    stdoutBuffer = processChunk(stdoutBuffer, data);
  });

  child.stderr?.on('data', (data: Buffer) => {
    stderrBuffer = processChunk(stderrBuffer, data);
  });

  child.on('error', err => {
    flushBuffers();
    onError(`Error: ${err.message}`);
    onComplete(1);
  });

  child.on('close', code => {
    flushBuffers();
    onComplete(code);
  });

  return {
    child,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      if (!child.killed) {
        child.kill(signal);
      }
    },
  };
}

export interface TruncateResult {
  lines: string[];
  truncatedCount: number;
}

/**
 * Truncates output array to max lines (keeps most recent).
 * Returns both the truncated lines and how many were dropped.
 */
export function truncateOutput(lines: string[], maxLines: number = MAX_OUTPUT_LINES): TruncateResult {
  if (lines.length <= maxLines) {
    return { lines, truncatedCount: 0 };
  }
  const truncatedCount = lines.length - maxLines;
  return {
    lines: lines.slice(truncatedCount),
    truncatedCount,
  };
}
