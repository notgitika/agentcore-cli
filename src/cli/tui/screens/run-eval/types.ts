import type { EvaluatorItem } from '../online-eval/types';

export type RunEvalStep = 'agent' | 'evaluators' | 'days' | 'confirm';

export interface RunEvalConfig {
  agent: string;
  evaluators: string[];
  days: number;
}

export const RUN_EVAL_STEP_LABELS: Record<RunEvalStep, string> = {
  agent: 'Agent',
  evaluators: 'Evaluators',
  days: 'Lookback',
  confirm: 'Confirm',
};

export const DEFAULT_LOOKBACK_DAYS = 7;

export interface AgentItem {
  name: string;
  build: string;
}

export interface RunEvalFlowData {
  agents: AgentItem[];
  evaluators: EvaluatorItem[];
}
