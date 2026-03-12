import type { EvaluationLevel, EvaluatorConfig } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Evaluator Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddEvaluatorStep = 'name' | 'level' | 'model' | 'instructions' | 'ratingScale' | 'confirm';

export interface AddEvaluatorConfig {
  name: string;
  level: EvaluationLevel;
  config: EvaluatorConfig;
}

export const EVALUATOR_STEP_LABELS: Record<AddEvaluatorStep, string> = {
  name: 'Name',
  level: 'Level',
  model: 'Model',
  instructions: 'Prompt',
  ratingScale: 'Scale',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const EVALUATION_LEVEL_OPTIONS = [
  { id: 'SESSION', title: 'Session', description: 'Evaluate entire conversation sessions' },
  { id: 'TRACE', title: 'Trace', description: 'Evaluate individual agent traces' },
  { id: 'TOOL_CALL', title: 'Tool Call', description: 'Evaluate individual tool calls' },
] as const;

export const DEFAULT_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allowed placeholders per evaluation level. The API requires instructions
 * to contain at least one placeholder from the evaluator's level.
 */
export const LEVEL_PLACEHOLDERS: Record<EvaluationLevel, string[]> = {
  SESSION: ['available_tools', 'context', 'actual_trajectory', 'expected_trajectory', 'assertions'],
  TRACE: ['available_tools', 'context', 'actual_trajectory', 'expected_trajectory', 'assertions'],
  TOOL_CALL: ['tool_name', 'tool_input', 'tool_output', 'context'],
};

/**
 * Default instruction templates per level that include required placeholders.
 */
export const DEFAULT_INSTRUCTIONS: Record<EvaluationLevel, string> = {
  SESSION:
    'Evaluate the agent session based on the following conversation. Context: {context}. Rate the overall quality of the response.',
  TRACE:
    'Evaluate the agent trace based on the following conversation. Context: {context}. Rate the quality of this trace.',
  TOOL_CALL:
    'Evaluate the tool call. Tool: {tool_name}. Input: {tool_input}. Output: {tool_output}. Rate the quality of this tool usage.',
};

/**
 * Validates that instructions contain at least one placeholder for the given level.
 */
export function validateInstructionPlaceholders(instructions: string, level: EvaluationLevel): string | true {
  const placeholders = LEVEL_PLACEHOLDERS[level];
  const hasPlaceholder = placeholders.some(p => instructions.includes(`{${p}}`));
  if (!hasPlaceholder) {
    return `Instructions must contain at least one placeholder: ${placeholders.map(p => `{${p}}`).join(', ')}`;
  }
  return true;
}

export interface RatingScalePreset {
  id: string;
  title: string;
  description: string;
  ratingScale: EvaluatorConfig['llmAsAJudge']['ratingScale'];
}

export const RATING_SCALE_PRESETS: RatingScalePreset[] = [
  {
    id: '1-5-quality',
    title: '1–5 Quality (Numerical)',
    description: 'Five-point quality scale from Poor to Excellent',
    ratingScale: {
      numerical: [
        { value: 1, label: 'Poor', definition: 'Fails to meet expectations' },
        { value: 2, label: 'Fair', definition: 'Partially meets expectations' },
        { value: 3, label: 'Good', definition: 'Meets expectations' },
        { value: 4, label: 'Very Good', definition: 'Exceeds expectations' },
        { value: 5, label: 'Excellent', definition: 'Far exceeds expectations' },
      ],
    },
  },
  {
    id: '1-3-simple',
    title: '1–3 Simple (Numerical)',
    description: 'Three-point scale: Low, Medium, High',
    ratingScale: {
      numerical: [
        { value: 1, label: 'Low', definition: 'Below acceptable quality' },
        { value: 2, label: 'Medium', definition: 'Acceptable quality' },
        { value: 3, label: 'High', definition: 'Above acceptable quality' },
      ],
    },
  },
  {
    id: 'pass-fail',
    title: 'Pass / Fail (Categorical)',
    description: 'Binary pass or fail assessment',
    ratingScale: {
      categorical: [
        { label: 'Pass', definition: 'Meets the evaluation criteria' },
        { label: 'Fail', definition: 'Does not meet the evaluation criteria' },
      ],
    },
  },
  {
    id: 'good-neutral-bad',
    title: 'Good / Neutral / Bad (Categorical)',
    description: 'Three-tier categorical assessment',
    ratingScale: {
      categorical: [
        { label: 'Good', definition: 'Positive outcome, meets or exceeds criteria' },
        { label: 'Neutral', definition: 'Acceptable but unremarkable outcome' },
        { label: 'Bad', definition: 'Negative outcome, fails to meet criteria' },
      ],
    },
  },
];
