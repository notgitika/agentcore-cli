import { TagsSchema } from './tags';
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

/**
 * CloudWatch log group name validation.
 * @see https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/Working-with-log-groups-and-streams.html
 */
export const LogGroupNameSchema = z
  .string()
  .min(1, 'Log group name is required')
  .max(512)
  .regex(
    /^[a-zA-Z0-9_\-/.*]+$/,
    'Log group name may contain alphanumeric characters, underscores, hyphens, forward slashes, dots, and asterisks'
  );

export const ServiceNameSchema = z.string().min(1, 'Service name is required').max(256);

export const OnlineEvalConfigSchema = z
  .object({
    name: OnlineEvalConfigNameSchema,
    /** Agent name to monitor (must match a project agent). Required unless customLogGroupName and customServiceName are provided. */
    agent: z.string().min(1, 'Agent name is required').optional(),
    /** Evaluator names (custom), Builtin.* IDs, or evaluator ARNs */
    evaluators: z.array(z.string().min(1)).min(1, 'At least one evaluator is required'),
    /** Sampling rate as a percentage (0.01 to 100) */
    samplingRate: z.number().min(0.01).max(100),
    /** Optional description for the online eval config */
    description: z.string().max(200).optional(),
    /** Whether to enable execution on create (default: true) */
    enableOnCreate: z.boolean().optional(),
    /** Custom CloudWatch log group name for evaluating agents not hosted on AgentCore Runtime */
    customLogGroupName: LogGroupNameSchema.optional(),
    /** Custom service name for evaluating agents not hosted on AgentCore Runtime */
    customServiceName: ServiceNameSchema.optional(),
    tags: TagsSchema.optional(),
  })
  .refine(
    data => {
      // Custom fields must be provided together
      const hasLogGroup = data.customLogGroupName !== undefined;
      const hasServiceName = data.customServiceName !== undefined;
      return hasLogGroup === hasServiceName;
    },
    {
      message: 'Both "customLogGroupName" and "customServiceName" must be provided together',
    }
  )
  .refine(
    data => {
      const hasAgent = data.agent !== undefined;
      const hasCustom = data.customLogGroupName !== undefined && data.customServiceName !== undefined;
      // Exactly one source must be specified, not both
      return (hasAgent || hasCustom) && !(hasAgent && hasCustom);
    },
    {
      message:
        'Specify either "agent" (for project agents) or both "customLogGroupName" and "customServiceName" (for external agents), but not both',
    }
  );

export type OnlineEvalConfig = z.infer<typeof OnlineEvalConfigSchema>;
