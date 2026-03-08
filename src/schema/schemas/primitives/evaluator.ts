import { z } from 'zod';

// ============================================================================
// Evaluator Types
// ============================================================================

export const EvaluationLevelSchema = z.enum(['SESSION', 'TRACE', 'TOOL_CALL']);
export type EvaluationLevel = z.infer<typeof EvaluationLevelSchema>;

export const EvaluatorNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

// ============================================================================
// Rating Scale
// ============================================================================

export const NumericalRatingSchema = z.object({
  value: z.number().int(),
  label: z.string().min(1),
  definition: z.string().min(1),
});

export type NumericalRating = z.infer<typeof NumericalRatingSchema>;

export const CategoricalRatingSchema = z.object({
  label: z.string().min(1),
  definition: z.string().min(1),
});

export type CategoricalRating = z.infer<typeof CategoricalRatingSchema>;

export const RatingScaleSchema = z
  .object({
    numerical: z.array(NumericalRatingSchema).optional(),
    categorical: z.array(CategoricalRatingSchema).optional(),
  })
  .refine(
    scale => {
      const hasNumerical = Boolean(scale.numerical);
      const hasCategorical = Boolean(scale.categorical);
      return hasNumerical !== hasCategorical;
    },
    { message: 'Rating scale must have either numerical or categorical, not both' }
  );

export type RatingScale = z.infer<typeof RatingScaleSchema>;

// ============================================================================
// LLM-as-a-Judge Config
// ============================================================================

export const LlmAsAJudgeConfigSchema = z.object({
  model: z.string().min(1, 'Model ID is required'),
  instructions: z.string().min(1, 'Evaluation instructions are required'),
  ratingScale: RatingScaleSchema,
});

export type LlmAsAJudgeConfig = z.infer<typeof LlmAsAJudgeConfigSchema>;

// ============================================================================
// Evaluator Config
// ============================================================================

export const EvaluatorConfigSchema = z.object({
  llmAsAJudge: LlmAsAJudgeConfigSchema,
});

export type EvaluatorConfig = z.infer<typeof EvaluatorConfigSchema>;
