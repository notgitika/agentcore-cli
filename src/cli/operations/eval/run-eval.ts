import { getCredentialProvider } from '../../aws';
import { evaluate } from '../../aws/agentcore';
import { DEFAULT_ENDPOINT_NAME } from '../../constants';
import type { DeployedProjectConfig } from '../resolve-agent';
import { loadDeployedProjectConfig, resolveAgent } from '../resolve-agent';
import { generateRunId, saveEvalRun } from './storage';
import type { EvalEvaluatorResult, EvalRunResult, EvalSessionScore, RunEvalOptions } from './types';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import type { ResultField } from '@aws-sdk/client-cloudwatch-logs';
import type { DocumentType } from '@smithy/types';

const SPANS_LOG_GROUP = 'aws/spans';

const SUPPORTED_SCOPES = new Set([
  'strands.telemetry.tracer',
  'opentelemetry.instrumentation.langchain',
  'openinference.instrumentation.langchain',
]);

interface ResolvedEvalContext {
  agentName: string;
  region: string;
  accountId: string;
  runtimeId: string;
  runtimeLogGroup: string;
  evaluatorIds: string[];
}

function resolveEvalContext(
  context: DeployedProjectConfig,
  options: RunEvalOptions
): { success: true; ctx: ResolvedEvalContext } | { success: false; error: string } {
  const agentResult = resolveAgent(context, { agent: options.agent });
  if (!agentResult.success) {
    return agentResult;
  }

  const { agent } = agentResult;
  const runtimeLogGroup = `/aws/bedrock-agentcore/runtimes/${agent.runtimeId}-${DEFAULT_ENDPOINT_NAME}`;

  // Resolve evaluator names to IDs
  const evaluatorIds: string[] = [];
  const targetResources = context.deployedState.targets[agent.targetName]?.resources;

  for (const evalName of options.evaluator) {
    if (evalName.startsWith('Builtin.')) {
      evaluatorIds.push(evalName);
      continue;
    }

    const deployedEval = targetResources?.evaluators?.[evalName];
    if (!deployedEval) {
      return {
        success: false,
        error: `Evaluator "${evalName}" not found in deployed state. Has it been deployed?`,
      };
    }
    evaluatorIds.push(deployedEval.evaluatorId);
  }

  // Also add any direct ARNs/IDs — extract ID from ARN if full ARN is passed
  if (options.evaluatorArn) {
    for (const arnOrId of options.evaluatorArn) {
      const arnMatch = /evaluator\/(.+)$/.exec(arnOrId);
      evaluatorIds.push(arnMatch ? arnMatch[1]! : arnOrId);
    }
  }

  if (evaluatorIds.length === 0) {
    return { success: false, error: 'No evaluators specified. Use -e/--evaluator or --evaluator-arn.' };
  }

  return {
    success: true,
    ctx: {
      agentName: agent.agentName,
      region: agent.region,
      accountId: agent.accountId,
      runtimeId: agent.runtimeId,
      runtimeLogGroup,
      evaluatorIds,
    },
  };
}

/**
 * Execute a CloudWatch Logs Insights query and wait for results.
 */
async function executeQuery(
  client: CloudWatchLogsClient,
  logGroupName: string,
  queryString: string,
  startTimeSec: number,
  endTimeSec: number
): Promise<ResultField[][]> {
  const startQuery = await client.send(
    new StartQueryCommand({
      logGroupName,
      startTime: startTimeSec,
      endTime: endTimeSec,
      queryString,
    })
  );

  if (!startQuery.queryId) {
    throw new Error('Failed to start CloudWatch Logs Insights query');
  }

  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));

    const queryResults = await client.send(new GetQueryResultsCommand({ queryId: startQuery.queryId }));
    const status = queryResults.status ?? 'Unknown';

    if (status === 'Failed' || status === 'Cancelled') {
      throw new Error(`CloudWatch query ${status.toLowerCase()}`);
    }

    if (status === 'Complete') {
      return queryResults.results ?? [];
    }
  }

  throw new Error('CloudWatch query timed out after 60 seconds');
}

