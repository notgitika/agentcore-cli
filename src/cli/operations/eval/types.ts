/** Result of a single evaluator within an eval run */
export interface EvalEvaluatorResult {
  evaluator: string;
  aggregateScore: number;
  sessionScores: EvalSessionScore[];
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/** Per-session score from an evaluator */
export interface EvalSessionScore {
  sessionId: string;
  traceId?: string;
  spanId?: string;
  value: number;
  label?: string;
  explanation?: string;
  errorMessage?: string;
}

/** Full eval run result stored to disk */
export interface EvalRunResult {
  runId: string;
  timestamp: string;
  agent: string;
  evaluators: string[];
  lookbackDays: number;
  sessionCount: number;
  results: EvalEvaluatorResult[];
}

/** Options for running an eval */
export interface RunEvalOptions {
  agent?: string;
  evaluator: string[];
  evaluatorArn?: string[];
  days: number;
  output?: string;
  json?: boolean;
}

/** Options for listing eval runs */
export interface ListEvalRunsOptions {
  agent?: string;
  limit?: number;
  json?: boolean;
}

/** Options for getting a single eval run */
export interface GetEvalRunOptions {
  runId: string;
  sessions?: boolean;
  json?: boolean;
}

/** Options for pause/resume online eval */
export interface OnlineEvalActionOptions {
  name: string;
  json?: boolean;
}
