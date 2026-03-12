import { findConfigRoot } from '../../../lib';
import type { EvalRunResult } from './types';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const EVAL_RESULTS_DIR = 'eval-results';

function getResultsDir(): string {
  const configRoot = findConfigRoot();
  if (!configRoot) {
    throw new Error('No agentcore project found. Run `agentcore create` first.');
  }
  return join(configRoot, EVAL_RESULTS_DIR);
}

export function generateRunId(): string {
  return `run_${randomUUID()}`;
}

export function saveEvalRun(result: EvalRunResult): string {
  const dir = getResultsDir();
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `${result.runId}.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2));
  return filePath;
}

export function loadEvalRun(runId: string): EvalRunResult {
  const dir = getResultsDir();
  const filePath = join(dir, `${runId}.json`);

  if (!existsSync(filePath)) {
    throw new Error(`Eval run "${runId}" not found at ${filePath}`);
  }

  return JSON.parse(readFileSync(filePath, 'utf-8')) as EvalRunResult;
}

export function listEvalRuns(): EvalRunResult[] {
  const dir = getResultsDir();

  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir)
    .filter(f => f.startsWith('run_') && f.endsWith('.json'))
    .sort()
    .reverse();

  return files.map(f => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as EvalRunResult);
}
