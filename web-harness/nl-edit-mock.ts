/**
 * Mock for the nl-edit operations module.
 * The real module uses Bun-specific `import ... with { type: 'text' }` syntax
 * which is not supported by Vite/esbuild.
 */

// Re-export types without importing from the schema package
export interface SchemaState {
  workspace: unknown | null;
  mcp: unknown | null;
  mcpDefs: unknown | null;
}

export interface OutOfDomainResponse {
  status: 'OUT_OF_DOMAIN';
  reason: string;
}

export interface AmbiguousInputResponse {
  status: 'AMBIGUOUS_INPUT';
  reason: string;
}

export interface SuccessResponse {
  status: 'SUCCESS';
  diff_message: string;
  changes: {
    'agentcore.json'?: unknown;
    'mcp.json'?: unknown;
    'mcp-defs.json'?: unknown;
  };
}

export interface ResponseValidationIssue {
  path: string;
  message: string;
}

export interface ResponseValidationError {
  file: string;
  issues: ResponseValidationIssue[];
}

export type NlEditResponse = OutOfDomainResponse | AmbiguousInputResponse | SuccessResponse;

export interface NlEditResult {
  success: boolean;
  response?: NlEditResponse;
  previewPaths?: Record<string, string>;
  error?: string;
  validationError?: ResponseValidationError;
}

export interface ValidationResult {
  success: boolean;
  response?: NlEditResponse;
  error?: string;
  validationError?: ResponseValidationError;
}

// Mock functions
export async function executeNlEdit(_userInput: string, _cwd: string): Promise<NlEditResult> {
  console.log('[nl-edit-mock] executeNlEdit called');
  return {
    success: false,
    error: 'NL Edit is not available in browser harness',
  };
}

export async function applyNlEditChanges(_cwd: string, _response: SuccessResponse): Promise<void> {
  console.log('[nl-edit-mock] applyNlEditChanges called');
  throw new Error('NL Edit is not available in browser harness');
}

export async function buildPrompt(
  _userInput: string,
  _currentSchemas: SchemaState,
  _fileTreeContext: string
): Promise<string> {
  console.log('[nl-edit-mock] buildPrompt called');
  return 'Mock prompt - NL Edit not available in browser';
}

export function parseAndValidateResponse(_rawContent: string): ValidationResult {
  console.log('[nl-edit-mock] parseAndValidateResponse called');
  return {
    success: false,
    error: 'NL Edit is not available in browser harness',
  };
}
