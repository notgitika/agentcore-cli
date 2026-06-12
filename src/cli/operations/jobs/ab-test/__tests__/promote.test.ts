import type { ABTestJobRecord } from '../../shared/types';
import { promoteABTestConfig } from '../promote';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ConfigIO — vi.hoisted ensures these are available before the hoisted vi.mock runs
const { mockReadProjectSpec, mockWriteProjectSpec, mockReadDeployedState } = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn(),
  mockReadDeployedState: vi.fn(),
}));

vi.mock('../../../../../lib', () => {
  class MockConfigIO {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
    readDeployedState = mockReadDeployedState;
  }
  return { ConfigIO: MockConfigIO };
});

// ---------------------------------------------------------------------------
// Helpers — promote is now RECORD-DRIVEN: it reads the job record's variants,
// not project.abTests[] (which the jobs model never populates).
// ---------------------------------------------------------------------------

function baseRecord(overrides: Partial<ABTestJobRecord>): ABTestJobRecord {
  return {
    type: 'ab-test',
    id: 'ab-123',
    arn: 'arn:aws:bedrock-agentcore:us-east-1:1:ab-test/ab-123',
    status: 'STOPPED',
    lifecycleStatus: 'STOPPED',
    createdAt: '2026-01-01T00:00:00Z',
    agent: 'my-agent',
    name: 'myTest',
    mode: 'config-bundle',
    gatewayArn: 'arn:aws:bedrock-agentcore:us-east-1:1:gateway/my-gw',
    variants: [],
    evaluationConfig: { onlineEvaluationConfigArn: 'arn:aws:eval:config' },
    ...overrides,
  };
}

function makeTargetBasedProject() {
  return {
    name: 'TestProject',
    runtimes: [
      {
        name: 'my-runtime',
        endpoints: {
          control: { version: 1 },
          treatment: { version: 2 },
        },
      },
    ],
    agentCoreGateways: [
      {
        name: 'my-gw',
        targets: [
          {
            name: 'ctrl-target',
            targetType: 'httpRuntime',
            httpRuntime: { runtime: 'my-runtime', runtimeEndpoint: 'control' },
          },
          {
            name: 'treat-target',
            targetType: 'httpRuntime',
            httpRuntime: { runtime: 'my-runtime', runtimeEndpoint: 'treatment' },
          },
        ],
      },
    ],
    onlineEvalConfigs: [],
    configBundles: [],
    abTests: [],
  };
}

function makeConfigBundleProject() {
  return {
    name: 'TestProject',
    runtimes: [],
    agentCoreGateways: [],
    onlineEvalConfigs: [],
    configBundles: [
      {
        name: 'controlBundle',
        type: 'ConfigurationBundle',
        components: { '{{runtime:r}}': { configuration: { systemPrompt: 'OLD' } } },
      },
      {
        name: 'treatmentBundle',
        type: 'ConfigurationBundle',
        components: { '{{runtime:r}}': { configuration: { systemPrompt: 'NEW' } } },
      },
    ],
    abTests: [],
  };
}

function makeBundleDeployedState() {
  return {
    targets: {
      default: {
        resources: {
          configBundles: {
            controlBundle: { bundleId: 'b-c', bundleArn: 'arn:aws:bundle:control', versionId: 'v1' },
            treatmentBundle: { bundleId: 'b-t', bundleArn: 'arn:aws:bundle:treatment', versionId: 'v2' },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('promoteABTestConfig (record-driven)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteProjectSpec.mockResolvedValue(undefined);
  });

  describe('target-based promote', () => {
    it('bumps control endpoint version to treatment version', async () => {
      mockReadProjectSpec.mockResolvedValue(makeTargetBasedProject());

      const record = baseRecord({
        mode: 'target-based',
        gatewayName: 'my-gw',
        variants: [
          { name: 'C', weight: 50, targetName: 'ctrl-target' },
          { name: 'T1', weight: 50, targetName: 'treat-target' },
        ],
      });

      const result = await promoteABTestConfig(record);

      expect(result.promoted).toBe(true);
      expect(result.mode).toBe('target-based');
      expect(result.promotionDetail).toContain('control');
      const written = mockWriteProjectSpec.mock.calls[0]![0];
      expect(written.runtimes[0].endpoints.control.version).toBe(2);
    });

    it('returns promoted=false when the gateway name is missing from the record', async () => {
      mockReadProjectSpec.mockResolvedValue(makeTargetBasedProject());
      const record = baseRecord({
        mode: 'target-based',
        gatewayName: undefined,
        variants: [
          { name: 'C', weight: 50, targetName: 'ctrl-target' },
          { name: 'T1', weight: 50, targetName: 'treat-target' },
        ],
      });

      const result = await promoteABTestConfig(record);
      expect(result.promoted).toBe(false);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });
  });

  describe('config-bundle promote', () => {
    it('copies the treatment bundle components onto the control bundle', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      mockReadDeployedState.mockResolvedValue(makeBundleDeployedState());

      const record = baseRecord({
        mode: 'config-bundle',
        variants: [
          { name: 'C', weight: 50, bundleArn: 'arn:aws:bundle:control', bundleVersion: 'v1' },
          { name: 'T1', weight: 50, bundleArn: 'arn:aws:bundle:treatment', bundleVersion: 'v2' },
        ],
      });

      const result = await promoteABTestConfig(record);

      expect(result.promoted).toBe(true);
      expect(result.mode).toBe('config-bundle');
      const written = mockWriteProjectSpec.mock.calls[0]![0];
      const control = written.configBundles.find((b: { name: string }) => b.name === 'controlBundle');
      expect(control.components['{{runtime:r}}'].configuration.systemPrompt).toBe('NEW');
    });

    it('returns promoted=false when bundles cannot be resolved from deployed state', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      mockReadDeployedState.mockResolvedValue({ targets: { default: { resources: { configBundles: {} } } } });

      const record = baseRecord({
        mode: 'config-bundle',
        variants: [
          { name: 'C', weight: 50, bundleArn: 'arn:aws:bundle:control', bundleVersion: 'v1' },
          { name: 'T1', weight: 50, bundleArn: 'arn:aws:bundle:treatment', bundleVersion: 'v2' },
        ],
      });

      const result = await promoteABTestConfig(record);
      expect(result.promoted).toBe(false);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });
  });

  describe('malformed record', () => {
    it('returns promoted=false when control/treatment variants are missing', async () => {
      mockReadProjectSpec.mockResolvedValue(makeConfigBundleProject());
      const record = baseRecord({ mode: 'config-bundle', variants: [] });

      const result = await promoteABTestConfig(record);
      expect(result.promoted).toBe(false);
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });
  });
});
