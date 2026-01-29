/**
 * Mock Filesystem Client
 *
 * Browser-side mock filesystem that:
 * - Loads initial state from the server on startup
 * - Provides sync read/write operations (from in-memory cache)
 * - Persists writes to the server (async, fire-and-forget)
 *
 * This allows the TUI to work with synchronous fs operations
 * while changes are persisted to the dev server.
 */
import { MOCK_SCENARIO } from './harness-env';

// Types
export interface MockFile {
  content: string;
  lastModified: number;
}

export interface MockFileStore {
  [path: string]: MockFile;
}

// In-memory file store (populated from server on init)
let fileStore: MockFileStore = {};
let directories: Set<string> = new Set();
let initialized = false;
let initPromise: Promise<void> | null = null;

// Log flag
const LOG_OPERATIONS = false;

function log(...args: unknown[]) {
  if (LOG_OPERATIONS) {
    console.log('[mock-fs-client]', ...args);
  }
}

/**
 * Initialize the mock filesystem from the server.
 * Call this early in the app lifecycle.
 */
export async function initializeMockFs(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      log('Initializing from server...');
      const response = await fetch('/__mock-fs-sync');
      if (!response.ok) {
        throw new Error(`Failed to sync: ${response.status}`);
      }
      const data = await response.json();
      fileStore = data.files || {};
      directories = new Set(data.directories || []);
      initialized = true;
      log('Initialized with', Object.keys(fileStore).length, 'files');
    } catch (err) {
      console.error('[mock-fs-client] Failed to initialize:', err);
      // Initialize with empty state so app doesn't crash
      fileStore = {};
      directories = new Set();
      initialized = true;
    }
  })();

  return initPromise;
}

/**
 * Check if the mock filesystem is initialized.
 */
export function isInitialized(): boolean {
  return initialized;
}

/**
 * Wait for initialization to complete.
 */
export async function waitForInit(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  return initializeMockFs();
}

/**
 * Check if a file exists (synchronous, from cache).
 */
export function existsSync(filePath: string): boolean {
  if (!initialized) {
    console.warn('[mock-fs-client] existsSync called before initialization');
    return false;
  }
  const exists = filePath in fileStore || directories.has(filePath);
  log('existsSync', filePath, '->', exists);
  return exists;
}

/**
 * Check if path is a directory.
 */
export function isDirectory(filePath: string): boolean {
  return directories.has(filePath);
}

/**
 * Read file content (synchronous, from cache).
 */
export function readFileSync(filePath: string): string {
  if (!initialized) {
    console.warn('[mock-fs-client] readFileSync called before initialization');
    return '{}';
  }
  const file = fileStore[filePath];
  if (!file) {
    log('readFileSync', filePath, '-> NOT FOUND');
    return '{}';
  }
  log('readFileSync', filePath, '->', file.content.length, 'bytes');
  return file.content;
}

/**
 * Write file content (synchronous write to cache, async persist to server).
 */
export function writeFileSync(filePath: string, content: string): void {
  log('writeFileSync', filePath, content.length, 'bytes');

  // Update local cache immediately
  fileStore[filePath] = {
    content,
    lastModified: Date.now(),
  };

  // Persist to server asynchronously
  fetch(`/__mock-fs${filePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }).catch(err => {
    console.error('[mock-fs-client] Failed to persist write:', err);
  });
}

/**
 * Async read file (returns Promise).
 */
export async function readFile(filePath: string): Promise<string> {
  await waitForInit();
  return readFileSync(filePath);
}

/**
 * Async write file (returns Promise when persisted to server).
 */
export async function writeFile(filePath: string, content: string): Promise<void> {
  await waitForInit();

  // Update local cache
  fileStore[filePath] = {
    content,
    lastModified: Date.now(),
  };

  // Persist to server
  const response = await fetch(`/__mock-fs${filePath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    throw new Error(`Failed to write file: ${response.status}`);
  }
}

/**
 * Delete a file.
 */
export async function deleteFile(filePath: string): Promise<void> {
  await waitForInit();

  delete fileStore[filePath];

  const response = await fetch(`/__mock-fs${filePath}`, {
    method: 'DELETE',
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete file: ${response.status}`);
  }
}

/**
 * List files in a directory.
 */
export function readdirSync(dirPath: string): string[] {
  if (!initialized) {
    console.warn('[mock-fs-client] readdirSync called before initialization');
    return [];
  }

  const prefix = dirPath.endsWith('/') ? dirPath : dirPath + '/';
  const files = Object.keys(fileStore)
    .filter(p => p.startsWith(prefix))
    .map(p => {
      const rest = p.slice(prefix.length);
      const firstSlash = rest.indexOf('/');
      return firstSlash === -1 ? rest : rest.slice(0, firstSlash);
    })
    .filter((v, i, a) => a.indexOf(v) === i); // unique

  log('readdirSync', dirPath, '->', files);
  return files;
}

/**
 * Reset the filesystem to initial state.
 */
export async function resetMockFs(): Promise<void> {
  const response = await fetch('/__mock-fs-reset', { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Failed to reset: ${response.status}`);
  }

  // Re-sync from server
  initialized = false;
  initPromise = null;
  await initializeMockFs();
}

/**
 * Get the current file store (for debugging).
 */
export function getFileStore(): Readonly<MockFileStore> {
  return fileStore;
}

/**
 * Get current scenario.
 */
export function getCurrentScenario(): string {
  return MOCK_SCENARIO;
}

// Auto-initialize when module loads (will be ready by the time React renders)
initializeMockFs();
