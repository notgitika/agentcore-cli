import { validateInvokeOptions } from '../validate.js';
import { describe, expect, it } from 'vitest';

describe('validateInvokeOptions', () => {
  it('returns valid with no options', () => {
    expect(validateInvokeOptions({})).toEqual({ valid: true });
  });

  it('returns valid with prompt and json', () => {
    expect(validateInvokeOptions({ json: true, prompt: 'hello' })).toEqual({ valid: true });
  });

  it('returns valid with prompt and stream', () => {
    expect(validateInvokeOptions({ stream: true, prompt: 'hello' })).toEqual({ valid: true });
  });

  it('returns invalid when json is true but no prompt', () => {
    const result = validateInvokeOptions({ json: true });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Prompt is required for JSON output');
  });

  it('returns invalid when stream is true but no prompt', () => {
    const result = validateInvokeOptions({ stream: true });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Prompt is required for streaming');
  });

  it('returns valid with prompt only', () => {
    expect(validateInvokeOptions({ prompt: 'test' })).toEqual({ valid: true });
  });

  it('returns valid with agentName and targetName', () => {
    expect(validateInvokeOptions({ agentName: 'my-agent', targetName: 'default' })).toEqual({ valid: true });
  });

  it('returns invalid when exec is true but no prompt', () => {
    const result = validateInvokeOptions({ exec: true });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--exec');
  });

  it('returns invalid when exec is combined with --tool', () => {
    const result = validateInvokeOptions({ exec: true, prompt: 'ls', tool: 'myTool' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--exec cannot be combined');
  });

  it('returns invalid when exec is combined with --input', () => {
    const result = validateInvokeOptions({ exec: true, prompt: 'ls', input: '{}' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--exec cannot be combined');
  });

  it('returns invalid when exec is combined with --stream', () => {
    const result = validateInvokeOptions({ exec: true, prompt: 'ls', stream: true });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--exec already streams');
  });

  it('returns valid with exec and prompt', () => {
    expect(validateInvokeOptions({ exec: true, prompt: 'ls -la' })).toEqual({ valid: true });
  });

  it('returns invalid when --harness and --runtime are both specified', () => {
    const result = validateInvokeOptions({ harnessName: 'h1', agentName: 'a1', prompt: 'hi' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cannot be used together');
  });

  it('returns invalid when --verbose is used without --harness', () => {
    const result = validateInvokeOptions({ verbose: true, prompt: 'hi' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('only supported with --harness');
  });

  it('returns valid with --harness and prompt', () => {
    expect(validateInvokeOptions({ harnessName: 'h1', prompt: 'hi' })).toEqual({ valid: true });
  });

  it('returns valid with --harness and --verbose', () => {
    expect(validateInvokeOptions({ harnessName: 'h1', verbose: true, prompt: 'hi' })).toEqual({ valid: true });
  });
});
