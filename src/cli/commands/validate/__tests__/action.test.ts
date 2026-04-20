import { handleValidate } from '../action.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockReadProjectSpec,
  mockReadAWSDeploymentTargets,
  mockReadDeployedState,
  mockReadHarnessSpec,
  mockConfigExists,
  mockFindConfigRoot,
} = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockReadAWSDeploymentTargets: vi.fn(),
  mockReadDeployedState: vi.fn(),
  mockReadHarnessSpec: vi.fn(),
  mockConfigExists: vi.fn(),
  mockFindConfigRoot: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => {
  class NoProjectError extends Error {
    constructor(msg?: string) {
      super(msg ?? 'No agentcore project found');
      this.name = 'NoProjectError';
    }
  }

  class ConfigValidationError extends Error {}
  class ConfigParseError extends Error {
    constructor(
      public readonly filePath: string,
      public override readonly cause: unknown
    ) {
      super(`Parse error at ${filePath}`);
    }
  }
  class ConfigReadError extends Error {
    constructor(
      public readonly filePath: string,
      public override readonly cause: unknown
    ) {
      super(`Read error at ${filePath}`);
    }
  }
  class ConfigNotFoundError extends Error {
    constructor(
      public readonly filePath: string,
      public readonly fileType: string
    ) {
      super(`${fileType} not found at ${filePath}`);
    }
  }

  return {
    ConfigIO: class {
      readProjectSpec = mockReadProjectSpec;
      readAWSDeploymentTargets = mockReadAWSDeploymentTargets;
      readDeployedState = mockReadDeployedState;
      readHarnessSpec = mockReadHarnessSpec;
      configExists = mockConfigExists;
    },
    ConfigValidationError,
    ConfigParseError,
    ConfigReadError,
    ConfigNotFoundError,
    NoProjectError,
    findConfigRoot: mockFindConfigRoot,
  };
});

