// Mock for shell module - no-op implementations for browser

// Types
export type ShellMode = 'inactive' | 'input' | 'running' | 'done';

export interface ShellOutput {
  lines: string[];
  exitCode: number | null;
}

export interface ShellExecutorCallbacks {
  onOutput: (lines: string[]) => void;
  onComplete: (exitCode: number | null) => void;
  onError: (error: string) => void;
}

export interface ShellExecutor {
  kill: (signal?: string) => void;
}

// Functions
export function warmupShell(): void {
  console.log('[browser mock] warmupShell called');
}

export function destroyShell(): void {
  console.log('[browser mock] destroyShell called');
}

export function spawnPersistentShellCommand(command: string, callbacks: ShellExecutorCallbacks): ShellExecutor {
  // Simulate command execution with mock output
  setTimeout(() => {
    callbacks.onOutput([`$ ${command}`, '(Commands are mocked in browser)']);
  }, 50);

  setTimeout(() => {
    callbacks.onComplete(0);
  }, 150);

  return {
    kill: (_signal?: string) => {
      console.log('[browser mock] persistent shell kill called');
      callbacks.onComplete(130);
    },
  };
}

export function spawnShellCommand(command: string, callbacks: ShellExecutorCallbacks): ShellExecutor {
  // Simulate command execution with mock output
  setTimeout(() => {
    callbacks.onOutput([`$ ${command}`, '(Commands are mocked in browser)']);
  }, 50);

  setTimeout(() => {
    callbacks.onComplete(0);
  }, 150);

  return {
    kill: (_signal?: string) => console.log('[browser mock] shell kill called'),
  };
}

export function truncateOutput(lines: string[], _maxLines: number = 500): string[] {
  return lines;
}
