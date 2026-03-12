import { handleRunEval } from '../run-eval.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockResolveAgent = vi.fn();
const mockLoadDeployedProjectConfig = vi.fn();
const mockEvaluate = vi.fn();
const mockSaveEvalRun = vi.fn();
const mockGenerateRunId = vi.fn();
const mockSend = vi.fn();
const mockGetCredentialProvider = vi.fn().mockReturnValue({});
const mockWriteFileSync = vi.fn();

vi.mock('../../resolve-agent', () => ({
  loadDeployedProjectConfig: () => mockLoadDeployedProjectConfig(),
  resolveAgent: (...args: unknown[]) => mockResolveAgent(...args),
}));

vi.mock('../../../aws/agentcore', () => ({
  evaluate: (...args: unknown[]) => mockEvaluate(...args),
}));

vi.mock('../../../aws', () => ({
  getCredentialProvider: () => mockGetCredentialProvider(),
}));

vi.mock('../storage', () => ({
  generateRunId: () => mockGenerateRunId(),
  saveEvalRun: (...args: unknown[]) => mockSaveEvalRun(...args),
}));

vi.mock('fs', async importOriginal => {
  const original = await importOriginal<typeof import('fs')>();
  return {
    ...original,
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  };
});

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class {
    send = mockSend;
  },
  StartQueryCommand: class {
    constructor(public input: unknown) {}
  },
  GetQueryResultsCommand: class {
    constructor(public input: unknown) {}
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeployedContext({
  agentName = 'my-agent',
  runtimeId = 'rt-123',
  evaluators = {} as Record<string, { evaluatorId: string }>,
} = {}) {
  return {
    project: {
      agents: [{ name: agentName }],
      onlineEvalConfigs: [],
    },
    awsTargets: [{ name: 'dev', region: 'us-east-1', account: '111222333444' }],
    deployedState: {
      targets: {
        dev: {
          resources: {
            agents: {
              [agentName]: {
                runtimeId,
                runtimeArn: `arn:aws:bedrock:us-east-1:111222333444:agent-runtime/${runtimeId}`,
                roleArn: 'arn:aws:iam::111222333444:role/test',
              },
            },
            evaluators,
          },
        },
      },
    },
  };
}

function makeOtelSpanRow(sessionId: string, traceId: string, spanBody: Record<string, unknown> = {}) {
  const message = JSON.stringify({
    scope: { name: 'strands.telemetry.tracer' },
    body: spanBody,
    traceId,
  });
  return [
    { field: '@message', value: message },
    { field: 'sessionId', value: sessionId },
    { field: 'traceId', value: traceId },
  ];
}

function setupCloudWatchToReturn(spanRows: unknown[][], runtimeLogRows: unknown[][] = []) {
  let queryCount = 0;
  mockSend.mockImplementation((cmd: { input: unknown }) => {
    const input = cmd.input as Record<string, unknown>;

    if ('queryString' in input) {
      // StartQueryCommand
      queryCount++;
      return Promise.resolve({ queryId: `q-${queryCount}` });
    }

    // GetQueryResultsCommand — return Complete immediately
    if (queryCount === 1) {
      return Promise.resolve({ status: 'Complete', results: spanRows });
    }
    return Promise.resolve({ status: 'Complete', results: runtimeLogRows });
  });
}

describe('handleRunEval', () => {
  beforeEach(() => {
    mockGenerateRunId.mockReturnValue('run_test-123');
    mockSaveEvalRun.mockReturnValue('/tmp/eval-results/run_test-123.json');
  });

  afterEach(() => vi.clearAllMocks());

  // ─── Context resolution ───────────────────────────────────────────────────

  it('returns error when agent resolution fails', async () => {
    mockLoadDeployedProjectConfig.mockResolvedValue({});
    mockResolveAgent.mockReturnValue({ success: false, error: 'No agents defined' });

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    expect(result.success).toBe(false);
    expect(result.error).toBe('No agents defined');
  });

  it('returns error when a custom evaluator is not found in deployed state', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const result = await handleRunEval({ evaluator: ['MissingEval'], days: 7 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('MissingEval');
    expect(result.error).toContain('not found in deployed state');
  });

  it('resolves builtin evaluators without deployed state lookup', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    // No spans found — will return before calling evaluate
    setupCloudWatchToReturn([]);

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    // Fails because no spans, but NOT because evaluator wasn't found
    expect(result.error).toContain('No session spans found');
  });

  it('resolves custom evaluator name to deployed evaluator ID', async () => {
    const ctx = makeDeployedContext({
      evaluators: { MyCustomEval: { evaluatorId: 'eval-custom-id' } },
    });
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const spanRows = [makeOtelSpanRow('session-1', 'trace-1')];
    setupCloudWatchToReturn(spanRows);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 4.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    const result = await handleRunEval({ evaluator: ['MyCustomEval'], days: 7 });

    expect(result.success).toBe(true);
    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({ evaluatorId: 'eval-custom-id' }));
  });

  it('extracts evaluator ID from ARN when --evaluator-arn is passed', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const spanRows = [makeOtelSpanRow('session-1', 'trace-1')];
    setupCloudWatchToReturn(spanRows);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 3.0, context: { spanContext: { sessionId: 'session-1' } } }],
    });

    const result = await handleRunEval({
      evaluator: [],
      evaluatorArn: ['arn:aws:bedrock:us-east-1:123:evaluator/my-eval-id'],
      days: 7,
    });

    expect(result.success).toBe(true);
    expect(mockEvaluate).toHaveBeenCalledWith(expect.objectContaining({ evaluatorId: 'my-eval-id' }));
  });

  // ─── No sessions ──────────────────────────────────────────────────────────

  it('returns error when no session spans are found', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([]);

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No session spans found');
    expect(result.error).toContain('my-agent');
  });

  // ─── Successful evaluation ────────────────────────────────────────────────

  it('runs evaluation across sessions and computes aggregate score', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const spanRows = [makeOtelSpanRow('session-1', 'trace-1'), makeOtelSpanRow('session-2', 'trace-2')];
    setupCloudWatchToReturn(spanRows);

    mockEvaluate
      .mockResolvedValueOnce({
        evaluationResults: [
          {
            value: 4.0,
            context: { spanContext: { sessionId: 'session-1', traceId: 'trace-1' } },
            tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          },
        ],
      })
      .mockResolvedValueOnce({
        evaluationResults: [
          {
            value: 2.0,
            context: { spanContext: { sessionId: 'session-2', traceId: 'trace-2' } },
            tokenUsage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
          },
        ],
      });

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    expect(result.success).toBe(true);
    expect(result.run).toBeDefined();
    expect(result.run!.sessionCount).toBe(2);
    expect(result.run!.results).toHaveLength(1);

    const evalResult = result.run!.results[0]!;
    expect(evalResult.aggregateScore).toBe(3.0); // (4 + 2) / 2
    expect(evalResult.sessionScores).toHaveLength(2);
    expect(evalResult.tokenUsage).toEqual({ inputTokens: 180, outputTokens: 90, totalTokens: 270 });
  });

  it('excludes errored sessions from aggregate score', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    const spanRows = [makeOtelSpanRow('session-1', 'trace-1')];
    setupCloudWatchToReturn(spanRows);

    mockEvaluate.mockResolvedValue({
      evaluationResults: [
        { value: 5.0, context: { spanContext: { sessionId: 's1' } } },
        { value: 0, errorMessage: 'something failed', context: { spanContext: { sessionId: 's2' } } },
      ],
    });

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    expect(result.success).toBe(true);
    const evalResult = result.run!.results[0]!;
    // Only the non-errored session (value 5.0) should be in the aggregate
    expect(evalResult.aggregateScore).toBe(5.0);
    expect(evalResult.sessionScores).toHaveLength(2);
  });

  // ─── Output handling ──────────────────────────────────────────────────────

  it('saves to default location when no output option', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 3.0, context: { spanContext: { sessionId: 's1' } } }],
    });

    const result = await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    expect(result.success).toBe(true);
    expect(mockSaveEvalRun).toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(result.filePath).toBe('/tmp/eval-results/run_test-123.json');
  });

  it('writes to custom output path when --output is specified', async () => {
    const ctx = makeDeployedContext();
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);
    mockEvaluate.mockResolvedValue({
      evaluationResults: [{ value: 3.0, context: { spanContext: { sessionId: 's1' } } }],
    });

    const result = await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate'],
      days: 7,
      output: '/tmp/my-output.json',
    });

    expect(result.success).toBe(true);
    expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/my-output.json', expect.any(String));
    expect(mockSaveEvalRun).not.toHaveBeenCalled();
    expect(result.filePath).toBe('/tmp/my-output.json');
  });

  // ─── Multiple evaluators ─────────────────────────────────────────────────

  it('runs multiple evaluators and returns separate results for each', async () => {
    const ctx = makeDeployedContext({
      evaluators: { CustomEval: { evaluatorId: 'eval-custom' } },
    });
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: 'rt-123',
      },
    });

    setupCloudWatchToReturn([makeOtelSpanRow('s1', 't1')]);

    mockEvaluate
      .mockResolvedValueOnce({
        evaluationResults: [{ value: 0.9, context: { spanContext: { sessionId: 's1' } } }],
      })
      .mockResolvedValueOnce({
        evaluationResults: [{ value: 4.5, context: { spanContext: { sessionId: 's1' } } }],
      });

    const result = await handleRunEval({
      evaluator: ['Builtin.GoalSuccessRate', 'CustomEval'],
      days: 7,
    });

    expect(result.success).toBe(true);
    expect(result.run!.results).toHaveLength(2);
    expect(result.run!.results[0]!.evaluator).toBe('Builtin.GoalSuccessRate');
    expect(result.run!.results[0]!.aggregateScore).toBe(0.9);
    expect(result.run!.results[1]!.evaluator).toBe('CustomEval');
    expect(result.run!.results[1]!.aggregateScore).toBe(4.5);
  });

  // ─── Query sanitization ───────────────────────────────────────────────────

  it('sanitizes runtimeId in CloudWatch query to prevent injection', async () => {
    const ctx = makeDeployedContext({ runtimeId: "rt-123'; DROP TABLE" });
    mockLoadDeployedProjectConfig.mockResolvedValue(ctx);
    mockResolveAgent.mockReturnValue({
      success: true,
      agent: {
        agentName: 'my-agent',
        targetName: 'dev',
        region: 'us-east-1',
        accountId: '111222333444',
        runtimeId: "rt-123'; DROP TABLE",
      },
    });

    setupCloudWatchToReturn([]);

    await handleRunEval({ evaluator: ['Builtin.GoalSuccessRate'], days: 7 });

    // Verify the StartQueryCommand was called with sanitized runtimeId (no single quotes)
    const startQueryCall = mockSend.mock.calls.find((call: unknown[]) => {
      const input = (call[0] as { input?: { queryString?: string } }).input;
      return input?.queryString !== undefined;
    });
    expect(startQueryCall).toBeDefined();
    const queryString = (startQueryCall![0] as { input: { queryString: string } }).input.queryString;
    expect(queryString).not.toContain("'rt-123'; DROP TABLE'");
    expect(queryString).toContain('rt-123; DROP TABLE');
  });
});
