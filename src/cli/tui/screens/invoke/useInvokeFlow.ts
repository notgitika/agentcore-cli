import { ConfigIO } from '../../../../lib';
import type {
  AgentCoreDeployedState,
  AwsDeploymentTarget,
  HarnessDeployedState,
  ModelProvider,
  NetworkMode,
  ProtocolMode,
  RuntimeAuthorizerType,
  AgentCoreProjectSpec as _AgentCoreProjectSpec,
} from '../../../../schema';
import {
  DEFAULT_RUNTIME_USER_ID,
  type McpToolDef,
  executeBashCommand,
  invokeA2ARuntime,
  invokeAgentRuntimeStreaming,
  mcpCallTool,
  mcpListTools,
} from '../../../aws';
import { invokeHarness } from '../../../aws/agentcore-harness';
import { getErrorMessage } from '../../../errors';
import { InvokeLogger } from '../../../logging';
import { formatMcpToolList } from '../../../operations/dev/utils';
import { canFetchRuntimeToken, fetchRuntimeToken } from '../../../operations/fetch-access';
import { generateSessionId } from '../../../operations/session';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface InvokeConfig {
  runtimes: {
    name: string;
    state: AgentCoreDeployedState;
    modelProvider?: ModelProvider;
    networkMode?: NetworkMode;
    protocol?: ProtocolMode;
    authorizerType?: RuntimeAuthorizerType;
  }[];
  harnesses: {
    name: string;
    state: HarnessDeployedState;
  }[];
  target: AwsDeploymentTarget;
  targetName: string;
  projectName: string;
}

export interface InvokeFlowOptions {
  initialSessionId?: string;
  initialUserId?: string;
  /** Custom headers to forward to the agent runtime on every invocation */
  headers?: Record<string, string>;
  initialBearerToken?: string;
}

export type TokenFetchState = 'idle' | 'fetching' | 'fetched' | 'error';

export interface PendingToolApproval {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  harnessArn: string;
  sessionId: string;
}

export interface InvokeFlowState {
  phase: 'loading' | 'ready' | 'invoking' | 'tool-approval' | 'error';
  config: InvokeConfig | null;
  selectedAgent: number;
  messages: { role: 'user' | 'assistant'; content: string; isHint?: boolean }[];
  error: string | null;
  logFilePath: string | null;
  sessionId: string | null;
  userId: string;
  bearerToken: string;
  tokenFetchState: TokenFetchState;
  tokenFetchError: string | null;
  tokenExpiresIn: number | undefined;
  mcpTools: McpToolDef[];
  mcpToolsFetched: boolean;
  pendingToolApproval: PendingToolApproval | null;
  selectAgent: (index: number) => void;
  setUserId: (id: string) => void;
  setBearerToken: (token: string) => void;
  fetchBearerToken: () => Promise<void>;
  invoke: (prompt: string) => Promise<void>;
  execCommand: (command: string) => Promise<void>;
  respondToTool: (approved: boolean, response: string) => Promise<void>;
  newSession: () => void;
  fetchMcpTools: () => Promise<void>;
}

