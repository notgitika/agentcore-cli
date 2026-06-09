/**
 * Job Engine constants: storage directory names, per-type terminal-status sets,
 * capability flags, and shared validation patterns.
 */
import type { JobCapabilities, JobRecord, JobType } from './types';

/**
 * Local storage directory per job type, under `<configRoot>/.cli/`.
 * Reuses the existing directory names so the layout is unchanged.
 */
export const STORAGE_DIRS: Record<JobType, string> = {
  recommendation: 'recommendations',
  'batch-evaluation': 'batch-eval-results',
};

/** Sentinel status set when a refresh GET 404s (job deleted on the service). Terminal for both types. */
export const NOT_FOUND_STATUS = 'NOT_FOUND';

/**
 * Terminal statuses per job type. The two services emit different vocabularies, so terminality
 * is per-type — a single shared set would invent statuses neither service emits.
 * `SUCCEEDED`/`DELETING` are kept defensively for recommendations (`COMPLETED`/`FAILED` are authoritative).
 */
export const TERMINAL_STATUSES: Record<JobType, ReadonlySet<string>> = {
  recommendation: new Set(['COMPLETED', 'FAILED', 'SUCCEEDED', 'DELETING', NOT_FOUND_STATUS]),
  'batch-evaluation': new Set([
    'COMPLETED',
    'COMPLETED_WITH_ERRORS',
    'FAILED',
    'STOPPED',
    'CANCELLED',
    NOT_FOUND_STATUS,
  ]),
};

/** Runtime capability flags (TUI display only; engine legality is enforced by types). */
export const JOB_CAPABILITIES: Record<JobType, JobCapabilities> = {
  recommendation: { canStop: false },
  'batch-evaluation': { canStop: true },
};

/** Batch-evaluation name rule: start with a letter, then letters/digits/underscores, max 48 chars. */
export const BATCH_EVAL_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/;

/**
 * Whether a record is in a terminal state AND fully settled (no further work on read).
 *
 * A record is settled when:
 *  - Its status is terminal for its type, OR
 *  - It has a persistent `error` (refresh retries exhausted — stop trying).
 */
export function isTerminal(record: JobRecord): boolean {
  if (record.error) {
    return true; // refresh retries exhausted — settled with an error
  }
  return TERMINAL_STATUSES[record.type].has(record.status);
}
