import { handlePauseResume } from '../pause-resume.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockLoadDeployedProjectConfig = vi.fn();
const mockUpdateOnlineEvalExecutionStatus = vi.fn();

vi.mock('../../resolve-agent', () => ({
  loadDeployedProjectConfig: () => mockLoadDeployedProjectConfig(),
}));

vi.mock('../../../aws/agentcore-control', () => ({
  updateOnlineEvalExecutionStatus: (...args: unknown[]) => mockUpdateOnlineEvalExecutionStatus(...args),
}));

function makeContext(configName: string, configId: string, targetName = 'dev', region = 'us-east-1') {
  return {
    project: {},
    awsTargets: [{ name: targetName, region, account: '123456789012' }],
    deployedState: {
      targets: {
        [targetName]: {
          resources: {
            onlineEvalConfigs: {
              [configName]: {
                onlineEvaluationConfigId: configId,
                onlineEvaluationConfigArn: `arn:aws:bedrock:${region}:123456789012:online-evaluation-config/${configId}`,
              },
            },
          },
        },
      },
    },
  };
}

describe('handlePauseResume', () => {
  afterEach(() => vi.clearAllMocks());

  it('pauses an online eval config', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue(makeContext('my-config', 'cfg-123'));
    mockUpdateOnlineEvalExecutionStatus.mockResolvedValue({
      configId: 'cfg-123',
      executionStatus: 'DISABLED',
      status: 'ACTIVE',
    });

    const result = await handlePauseResume({ name: 'my-config' }, 'pause');

    expect(result.success).toBe(true);
    expect(result.executionStatus).toBe('DISABLED');
    expect(mockUpdateOnlineEvalExecutionStatus).toHaveBeenCalledWith({
      region: 'us-east-1',
      onlineEvaluationConfigId: 'cfg-123',
      executionStatus: 'DISABLED',
    });
  });

  it('resumes an online eval config', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue(makeContext('my-config', 'cfg-123'));
    mockUpdateOnlineEvalExecutionStatus.mockResolvedValue({
      configId: 'cfg-123',
      executionStatus: 'ENABLED',
      status: 'ACTIVE',
    });

    const result = await handlePauseResume({ name: 'my-config' }, 'resume');

    expect(result.success).toBe(true);
    expect(result.executionStatus).toBe('ENABLED');
    expect(mockUpdateOnlineEvalExecutionStatus).toHaveBeenCalledWith({
      region: 'us-east-1',
      onlineEvaluationConfigId: 'cfg-123',
      executionStatus: 'ENABLED',
    });
  });

  it('returns error when no deployed targets exist', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue({
      project: {},
      awsTargets: [],
      deployedState: { targets: {} },
    });

    const result = await handlePauseResume({ name: 'my-config' }, 'pause');

    expect(result.success).toBe(false);
    expect(result.error).toContain('No deployed targets found');
  });

  it('returns error when config name is not found in deployed state', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue(makeContext('other-config', 'cfg-999'));

    const result = await handlePauseResume({ name: 'missing-config' }, 'pause');

    expect(result.success).toBe(false);
    expect(result.error).toContain('missing-config');
    expect(result.error).toContain('not found');
  });

  it('returns error when target config is missing from aws-targets', async () => {
    const context = makeContext('my-config', 'cfg-123');
    // Remove the target from awsTargets but keep it in deployedState
    context.awsTargets = [];
    mockLoadDeployedProjectConfig.mockResolvedValue(context);

    const result = await handlePauseResume({ name: 'my-config' }, 'pause');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Target config');
    expect(result.error).toContain('not found');
  });

  it('returns error when the SDK call fails', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue(makeContext('my-config', 'cfg-123'));
    mockUpdateOnlineEvalExecutionStatus.mockRejectedValue(new Error('Service unavailable'));

    const result = await handlePauseResume({ name: 'my-config' }, 'pause');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Service unavailable');
  });
});
