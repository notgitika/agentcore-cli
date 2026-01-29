// Agent attach types
export interface AttachAgentOptions {
  source?: string;
  target?: string;
  name?: string;
  json?: boolean;
}

export interface AttachAgentResult {
  success: boolean;
  sourceAgent?: string;
  targetAgent?: string;
  error?: string;
}

// Memory attach types
export interface AttachMemoryOptions {
  agent?: string;
  memory?: string;
  access?: string;
  json?: boolean;
}

export interface AttachMemoryResult {
  success: boolean;
  agentName?: string;
  memoryName?: string;
  error?: string;
}

// Identity attach types
export interface AttachIdentityOptions {
  agent?: string;
  identity?: string;
  json?: boolean;
}

export interface AttachIdentityResult {
  success: boolean;
  agentName?: string;
  identityName?: string;
  error?: string;
}

// MCP Runtime attach types
export interface AttachMcpRuntimeOptions {
  agent?: string;
  runtime?: string;
  json?: boolean;
}

export interface AttachMcpRuntimeResult {
  success: boolean;
  agentName?: string;
  runtimeName?: string;
  error?: string;
}
// Gateway attach types
export interface AttachGatewayOptions {
  agent?: string;
  gateway?: string;
  json?: boolean;
}

export interface AttachGatewayResult {
  success: boolean;
  agentName?: string;
  gatewayName?: string;
  error?: string;
}