export function useInvokeFlow(options: InvokeFlowOptions = {}): InvokeFlowState {
  const { initialSessionId, initialUserId, headers, initialBearerToken } = options;
  const [phase, setPhase] = useState<'loading' | 'ready' | 'invoking' | 'tool-approval' | 'error'>('loading');
  const [pendingToolApproval, setPendingToolApproval] = useState<PendingToolApproval | null>(null);
  const [config, setConfig] = useState<InvokeConfig | null>(null);
  const [selectedAgent, setSelectedAgent] = useState(0);
  const [messages, setMessages] = useState<
    { role: 'user' | 'assistant'; content: string; isHint?: boolean; isExec?: boolean }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [logFilePath, setLogFilePath] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string>(initialUserId ?? DEFAULT_RUNTIME_USER_ID);
  const [bearerToken, setBearerToken] = useState<string>(initialBearerToken ?? '');
  const [tokenFetchState, setTokenFetchState] = useState<TokenFetchState>('idle');
  const [tokenFetchError, setTokenFetchError] = useState<string | null>(null);
  const [tokenExpiresIn, setTokenExpiresIn] = useState<number | undefined>(undefined);

  // MCP state
  const [mcpTools, setMcpTools] = useState<McpToolDef[]>([]);
  const [mcpToolsFetched, setMcpToolsFetched] = useState(false);
  const mcpToolsRef = useRef<McpToolDef[]>([]);
  const mcpSessionIdRef = useRef<string | undefined>(undefined);

  // Persistent logger for the session
  const loggerRef = useRef<InvokeLogger | null>(null);

  // Load config on mount
  useEffect(() => {
    const load = async () => {
      try {
        const configIO = new ConfigIO();
        const project = await configIO.readProjectSpec();
        const deployedState = await configIO.readDeployedState();
        const awsTargets = await configIO.readAWSDeploymentTargets();

        const targetNames = Object.keys(deployedState.targets);
        if (targetNames.length === 0) {
          setError('No deployed targets found. Run `agentcore deploy` first.');
          setPhase('error');
          return;
        }

        const targetName = targetNames[0]!;
        const targetState = deployedState.targets[targetName];
        const targetConfig = awsTargets.find(t => t.name === targetName);

        if (!targetConfig) {
          setError(`Target config '${targetName}' not found`);
          setPhase('error');
          return;
        }

        const runtimes: InvokeConfig['runtimes'] = [];
        for (const agent of project.runtimes) {
          const state = targetState?.resources?.runtimes?.[agent.name];
          if (!state) continue;
          runtimes.push({
            name: agent.name,
            state,
            modelProvider: undefined,
            networkMode: agent.networkMode,
            protocol: agent.protocol,
            authorizerType: agent.authorizerType,
          });
        }

        const harnesses: InvokeConfig['harnesses'] = [];
        for (const harness of project.harnesses ?? []) {
          const state = targetState?.resources?.harnesses?.[harness.name];
          if (!state) continue;
          harnesses.push({ name: harness.name, state });
        }

        if (runtimes.length === 0 && harnesses.length === 0) {
          setError('No deployed agents or harnesses found. Run `agentcore deploy` first.');
          setPhase('error');
          return;
        }

        setConfig({ runtimes, harnesses, target: targetConfig, targetName, projectName: project.name });

        // Initialize session ID - always generate fresh unless explicitly provided
        if (initialSessionId) {
          setSessionId(initialSessionId);
        } else {
          const newId = generateSessionId();
          setSessionId(newId);
        }

        setPhase('ready');
      } catch (err) {
        setError(getErrorMessage(err));
        setPhase('error');
      }
    };
    void load();
  }, [initialSessionId]);

  const getMcpInvokeOptions = useCallback(() => {
    if (!config) return null;
    const agent = config.runtimes[selectedAgent];
    if (!agent) return null;
    return {
      region: config.target.region,
      runtimeArn: agent.state.runtimeArn,
      userId,
      mcpSessionId: mcpSessionIdRef.current,
      headers,
      bearerToken: bearerToken || undefined,
    };
  }, [config, selectedAgent, userId, headers, bearerToken]);

  const fetchMcpTools = useCallback(async () => {
    const opts = getMcpInvokeOptions();
    if (!opts) return;

    try {
      const result = await mcpListTools(opts);
      setMcpTools(result.tools);
      mcpToolsRef.current = result.tools;
      mcpSessionIdRef.current = result.mcpSessionId;
      setMcpToolsFetched(true);
      if (result.tools.length > 0) {
        setMessages(prev => [...prev, { role: 'assistant', content: formatMcpToolList(result.tools), isHint: true }]);
      }
    } catch (err) {
      const errMsg = getErrorMessage(err);
      setMessages(prev => [...prev, { role: 'assistant', content: `Failed to list tools: ${errMsg}` }]);
      setMcpTools([]);
      mcpToolsRef.current = [];
      setMcpToolsFetched(true);
    }
  }, [getMcpInvokeOptions]);

  const fetchBearerToken = useCallback(async () => {
    if (!config) return;
    const agent = config.runtimes[selectedAgent];
    if (agent?.authorizerType !== 'CUSTOM_JWT') return;

    // Check if credentials are set up before attempting fetch
    const canFetch = await canFetchRuntimeToken(agent.name);
    if (!canFetch) {
      setTokenFetchState('error');
      setTokenFetchError(
        'No OAuth credentials configured for auto-fetch. Press T to enter a bearer token manually, or re-add the agent with --client-id and --client-secret.'
      );
      return;
    }

    setTokenFetchState('fetching');
    setTokenFetchError(null);
    try {
      const result = await fetchRuntimeToken(agent.name, { deployTarget: config.targetName });
      setBearerToken(result.token);
      setTokenExpiresIn(result.expiresIn);
      setTokenFetchState('fetched');
    } catch (err) {
      setTokenFetchError(getErrorMessage(err));
      setTokenFetchState('error');
    }
  }, [config, selectedAgent]);

  // Track current streaming content to avoid stale closure issues
  const streamingContentRef = useRef('');

  const streamHarnessInvoke = useCallback(
    async (
      region: string,
      harnessArn: string,
      runtimeSessionId: string,
      harnessMessages: { role: string; content: Record<string, unknown>[] }[]
    ) => {
      let pendingToolUseId: string | undefined;
      let pendingToolName: string | undefined;
      let pendingToolInput = '';

      try {
        const stream = invokeHarness({
          region,
          harnessArn,
          runtimeSessionId,
          messages: harnessMessages,
        });

        for await (const event of stream) {
          switch (event.type) {
            case 'contentBlockDelta':
              if (event.delta.type === 'text') {
                streamingContentRef.current += event.delta.text;
                const currentContent = streamingContentRef.current;
                setMessages(prev => {
                  const updated = [...prev];
                  const lastIdx = updated.length - 1;
                  if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
                    updated[lastIdx] = { role: 'assistant', content: currentContent };
                  }
                  return updated;
                });
              } else if (event.delta.type === 'toolUse') {
                pendingToolInput += event.delta.input;
              }
              break;
            case 'contentBlockStart':
              if (event.start.type === 'toolUse') {
                pendingToolUseId = event.start.toolUse.toolUseId;
                pendingToolName = event.start.toolUse.name;
                pendingToolInput = '';
                const serverName = event.start.toolUse.serverName;
                const label = serverName ? `${serverName}/${pendingToolName}` : pendingToolName;
                streamingContentRef.current += `\n🔧 Tool: ${label}\n`;
                const currentContent = streamingContentRef.current;
                setMessages(prev => {
                  const updated = [...prev];
                  const lastIdx = updated.length - 1;
                  if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
                    updated[lastIdx] = { role: 'assistant', content: currentContent };
                  }
                  return updated;
                });
              }
              break;
            case 'messageStop':
              if (event.stopReason === 'tool_use' && pendingToolUseId) {
                let inputObj: Record<string, unknown> = {};
                try {
                  inputObj = JSON.parse(pendingToolInput) as Record<string, unknown>;
                } catch {
                  // use empty
                }
                setPendingToolApproval({
                  toolUseId: pendingToolUseId,
                  toolName: pendingToolName ?? 'unknown',
                  input: inputObj,
                  harnessArn,
                  sessionId: runtimeSessionId,
                });
                setPhase('tool-approval');
                return;
              }
              break;
            case 'metadata': {
              const { inputTokens, outputTokens } = event.usage;
              const latency = (event.metrics.latencyMs / 1000).toFixed(1);
              const metaLine = `⚡ ${inputTokens} in · ${outputTokens} out · ${latency}s`;
              setMessages(prev => [...prev, { role: 'assistant', content: metaLine, isHint: true }]);
              break;
            }
            case 'error':
              streamingContentRef.current += `\nError: ${event.message}`;
              setMessages(prev => {
                const updated = [...prev];
                const lastIdx = updated.length - 1;
                if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
                  updated[lastIdx] = { role: 'assistant', content: streamingContentRef.current };
                }
                return updated;
              });
              break;
          }
        }

        setPhase('ready');
      } catch (err) {
        const errMsg = getErrorMessage(err);
        setMessages(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
            updated[lastIdx] = { role: 'assistant', content: `Error: ${errMsg}` };
          }
          return updated;
        });
        setPhase('ready');
      }
    },
    []
  );

  const invoke = useCallback(
    async (prompt: string) => {
      if (!config || phase === 'invoking') return;

      const isHarness = selectedAgent >= config.runtimes.length;
      const agent = config.runtimes[selectedAgent];
      if (!agent && !isHarness) return;

      const isMcp = !isHarness && agent?.protocol === 'MCP';

      // Create logger on first invoke or if agent changed
      if (!loggerRef.current) {
        const harnessForLog = isHarness ? config.harnesses[selectedAgent - config.runtimes.length] : undefined;
        loggerRef.current = new InvokeLogger({
          agentName: agent?.name ?? harnessForLog?.name ?? 'harness',
          runtimeArn: agent?.state.runtimeArn ?? harnessForLog?.state.harnessArn ?? '',
          region: config.target.region,
          sessionId: sessionId ?? undefined,
        });
        setLogFilePath(loggerRef.current.getAbsoluteLogPath());
      }

      const logger = loggerRef.current;

      // MCP: handle tool calls
      if (isMcp) {
        // "list" refreshes the tool list
        if (prompt.trim().toLowerCase() === 'list') {
          setMessages(prev => [...prev, { role: 'user', content: prompt }]);
          setPhase('invoking');
          await fetchMcpTools();
          setPhase('ready');
          return;
        }

        // Parse "tool_name {json_args}" or just "tool_name"
        const match = /^(\S+)\s*(.*)/.exec(prompt);
        if (!match) return;
        const toolName = match[1]!;
        const argsStr = match[2]?.trim() ?? '';

        setMessages(prev => [...prev, { role: 'user', content: prompt }, { role: 'assistant', content: '' }]);
        setPhase('invoking');

        logger.logPrompt(`MCP tools/call: ${toolName}(${argsStr})`, sessionId ?? undefined, userId);

        try {
          let args: Record<string, unknown> = {};
          if (argsStr) {
            args = JSON.parse(argsStr) as Record<string, unknown>;
          }
          const opts = getMcpInvokeOptions();
          if (!opts) throw new Error('No agent config available');

          const result = await mcpCallTool(opts, toolName, args);

          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = { role: 'assistant', content: `Result: ${result}` };
            }
            return updated;
          });

          logger.logResponse(result);
        } catch (err) {
          const errMsg = getErrorMessage(err);
          logger.logError(err, 'MCP call failed');

          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = { role: 'assistant', content: `Error: ${errMsg}` };
            }
            return updated;
          });
        }

        setPhase('ready');
        return;
      }

      if (isHarness) {
        const harnessIdx = selectedAgent - config.runtimes.length;
        const harness = config.harnesses[harnessIdx];
        if (!harness) return;

        setMessages(prev => [...prev, { role: 'user', content: prompt }, { role: 'assistant', content: '' }]);
        setPhase('invoking');
        streamingContentRef.current = '';

        await streamHarnessInvoke(config.target.region, harness.state.harnessArn, sessionId ?? generateSessionId(), [
          { role: 'user', content: [{ text: prompt }] },
        ]);
        return;
      }

      // HTTP / A2A: streaming invoke (agent is guaranteed defined here — harness path returned above)
      if (!agent) return;
      const isA2A = agent.protocol === 'A2A';
      setMessages(prev => [...prev, { role: 'user', content: prompt }, { role: 'assistant', content: '' }]);
      setPhase('invoking');
      streamingContentRef.current = '';

      logger.logPrompt(prompt, sessionId ?? undefined, userId);

      try {
        const result = isA2A
          ? await invokeA2ARuntime(
              { region: config.target.region, runtimeArn: agent.state.runtimeArn, userId, logger, headers },
              prompt
            )
          : await invokeAgentRuntimeStreaming({
              region: config.target.region,
              runtimeArn: agent.state.runtimeArn,
              payload: prompt,
              sessionId: sessionId ?? undefined,
              userId,
              logger,
              headers,
              bearerToken: bearerToken || undefined,
            });

        if (result.sessionId) {
          setSessionId(result.sessionId);
          logger.updateSessionId(result.sessionId);
        }

        for await (const chunk of result.stream) {
          streamingContentRef.current += chunk;
          const currentContent = streamingContentRef.current;
          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = { role: 'assistant', content: currentContent };
            }
            return updated;
          });
        }

        logger.logResponse(streamingContentRef.current);

        setPhase('ready');
      } catch (err) {
        const errMsg = getErrorMessage(err);
        logger.logError(err, 'invoke streaming failed');

        setMessages(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
            updated[lastIdx] = { role: 'assistant', content: `Error: ${errMsg}` };
          }
          return updated;
        });
        setPhase('ready');
      }
    },
    [
      config,
      selectedAgent,
      phase,
      sessionId,
      userId,
      headers,
      bearerToken,
      fetchMcpTools,
      getMcpInvokeOptions,
      streamHarnessInvoke,
    ]
  );

  const execCommand = useCallback(
    async (command: string) => {
      if (!config || phase === 'invoking') return;

      const isHarnessExec = selectedAgent >= config.runtimes.length;
      const agent = isHarnessExec ? undefined : config.runtimes[selectedAgent];
      if (!agent && !isHarnessExec) return;

      // For harness exec, we need the underlying agentRuntimeArn
      let execRuntimeArn: string | undefined;
      let execName: string;
      if (isHarnessExec) {
        const harnessIdx = selectedAgent - config.runtimes.length;
        const harness = config.harnesses[harnessIdx];
        if (!harness) return;
        execRuntimeArn = harness.state.agentRuntimeArn;
        execName = harness.name;
        if (!execRuntimeArn) {
          setMessages(prev => [
            ...prev,
            { role: 'user', content: `! ${command}`, isExec: true },
            {
              role: 'assistant',
              content: 'Exec requires agentRuntimeArn in deployed state. Re-deploy to populate it.',
              isExec: true,
            },
          ]);
          return;
        }
      } else {
        execRuntimeArn = agent!.state.runtimeArn;
        execName = agent!.name;
      }

      // Create logger on first exec or if agent changed
      if (!loggerRef.current) {
        loggerRef.current = new InvokeLogger({
          agentName: execName,
          runtimeArn: execRuntimeArn,
          region: config.target.region,
          sessionId: sessionId ?? undefined,
        });
        setLogFilePath(loggerRef.current.getAbsoluteLogPath());
      }

      const logger = loggerRef.current;

      setMessages(prev => [
        ...prev,
        { role: 'user', content: `! ${command}`, isExec: true },
        { role: 'assistant', content: '', isExec: true },
      ]);
      setPhase('invoking');
      streamingContentRef.current = '';

      logger.logPrompt(`exec: ${command}`, sessionId ?? undefined, userId);

      try {
        const result = await executeBashCommand({
          region: config.target.region,
          runtimeArn: execRuntimeArn,
          command,
          sessionId: sessionId ?? undefined,
          headers,
          bearerToken: bearerToken || undefined,
        });

        for await (const event of result.stream) {
          switch (event.type) {
            case 'stdout':
              if (event.data) {
                streamingContentRef.current += event.data;
              }
              break;
            case 'stderr':
              if (event.data) {
                streamingContentRef.current += event.data;
              }
              break;
            case 'stop':
              if (event.exitCode !== undefined && event.exitCode !== 0) {
                streamingContentRef.current += `\n[exit code: ${event.exitCode}${event.status === 'TIMED_OUT' ? ' (timed out)' : ''}]`;
              }
              break;
          }
          const currentContent = streamingContentRef.current;
          setMessages(prev => {
            const updated = [...prev];
            const lastIdx = updated.length - 1;
            if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
              updated[lastIdx] = { ...updated[lastIdx], content: currentContent };
            }
            return updated;
          });
        }

        logger.logResponse(streamingContentRef.current);
        setPhase('ready');
      } catch (err) {
        const errMsg = getErrorMessage(err);
        logger.logError(err, 'exec command failed');

        setMessages(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx]?.role === 'assistant') {
            updated[lastIdx] = { ...updated[lastIdx], content: `Error: ${errMsg}` };
          }
          return updated;
        });
        setPhase('ready');
      }
    },
    [config, selectedAgent, phase, sessionId, userId, headers, bearerToken]
  );

  const respondToTool = useCallback(
    async (approved: boolean, response: string) => {
      if (!pendingToolApproval || !config) return;

      const { toolUseId, harnessArn, sessionId: runtimeSessionId } = pendingToolApproval;

      const statusIcon = approved ? '✅' : '❌';
      setMessages(prev => [...prev, { role: 'assistant', content: `${statusIcon} ${response}`, isHint: true }]);
      setPendingToolApproval(null);
      setPhase('invoking');
      streamingContentRef.current = '';
      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      await streamHarnessInvoke(config.target.region, harnessArn, runtimeSessionId, [
        {
          role: 'assistant',
          content: [
            {
              toolUse: {
                toolUseId,
                name: pendingToolApproval.toolName,
                input: pendingToolApproval.input,
              },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              toolResult: {
                toolUseId,
                content: [{ text: response }],
                status: approved ? 'success' : 'error',
              },
            },
          ],
        },
      ]);
    },
    [config, pendingToolApproval, streamHarnessInvoke]
  );

  const newSession = useCallback(() => {
    const newId = generateSessionId();
    setSessionId(newId);
    setMessages([]);
    setPendingToolApproval(null);
    // Reset MCP session
    mcpSessionIdRef.current = undefined;
    setMcpTools([]);
    mcpToolsRef.current = [];
    setMcpToolsFetched(false);
  }, []);

  return {
    phase,
    config,
    selectedAgent,
    messages,
    error,
    logFilePath,
    sessionId,
    userId,
    bearerToken,
    tokenFetchState,
    tokenFetchError,
    tokenExpiresIn,
    mcpTools,
    mcpToolsFetched,
    pendingToolApproval,
    selectAgent: setSelectedAgent,
    setUserId,
    setBearerToken,
    fetchBearerToken,
    invoke,
    execCommand,
    respondToTool,
    newSession,
    fetchMcpTools,
  };
}
