import {
  LogGroupNameSchema,
  OnlineEvalConfigNameSchema,
  OnlineEvalConfigSchema,
  ServiceNameSchema,
} from '../online-eval-config';
import { describe, expect, it } from 'vitest';

describe('OnlineEvalConfigNameSchema', () => {
  it('accepts valid names', () => {
    expect(OnlineEvalConfigNameSchema.safeParse('MyConfig').success).toBe(true);
    expect(OnlineEvalConfigNameSchema.safeParse('config_1').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(OnlineEvalConfigNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects names starting with a number', () => {
    expect(OnlineEvalConfigNameSchema.safeParse('1config').success).toBe(false);
  });

  it('rejects names with hyphens', () => {
    expect(OnlineEvalConfigNameSchema.safeParse('my-config').success).toBe(false);
  });

  it('rejects names longer than 48 characters', () => {
    const longName = 'A' + 'a'.repeat(48);
    expect(OnlineEvalConfigNameSchema.safeParse(longName).success).toBe(false);
  });
});

describe('OnlineEvalConfigSchema', () => {
  const validConfig = {
    name: 'TestConfig',
    agent: 'MyAgent',
    evaluators: ['Builtin.GoalSuccessRate'],
    samplingRate: 10,
  };

  it('accepts valid config', () => {
    expect(OnlineEvalConfigSchema.safeParse(validConfig).success).toBe(true);
  });

  it('accepts multiple evaluators', () => {
    const config = { ...validConfig, evaluators: ['Builtin.X', 'CustomEval'] };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('accepts evaluator ARNs', () => {
    const config = {
      ...validConfig,
      evaluators: ['arn:aws:bedrock:us-east-1:123456:evaluator/MyEval-abc'],
    };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects empty evaluators array', () => {
    const config = { ...validConfig, evaluators: [] };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects sampling rate below 0.01', () => {
    const config = { ...validConfig, samplingRate: 0.001 };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects sampling rate above 100', () => {
    const config = { ...validConfig, samplingRate: 101 };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('accepts minimum sampling rate of 0.01', () => {
    const config = { ...validConfig, samplingRate: 0.01 };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('accepts maximum sampling rate of 100', () => {
    const config = { ...validConfig, samplingRate: 100 };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects empty string in evaluators array', () => {
    const config = { ...validConfig, evaluators: [''] };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('accepts optional description field', () => {
    const config = { ...validConfig, description: 'My eval config description' };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects description longer than 200 characters', () => {
    const config = { ...validConfig, description: 'x'.repeat(201) };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('accepts optional enableOnCreate field', () => {
    const config = { ...validConfig, enableOnCreate: false };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('accepts config without description and enableOnCreate', () => {
    expect(OnlineEvalConfigSchema.safeParse(validConfig).success).toBe(true);
  });

  // ── Custom log source (external agent) ──────────────────────────

  it('accepts config with custom log source fields and no agent', () => {
    const config = {
      type: 'OnlineEvaluationConfig' as const,
      name: 'ExternalConfig',
      evaluators: ['Builtin.GoalSuccessRate'],
      samplingRate: 10,
      customLogGroupName: '/aws/bedrock-agentcore/runtimes/my-external-agent',
      customServiceName: 'my-external-service',
    };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(true);
  });

  it('rejects config with both agent and custom log source fields', () => {
    const config = {
      ...validConfig,
      customLogGroupName: '/custom/log-group',
      customServiceName: 'custom-service',
    };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects config with neither agent nor custom log source fields', () => {
    const config = {
      type: 'OnlineEvaluationConfig' as const,
      name: 'NoSource',
      evaluators: ['Builtin.GoalSuccessRate'],
      samplingRate: 10,
    };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects config with only customLogGroupName but no customServiceName', () => {
    const config = {
      type: 'OnlineEvaluationConfig' as const,
      name: 'PartialCustom',
      evaluators: ['Builtin.GoalSuccessRate'],
      samplingRate: 10,
      customLogGroupName: '/some/log-group',
    };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects config with only customServiceName but no customLogGroupName', () => {
    const config = {
      type: 'OnlineEvaluationConfig' as const,
      name: 'PartialCustom',
      evaluators: ['Builtin.GoalSuccessRate'],
      samplingRate: 10,
      customServiceName: 'my-service',
    };
    expect(OnlineEvalConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe('LogGroupNameSchema', () => {
  it('accepts valid log group names', () => {
    expect(LogGroupNameSchema.safeParse('/aws/bedrock-agentcore/runtimes/abc123').success).toBe(true);
    expect(LogGroupNameSchema.safeParse('aws/spans').success).toBe(true);
    expect(LogGroupNameSchema.safeParse('/my/custom-log-group').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(LogGroupNameSchema.safeParse('').success).toBe(false);
  });

  it('rejects names with invalid characters', () => {
    expect(LogGroupNameSchema.safeParse('/log group with spaces').success).toBe(false);
  });
});

describe('ServiceNameSchema', () => {
  it('accepts valid service names', () => {
    expect(ServiceNameSchema.safeParse('my-service').success).toBe(true);
    expect(ServiceNameSchema.safeParse('ProjectName_AgentName.DEFAULT').success).toBe(true);
  });

  it('rejects empty string', () => {
    expect(ServiceNameSchema.safeParse('').success).toBe(false);
  });
});
