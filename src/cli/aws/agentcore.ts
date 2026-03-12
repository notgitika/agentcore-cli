import { getCredentialProvider } from './account';
import {
  BedrockAgentCoreClient,
  EvaluateCommand,
  InvokeAgentRuntimeCommand,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { DocumentType } from '@smithy/types';

/** Logger interface for SSE events */
export interface SSELogger {
  logSSEEvent(rawLine: string): void;
}

/** Default user ID sent with invocations. Container agents require this to obtain workload access tokens. */
export const DEFAULT_RUNTIME_USER_ID = 'default-user';

export interface InvokeAgentRuntimeOptions {
  region: string;
  runtimeArn: string;
  payload: string;
  sessionId?: string;
  /** User ID for the runtime invocation. Defaults to 'default-user'. Required for Container agents using identity providers. */
  userId?: string;
  /** Optional logger for SSE event debugging */
  logger?: SSELogger;
}

export interface InvokeAgentRuntimeResult {
  content: string;
  sessionId?: string;
}

export interface StreamingInvokeResult {
  stream: AsyncGenerator<string, void, unknown>;
  sessionId: string | undefined;
}

export interface StopRuntimeSessionOptions {
  region: string;
  runtimeArn: string;
  sessionId: string;
}

export interface StopRuntimeSessionResult {
  sessionId: string | undefined;
  statusCode: number | undefined;
}

/**
 * Parse a single SSE data line and extract the content.
 * Returns null if the line is not a data line or contains an error.
 */
export function parseSSELine(line: string): { content: string | null; error: string | null } {
  if (!line.startsWith('data: ')) {
    return { content: null, error: null };
  }
  const content = line.slice(6);
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'string') {
      return { content: parsed, error: null };
    } else if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      return { content: null, error: String((parsed as { error: unknown }).error) };
    }
  } catch {
    return { content, error: null };
  }
  return { content: null, error: null };
}

/**
 * Parse SSE response into combined text.
 */
export function parseSSE(text: string): string {
  const parts: string[] = [];
  for (const line of text.split('\n')) {
    const { content, error } = parseSSELine(line);
    if (error) {
      return `Error: ${error}`;
    }
    if (content) {
      parts.push(content);
    }
  }
  return parts.join('');
}

/**
 * Extract result from a JSON response object.
 * Handles both {"result": "..."} and plain text responses.
 */
export function extractResult(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'result' in parsed) {
      const result = (parsed as { result: unknown }).result;
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    }
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

/**
 * Invoke an AgentCore Runtime and stream the response chunks.
 * Returns an object with the stream generator and session ID.
 */
export async function invokeAgentRuntimeStreaming(options: InvokeAgentRuntimeOptions): Promise<StreamingInvokeResult> {
  const client = new BedrockAgentCoreClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: options.runtimeArn,
    payload: new TextEncoder().encode(JSON.stringify({ prompt: options.payload })),
    contentType: 'application/json',
    accept: 'application/json',
    runtimeSessionId: options.sessionId,
    runtimeUserId: options.userId ?? DEFAULT_RUNTIME_USER_ID,
  });

  const response = await client.send(command);
  const sessionId = response.runtimeSessionId;

  if (!response.response) {
    throw new Error('No response from AgentCore Runtime');
  }

  const webStream = response.response.transformToWebStream();
  const reader = webStream.getReader();
  const decoder = new TextDecoder();

  async function* streamGenerator(): AsyncGenerator<string, void, unknown> {
    let buffer = '';
    let fullResponse = '';
    let yieldedContent = false;
    const { logger } = options;

    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;

        const decoded = decoder.decode(result.value as Uint8Array, { stream: true });
        buffer += decoded;
        fullResponse += decoded;

        // Process complete lines from the buffer
        const lines = buffer.split('\n');
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          // Log raw SSE line if logger provided
          if (logger && line.trim()) {
            logger.logSSEEvent(line);
          }
          const { content, error } = parseSSELine(line);
          if (error) {
            yield `Error: ${error}`;
            return;
          }
          if (content) {
            yield content;
            yieldedContent = true;
          }
        }
      }

      // Process any remaining content in the buffer
      if (buffer) {
        // Log raw SSE line if logger provided
        if (logger && buffer.trim()) {
          logger.logSSEEvent(buffer);
        }
        const { content, error } = parseSSELine(buffer);
        if (error) {
          yield `Error: ${error}`;
        } else if (content) {
          yield content;
          yieldedContent = true;
        }
      }

      // Fallback for plain JSON responses (non-SSE)
      if (!yieldedContent && fullResponse.trim()) {
        yield extractResult(fullResponse.trim());
      }
    } finally {
      reader.releaseLock();
    }
  }

  return {
    stream: streamGenerator(),
    sessionId,
  };
}

