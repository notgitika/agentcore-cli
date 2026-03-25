// ─────────────────────────────────────────────────────────────────────────────
// Online Eval Config Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type LogSourceType = 'project-agent' | 'external-agent';

export type AddOnlineEvalStep =
  | 'name'
  | 'logSource'
  | 'agent'
  | 'customServiceName'
  | 'customLogGroupName'
  | 'evaluators'
  | 'samplingRate'
  | 'enableOnCreate'
  | 'confirm';

export interface AddOnlineEvalConfig {
  name: string;
  agent?: string;
  evaluators: string[];
  samplingRate: number;
  enableOnCreate: boolean;
  description?: string;
  customLogGroupName?: string;
  customServiceName?: string;
}

export const ONLINE_EVAL_STEP_LABELS: Record<AddOnlineEvalStep, string> = {
  name: 'Name',
  logSource: 'Source',
  agent: 'Agent',
  customServiceName: 'Service',
  customLogGroupName: 'Log Group',
  evaluators: 'Evaluators',
  samplingRate: 'Rate',
  enableOnCreate: 'Enable',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator Items (fetched from API)
// ─────────────────────────────────────────────────────────────────────────────

export interface EvaluatorItem {
  /** ARN used as the stored identifier in the config */
  arn: string;
  /** Display name */
  name: string;
  /** 'Builtin' or 'Custom' */
  type: string;
  /** Optional description */
  description?: string;
}

export const DEFAULT_SAMPLING_RATE = 10;
