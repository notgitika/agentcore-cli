import { ConfigIO } from '../../../lib';
import type { HarnessSpec } from '../../../schema';
import type { HarnessToolType } from '../../../schema/schemas/primitives/harness';

export interface AddToolOptions {
  harness: string;
  type: string;
  name: string;
  url?: string;
  browserArn?: string;
  codeInterpreterArn?: string;
  gatewayArn?: string;
  gateway?: string;
  json?: boolean;
}

export interface AddToolResult {
  success: boolean;
  error?: string;
  harnessName?: string;
  toolName?: string;
}

const VALID_TOOL_TYPES: HarnessToolType[] = [
  'agentcore_browser',
  'agentcore_code_interpreter',
  'remote_mcp',
  'agentcore_gateway',
  'inline_function',
];

export async function handleAddTool(options: AddToolOptions): Promise<AddToolResult> {
  const { harness, type, name } = options;

  if (!VALID_TOOL_TYPES.includes(type as HarnessToolType)) {
    return {
      success: false,
      error: `Invalid tool type '${type}'. Valid types: ${VALID_TOOL_TYPES.join(', ')}`,
    };
  }

  const toolType = type as HarnessToolType;

  if (toolType === 'remote_mcp' && !options.url) {
    return { success: false, error: '--url is required for remote_mcp tools' };
  }

  if (toolType === 'agentcore_gateway' && !options.gatewayArn && !options.gateway) {
    return { success: false, error: '--gateway-arn or --gateway is required for agentcore_gateway tools' };
  }

  const configIO = new ConfigIO();

  // Resolve --gateway (project name) to ARN from deployed-state
  let resolvedGatewayArn = options.gatewayArn;
  if (toolType === 'agentcore_gateway' && options.gateway && !resolvedGatewayArn) {
    try {
      const deployedState = await configIO.readDeployedState();
      const targetNames = Object.keys(deployedState.targets);
      if (targetNames.length === 0) {
        return { success: false, error: 'No deployed targets found. Deploy the gateway first.' };
      }
      const targetState = deployedState.targets[targetNames[0]!];
      const gatewayState = targetState?.resources?.mcp?.gateways?.[options.gateway];
      if (!gatewayState) {
        return {
          success: false,
          error: `Gateway '${options.gateway}' not found in deployed state. Deploy it first or use --gateway-arn.`,
        };
      }
      resolvedGatewayArn = gatewayState.gatewayArn;
    } catch {
      return { success: false, error: 'Could not read deployed state. Deploy the gateway first or use --gateway-arn.' };
    }
  }

  let harnessSpec: HarnessSpec;
  try {
    harnessSpec = await configIO.readHarnessSpec(harness);
  } catch {
    return {
      success: false,
      error: `Harness '${harness}' not found. Check the name or run 'agentcore add harness' first.`,
    };
  }

  const existingTool = harnessSpec.tools.find(t => t.name === name);
  if (existingTool) {
    return { success: false, error: `Tool '${name}' already exists in harness '${harness}'` };
  }

  const toolEntry: HarnessSpec['tools'][number] = { type: toolType, name };

  if (toolType === 'remote_mcp') {
    toolEntry.config = { remoteMcp: { url: options.url! } };
  } else if (toolType === 'agentcore_browser' && options.browserArn) {
    toolEntry.config = { agentCoreBrowser: { browserArn: options.browserArn } };
  } else if (toolType === 'agentcore_code_interpreter' && options.codeInterpreterArn) {
    toolEntry.config = { agentCoreCodeInterpreter: { codeInterpreterArn: options.codeInterpreterArn } };
  } else if (toolType === 'agentcore_gateway') {
    toolEntry.config = { agentCoreGateway: { gatewayArn: resolvedGatewayArn! } };
  }

  harnessSpec.tools.push(toolEntry);

  await configIO.writeHarnessSpec(harness, harnessSpec);

  return { success: true, harnessName: harness, toolName: name };
}
