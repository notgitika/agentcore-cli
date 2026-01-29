// Mock for templates/schema-assets.ts - browser mock
// These are raw text imports that don't work in the browser

/**
 * LLM-compacted schema files for AI coding context.
 * Each file is self-contained and maps to a JSON config file.
 */
export const LLM_CONTEXT_FILES: Record<string, string> = {
  'README.md': '# LLM Context Files\n\nMock content for browser testing.',
  'agentcore.ts': 'export const AgentCoreSchema = {};',
  'mcp.ts': 'export const McpSchema = {};',
  'aws-targets.ts': 'export const AwsTargetsSchema = {};',
};
