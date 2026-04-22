import type { HarnessSpec } from '../../../../../../schema';
import { mapHarnessSpecToCreateOptions } from '../harness-mapper';
import { stat } from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

const mockedStat = vi.mocked(stat);

beforeEach(() => {
  vi.clearAllMocks();
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  mockedStat.mockRejectedValue(enoent);
});

function minimalSpec(overrides?: Partial<HarnessSpec>): HarnessSpec {
  return {
    name: 'test_harness',
    model: { provider: 'bedrock', modelId: 'anthropic.claude-3-sonnet-20240229-v1:0' },
    tools: [],
    skills: [],
    ...overrides,
  };
}

const BASE_OPTIONS = {
  harnessDir: '/project/agentcore/harnesses/test_harness',
  executionRoleArn: 'arn:aws:iam::123456789012:role/HarnessRole',
  region: 'us-east-1' as const,
  projectName: 'myproject',
};

describe('mapHarnessSpecToCreateOptions - authorizer configuration', () => {
  it('maps CUSTOM_JWT auth config with casing transform', async () => {
    const spec = minimalSpec({
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123/.well-known/openid-configuration',
          allowedAudience: ['aud-1', 'aud-2'],
          allowedClients: ['client-1'],
          allowedScopes: ['openid', 'profile'],
          customClaims: [
            {
              inboundTokenClaimName: 'department',
              inboundTokenClaimValueType: 'STRING',
              authorizingClaimMatchValue: {
                claimMatchOperator: 'EQUALS',
                claimMatchValue: { matchValueString: 'engineering' },
              },
            },
          ],
        },
      },
    });

    const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

    expect(result.authorizerConfiguration).toEqual({
      customJWTAuthorizer: {
        discoveryUrl: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123/.well-known/openid-configuration',
        allowedAudience: ['aud-1', 'aud-2'],
        allowedClients: ['client-1'],
        allowedScopes: ['openid', 'profile'],
        customClaims: [
          {
            inboundTokenClaimName: 'department',
            inboundTokenClaimValueType: 'STRING',
            authorizingClaimMatchValue: {
              claimMatchOperator: 'EQUALS',
              claimMatchValue: { matchValueString: 'engineering' },
            },
          },
        ],
      },
    });
  });

  it('omits authorizerConfiguration when not in spec', async () => {
    const spec = minimalSpec();

    const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

    expect(result.authorizerConfiguration).toBeUndefined();
  });

  it('includes only populated optional JWT fields', async () => {
    const spec = minimalSpec({
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123/.well-known/openid-configuration',
          allowedAudience: ['aud-1'],
        },
      },
    });

    const result = await mapHarnessSpecToCreateOptions({ ...BASE_OPTIONS, harnessSpec: spec });

    expect(result.authorizerConfiguration).toEqual({
      customJWTAuthorizer: {
        discoveryUrl: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123/.well-known/openid-configuration',
        allowedAudience: ['aud-1'],
      },
    });

    // Verify optional fields that were not provided are absent
    const jwtConfig = result.authorizerConfiguration!.customJWTAuthorizer as Record<string, unknown>;
    expect(jwtConfig).not.toHaveProperty('allowedClients');
    expect(jwtConfig).not.toHaveProperty('allowedScopes');
    expect(jwtConfig).not.toHaveProperty('customClaims');
  });
});
