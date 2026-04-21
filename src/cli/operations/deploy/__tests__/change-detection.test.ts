import { canSkipDeploy, computeProjectDeployHash } from '../change-detection';
import { describe, expect, it, vi } from 'vitest';

describe('computeProjectDeployHash', () => {
  it('produces same hash for identical input', async () => {
    const configIO = mockConfigIO({
      projectSpec: { name: 'test', runtimes: [], harnesses: [], memories: [] },
      awsTargets: [{ name: 'default', account: '123', region: 'us-west-2' }],
    });

    const hash1 = await computeProjectDeployHash(configIO as any);
    const hash2 = await computeProjectDeployHash(configIO as any);
    expect(hash1).toBe(hash2);
  });

  it('changes hash when project spec changes', async () => {
    const configIO1 = mockConfigIO({
      projectSpec: { name: 'test', runtimes: [], harnesses: [], memories: [] },
      awsTargets: [{ name: 'default', account: '123', region: 'us-west-2' }],
    });

    const configIO2 = mockConfigIO({
      projectSpec: { name: 'test-changed', runtimes: [], harnesses: [], memories: [] },
      awsTargets: [{ name: 'default', account: '123', region: 'us-west-2' }],
    });

    const hash1 = await computeProjectDeployHash(configIO1 as any);
    const hash2 = await computeProjectDeployHash(configIO2 as any);
    expect(hash1).not.toBe(hash2);
  });

  it('changes hash when aws targets change', async () => {
    const configIO1 = mockConfigIO({
      projectSpec: { name: 'test', runtimes: [], harnesses: [], memories: [] },
      awsTargets: [{ name: 'default', account: '123', region: 'us-west-2' }],
    });

    const configIO2 = mockConfigIO({
      projectSpec: { name: 'test', runtimes: [], harnesses: [], memories: [] },
      awsTargets: [{ name: 'default', account: '123', region: 'us-east-1' }],
    });

    const hash1 = await computeProjectDeployHash(configIO1 as any);
    const hash2 = await computeProjectDeployHash(configIO2 as any);
    expect(hash1).not.toBe(hash2);
  });

  it('returns a 16-character hex string', async () => {
    const configIO = mockConfigIO({
      projectSpec: { name: 'test', runtimes: [], harnesses: [], memories: [] },
      awsTargets: [{ name: 'default', account: '123', region: 'us-west-2' }],
    });

    const hash = await computeProjectDeployHash(configIO as any);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('canSkipDeploy', () => {
  it('returns false when project has runtimes', async () => {
    const configIO = mockConfigIO({
      projectSpec: { name: 'test', runtimes: [{ name: 'agent1' }], harnesses: [], memories: [] },
      awsTargets: [{ name: 'default', account: '123', region: 'us-west-2' }],
      deployedState: { targets: { default: { resources: { deployHash: 'abc' } } } },
    });

    expect(await canSkipDeploy(configIO as any)).toBe(false);
  });

  it('returns false when no deployed state', async () => {
    const configIO = mockConfigIO({
      projectSpec: { name: 'test', runtimes: [], harnesses: [], memories: [] },
      awsTargets: [{ name: 'default', account: '123', region: 'us-west-2' }],
      deployedState: { targets: {} },
    });

    expect(await canSkipDeploy(configIO as any)).toBe(false);
  });

  it('returns false when hash differs', async () => {
    const configIO = mockConfigIO({
      projectSpec: { name: 'test', runtimes: [], harnesses: [], memories: [] },
      awsTargets: [{ name: 'default', account: '123', region: 'us-west-2' }],
      deployedState: { targets: { default: { resources: { deployHash: 'stale-hash' } } } },
    });

    expect(await canSkipDeploy(configIO as any)).toBe(false);
  });

  it('returns true when hash matches for harness-only project', async () => {
    const projectSpec = { name: 'test', runtimes: [], harnesses: [], memories: [] };
    const awsTargets = [{ name: 'default', account: '123', region: 'us-west-2' }];

    const configIO = mockConfigIO({ projectSpec, awsTargets, deployedState: { targets: {} } });
    const hash = await computeProjectDeployHash(configIO as any);

    const configIO2 = mockConfigIO({
      projectSpec,
      awsTargets,
      deployedState: { targets: { default: { resources: { deployHash: hash } } } },
    });

    expect(await canSkipDeploy(configIO2 as any)).toBe(true);
  });

  it('returns false when any target has mismatched hash', async () => {
    const projectSpec = { name: 'test', runtimes: [], harnesses: [], memories: [] };
    const awsTargets = [{ name: 'default', account: '123', region: 'us-west-2' }];

    const configIO = mockConfigIO({ projectSpec, awsTargets, deployedState: { targets: {} } });
    const hash = await computeProjectDeployHash(configIO as any);

    const configIO2 = mockConfigIO({
      projectSpec,
      awsTargets,
      deployedState: {
        targets: {
          default: { resources: { deployHash: hash } },
          staging: { resources: { deployHash: 'wrong' } },
        },
      },
    });

    expect(await canSkipDeploy(configIO2 as any)).toBe(false);
  });
});

function mockConfigIO(opts: { projectSpec: any; awsTargets: any; deployedState?: any }) {
  return {
    readProjectSpec: vi.fn().mockResolvedValue(opts.projectSpec),
    readAWSDeploymentTargets: vi.fn().mockResolvedValue(opts.awsTargets),
    readDeployedState: vi.fn().mockResolvedValue(opts.deployedState ?? { targets: {} }),
    getConfigRoot: vi.fn().mockReturnValue('/fake/agentcore'),
  };
}
