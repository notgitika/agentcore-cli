import { ConfigIO } from '../../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../schema';
import {
  executeBashCommand,
  invokeA2ARuntime,
  invokeAgentRuntime,
  invokeAgentRuntimeStreaming,
  mcpCallTool,
  mcpInitSession,
  mcpListTools,
} from '../../aws';
import { invokeHarness } from '../../aws/agentcore-harness';
import { InvokeLogger } from '../../logging';
import { formatMcpToolList } from '../../operations/dev/utils';
import { canFetchRuntimeToken, fetchRuntimeToken } from '../../operations/fetch-access';
import type { InvokeOptions, InvokeResult } from './types';
import { randomUUID } from 'node:crypto';

export interface InvokeContext {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
}

/**
 * Loads configuration required for invocation
 */
export async function loadInvokeConfig(configIO: ConfigIO = new ConfigIO()): Promise<InvokeContext> {
  return {
    project: await configIO.readProjectSpec(),
    deployedState: await configIO.readDeployedState(),
    awsTargets: await configIO.readAWSDeploymentTargets(),
  };
}

/**
 * Main invoke handler
 */
export async function handleInvoke(context: InvokeContext, options: InvokeOptions = {}): Promise<InvokeResult> {
  const { project, deployedState, awsTargets } = context;

  // Resolve target
  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return { success: false, error: 'No deployed targets found. Run `agentcore deploy` first.' };
  }

  const selectedTargetName = options.targetName ?? targetNames[0]!;

  if (options.targetName && !targetNames.includes(options.targetName)) {
    return { success: false, error: `Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}` };
  }

  const targetState = deployedState.targets[selectedTargetName];
  const targetConfig = awsTargets.find(t => t.name === selectedTargetName);

  if (!targetConfig) {
    return { success: false, error: `Target config '${selectedTargetName}' not found in aws-targets` };
  }

  // ── Route to harness or runtime ─────────────────────────────────────────
  const harnessEntries = project.harnesses ?? [];
  const hasBoth = project.runtimes.length > 0 && harnessEntries.length > 0;

  if (hasBoth && !options.harnessName && !options.agentName) {
    const allNames = [
      ...project.runtimes.map(r => `--runtime ${r.name}`),
      ...harnessEntries.map(h => `--harness ${h.name}`),
    ];
    return {
      success: false,
      error: `Project has both runtimes and harnesses. Specify one:\n  ${allNames.join('\n  ')}`,
    };
  }

  const isHarnessInvoke = options.harnessName != null || (harnessEntries.length > 0 && project.runtimes.length === 0);

  if (isHarnessInvoke) {
    return handleHarnessInvoke(project, targetState, targetConfig, selectedTargetName, options);
  }

  // ── Runtime invoke path ────────────────────────────────────────────────
  if (project.runtimes.length === 0) {
    return { success: false, error: 'No runtimes or harnesses defined in configuration' };
  }

  // Resolve agent
  const agentNames = project.runtimes.map(a => a.name);

  if (!options.agentName && project.runtimes.length > 1) {
    return { success: false, error: `Multiple runtimes found. Use --runtime to specify one: ${agentNames.join(', ')}` };
  }

  const agentSpec = options.agentName ? project.runtimes.find(a => a.name === options.agentName) : project.runtimes[0];

  if (options.agentName && !agentSpec) {
    return { success: false, error: `Agent '${options.agentName}' not found. Available: ${agentNames.join(', ')}` };
  }

  if (!agentSpec) {
    return { success: false, error: 'No agents defined in configuration' };
  }

  // Warn about VPC mode endpoint requirements
  if (agentSpec.networkMode === 'VPC') {
    console.log(
      '\x1b[33mWarning: This agent uses VPC network mode. Ensure your VPC endpoints are configured for invocation.\x1b[0m'
    );
  }

  // Get the deployed state for this specific agent
  const agentState = targetState?.resources?.runtimes?.[agentSpec.name];

  if (!agentState) {
    return { success: false, error: `Agent '${agentSpec.name}' is not deployed to target '${selectedTargetName}'` };
  }

  // Auto-fetch bearer token for CUSTOM_JWT agents when not provided
  if (agentSpec.authorizerType === 'CUSTOM_JWT' && !options.bearerToken) {
    const canFetch = await canFetchRuntimeToken(agentSpec.name);
    if (canFetch) {
      try {
        const tokenResult = await fetchRuntimeToken(agentSpec.name, { deployTarget: selectedTargetName });
        options = { ...options, bearerToken: tokenResult.token };
      } catch (err) {
        return {
          success: false,
          error: `CUSTOM_JWT agent requires a bearer token. Auto-fetch failed: ${err instanceof Error ? err.message : String(err)}\nProvide one manually with --bearer-token.`,
        };
      }
    } else {
      return {
        success: false,
        error: `Agent '${agentSpec.name}' is configured for CUSTOM_JWT but no bearer token is available.\nEither provide --bearer-token or re-add the agent with --client-id and --client-secret to enable auto-fetch.`,
      };
    }
  }

  // Exec mode: run shell command in runtime container
  if (options.exec) {
    const logger = new InvokeLogger({
      agentName: agentSpec.name,
      runtimeArn: agentState.runtimeArn,
      region: targetConfig.region,
    });
    const command = options.prompt;
    if (!command) {
      return { success: false, error: '--exec requires a command (prompt)' };
    }
    logger.logPrompt(command, undefined, options.userId);

    try {
      const result = await executeBashCommand({
        region: targetConfig.region,
        runtimeArn: agentState.runtimeArn,
        command,
        sessionId: options.sessionId,
        timeout: options.timeout,
        headers: options.headers,
        bearerToken: options.bearerToken,
      });

      let stdout = '';
      let stderr = '';
      let exitCode: number | undefined;
      let status: string | undefined;

      for await (const event of result.stream) {
        switch (event.type) {
          case 'stdout':
            if (event.data) {
              stdout += event.data;
              if (!options.json) {
                process.stdout.write(event.data);
              }
            }
            break;
          case 'stderr':
            if (event.data) {
              stderr += event.data;
              if (!options.json) {
                process.stderr.write(event.data);
              }
            }
            break;
          case 'stop':
            exitCode = event.exitCode;
            status = event.status;
            break;
        }
      }

      logger.logResponse(stdout || stderr || `exit code: ${exitCode}`);

      if (options.json) {
        return {
          success: exitCode === 0,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          response: JSON.stringify({ stdout, stderr, exitCode, status }),
          logFilePath: logger.logFilePath,
        };
      }

      if (exitCode === undefined) {
        return {
          success: false,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          error: 'Command stream ended without exit code',
          logFilePath: logger.logFilePath,
        };
      }

      if (exitCode !== 0) {
        return {
          success: false,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          error: `Command exited with code ${exitCode}${status === 'TIMED_OUT' ? ' (timed out)' : ''}`,
          logFilePath: logger.logFilePath,
        };
      }

      return {
        success: true,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        logFilePath: logger.logFilePath,
      };
    } catch (err) {
      logger.logError(err, 'exec command failed');
      throw err;
    }
  }

  // MCP protocol handling
  if (agentSpec.protocol === 'MCP') {
    const mcpOpts = {
      region: targetConfig.region,
      runtimeArn: agentState.runtimeArn,
      userId: options.userId,
      headers: options.headers,
      bearerToken: options.bearerToken,
    };

    // list-tools: list available MCP tools
    if (options.prompt === 'list-tools') {
      try {
        const result = await mcpListTools(mcpOpts);
        const response = formatMcpToolList(result.tools);
        return {
          success: true,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          response,
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to list MCP tools: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // call-tool: call an MCP tool by name
    if (options.prompt === 'call-tool') {
      if (!options.tool) {
        return {
          success: false,
          error: 'MCP call-tool requires --tool <name>. Use "list-tools" to see available tools.',
        };
      }
      let args: Record<string, unknown> = {};
      if (options.input) {
        try {
          args = JSON.parse(options.input) as Record<string, unknown>;
        } catch {
          return { success: false, error: `Invalid JSON for --input: ${options.input}` };
        }
      }
      try {
        // Lightweight init to get session ID (no tools/list round-trip)
        const mcpSessionId = await mcpInitSession(mcpOpts);
        const response = await mcpCallTool({ ...mcpOpts, mcpSessionId }, options.tool, args);
        return {
          success: true,
          agentName: agentSpec.name,
          targetName: selectedTargetName,
          response,
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to call MCP tool: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (!options.prompt) {
      return {
        success: false,
        error:
          'MCP agents require a command. Usage:\n  agentcore invoke list-tools\n  agentcore invoke call-tool --tool <name> --input \'{"arg": "value"}\'',
      };
    }
  }

  if (!options.prompt) {
    return { success: false, error: 'No prompt provided. Usage: agentcore invoke "your prompt"' };
  }

  // A2A protocol handling — send JSON-RPC message/send via InvokeAgentRuntime
  if (agentSpec.protocol === 'A2A') {
    try {
      const a2aResult = await invokeA2ARuntime(
        {
          region: targetConfig.region,
          runtimeArn: agentState.runtimeArn,
          userId: options.userId,
          headers: options.headers,
        },
        options.prompt
      );
      let response = '';
      for await (const chunk of a2aResult.stream) {
        response += chunk;
        if (options.stream) {
          process.stdout.write(chunk);
        }
      }
      if (options.stream) {
        process.stdout.write('\n');
      }
      return {
        success: true,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        response,
      };
    } catch (err) {
      return { success: false, error: `A2A invoke failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Create logger for this invocation
  const logger = new InvokeLogger({
    agentName: agentSpec.name,
    runtimeArn: agentState.runtimeArn,
    region: targetConfig.region,
  });

  logger.logPrompt(options.prompt, undefined, options.userId);

  if (options.stream) {
    // Streaming mode
    let fullResponse = '';
    try {
      const result = await invokeAgentRuntimeStreaming({
        region: targetConfig.region,
        runtimeArn: agentState.runtimeArn,
        payload: options.prompt,
        sessionId: options.sessionId,
        userId: options.userId,
        logger,
        headers: options.headers,
        bearerToken: options.bearerToken,
      });

      for await (const chunk of result.stream) {
        fullResponse += chunk;
        process.stdout.write(chunk);
      }
      process.stdout.write('\n');

      logger.logResponse(fullResponse);

      return {
        success: true,
        agentName: agentSpec.name,
        targetName: selectedTargetName,
        response: fullResponse,
        logFilePath: logger.logFilePath,
      };
    } catch (err) {
      logger.logError(err, 'invoke streaming failed');
      throw err;
    }
  }

  // Non-streaming mode
  const response = await invokeAgentRuntime({
    region: targetConfig.region,
    runtimeArn: agentState.runtimeArn,
    payload: options.prompt,
    sessionId: options.sessionId,
    userId: options.userId,
    headers: options.headers,
    bearerToken: options.bearerToken,
  });

  logger.logResponse(response.content);

  return {
    success: true,
    agentName: agentSpec.name,
    targetName: selectedTargetName,
    response: response.content,
    logFilePath: logger.logFilePath,
  };
}

// ============================================================================
// Harness Invoke
// ============================================================================

async function handleHarnessInvoke(
  project: AgentCoreProjectSpec,
  targetState: DeployedState['targets'][string] | undefined,
  targetConfig: { region: string; name: string },
  selectedTargetName: string,
  options: InvokeOptions
): Promise<InvokeResult> {
  const harnessEntries = project.harnesses ?? [];

  if (harnessEntries.length === 0) {
    return { success: false, error: 'No harnesses defined in configuration' };
  }

  // Resolve harness name — explicit flag, or auto-infer if only one
  let harnessName = options.harnessName;
  if (!harnessName) {
    if (harnessEntries.length > 1) {
      const names = harnessEntries.map(h => h.name);
      return {
        success: false,
        error: `Multiple harnesses found. Use --harness to specify one: ${names.join(', ')}`,
      };
    }
    harnessName = harnessEntries[0]!.name;
  }

  const harnessEntry = harnessEntries.find(h => h.name === harnessName);
  if (!harnessEntry) {
    const names = harnessEntries.map(h => h.name);
    return {
      success: false,
      error: `Harness '${harnessName}' not found. Available: ${names.join(', ')}`,
    };
  }

  // Get deployed state for this harness
  const harnessState = targetState?.resources?.harnesses?.[harnessName];
  if (!harnessState) {
    return {
      success: false,
      error: `Harness '${harnessName}' is not deployed to target '${selectedTargetName}'. Run \`agentcore deploy\` first.`,
    };
  }

  // Exec mode: run shell command on harness VM via InvokeAgentRuntimeCommand
  if (options.exec) {
    if (!harnessState.agentRuntimeArn) {
      return { success: false, error: 'Exec requires agentRuntimeArn in deployed state. Re-deploy to populate it.' };
    }
    const command = options.prompt;
    if (!command) {
      return {
        success: false,
        error: '--exec requires a command. Usage: agentcore invoke --exec --harness <name> "ls -la"',
      };
    }

    try {
      const result = await executeBashCommand({
        region: targetConfig.region,
        runtimeArn: harnessState.agentRuntimeArn,
        command,
        sessionId: options.sessionId,
        timeout: options.timeout,
      });

      let stdout = '';
      let stderr = '';
      let exitCode: number | undefined;
      let status: string | undefined;

      for await (const event of result.stream) {
        switch (event.type) {
          case 'stdout':
            if (event.data) {
              stdout += event.data;
              if (!options.json) process.stdout.write(event.data);
            }
            break;
          case 'stderr':
            if (event.data) {
              stderr += event.data;
              if (!options.json) process.stderr.write(event.data);
            }
            break;
          case 'stop':
            exitCode = event.exitCode;
            status = event.status;
            break;
        }
      }

      if (options.json) {
        return {
          success: exitCode === 0,
          targetName: selectedTargetName,
          response: JSON.stringify({ stdout, stderr, exitCode, status }),
        };
      }

      if (exitCode !== 0) {
        return {
          success: false,
          targetName: selectedTargetName,
          error: `Command exited with code ${exitCode}${status === 'TIMED_OUT' ? ' (timed out)' : ''}`,
        };
      }

      return { success: true, targetName: selectedTargetName };
    } catch (err) {
      return { success: false, error: `Exec failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (!options.prompt) {
    return { success: false, error: 'No prompt provided. Usage: agentcore invoke --harness <name> "your prompt"' };
  }

  const sessionId = options.sessionId ?? randomUUID();
  const region = targetConfig.region;

  let fullResponse = '';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  const cyan = '\x1b[36m';

  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerInterval: NodeJS.Timeout | undefined;
  let spinnerIdx = 0;
  if (!options.json && !options.verbose) {
    process.stderr.write(`${dim}${SPINNER[0]} Thinking...${reset}`);
    spinnerInterval = setInterval(() => {
      spinnerIdx = (spinnerIdx + 1) % SPINNER.length;
      process.stderr.write(`\r${dim}${SPINNER[spinnerIdx]} Thinking...${reset}`);
    }, 80);
  }

  let spinnerCleared = false;
  const clearSpinner = () => {
    if (spinnerInterval && !spinnerCleared) {
      clearInterval(spinnerInterval);
      spinnerCleared = true;
      process.stderr.write('\r\x1b[K');
    }
  };

  try {
    let messages: { role: string; content: Record<string, unknown>[] }[] = [
      { role: 'user', content: [{ text: options.prompt }] },
    ];

    const baseOpts: Partial<import('../../aws/agentcore-harness').InvokeHarnessOptions> = {};
    if (options.modelId) baseOpts.model = { bedrockModelConfig: { modelId: options.modelId } };
    if (options.maxIterations != null) baseOpts.maxIterations = options.maxIterations;
    if (options.maxTokens != null) baseOpts.maxTokens = options.maxTokens;
    if (options.harnessTimeout != null) baseOpts.timeoutSeconds = options.harnessTimeout;
    if (options.skills) baseOpts.skills = options.skills.split(',').map(p => ({ path: p.trim() }));
    if (options.systemPrompt) baseOpts.systemPrompt = [{ text: options.systemPrompt }];
    if (options.allowedTools) baseOpts.allowedTools = options.allowedTools.split(',').map(t => t.trim());
    if (options.actorId) baseOpts.actorId = options.actorId;

    let continueLoop = true;
    while (continueLoop) {
      continueLoop = false;

      const stream = invokeHarness({
        region,
        harnessArn: harnessState.harnessArn,
        runtimeSessionId: sessionId,
        messages,
        ...baseOpts,
      });

      let pendingToolUseId: string | undefined;
      let pendingToolName: string | undefined;
      let pendingToolInput = '';

      for await (const event of stream) {
        if (options.verbose) {
          clearSpinner();
          console.log(JSON.stringify(event));
          continue;
        }

        switch (event.type) {
          case 'contentBlockDelta':
            if (event.delta.type === 'text') {
              clearSpinner();
              fullResponse += event.delta.text;
              if (!options.json) {
                process.stdout.write(event.delta.text);
              }
            } else if (event.delta.type === 'toolUse') {
              pendingToolInput += event.delta.input;
            }
            break;
          case 'contentBlockStart':
            if (event.start.type === 'toolUse') {
              pendingToolUseId = event.start.toolUse.toolUseId;
              pendingToolName = event.start.toolUse.name;
              pendingToolInput = '';
              if (!options.json) {
                const serverName = event.start.toolUse.serverName;
                const label = serverName ? `${serverName}/${pendingToolName}` : pendingToolName;
                process.stderr.write(`\n${dim}🔧 Tool: ${label}${reset}\n`);
              }
            }
            break;
          case 'messageStop':
            if (event.stopReason === 'tool_use' && pendingToolUseId) {
              clearSpinner();
              let inputObj: Record<string, unknown> = {};
              try {
                inputObj = JSON.parse(pendingToolInput) as Record<string, unknown>;
              } catch {
                // use empty
              }

              if (!options.json) {
                const yellow = '\x1b[33m';
                const bold = '\x1b[1m';
                process.stderr.write(`\n${yellow}${bold}⏸ Agent requesting: ${pendingToolName}${reset}\n`);
                if (Object.keys(inputObj).length > 0) {
                  process.stderr.write(`${dim}Input: ${JSON.stringify(inputObj, null, 2)}${reset}\n`);
                }
              }

              const toolResult = await promptForToolResult(pendingToolName ?? 'unknown', inputObj, options.json);

              messages = [
                {
                  role: 'assistant',
                  content: [
                    {
                      toolUse: {
                        toolUseId: pendingToolUseId,
                        name: pendingToolName ?? 'unknown',
                        input: inputObj,
                      },
                    },
                  ],
                },
                {
                  role: 'user',
                  content: [
                    {
                      toolResult: {
                        toolUseId: pendingToolUseId,
                        content: [{ text: toolResult.response }],
                        status: toolResult.approved ? 'success' : 'error',
                      },
                    },
                  ],
                },
              ];
              continueLoop = true;

              if (!options.json) {
                const statusIcon = toolResult.approved ? '✅' : '❌';
                process.stderr.write(`${statusIcon} ${toolResult.response}\n`);
              }
            } else if (!options.json) {
              process.stdout.write('\n');
            }
            break;
          case 'metadata':
            if (!options.json) {
              const { inputTokens, outputTokens } = event.usage;
              const latency = (event.metrics.latencyMs / 1000).toFixed(1);
              process.stderr.write(
                `\n${dim}⚡ ${cyan}${inputTokens}${dim} in · ${cyan}${outputTokens}${dim} out · ${cyan}${latency}s${reset}\n`
              );
              process.stderr.write(`${dim}🔗 Session: ${cyan}${sessionId}${reset}\n`);
            }
            break;
          case 'error':
            clearSpinner();
            if (options.json) {
              return { success: false, error: `${event.errorType}: ${event.message}` };
            }
            process.stderr.write(`\nError: ${event.message}\n`);
            break;
        }
      }
    }

    if (options.json) {
      return {
        success: true,
        targetName: selectedTargetName,
        response: JSON.stringify({ text: fullResponse, sessionId }),
      };
    }

    return { success: true, targetName: selectedTargetName };
  } catch (err) {
    clearSpinner();
    return {
      success: false,
      error: `Harness invoke failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function promptForToolResult(
  toolName: string,
  input: Record<string, unknown>,
  jsonMode?: boolean
): Promise<{ approved: boolean; response: string }> {
  if (jsonMode) {
    return { approved: true, response: 'Approved' };
  }

  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  return new Promise(resolve => {
    rl.question('\x1b[33m[Y]es / [N]o / or type a custom response: \x1b[0m', answer => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'n' || trimmed === 'no' || trimmed === 'deny') {
        resolve({ approved: false, response: 'Denied by user' });
      } else if (trimmed === 'y' || trimmed === 'yes' || trimmed === '' || trimmed === 'approve') {
        resolve({ approved: true, response: 'Approved' });
      } else {
        resolve({ approved: true, response: answer.trim() });
      }
    });
  });
}
