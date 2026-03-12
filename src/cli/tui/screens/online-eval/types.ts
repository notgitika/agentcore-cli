// ─────────────────────────────────────────────────────────────────────────────
// Online Eval Config Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddOnlineEvalStep = 'name' | 'agents' | 'evaluators' | 'samplingRate' | 'confirm';

export interface AddOnlineEvalConfig {
  name: string;
  agents: string[];
  evaluators: string[];
  samplingRate: number;
  description?: string;
  enableOnCreate?: boolean;
}

export const ONLINE_EVAL_STEP_LABELS: Record<AddOnlineEvalStep, string> = {
  name: 'Name',
  agents: 'Agents',
  evaluators: 'Evaluators',
  samplingRate: 'Rate',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// Built-in Evaluators
// ─────────────────────────────────────────────────────────────────────────────

export const BUILTIN_EVALUATORS = [
  { id: 'Builtin.Helpfulness', title: 'Builtin.Helpfulness', description: 'Measures how helpful agent responses are' },
  {
    id: 'Builtin.GoalSuccessRate',
    title: 'Builtin.GoalSuccessRate',
    description: 'Measures whether the agent achieved the user goal',
  },
  {
    id: 'Builtin.Faithfulness',
    title: 'Builtin.Faithfulness',
    description: 'Measures factual consistency with source material',
  },
] as const;

export const DEFAULT_SAMPLING_RATE = 10;
