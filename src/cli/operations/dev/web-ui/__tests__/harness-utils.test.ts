import type { HarnessInvocationOverrides } from '../api-types.js';
import { buildInvokeOptions } from '../handlers/harness-utils.js';
import { describe, expect, it } from 'vitest';

const BASE_ARN = 'arn:aws:bedrock-agentcore:us-west-2:123:harness/abc';
const REGION = 'us-west-2';
const SESSION_ID = 'sess-1';
const MESSAGES = [{ role: 'user' as const, content: [{ text: 'hello' }] }];

describe('buildInvokeOptions', () => {
  it('sets required fields with no overrides', () => {
    const opts = buildInvokeOptions(BASE_ARN, REGION, SESSION_ID, MESSAGES);

    expect(opts).toMatchObject({
      harnessArn: BASE_ARN,
      region: REGION,
      runtimeSessionId: SESSION_ID,
      messages: MESSAGES,
      maxIterations: 75,
    });
  });

  it('forwards model override', () => {
    const overrides: HarnessInvocationOverrides = {
      model: { bedrockModelConfig: { modelId: 'anthropic.claude-v2' } },
    };

    const opts = buildInvokeOptions(BASE_ARN, REGION, SESSION_ID, MESSAGES, overrides);

    expect(opts.model).toEqual({ bedrockModelConfig: { modelId: 'anthropic.claude-v2' } });
  });

  it('wraps systemPrompt string into HarnessSystemPrompt array', () => {
    const opts = buildInvokeOptions(BASE_ARN, REGION, SESSION_ID, MESSAGES, {
      systemPrompt: 'Be concise',
    });

    expect(opts.systemPrompt).toEqual([{ text: 'Be concise' }]);
  });

  it('forwards skills', () => {
    const overrides: HarnessInvocationOverrides = {
      skills: [{ path: '/tools/search' }],
    };

    const opts = buildInvokeOptions(BASE_ARN, REGION, SESSION_ID, MESSAGES, overrides);

    expect(opts.skills).toEqual([{ path: '/tools/search' }]);
  });

  it('forwards actorId', () => {
    const opts = buildInvokeOptions(BASE_ARN, REGION, SESSION_ID, MESSAGES, {
      actorId: 'user-42',
    });

    expect(opts.actorId).toBe('user-42');
  });

  it('forwards maxIterations', () => {
    const opts = buildInvokeOptions(BASE_ARN, REGION, SESSION_ID, MESSAGES, {
      maxIterations: 10,
    });

    expect(opts.maxIterations).toBe(10);
  });

  it('forwards maxTokens', () => {
    const opts = buildInvokeOptions(BASE_ARN, REGION, SESSION_ID, MESSAGES, {
      maxTokens: 1024,
    });

    expect(opts.maxTokens).toBe(1024);
  });

  it('forwards timeoutSeconds', () => {
    const opts = buildInvokeOptions(BASE_ARN, REGION, SESSION_ID, MESSAGES, {
      timeoutSeconds: 30,
    });

    expect(opts.timeoutSeconds).toBe(30);
  });

  it('forwards allowedTools', () => {
    const opts = buildInvokeOptions(BASE_ARN, REGION, SESSION_ID, MESSAGES, {
      allowedTools: ['tool-a', 'tool-b'],
    });

    expect(opts.allowedTools).toEqual(['tool-a', 'tool-b']);
  });

  it('forwards tools', () => {
    const overrides: HarnessInvocationOverrides = {
      tools: [
        { type: 'remote_mcp', name: 'my-mcp', config: { url: 'https://example.com' } },
        { type: 'inline_function', name: 'calc', config: { fn: 'add' } },
      ],
    };

    const opts = buildInvokeOptions(BASE_ARN, REGION, SESSION_ID, MESSAGES, overrides);

    expect(opts.tools).toEqual(overrides.tools);
  });

  it('forwards all overrides together', () => {
    const overrides: HarnessInvocationOverrides = {
      model: { openAiModelConfig: { modelId: 'gpt-4' } },
      systemPrompt: 'You are helpful',
      skills: [{ path: '/s' }],
      actorId: 'actor-1',
      maxIterations: 5,
      maxTokens: 256,
      timeoutSeconds: 60,
      allowedTools: ['tool-x'],
      tools: [{ type: 'remote_mcp', name: 'mcp-1', config: {} }],
    };

    const opts = buildInvokeOptions(BASE_ARN, REGION, SESSION_ID, MESSAGES, overrides);

    expect(opts.model).toEqual(overrides.model);
    expect(opts.systemPrompt).toEqual([{ text: 'You are helpful' }]);
    expect(opts.skills).toEqual(overrides.skills);
    expect(opts.actorId).toBe('actor-1');
    expect(opts.maxIterations).toBe(5);
    expect(opts.maxTokens).toBe(256);
    expect(opts.timeoutSeconds).toBe(60);
    expect(opts.allowedTools).toEqual(['tool-x']);
    expect(opts.tools).toEqual(overrides.tools);
  });
});
