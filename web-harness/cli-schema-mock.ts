/**
 * Mock for the CLI's schema document module (src/cli/schema).
 * The real module uses fs/promises which is not available in browser.
 */

export interface LoadDocumentResult {
  content: string;
  validationError?: string;
}

export interface SaveDocumentResult {
  ok: boolean;
  content?: string;
  error?: string;
}

export async function loadSchemaDocument(_filePath: string, _schema: unknown): Promise<LoadDocumentResult> {
  console.log('[cli-schema-mock] loadSchemaDocument called');
  return {
    content: '{}',
    validationError: undefined,
  };
}

export async function saveSchemaDocument(
  _filePath: string,
  content: string,
  _schema: unknown
): Promise<SaveDocumentResult> {
  console.log('[cli-schema-mock] saveSchemaDocument called');
  return { ok: true, content };
}
