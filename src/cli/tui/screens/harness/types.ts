import type { HarnessModelProvider, NetworkMode } from '../../../../schema';

export type ContainerMode = 'none' | 'uri' | 'dockerfile';

export type AddHarnessStep =
  | 'name'
  | 'model-provider'
  | 'api-key-arn'
  | 'container'
  | 'container-uri'
  | 'container-dockerfile'
  | 'advanced'
  | 'memory'
  | 'network-mode'
  | 'subnets'
  | 'security-groups'
  | 'idle-timeout'
  | 'max-lifetime'
  | 'max-iterations'
  | 'max-tokens'
  | 'timeout'
  | 'truncation-strategy'
  | 'confirm';

export interface AddHarnessConfig {
  name: string;
  modelProvider: HarnessModelProvider;
  modelId: string;
  apiKeyArn?: string;
  skipMemory?: boolean;
  containerMode?: ContainerMode;
  containerUri?: string;
  dockerfilePath?: string;
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  truncationStrategy?: 'sliding_window' | 'summarization';
  networkMode?: NetworkMode;
  subnets?: string[];
  securityGroups?: string[];
  idleTimeout?: number;
  maxLifetime?: number;
}

export const HARNESS_STEP_LABELS: Record<AddHarnessStep, string> = {
  name: 'Name',
  'model-provider': 'Model provider',
  'api-key-arn': 'API key ARN',
  container: 'Container',
  'container-uri': 'Container URI',
  'container-dockerfile': 'Dockerfile path',
  advanced: 'Advanced settings',
  memory: 'Memory',
  'network-mode': 'Network mode',
  subnets: 'Subnets',
  'security-groups': 'Security groups',
  'idle-timeout': 'Idle timeout',
  'max-lifetime': 'Max lifetime',
  'max-iterations': 'Max iterations',
  'max-tokens': 'Max tokens',
  timeout: 'Timeout',
  'truncation-strategy': 'Truncation',
  confirm: 'Confirm',
};

export const MODEL_PROVIDER_OPTIONS = [
  { id: 'bedrock' as const, title: 'Amazon Bedrock', description: 'Use models via Amazon Bedrock' },
  { id: 'open_ai' as const, title: 'OpenAI', description: 'Use OpenAI models (requires API key ARN)' },
  { id: 'gemini' as const, title: 'Google Gemini', description: 'Use Google Gemini models (requires API key ARN)' },
] as const;

export const DEFAULT_MODEL_IDS: Record<HarnessModelProvider, string> = {
  bedrock: 'global.anthropic.claude-sonnet-4-6',
  open_ai: 'gpt-5',
  gemini: 'gemini-2.5-flash',
};

export const TRUNCATION_STRATEGY_OPTIONS = [
  { id: 'sliding_window' as const, title: 'Sliding window', description: 'Keep most recent messages' },
  { id: 'summarization' as const, title: 'Summarization', description: 'Compress older context' },
] as const;

export const ADVANCED_SETTING_OPTIONS = [
  { id: 'memory', title: 'Memory', description: 'Enable or disable persistent memory' },
  { id: 'network', title: 'Network', description: 'VPC configuration' },
  { id: 'lifecycle', title: 'Lifecycle', description: 'Idle timeout and max lifetime' },
  { id: 'execution', title: 'Execution limits', description: 'Iterations, tokens, timeout' },
  { id: 'truncation', title: 'Truncation', description: 'Context management strategy' },
] as const;

export type AdvancedSetting = (typeof ADVANCED_SETTING_OPTIONS)[number]['id'];

export const MEMORY_OPTIONS = [
  { id: 'disabled' as const, title: 'No persistent memory', description: 'Harness does not retain context across sessions' },
  { id: 'enabled' as const, title: 'Enabled', description: 'Create persistent memory for this harness' },
] as const;

export const CONTAINER_MODE_OPTIONS = [
  { id: 'none' as const, title: 'None', description: 'Use the default managed runtime' },
  { id: 'uri' as const, title: 'Container URI', description: 'Use a pre-built container image (ECR URI)' },
  { id: 'dockerfile' as const, title: 'Dockerfile', description: 'Build from a Dockerfile' },
] as const;

export const NETWORK_MODE_OPTIONS = [
  { id: 'PUBLIC' as const, title: 'Public', description: 'Internet-facing' },
  { id: 'VPC' as const, title: 'VPC', description: 'Deploy within a VPC' },
] as const;
