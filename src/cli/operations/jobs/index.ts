/**
 * Job Engine public API.
 *
 * Usage:
 *   const engine = createJobEngine(new ConfigIO());
 *   const r = await engine.start('recommendation', opts);
 *   const jobs = await engine.list({ type: 'recommendation' });
 */
export { createJobEngine } from './engine';
export { isTerminal, JOB_CAPABILITIES, STORAGE_DIRS, TERMINAL_STATUSES, NOT_FOUND_STATUS } from './constants';
export { regionFromArn } from './region';
export { waitForTerminal } from './wait';
export type { WaitForTerminalOptions } from './wait';
export { runDatasetPhase1, BATCH_INGESTION_DELAY_MS } from './batch-evaluation/dataset-phase1';
export type { DatasetPhase1Result } from './batch-evaluation/dataset-phase1';

export type {
  JobEngine,
  JobType,
  JobRecord,
  JobRecordBase,
  RecommendationJobRecord,
  BatchEvaluationJobRecord,
  JobCapabilities,
  ListOptions,
  StartRecommendationJobOptions,
  StartBatchEvaluationJobOptions,
  RecommendationInputSource,
  RecommendationTraceSource,
  BatchEvaluationSource,
  ToolDescJsonPath,
  RecommendationType,
} from './types';
