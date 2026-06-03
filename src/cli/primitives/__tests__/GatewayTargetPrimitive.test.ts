import type { AgentCoreProjectSpec } from '../../../schema';
import { GatewayTargetPrimitive } from '../GatewayTargetPrimitive';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const defaultProject: AgentCoreProjectSpec = {
  name: 'test',
  version: 1,
  managedBy: 'CDK' as const,
  runtimes: [],
  memories: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  agentCoreGateways: [
    {
      name: 'my-gateway',
      targets: [],
      authorizerType: 'NONE',
      enableSemanticSearch: true,
      exceptionLevel: 'NONE',
    },
  ],
  policyEngines: [],
  configBundles: [],
  abTests: [],
  harnesses: [],
  datasets: [],
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
    requireConfigRoot: vi.fn().mockReturnValue('/fake/root'),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
    toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
    serializeResult: (r: unknown) => r,
    APP_DIR: 'app',
    MCP_APP_SUBDIR: 'mcp',
    ResourceNotFoundError: class extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'ResourceNotFoundError';
      }
    },
    ValidationError: class extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'ValidationError';
      }
    },
  };
});

/** Extract the written project spec targets for the gateway. */
function getWrittenGatewayTargets() {
  expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
  const spec = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
  const gw = spec.agentCoreGateways[0];
  expect(gw).toBeDefined();
  return gw!.targets;
}

describe('GatewayTargetPrimitive', () => {
  let primitive: GatewayTargetPrimitive;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProjectSpec.mockImplementation(() => Promise.resolve(JSON.parse(JSON.stringify(defaultProject))));
    primitive = new GatewayTargetPrimitive();
  });

  describe('createHttpRuntimeTarget', () => {
    it('writes correct nested httpRuntime structure to agentcore.json', async () => {
      await primitive.createHttpRuntimeTarget({
        name: 'my-http-target',
        gateway: 'my-gateway',
        runtime: 'my-agent',
      });

      const targets = getWrittenGatewayTargets();
      expect(targets).toHaveLength(1);
      expect(targets[0]).toEqual({
        name: 'my-http-target',
        targetType: 'httpRuntime',
        httpRuntime: { runtime: 'my-agent' },
      });
    });

    it('includes runtimeEndpoint when endpoint is specified', async () => {
      await primitive.createHttpRuntimeTarget({
        name: 'my-http-target',
        gateway: 'my-gateway',
        runtime: 'my-agent',
        endpoint: 'LIVE',
      });

      const targets = getWrittenGatewayTargets();
      expect(targets[0]).toEqual({
        name: 'my-http-target',
        targetType: 'httpRuntime',
        httpRuntime: { runtime: 'my-agent', runtimeEndpoint: 'LIVE' },
      });
    });

    it('includes outboundAuth when OAUTH is specified', async () => {
      await primitive.createHttpRuntimeTarget({
        name: 'my-http-target',
        gateway: 'my-gateway',
        runtime: 'my-agent',
        outboundAuth: { type: 'OAUTH', credentialName: 'my-cred', scopes: ['read', 'write'] },
      });

      const targets = getWrittenGatewayTargets();
      expect(targets[0]).toEqual({
        name: 'my-http-target',
        targetType: 'httpRuntime',
        httpRuntime: { runtime: 'my-agent' },
        outboundAuth: { type: 'OAUTH', credentialName: 'my-cred', scopes: ['read', 'write'] },
      });
    });

    it('omits outboundAuth when type is NONE', async () => {
      await primitive.createHttpRuntimeTarget({
        name: 'my-http-target',
        gateway: 'my-gateway',
        runtime: 'my-agent',
        outboundAuth: { type: 'NONE' },
      });

      const targets = getWrittenGatewayTargets();
      expect(targets[0]!.outboundAuth).toBeUndefined();
    });

    it('throws error for duplicate target name', async () => {
      mockReadProjectSpec.mockImplementation(() =>
        Promise.resolve({
          ...JSON.parse(JSON.stringify(defaultProject)),
          agentCoreGateways: [
            {
              name: 'my-gateway',
              targets: [{ name: 'existing-target', targetType: 'httpRuntime', httpRuntime: { runtime: 'x' } }],
              authorizerType: 'NONE',
              enableSemanticSearch: true,
              exceptionLevel: 'NONE',
            },
          ],
        })
      );

      await expect(
        primitive.createHttpRuntimeTarget({
          name: 'existing-target',
          gateway: 'my-gateway',
          runtime: 'my-agent',
        })
      ).rejects.toThrow(/already exists/);
    });

    it('throws error for missing gateway', async () => {
      await expect(
        primitive.createHttpRuntimeTarget({
          name: 'my-http-target',
          gateway: 'non-existent-gateway',
          runtime: 'my-agent',
        })
      ).rejects.toThrow(/not found/);
    });
  });
});
