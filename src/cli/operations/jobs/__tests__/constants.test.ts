import { NOT_FOUND_STATUS, isTerminal } from '../constants';
import type { BatchEvaluationJobRecord, RecommendationJobRecord } from '../types';
import { describe, expect, it } from 'vitest';

function rec(status: string): RecommendationJobRecord {
  return {
    type: 'recommendation',
    id: 'rec-1',
    arn: 'arn',
    status,
    createdAt: '2026-06-01T00:00:00Z',
    agent: 'a',
    recommendationType: 'SYSTEM_PROMPT_RECOMMENDATION',
    evaluators: [],
    inputSource: 'inline',
  };
}

function batch(status: string, error?: string): BatchEvaluationJobRecord {
  return {
    type: 'batch-evaluation',
    id: 'be-1',
    arn: 'arn',
    status,
    createdAt: '2026-06-01T00:00:00Z',
    agent: 'a',
    name: 'n',
    evaluators: [],
    error,
  };
}

describe('isTerminal', () => {
  it('treats recommendation COMPLETED/FAILED/NOT_FOUND as terminal', () => {
    expect(isTerminal(rec('COMPLETED'))).toBe(true);
    expect(isTerminal(rec('FAILED'))).toBe(true);
    expect(isTerminal(rec(NOT_FOUND_STATUS))).toBe(true);
  });

  it('treats recommendation PENDING/IN_PROGRESS as non-terminal', () => {
    expect(isTerminal(rec('PENDING'))).toBe(false);
    expect(isTerminal(rec('IN_PROGRESS'))).toBe(false);
  });

  it('treats batch COMPLETED/NOT_FOUND as terminal', () => {
    expect(isTerminal(batch('COMPLETED'))).toBe(true);
    expect(isTerminal(batch(NOT_FOUND_STATUS))).toBe(true);
  });

  it('treats a record with error as terminal regardless of status', () => {
    expect(isTerminal(batch('IN_PROGRESS', 'refresh failed'))).toBe(true);
    expect(isTerminal(rec('PENDING'))).toBe(false); // no error → non-terminal
  });

  it('treats unknown statuses as non-terminal', () => {
    expect(isTerminal(rec('SOMETHING_NEW'))).toBe(false);
    expect(isTerminal(batch('STOPPING'))).toBe(false);
  });
});
