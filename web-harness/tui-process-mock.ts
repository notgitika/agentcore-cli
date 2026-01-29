// Mock for tui/utils/process.ts - no-op implementations for browser

export async function isProcessRunning(_pid: number): Promise<boolean> {
  return false;
}

export async function cleanupStaleLockFiles(_cdkOutDir: string): Promise<void> {
  // No-op in browser
}
