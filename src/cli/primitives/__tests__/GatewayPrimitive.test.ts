import type { AgentCoreProjectSpec } from '../../../schema';
import { GatewayPrimitive } from '../GatewayPrimitive';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const defaultProject: AgentCoreProjectSpec = {
  name: 'test',
  version: 1,
  agents: [],
  memories: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  agentCoreGateways: [],
};

const { mockConfigExists, mockReadProjectSpec, mockWriteProjectSpec } = vi.hoisted(() => ({
  mockConfigExists: vi.fn().mockReturnValue(true),
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib', () => {
  const MockConfigIO = vi.fn(function (this: Record<string, unknown>) {
    this.configExists = mockConfigExists;
    this.readProjectSpec = mockReadProjectSpec;
    this.writeProjectSpec = mockWriteProjectSpec;
  });
  return {
    ConfigIO: MockConfigIO,
    findConfigRoot: vi.fn().mockReturnValue('/fake/root'),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
  };
});

/** Extract the first gateway written to writeProjectSpec. */
function getWrittenGateway() {
  expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
  const spec = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
  const gw = spec.agentCoreGateways[0];
  expect(gw).toBeDefined();
  return gw!;
}

describe('GatewayPrimitive', () => {
  let primitive: GatewayPrimitive;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProjectSpec.mockImplementation(() => Promise.resolve({ ...defaultProject, agentCoreGateways: [] }));
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
