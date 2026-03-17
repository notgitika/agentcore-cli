import { getErrorMessage } from '../../errors';
import { loadEvalRun } from './storage';
import type { EvalRunResult, GetEvalRunOptions } from './types';

export interface GetEvalRunResult {
  success: boolean;
  error?: string;
  run?: EvalRunResult;
}

export function handleGetEvalRun(options: GetEvalRunOptions): GetEvalRunResult {
  try {
    const run = loadEvalRun(options.filename);
    return { success: true, run };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}