/**
 * Extract parsed @message documents from CloudWatch Insights results.
 */
function extractMessages(rows: ResultField[][]): Record<string, unknown>[] {
  const docs: Record<string, unknown>[] = [];
  for (const row of rows) {
    const messageField = row.find(f => f.field === '@message');
    if (messageField?.value) {
      try {
        docs.push(JSON.parse(messageField.value) as Record<string, unknown>);
      } catch {
        // Skip non-JSON log lines
      }
    }
  }
  return docs;
}

/**
 * Check if a document is relevant for evaluation:
 * - Has a supported instrumentation scope, OR
 * - Is a log record with conversation data (body.input / body.output)
 */
function isRelevantForEval(doc: Record<string, unknown>): boolean {
  const scope = doc.scope as Record<string, unknown> | undefined;
  const scopeName = scope?.name as string | undefined;
  if (scopeName && SUPPORTED_SCOPES.has(scopeName)) {
    return true;
  }

  const body = doc.body;
  if (body && typeof body === 'object' && ('input' in body || 'output' in body)) {
    return true;
  }

  return false;
}

interface SessionSpans {
  sessionId: string;
  spans: DocumentType[];
}

/**
 * Fetch OTel spans from the `aws/spans` log group and runtime logs from the agent's
 * log group, then group them by session.
 *
 * The Evaluate API requires spans from a single session per call.
 */
async function fetchSessionSpans(
  runtimeId: string,
  runtimeLogGroup: string,
  region: string,
  lookbackDays: number
): Promise<SessionSpans[]> {
  const endTimeMs = Date.now();
  const startTimeMs = endTimeMs - lookbackDays * 24 * 60 * 60 * 1000;
  const startTimeSec = Math.floor(startTimeMs / 1000);
  const endTimeSec = Math.floor(endTimeMs / 1000);

  const client = new CloudWatchLogsClient({
    credentials: getCredentialProvider(),
    region,
  });

  // 1. Query proper OTel spans from the aws/spans log group
  const spanRows = await executeQuery(
    client,
    SPANS_LOG_GROUP,
    `fields @message, attributes.session.id as sessionId, traceId
     | parse resource.attributes.cloud.resource_id "runtime/*/" as parsedAgentId
     | filter parsedAgentId = '${runtimeId}'
     | sort startTimeUnixNano asc
     | limit 10000`,
    startTimeSec,
    endTimeSec
  );

  // Group spans by session and collect trace IDs
  const sessionMap = new Map<string, DocumentType[]>();
  const traceIds = new Set<string>();

  for (const row of spanRows) {
    const messageField = row.find(f => f.field === '@message');
    const sessionField = row.find(f => f.field === 'sessionId');
    const traceField = row.find(f => f.field === 'traceId');

    if (!messageField?.value) continue;

    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(messageField.value) as Record<string, unknown>;
    } catch {
      continue;
    }

    const sessionId = sessionField?.value ?? 'unknown';
    if (!sessionMap.has(sessionId)) {
      sessionMap.set(sessionId, []);
    }
    sessionMap.get(sessionId)!.push(doc as DocumentType);

    if (traceField?.value) {
      traceIds.add(traceField.value);
    }
  }

  if (sessionMap.size === 0) {
    return [];
  }

  // 2. Query runtime logs from the agent's log group for the trace IDs found
  if (traceIds.size > 0) {
    const traceFilter = [...traceIds].map(t => `'${t}'`).join(', ');
    let logRows: ResultField[][] = [];
    try {
      logRows = await executeQuery(
        client,
        runtimeLogGroup,
        `fields @message, traceId
         | filter traceId in [${traceFilter}]
         | sort @timestamp asc
         | limit 10000`,
        startTimeSec,
        endTimeSec
      );
    } catch {
      // Runtime log group may not exist yet; continue with spans only
    }

    const logDocs = extractMessages(logRows);

    // Match runtime logs to sessions via traceId
    // Build traceId → sessionId mapping from spans
    const traceToSession = new Map<string, string>();
    for (const row of spanRows) {
      const traceField = row.find(f => f.field === 'traceId');
      const sessionField = row.find(f => f.field === 'sessionId');
      if (traceField?.value && sessionField?.value) {
        traceToSession.set(traceField.value, sessionField.value);
      }
    }

    for (const logDoc of logDocs) {
      if (!isRelevantForEval(logDoc)) continue;

      const logTraceId = logDoc.traceId as string | undefined;
      const sessionId = logTraceId ? (traceToSession.get(logTraceId) ?? 'unknown') : 'unknown';
      if (!sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, []);
      }
      sessionMap.get(sessionId)!.push(logDoc as DocumentType);
    }
  }

  // 3. Build session list — aws/spans docs are already scoped by runtimeId (step 1),
  //    and runtime log docs were filtered through isRelevantForEval (step 2).
  //    We keep all docs so the Evaluate API has full trace context for resolving
  //    template variables like {actual_trajectory}.
  const sessions: SessionSpans[] = [];
  for (const [sessionId, docs] of sessionMap) {
    if (docs.length > 0) {
      sessions.push({ sessionId, spans: docs });
    }
  }

  return sessions;
}

