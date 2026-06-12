import { HarnessPrimitive } from '../HarnessPrimitive';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();
const mockReadDeployedState = vi.fn();
const mockWriteDeployedState = vi.fn();
const mockDeleteHarness = vi.fn();
const mockRm = vi.fn();

vi.mock('../../../lib', () => ({
  APP_DIR: 'app',
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    readDeployedState = mockReadDeployedState;
    writeDeployedState = mockWriteDeployedState;
    getPathResolver = () => ({ getHarnessDir: (name: string) => `/fake/root/app/${name}` });
  },
  findConfigRoot: () => '/fake/root',
}));

vi.mock('../../aws/agentcore-harness', () => ({
  deleteHarness: (...args: unknown[]) => mockDeleteHarness(...args),
}));

vi.mock('fs/promises', () => ({
  rm: (...args: unknown[]) => mockRm(...args),
  access: vi.fn(),
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

const ARN = 'arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/h-legacy';

function project(harnessNames: string[] = [], memoryNames: string[] = []) {
  return {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: [],
    memories: memoryNames.map(name => ({ name })),
    harnesses: harnessNames.map(name => ({ name, path: `app/${name}` })),
  };
}

function orphanState(name = 'legacy', target = 'default') {
  return {
    targets: {
      [target]: {
        resources: {
          stackName: 'S',
          harnesses: {
            [name]: { harnessId: 'h-legacy', harnessArn: ARN, roleArn: 'arn:r', status: 'READY' },
          },
        },
      },
    },
  };
}

const primitive = new HarnessPrimitive();

describe('HarnessPrimitive.remove — orphan handling', () => {
  afterEach(() => vi.clearAllMocks());

  it('refuses to delete an orphan without an explicit choice (never auto-deletes)', async () => {
    mockReadProjectSpec.mockResolvedValue(project(['legacy'], ['legacyMemory']));
    mockReadDeployedState.mockResolvedValue(orphanState());

    const result = await primitive.remove('legacy');

    expect(result.success).toBe(false);
    if (!result.success) {
      // Explicitly states nothing happened, then offers the two explicit choices.
      expect(result.error.message).toContain('No changes were made');
      expect(result.error.message).toContain('was not deleted');
      expect(result.error.message).toContain('--keep');
      expect(result.error.message).toContain('--discard');
    }
    expect(mockDeleteHarness).not.toHaveBeenCalled();
    expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    expect(mockWriteDeployedState).not.toHaveBeenCalled();
  });

  it('delete-and-keep: deletes from AWS, clears the orphan record, KEEPS the agentcore.json entry', async () => {
    mockReadProjectSpec.mockResolvedValue(project(['legacy'], ['legacyMemory']));
    mockReadDeployedState.mockResolvedValue(orphanState());
    mockDeleteHarness.mockResolvedValue({});

    const result = await primitive.remove('legacy', { orphanAction: 'keep' });

    expect(result.success).toBe(true);
    expect(mockDeleteHarness).toHaveBeenCalledWith({ region: 'us-west-2', harnessId: 'h-legacy' });
    // Orphan record dropped from deployed-state...
    const written = mockWriteDeployedState.mock.calls[0]![0];
    expect(written.targets.default.resources.harnesses.legacy).toBeUndefined();
    // ...but the spec entry is kept (no spec write) so the next deploy recreates it under CFN.
    expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('delete-and-discard: deletes from AWS, clears the record, and removes the spec entry + memory + dir', async () => {
    mockReadProjectSpec.mockResolvedValue(project(['legacy'], ['legacyMemory']));
    mockReadDeployedState.mockResolvedValue(orphanState());
    mockDeleteHarness.mockResolvedValue({});

    const result = await primitive.remove('legacy', { orphanAction: 'discard' });

    expect(result.success).toBe(true);
    expect(mockDeleteHarness).toHaveBeenCalledWith({ region: 'us-west-2', harnessId: 'h-legacy' });
    const writtenState = mockWriteDeployedState.mock.calls[0]![0];
    expect(writtenState.targets.default.resources.harnesses.legacy).toBeUndefined();
    const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
    expect(writtenSpec.harnesses.find((h: { name: string }) => h.name === 'legacy')).toBeUndefined();
    expect(writtenSpec.memories.find((m: { name: string }) => m.name === 'legacyMemory')).toBeUndefined();
    expect(mockRm).toHaveBeenCalledWith('/fake/root/app/legacy', expect.objectContaining({ recursive: true }));
  });

  it('treats a 404 from deleteHarness as already-deleted (success), still reconciling state', async () => {
    mockReadProjectSpec.mockResolvedValue(project(['legacy'], ['legacyMemory']));
    mockReadDeployedState.mockResolvedValue(orphanState());
    mockDeleteHarness.mockRejectedValue(new Error('ResourceNotFoundException: 404 harness does not exist'));

    const result = await primitive.remove('legacy', { orphanAction: 'keep' });

    expect(result.success).toBe(true);
    expect(mockWriteDeployedState).toHaveBeenCalled();
  });

  it('aborts and leaves local state unchanged when deleteHarness fails for a non-404 reason', async () => {
    mockReadProjectSpec.mockResolvedValue(project(['legacy'], ['legacyMemory']));
    mockReadDeployedState.mockResolvedValue(orphanState());
    mockDeleteHarness.mockRejectedValue(new Error('AccessDeniedException: not authorized'));

    const result = await primitive.remove('legacy', { orphanAction: 'discard' });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('left unchanged');
    expect(mockWriteDeployedState).not.toHaveBeenCalled();
    expect(mockWriteProjectSpec).not.toHaveBeenCalled();
  });
});

describe('HarnessPrimitive.remove — non-orphan (CDK-managed) handling', () => {
  afterEach(() => vi.clearAllMocks());

  it('is a pure spec edit: removes entry + memory + dir, no AWS delete', async () => {
    mockReadProjectSpec.mockResolvedValue(project(['h1'], ['h1Memory']));
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            stackName: 'S',
            harnesses: {
              h1: {
                harnessId: 'h-h1',
                harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:1:harness/h-h1',
                roleArn: 'arn:r',
                status: 'READY',
                provisioner: 'cloudformation',
              },
            },
          },
        },
      },
    });

    const result = await primitive.remove('h1');

    expect(result.success).toBe(true);
    expect(mockDeleteHarness).not.toHaveBeenCalled();
    const writtenSpec = mockWriteProjectSpec.mock.calls[0]![0];
    expect(writtenSpec.harnesses.find((h: { name: string }) => h.name === 'h1')).toBeUndefined();
    expect(mockRm).toHaveBeenCalled();
    expect(mockWriteDeployedState).not.toHaveBeenCalled();
  });

  it('ignoring the orphanAction flag for a CDK-managed harness (flags are orphan-only)', async () => {
    mockReadProjectSpec.mockResolvedValue(project(['h1'], []));
    mockReadDeployedState.mockResolvedValue({
      targets: {
        default: {
          resources: {
            stackName: 'S',
            harnesses: {
              h1: {
                harnessId: 'h-h1',
                harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:1:harness/h-h1',
                roleArn: 'arn:r',
                status: 'READY',
                provisioner: 'cloudformation',
              },
            },
          },
        },
      },
    });

    const result = await primitive.remove('h1', { orphanAction: 'discard' });

    expect(result.success).toBe(true);
    expect(mockDeleteHarness).not.toHaveBeenCalled();
  });

  it('returns not-found when the harness is neither in spec nor an orphan', async () => {
    mockReadProjectSpec.mockResolvedValue(project([], []));
    mockReadDeployedState.mockResolvedValue({ targets: {} });

    const result = await primitive.remove('ghost');

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('not found');
  });
});
