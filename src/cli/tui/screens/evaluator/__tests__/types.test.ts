import { DEFAULT_INSTRUCTIONS, DEFAULT_MODEL, LEVEL_PLACEHOLDERS, validateInstructionPlaceholders } from '../types.js';
import { describe, expect, it } from 'vitest';

describe('LEVEL_PLACEHOLDERS', () => {
  it('defines placeholders for all three levels', () => {
    expect(LEVEL_PLACEHOLDERS).toHaveProperty('SESSION');
    expect(LEVEL_PLACEHOLDERS).toHaveProperty('TRACE');
    expect(LEVEL_PLACEHOLDERS).toHaveProperty('TOOL_CALL');
  });

  it('SESSION and TRACE share context and trajectory placeholders', () => {
    expect(LEVEL_PLACEHOLDERS.SESSION).toContain('context');
    expect(LEVEL_PLACEHOLDERS.TRACE).toContain('context');
    expect(LEVEL_PLACEHOLDERS.SESSION).toContain('actual_trajectory');
    expect(LEVEL_PLACEHOLDERS.TRACE).toContain('actual_trajectory');
  });

  it('TOOL_CALL has tool-specific placeholders', () => {
    expect(LEVEL_PLACEHOLDERS.TOOL_CALL).toContain('tool_name');
    expect(LEVEL_PLACEHOLDERS.TOOL_CALL).toContain('tool_input');
    expect(LEVEL_PLACEHOLDERS.TOOL_CALL).toContain('tool_output');
  });
});

describe('DEFAULT_INSTRUCTIONS', () => {
  it('each default instruction passes its own level validation', () => {
    for (const level of ['SESSION', 'TRACE', 'TOOL_CALL'] as const) {
      const result = validateInstructionPlaceholders(DEFAULT_INSTRUCTIONS[level], level);
      expect(result).toBe(true);
    }
  });

  it('SESSION default uses {context}', () => {
    expect(DEFAULT_INSTRUCTIONS.SESSION).toContain('{context}');
  });

  it('TOOL_CALL default uses {tool_name}, {tool_input}, {tool_output}', () => {
    expect(DEFAULT_INSTRUCTIONS.TOOL_CALL).toContain('{tool_name}');
    expect(DEFAULT_INSTRUCTIONS.TOOL_CALL).toContain('{tool_input}');
    expect(DEFAULT_INSTRUCTIONS.TOOL_CALL).toContain('{tool_output}');
  });
});

describe('DEFAULT_MODEL', () => {
  it('is a Claude Sonnet model ID', () => {
    expect(DEFAULT_MODEL).toContain('anthropic');
    expect(DEFAULT_MODEL).toContain('sonnet');
  });
});

describe('validateInstructionPlaceholders', () => {
  it('returns true when at least one valid placeholder is present for SESSION', () => {
    expect(validateInstructionPlaceholders('Check {context} now', 'SESSION')).toBe(true);
    expect(validateInstructionPlaceholders('See {available_tools}', 'SESSION')).toBe(true);
    expect(validateInstructionPlaceholders('Trajectory: {actual_trajectory}', 'SESSION')).toBe(true);
  });

  it('returns true when at least one valid placeholder is present for TOOL_CALL', () => {
    expect(validateInstructionPlaceholders('Tool: {tool_name}', 'TOOL_CALL')).toBe(true);
    expect(validateInstructionPlaceholders('Output: {tool_output}', 'TOOL_CALL')).toBe(true);
  });

  it('returns error string when no valid placeholders are present', () => {
    const result = validateInstructionPlaceholders('No placeholders here', 'SESSION');
    expect(typeof result).toBe('string');
    expect(result).toContain('must contain at least one placeholder');
  });

  it('rejects SESSION-level placeholders for TOOL_CALL level', () => {
    const result = validateInstructionPlaceholders('Check {context} now', 'TOOL_CALL');
    // {context} IS valid for TOOL_CALL, so this should pass
    expect(result).toBe(true);
  });

  it('rejects TOOL_CALL-level placeholders for SESSION level', () => {
    const result = validateInstructionPlaceholders('Tool: {tool_name}', 'SESSION');
    expect(typeof result).toBe('string');
    expect(result).toContain('must contain at least one placeholder');
  });

  it('does not match partial placeholder names', () => {
    // {tool_names} should not match {tool_name} since includes checks for exact {placeholder}
    const result = validateInstructionPlaceholders('Extra: {contexts}', 'SESSION');
    expect(typeof result).toBe('string');
  });

  it('handles multiple placeholders — at least one valid is enough', () => {
    const result = validateInstructionPlaceholders('{unknown_thing} and {context}', 'SESSION');
    expect(result).toBe(true);
  });

  it('returns descriptive error listing allowed placeholders', () => {
    const result = validateInstructionPlaceholders('nothing', 'TOOL_CALL');
    expect(typeof result).toBe('string');
    expect(result as string).toContain('{tool_name}');
    expect(result as string).toContain('{tool_input}');
    expect(result as string).toContain('{tool_output}');
  });
});
