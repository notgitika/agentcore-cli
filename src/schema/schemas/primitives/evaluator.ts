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

export const BedrockModelIdSchema = z
  .string()
  .min(1, 'Model ID is required')
  .regex(
    /^(arn:aws(-[a-z]+)?:bedrock:[a-z0-9-]+:\d{12}:(inference-profile|foundation-model)\/[a-zA-Z0-9._:-]+|([a-z]{2}(-[a-z]+)?\.)?[a-z0-9]+\.[a-zA-Z0-9._-]+(:[0-9]+)?)$/,
    'Must be a valid Bedrock model ID (e.g. us.anthropic.claude-sonnet-4-5-20250929-v1:0) or model ARN'
  );

export const LlmAsAJudgeConfigSchema = z.object({
  model: BedrockModelIdSchema,
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