/**
 * Invoke an AgentCore Runtime and return the response.
 */
export async function invokeAgentRuntime(options: InvokeAgentRuntimeOptions): Promise<InvokeAgentRuntimeResult> {
  const client = new BedrockAgentCoreClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: options.runtimeArn,
    payload: new TextEncoder().encode(JSON.stringify({ prompt: options.payload })),
    contentType: 'application/json',
    accept: 'application/json',
    runtimeSessionId: options.sessionId,
    runtimeUserId: options.userId ?? DEFAULT_RUNTIME_USER_ID,
  });

  const response = await client.send(command);

  if (!response.response) {
    throw new Error('No response from AgentCore Runtime');
  }

  const bytes = await response.response.transformToByteArray();
  const text = new TextDecoder().decode(bytes);

  // Parse SSE format if present
  const content = text.includes('data: ') ? parseSSE(text) : extractResult(text);

  return {
    content,
    sessionId: response.runtimeSessionId,
  };
}

// ============================================================================
// Evaluate
// ============================================================================

export interface EvaluateOptions {
  region: string;
  evaluatorId: string;
  sessionSpans: DocumentType[];
  targetSpanIds?: string[];
  targetTraceIds?: string[];
}

export interface EvaluationResultContext {
  sessionId: string | undefined;
  traceId: string | undefined;
  spanId: string | undefined;
}

export interface EvaluationResultTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface EvaluationResult {
  evaluatorArn: string | undefined;
  evaluatorId: string | undefined;
  evaluatorName: string | undefined;
  explanation: string | undefined;
  value: number | undefined;
  label: string | undefined;
  errorMessage: string | undefined;
  errorCode: string | undefined;
  context: EvaluationResultContext | undefined;
  tokenUsage: EvaluationResultTokenUsage | undefined;
}

export interface EvaluateResult {
  evaluationResults: EvaluationResult[];
}

/**
 * Run on-demand evaluation of agent traces using a specified evaluator.
 */
export async function evaluate(options: EvaluateOptions): Promise<EvaluateResult> {
  const client = new BedrockAgentCoreClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const evaluationTarget = options.targetSpanIds
    ? { spanIds: options.targetSpanIds }
    : options.targetTraceIds
      ? { traceIds: options.targetTraceIds }
      : undefined;

  const command = new EvaluateCommand({
    evaluatorId: options.evaluatorId,
    evaluationInput: {
      sessionSpans: options.sessionSpans,
    },
    ...(evaluationTarget ? { evaluationTarget } : {}),
  });

  const response = await client.send(command);

  if (!response.evaluationResults) {
    throw new Error('No evaluation results returned');
  }

  return {
    evaluationResults: response.evaluationResults.map(r => {
      const spanContext = r.context && 'spanContext' in r.context ? r.context.spanContext : undefined;

      return {
        evaluatorArn: r.evaluatorArn,
        evaluatorId: r.evaluatorId,
        evaluatorName: r.evaluatorName,
        explanation: r.explanation,
        value: r.value,
        label: r.label,
        errorMessage: r.errorMessage,
        errorCode: r.errorCode,
        context: spanContext
          ? {
              sessionId: spanContext.sessionId,
              traceId: spanContext.traceId,
              spanId: spanContext.spanId,
            }
          : undefined,
        tokenUsage: r.tokenUsage
          ? {
              inputTokens: r.tokenUsage.inputTokens ?? 0,
              outputTokens: r.tokenUsage.outputTokens ?? 0,
              totalTokens: r.tokenUsage.totalTokens ?? 0,
            }
          : undefined,
      };
    }),
  };
}

/**
 * Stop a runtime session.
 */
export async function stopRuntimeSession(options: StopRuntimeSessionOptions): Promise<StopRuntimeSessionResult> {
  const client = new BedrockAgentCoreClient({
    region: options.region,
    credentials: getCredentialProvider(),
  });

  const command = new StopRuntimeSessionCommand({
    agentRuntimeArn: options.runtimeArn,
    runtimeSessionId: options.sessionId,
  });

  const response = await client.send(command);

  return {
    sessionId: response.runtimeSessionId,
    statusCode: response.statusCode,
  };
}
