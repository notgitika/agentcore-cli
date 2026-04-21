export interface InvokeOptions {
  agentName?: string;
  harnessName?: string;
  targetName?: string;
  prompt?: string;
  sessionId?: string;
  userId?: string;
  json?: boolean;
  stream?: boolean;
  /** MCP tool name (used with prompt "call-tool") */
  tool?: string;
  /** MCP tool arguments as JSON string (used with --tool) */
  input?: string;
  /** Execute a shell command in the runtime container instead of invoking the agent */
  exec?: boolean;
  /** Timeout in seconds for exec commands */
  timeout?: number;
  /** Custom headers to forward to the agent runtime (key-value pairs) */
  headers?: Record<string, string>;
  /** Bearer token for CUSTOM_JWT auth (bypasses SigV4) */
  bearerToken?: string;
  /** Print verbose streaming JSON events instead of formatted text (harness only) */
  verbose?: boolean;
  /** Override model ID for this invocation (harness only) */
  modelId?: string;
  /** Override tools for this invocation (harness only, comma-separated) */
  tools?: string;
  /** Override max iterations (harness only) */
  maxIterations?: number;
  /** Override timeout seconds (harness only) */
  harnessTimeout?: number;
  /** Override max tokens (harness only) */
  maxTokens?: number;
  /** Skills to use (harness only, comma-separated paths) */
  skills?: string;
  /** Override system prompt (harness only) */
  systemPrompt?: string;
  /** Override allowed tools (harness only, comma-separated) */
  allowedTools?: string;
  /** Override memory actor ID (harness only) */
  actorId?: string;
  /** Auto-approve inline_function tool calls without prompting */
  autoApprove?: boolean;
}

export interface InvokeResult {
  success: boolean;
  agentName?: string;
  targetName?: string;
  response?: string;
  error?: string;
  logFilePath?: string;
}
