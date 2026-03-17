import { handleGetEvalRun } from '../get-eval-run.js';
import type { EvalRunResult } from '../types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockLoadEvalRun = vi.fn();

vi.mock('../storage', () => ({
  loadEvalRun: (...args: unknown[]) => mockLoadEvalRun(...args),
}));

const sampleRun: EvalRunResult = {
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

    const result = handleGetEvalRun({ filename: 'eval_2025-01-15_10-00-00' });

    expect(result.success).toBe(true);
    expect(result.run).toEqual(sampleRun);
    expect(mockLoadEvalRun).toHaveBeenCalledWith('eval_2025-01-15_10-00-00');
  });

  it('returns error when run is not found', () => {
    mockLoadEvalRun.mockImplementation(() => {
      throw new Error('Eval run "eval_2025-01-01_00-00-00" not found');
    });

    const result = handleGetEvalRun({ filename: 'eval_2025-01-01_00-00-00' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(result.run).toBeUndefined();
  });

  it('handles non-Error thrown values via getErrorMessage', () => {
    mockLoadEvalRun.mockImplementation(() => {
      throw new Error('string error');
    });

    const result = handleGetEvalRun({ filename: 'eval_bad' });

    expect(result.success).toBe(false);
    expect(result.error).toBe('string error');
  });
});