describe('handleValidate', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns error when no project found', async () => {
    mockFindConfigRoot.mockReturnValue(null);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('No agentcore project found');
  });

  it('returns success when all configs are valid', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', version: 1, managedBy: 'CDK' as const, runtimes: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(true);
  });

  it('returns error when project spec fails', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockRejectedValue(new Error('invalid project'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid project');
  });

  it('returns error when AWS targets fails', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', version: 1, managedBy: 'CDK' as const, runtimes: [] });
    mockReadAWSDeploymentTargets.mockRejectedValue(new Error('bad targets'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('bad targets');
  });

  it('validates state file when it exists', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', version: 1, managedBy: 'CDK' as const, runtimes: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(true);
    mockReadDeployedState.mockResolvedValue({ targets: {} });

    const result = await handleValidate({});

    expect(result.success).toBe(true);
    expect(mockReadDeployedState).toHaveBeenCalled();
  });

  it('returns error when state file is invalid', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', version: 1, managedBy: 'CDK' as const, runtimes: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(true);
    mockReadDeployedState.mockRejectedValue(new Error('bad state'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('bad state');
  });

  it('uses custom directory when provided', async () => {
    mockFindConfigRoot.mockReturnValue('/custom/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', version: 1, managedBy: 'CDK' as const, runtimes: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({ directory: '/custom' });

    expect(result.success).toBe(true);
    expect(mockFindConfigRoot).toHaveBeenCalledWith('/custom');
  });

  it('formats ConfigValidationError with its message', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigValidationError } = await import('../../../../lib/index.js');
    mockReadProjectSpec.mockRejectedValue(new (ConfigValidationError as any)('field "name" is required'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('field "name" is required');
  });

  it('formats ConfigParseError with cause', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigParseError } = await import('../../../../lib/index.js');
    mockReadProjectSpec.mockRejectedValue(new ConfigParseError('agentcore.json', new Error('Unexpected token')));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid JSON in agentcore.json');
    expect(result.error).toContain('Unexpected token');
  });

  it('formats ConfigReadError with cause', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigReadError } = await import('../../../../lib/index.js');
    mockReadProjectSpec.mockRejectedValue(
      new ConfigReadError('agentcore.json', new Error('EACCES: permission denied'))
    );

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to read agentcore.json');
    expect(result.error).toContain('EACCES');
  });

  it('formats ConfigNotFoundError with file name', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigNotFoundError } = await import('../../../../lib/index.js');
    mockReadProjectSpec.mockRejectedValue(new ConfigNotFoundError('/path/agentcore.json', 'project'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('Required file not found: agentcore.json');
  });

  it('formats non-Error values as strings', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockRejectedValue('string error');

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('string error');
  });

  describe('harness validation', () => {
    const projectWithHarness = {
      name: 'Test',
      version: 1,
      managedBy: 'CDK' as const,
      runtimes: [],
      memories: [{ name: 'myMemory', eventExpiryDuration: 30, strategies: [] }],
      harnesses: [{ name: 'myHarness', path: './harnesses/myHarness' }],
    };

    const validHarnessSpec = {
      name: 'myHarness',
      model: { provider: 'bedrock', modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0' },
      tools: [],
      skills: [],
    };

    it('validates harness specs when project has harnesses', async () => {
      mockFindConfigRoot.mockReturnValue('/project/agentcore');
      mockReadProjectSpec.mockResolvedValue(projectWithHarness);
      mockReadAWSDeploymentTargets.mockResolvedValue([]);
      mockConfigExists.mockReturnValue(false);
      mockReadHarnessSpec.mockResolvedValue(validHarnessSpec);

      const result = await handleValidate({});

      expect(result.success).toBe(true);
      expect(mockReadHarnessSpec).toHaveBeenCalledWith('myHarness');
    });

    it('returns error when harness spec is invalid', async () => {
      mockFindConfigRoot.mockReturnValue('/project/agentcore');
      mockReadProjectSpec.mockResolvedValue(projectWithHarness);
      mockReadAWSDeploymentTargets.mockResolvedValue([]);
      mockConfigExists.mockReturnValue(false);
      mockReadHarnessSpec.mockRejectedValue(new Error('invalid harness'));

      const result = await handleValidate({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid harness');
    });

    it('returns error when harness references non-existent memory', async () => {
      mockFindConfigRoot.mockReturnValue('/project/agentcore');
      mockReadProjectSpec.mockResolvedValue(projectWithHarness);
      mockReadAWSDeploymentTargets.mockResolvedValue([]);
      mockConfigExists.mockReturnValue(false);
      mockReadHarnessSpec.mockResolvedValue({
        ...validHarnessSpec,
        memory: { name: 'nonExistent' },
      });

      const result = await handleValidate({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('references memory "nonExistent"');
      expect(result.error).toContain('not defined in the project');
    });

    it('passes when harness references existing memory', async () => {
      mockFindConfigRoot.mockReturnValue('/project/agentcore');
      mockReadProjectSpec.mockResolvedValue(projectWithHarness);
      mockReadAWSDeploymentTargets.mockResolvedValue([]);
      mockConfigExists.mockReturnValue(false);
      mockReadHarnessSpec.mockResolvedValue({
        ...validHarnessSpec,
        memory: { name: 'myMemory' },
      });

      const result = await handleValidate({});

      expect(result.success).toBe(true);
    });

    it('passes when harness memory uses arn instead of name', async () => {
      mockFindConfigRoot.mockReturnValue('/project/agentcore');
      mockReadProjectSpec.mockResolvedValue(projectWithHarness);
      mockReadAWSDeploymentTargets.mockResolvedValue([]);
      mockConfigExists.mockReturnValue(false);
      mockReadHarnessSpec.mockResolvedValue({
        ...validHarnessSpec,
        memory: { arn: 'arn:aws:bedrock:us-east-1:123456789012:memory/abc' },
      });

      const result = await handleValidate({});

      expect(result.success).toBe(true);
    });

    it('skips harness validation when project has no harnesses', async () => {
      mockFindConfigRoot.mockReturnValue('/project/agentcore');
      mockReadProjectSpec.mockResolvedValue({
        name: 'Test',
        version: 1,
        managedBy: 'CDK' as const,
        runtimes: [],
        memories: [],
      });
      mockReadAWSDeploymentTargets.mockResolvedValue([]);
      mockConfigExists.mockReturnValue(false);

      const result = await handleValidate({});

      expect(result.success).toBe(true);
      expect(mockReadHarnessSpec).not.toHaveBeenCalled();
    });

    it('validates multiple harnesses and fails on first error', async () => {
      mockFindConfigRoot.mockReturnValue('/project/agentcore');
      mockReadProjectSpec.mockResolvedValue({
        ...projectWithHarness,
        harnesses: [
          { name: 'harness1', path: './harnesses/harness1' },
          { name: 'harness2', path: './harnesses/harness2' },
        ],
      });
      mockReadAWSDeploymentTargets.mockResolvedValue([]);
      mockConfigExists.mockReturnValue(false);
      mockReadHarnessSpec.mockImplementation((name: string) => {
        if (name === 'harness1') return Promise.resolve(validHarnessSpec);
        return Promise.reject(new Error('harness2 invalid'));
      });

      const result = await handleValidate({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('harness2 invalid');
    });
  });
});
