// Mock for templates/templateRoot.ts - browser mock

export const TEMPLATE_ROOT = '/mock/templates';

export function resolveTemplateRoot(): string {
  return TEMPLATE_ROOT;
}

export function getTemplatePath(relativePath: string): string {
  return `${TEMPLATE_ROOT}/${relativePath}`;
}