export interface RunEvalResult {
  success: boolean;
  error?: string;
  run?: EvalRunResult;
  filePath?: string;
}

export async function handleRunEval(options: RunEvalOptions): Promise<RunEvalResult> {
  const context = await loadDeployedProjectConfig();
  const resolution = resolveEvalContext(context, options);

  if (!resolution.success) {
    return { success: false, error: resolution.error };
  }

  const { ctx } = resolution;

  // Fetch spans grouped by session
  const sessions = await fetchSessionSpans(ctx.runtimeId, ctx.runtimeLogGroup, ctx.region, options.days);

  if (sessions.length === 0) {
    return {
      success: false,
      error: `No session spans found for agent "${ctx.agentName}" in the last ${options.days} day(s). Has the agent been invoked?`,
    };
  }

  // Run each evaluator against each session
  const results: EvalEvaluatorResult[] = [];
  const allEvaluatorNames = [...options.evaluator, ...(options.evaluatorArn ?? [])];

  for (let i = 0; i < ctx.evaluatorIds.length; i++) {
    const evaluatorId = ctx.evaluatorIds[i]!;
    const evaluatorName = allEvaluatorNames[i] ?? evaluatorId;

    const sessionScores: EvalSessionScore[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;

    for (const session of sessions) {
      const response = await evaluate({
        region: ctx.region,
        evaluatorId,
        sessionSpans: session.spans,
      });

      for (const r of response.evaluationResults) {
        sessionScores.push({
          sessionId: r.context?.sessionId ?? session.sessionId,
          traceId: r.context?.traceId,
          spanId: r.context?.spanId,
          value: r.value ?? 0,
          label: r.label,
          explanation: r.explanation,
          errorMessage: r.errorMessage,
        });

        totalInputTokens += r.tokenUsage?.inputTokens ?? 0;
        totalOutputTokens += r.tokenUsage?.outputTokens ?? 0;
        totalTokens += r.tokenUsage?.totalTokens ?? 0;
      }
    }

    const validScores = sessionScores.filter(s => !s.errorMessage);
    const aggregateScore =
      validScores.length > 0 ? validScores.reduce((sum, s) => sum + s.value, 0) / validScores.length : 0;

    results.push({
      evaluator: evaluatorName,
      aggregateScore,
      sessionScores,
      tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, totalTokens },
    });
  }

  // Build run result
  const run: EvalRunResult = {
    runId: generateRunId(),
    timestamp: new Date().toISOString(),
    agent: ctx.agentName,
    evaluators: allEvaluatorNames,
    lookbackDays: options.days,
    sessionCount: sessions.length,
    results,
  };

  // Save to disk
  const filePath = options.output ?? saveEvalRun(run);

  return { success: true, run, filePath };
}
