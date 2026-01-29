import type { DestroyOptions } from './types';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateDestroyOptions(options: DestroyOptions): ValidationResult {
  if (!options.target || options.target.trim() === '') {
    return { valid: false, error: '--target is required' };
  }

  return { valid: true };
}
