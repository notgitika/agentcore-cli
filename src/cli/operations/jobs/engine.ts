/**
 * Job Engine factory. NOT a singleton — `createJobEngine(configIO)` per call site; configIO is
 * injected and read ONLY inside handler.create(). The engine owns persistence (start → save) and
 * the refresh-on-read lifecycle; commands/TUI stay thin.
 */
import { ConfigIO, JobNotFoundError } from '../../../lib';
import type { Result } from '../../../lib/result';
import { validateAwsCredentials } from '../../aws/account';
import { batchEvaluationHandler } from './batch-evaluation/handler';
import { JOB_CAPABILITIES, isTerminal } from './constants';
import { recommendationHandler } from './recommendation/handler';
import { deleteRecord, listRecords, loadRecord, saveRecord } from './storage';
import type {
  HandlerByType,
  JobCapabilities,
  JobEngine,
  JobRecord,
  JobType,
  ListOptions,
  RecordByType,
  StartOptionsByType,
  StoppableJobType,
} from './types';

/** Static registry; `satisfies` makes a missing trait on any handler a compile-time error. */
const handlers = {
  recommendation: recommendationHandler,
  'batch-evaluation': batchEvaluationHandler,
} as const satisfies HandlerByType;

/** Does this handler compose the optional Settles trait? */
function hasSettle<T extends JobType>(
  handler: HandlerByType[T]
): handler is HandlerByType[T] & { settle: (r: JobRecord, c: ConfigIO) => Promise<JobRecord> } {
  return typeof (handler as { settle?: unknown }).settle === 'function';
}

export function createJobEngine(configIO: ConfigIO = new ConfigIO()): JobEngine {
  const REFRESH_MAX_RETRIES = 3;

  /**
   * Refresh one record from the service with up to 3 retries. Handlers return Result — no try/catch
   * needed. On success, clears any prior error and persists. After all retries fail, persists
   * record.error with the last failure message so isTerminal() settles and the user sees it.
   */
  async function refreshOne<T extends JobType>(record: Extract<JobRecord, { type: T }>): Promise<JobRecord> {
    if (isTerminal(record)) {
      return record;
    }
    const handler = handlers[record.type];
    type RefreshFn = (r: typeof record) => Promise<Result<{ record: JobRecord }>>;
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt < REFRESH_MAX_RETRIES; attempt++) {
      const result = await (handler.refresh as RefreshFn)(record);
      if (result.success) {
        const updated = result.record;
        if (updated.error) {
          delete (updated as { error?: string }).error;
        }
        saveRecord(updated);
        return updated;
      }
      lastErr = result.error;
    }

    // All retries exhausted — persist the error so isTerminal() settles and the user sees it.
    const failed: JobRecord = { ...record, error: lastErr!.message };
    saveRecord(failed);
    return failed;
  }

  /** Run a handler's optional settle() step (sequential; may mutate project config). */
  async function settleOne(record: JobRecord): Promise<JobRecord> {
    const handler = handlers[record.type];
    if (!hasSettle(handler)) {
      return record;
    }
    try {
      const settled = await handler.settle(record, configIO);
      if (settled !== record) {
        saveRecord(settled);
      }
      return settled;
    } catch {
      return record;
    }
  }

  return {
    async start<T extends JobType>(type: T, opts: StartOptionsByType[T]): Promise<Result<{ record: RecordByType[T] }>> {
      const creds = await validateCredentials();
      if (!creds.success) {
        return creds;
      }
      const handler = handlers[type];
      // create is typed per-handler; the registry guarantees opts/record line up with `type`.
      const result = await (
        handler.create as (o: StartOptionsByType[T], c: ConfigIO) => Promise<Result<{ record: RecordByType[T] }>>
      )(opts, configIO);
      if (result.success) {
        saveRecord(result.record);
      }
      return result;
    },

    async get<T extends JobType>(type: T, id: string): Promise<RecordByType[T] | undefined> {
      const record = loadRecord(type, id);
      if (!record) {
        return undefined;
      }
      const refreshed = await refreshOne<T>(record);
      const settled = await settleOne(refreshed);
      return settled as RecordByType[T];
    },

    async list(opts?: ListOptions): Promise<JobRecord[]> {
      const records = listRecords(opts?.type);
      // Refresh statuses in parallel...
      const refreshed = await Promise.all(records.map(r => refreshOne(r)));
      // ...then run any config-mutating settle steps SEQUENTIALLY (avoids concurrent agentcore.json writes).
      const settled: JobRecord[] = [];
      for (const r of refreshed) {
        settled.push(await settleOne(r));
      }
      let out = settled;
      if (opts?.agent) {
        out = out.filter(r => r.agent === opts.agent);
      }
      out.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : a.id < b.id ? -1 : 1));
      if (opts?.limit != null) {
        out = out.slice(0, opts.limit);
      }
      return out;
    },

    async stop(type: StoppableJobType, id: string): Promise<Result> {
      const record = loadRecord(type, id);
      if (!record) {
        return { success: false, error: new JobNotFoundError(`Job "${id}" not found.`) };
      }
      // Only stoppable handlers are reachable here (type-narrowed); batch-evaluation composes Stoppable.
      const result = await handlers[type].stop(record);
      if (result.success) {
        saveRecord({ ...record, status: 'STOPPING' });
      }
      return result;
    },

    async archive(type: JobType, id: string): Promise<Result> {
      const record = loadRecord(type, id);
      if (!record) {
        return { success: false, error: new JobNotFoundError(`Job "${id}" not found.`) };
      }
      const handler = handlers[type];
      const result = await (handler.archive as (r: JobRecord) => Promise<Result>)(record);
      if (result.success) {
        deleteRecord(type, id);
      }
      return result;
    },

    capabilities(type: JobType): JobCapabilities {
      return JOB_CAPABILITIES[type];
    },
  };
}

/** Wrap validateAwsCredentials (which throws) into a Result so start() can return it cleanly. */
async function validateCredentials(): Promise<Result> {
  try {
    await validateAwsCredentials();
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}
