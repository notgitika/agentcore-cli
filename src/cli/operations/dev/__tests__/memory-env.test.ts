import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockReadDeployedState } = vi.hoisted(() => ({
  mockReadDeployedState: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    readDeployedState = mockReadDeployedState;
  },
}));

const { getMemoryEnvVars } = await import('../memory-env.js');

describe('getMemoryEnvVars', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty when no deployed state', async () => {
    mockReadDeployedState.mockRejectedValue(new Error('not found'));
    const result = await getMemoryEnvVars();
    expect(result).toEqual({});
  });

  it('returns empty when no memories deployed', async () => {
    mockReadDeployedState.mockResolvedValue({ targets: {} });
    const result = await getMemoryEnvVars();
    expect(result).toEqual({});
  });

  it('generates MEMORY_*_ID env vars for deployed memories', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            memories: {
              MyAgentMemory: { memoryId: 'mem-abc123', memoryArn: 'arn:aws:bedrock:us-east-1:123:memory/mem-abc123' },
            },
          },
        },
      },
    });

    const result = await getMemoryEnvVars();
    expect(result).toEqual({
      MEMORY_MYAGENTMEMORY_ID: 'mem-abc123',
    });
  });

  it('handles multiple memories across targets', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            memories: {
              MyAgentMemory: { memoryId: 'mem-111', memoryArn: 'arn:1' },
              'other-memory': { memoryId: 'mem-222', memoryArn: 'arn:2' },
            },
          },
        },
      },
    });

    const result = await getMemoryEnvVars();
    expect(result).toEqual({
      MEMORY_MYAGENTMEMORY_ID: 'mem-111',
      MEMORY_OTHER_MEMORY_ID: 'mem-222',
    });
  });

  it('skips memories without memoryId', async () => {
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: { memories: { broken: {} } },
        },
      },
    });

    const result = await getMemoryEnvVars();
    expect(result).toEqual({});
  });
});
