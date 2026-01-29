import { access } from 'node:fs/promises';

/**
 * Check if a file or directory exists.
 *
 * @param path - Path to check
 * @returns Promise resolving to true if path exists, false otherwise
 *
 * @example
 * ```ts
 * if (await exists(join(projectDir, 'agentcore.json'))) {
 *   // file exists
 * }
 * ```
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
