import { handleGetEvalRun } from '../get-eval-run.js';
import type { EvalRunResult } from '../types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockLoadEvalRun = vi.fn();

vi.mock('../storage', () => ({
  loadEvalRun: (...args: unknown[]) => mockLoadEvalRun(...args),
}));

const sampleRun: EvalRunResult = {
  runId: 'run_abc',
  timestamp: '2025-01-15T10:00:00.000Z',
  agent: 'test-agent',
  evaluators: ['Builtin.GoalSuccessRate'],
  lookbackDays: 7,
  sessionCount: 5,
  results: [
    {
      evaluator: 'Builtin.GoalSuccessRate',
      aggregateScore: 0.9,
      sessionScores: [{ sessionId: 's1', value: 0.9 }],
    },
  ],
};

describe('handleGetEvalRun', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns the run on success', () => {
    mockLoadEvalRun.mockReturnValue(sampleRun);

    const result = handleGetEvalRun({ runId: 'run_abc' });

    expect(result.success).toBe(true);
    expect(result.run).toEqual(sampleRun);
    expect(mockLoadEvalRun).toHaveBeenCalledWith('run_abc');
  });

  it('returns error when run is not found', () => {
    mockLoadEvalRun.mockImplementation(() => {
      throw new Error('Eval run "run_missing" not found');
    });

    const result = handleGetEvalRun({ runId: 'run_missing' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('run_missing');
    expect(result.run).toBeUndefined();
  });

  it('handles non-Error thrown values via getErrorMessage', () => {
    mockLoadEvalRun.mockImplementation(() => {
      throw new Error('string error');
    });

    const result = handleGetEvalRun({ runId: 'run_bad' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('string error');
  });
});
