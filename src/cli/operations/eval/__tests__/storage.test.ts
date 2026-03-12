import { generateRunId, listEvalRuns, loadEvalRun, saveEvalRun } from '../storage.js';
import type { EvalRunResult } from '../types.js';
// Use real fs via a temp directory
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindConfigRoot = vi.fn();

vi.mock('../../../../lib', () => ({
  findConfigRoot: () => mockFindConfigRoot(),
}));

function makeTmpDir(): string {
  const dir = join(tmpdir(), `eval-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRunResult(overrides: Partial<EvalRunResult> = {}): EvalRunResult {
  return {
    runId: overrides.runId ?? `run_${Date.now()}`,
    timestamp: '2025-01-15T10:00:00.000Z',
    agent: 'test-agent',
    evaluators: ['Builtin.GoalSuccessRate'],
    lookbackDays: 7,
    sessionCount: 3,
    results: [
      {
        evaluator: 'Builtin.GoalSuccessRate',
        aggregateScore: 0.85,
        sessionScores: [{ sessionId: 's1', value: 0.85 }],
      },
    ],
    ...overrides,
  };
}

describe('storage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mockFindConfigRoot.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  describe('generateRunId', () => {
    it('returns a string starting with run_', () => {
      const id = generateRunId();
      expect(id).toMatch(/^run_[0-9a-f-]+$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateRunId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('saveEvalRun', () => {
    it('creates eval-results directory and writes JSON file', () => {
      const run = makeRunResult({ runId: 'run_save-test' });
      const filePath = saveEvalRun(run);

      expect(filePath).toContain('eval-results');
      expect(filePath).toContain('run_save-test.json');
      expect(existsSync(filePath)).toBe(true);
    });

    it('writes valid JSON that can be read back', () => {
      const run = makeRunResult({ runId: 'run_roundtrip' });
      saveEvalRun(run);
      const loaded = loadEvalRun('run_roundtrip');
      expect(loaded).toEqual(run);
    });
  });

  describe('loadEvalRun', () => {
    it('loads a previously saved run', () => {
      const run = makeRunResult({ runId: 'run_load-test', agent: 'my-agent' });
      saveEvalRun(run);

      const loaded = loadEvalRun('run_load-test');
      expect(loaded.agent).toBe('my-agent');
      expect(loaded.results).toHaveLength(1);
    });

    it('throws for a non-existent run ID', () => {
      expect(() => loadEvalRun('run_does-not-exist')).toThrow('Eval run "run_does-not-exist" not found');
    });
  });

  describe('listEvalRuns', () => {
    it('returns empty array when eval-results dir does not exist', () => {
      // Point to a dir with no eval-results subdirectory
      const emptyDir = makeTmpDir();
      mockFindConfigRoot.mockReturnValue(emptyDir);

      expect(listEvalRuns()).toEqual([]);

      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('returns saved runs', () => {
      saveEvalRun(makeRunResult({ runId: 'run_aaa' }));
      saveEvalRun(makeRunResult({ runId: 'run_bbb' }));

      const runs = listEvalRuns();
      expect(runs).toHaveLength(2);
    });

    it('returns runs in reverse sorted order (newest first)', () => {
      saveEvalRun(makeRunResult({ runId: 'run_aaa' }));
      saveEvalRun(makeRunResult({ runId: 'run_zzz' }));
      saveEvalRun(makeRunResult({ runId: 'run_mmm' }));

      const runs = listEvalRuns();
      expect(runs.map(r => r.runId)).toEqual(['run_zzz', 'run_mmm', 'run_aaa']);
    });

    it('ignores files that do not match the naming pattern', async () => {
      saveEvalRun(makeRunResult({ runId: 'run_valid' }));

      // Write a file that doesn't match the pattern
      const resultsDir = join(tmpDir, 'eval-results');
      const { writeFileSync } = await import('fs');
      writeFileSync(join(resultsDir, 'notes.txt'), 'not a run');
      writeFileSync(join(resultsDir, 'other.json'), '{}');

      const runs = listEvalRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.runId).toBe('run_valid');
    });
  });

  describe('error when no config root', () => {
    it('throws when findConfigRoot returns null', () => {
      mockFindConfigRoot.mockReturnValue(null);
      expect(() => saveEvalRun(makeRunResult())).toThrow('No agentcore project found');
    });
  });
});
