import type { PlanOptions } from './types';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validatePlanOptions(options: PlanOptions): ValidationResult {
  if (options.json && !options.target) {
    return { valid: false, error: '--target is required for JSON output' };
  }
  return { valid: true };
}
