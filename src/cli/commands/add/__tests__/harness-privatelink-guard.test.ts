import type { AddHarnessCliOptions } from '../types';
import { validateAddHarnessOptions } from '../validate';
import { describe, expect, it } from 'vitest';

const base: AddHarnessCliOptions = {
  name: 'h1',
  modelProvider: 'bedrock',
  modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
};

const DISCOVERY = 'https://idp.example.com/.well-known/openid-configuration';

describe('validateAddHarnessOptions — PrivateLink authorizer guard', () => {
  it('rejects --private-endpoint-* flags with AWS_IAM authorizer', () => {
    const result = validateAddHarnessOptions({
      ...base,
      authorizerType: 'AWS_IAM',
      privateEndpointVpcId: 'vpc-0123456789abcdef0',
      privateEndpointSubnets: 'subnet-0123456789abcdef0',
      privateEndpointIpType: 'IPV4',
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('only valid with CUSTOM_JWT');
  });

  it('rejects a private-endpoint flag when no authorizer type is set', () => {
    const result = validateAddHarnessOptions({ ...base, privateEndpointLatticeArn: 'rcfg-0123456789abcdefg' });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain('only valid with CUSTOM_JWT');
  });

  it('accepts a private-endpoint flag with CUSTOM_JWT authorizer', () => {
    const result = validateAddHarnessOptions({
      ...base,
      authorizerType: 'CUSTOM_JWT',
      discoveryUrl: DISCOVERY,
      allowedAudience: 'aud-1',
      privateEndpointLatticeArn: 'rcfg-0123456789abcdefg',
    });
    expect(result.valid).toBe(true);
  });

  it('does not flag a plain AWS_IAM harness (no PrivateLink flags)', () => {
    const result = validateAddHarnessOptions({ ...base, authorizerType: 'AWS_IAM' });
    expect(result.valid).toBe(true);
  });
});
