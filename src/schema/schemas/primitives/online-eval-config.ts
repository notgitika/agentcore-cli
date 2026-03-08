import { z } from 'zod';

// ============================================================================
// Online Eval Config Types
// ============================================================================

export const OnlineEvalConfigNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

export const OnlineEvalConfigSchema = z.object({
  type: z.literal('OnlineEvalConfig'),
  name: OnlineEvalConfigNameSchema,
  /** Agent names this online eval config monitors */
  agents: z.array(z.string().min(1)).min(1, 'At least one agent is required'),
  /** Evaluator names (custom) or Builtin.* IDs */
  evaluators: z.array(z.string().min(1)).min(1, 'At least one evaluator is required'),
  /** Sampling rate as a percentage (0.01 to 100) */
  samplingRate: z.number().min(0.01).max(100),
  /** Whether to start the pipeline immediately on deploy */
  enableOnCreate: z.boolean().default(true),
});

export type OnlineEvalConfig = z.infer<typeof OnlineEvalConfigSchema>;
