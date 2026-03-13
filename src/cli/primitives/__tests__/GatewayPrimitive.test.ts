import type { AgentCoreMcpSpec } from '../../../schema';
import { GatewayPrimitive } from '../GatewayPrimitive';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfigExists, mockReadMcpSpec, mockWriteMcpSpec } = vi.hoisted(() => ({
  mockConfigExists: vi.fn().mockReturnValue(true),
  mockReadMcpSpec: vi.fn().mockResolvedValue({ agentCoreGateways: [] }),
  mockWriteMcpSpec: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib', () => {
  const MockConfigIO = vi.fn(function (this: Record<string, unknown>) {
    this.configExists = mockConfigExists;
    this.readMcpSpec = mockReadMcpSpec;
    this.writeMcpSpec = mockWriteMcpSpec;
  });
  return {
    ConfigIO: MockConfigIO,
    findConfigRoot: vi.fn().mockReturnValue('/fake/root'),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
  };
});

/** Extract the first gateway written to writeMcpSpec. */
function getWrittenGateway() {
  expect(mockWriteMcpSpec).toHaveBeenCalledTimes(1);
  const spec = mockWriteMcpSpec.mock.calls[0]![0] as AgentCoreMcpSpec;
  const gw = spec.agentCoreGateways[0];
  expect(gw).toBeDefined();
  return gw!;
}

describe('GatewayPrimitive', () => {
  let primitive: GatewayPrimitive;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadMcpSpec.mockResolvedValue({ agentCoreGateways: [] });
    primitive = new GatewayPrimitive();
  });

  describe('exceptionLevel', () => {
    it('defaults to exceptionLevel NONE', async () => {
      await primitive.add({ name: 'test-gw', authorizerType: 'NONE' });

      const gw = getWrittenGateway();
      expect(gw.exceptionLevel).toBe('NONE');
    });

    it('exceptionLevel DEBUG passes through', async () => {
      await primitive.add({ name: 'test-gw', authorizerType: 'NONE', exceptionLevel: 'DEBUG' });

      const gw = getWrittenGateway();
      expect(gw.exceptionLevel).toBe('DEBUG');
    });

    it('invalid exceptionLevel falls back to NONE', async () => {
      await primitive.add({ name: 'test-gw', authorizerType: 'NONE', exceptionLevel: 'VERBOSE' });

      const gw = getWrittenGateway();
      expect(gw.exceptionLevel).toBe('NONE');
    });
  });
});
