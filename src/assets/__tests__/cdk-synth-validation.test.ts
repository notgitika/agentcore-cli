/**
 * CDK Synthesis Validation Tests
 *
 * Validates that realistic agentcore.json configurations can be synthesized
 * into valid CloudFormation templates by the vended CDK stack.
 *
 * These tests catch schema mismatches and construct bugs before deploy time.
 */
import { AgentCoreStack } from '../cdk/lib/cdk-stack';
import { setSessionProjectRoot } from '@aws/agentcore-cdk';
import type { AgentCoreProjectSpec } from '@aws/agentcore-cdk';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ─── CFN Resource Types ──────────────────────────────────────────────────────

const CFN_RUNTIME = 'AWS::BedrockAgentCore::Runtime';
const CFN_MEMORY = 'AWS::BedrockAgentCore::Memory';
const CFN_EVALUATOR = 'AWS::BedrockAgentCore::Evaluator';
const CFN_POLICY_ENGINE = 'AWS::BedrockAgentCore::PolicyEngine';
const CFN_POLICY = 'AWS::BedrockAgentCore::Policy';
const CFN_ECR_REPO = 'AWS::ECR::Repository';
const CFN_CODEBUILD = 'AWS::CodeBuild::Project';
const CFN_IAM_ROLE = 'AWS::IAM::Role';

// ─── Test project directory ──────────────────────────────────────────────────
// AgentCoreApplication calls findConfigRoot() which walks up from cwd looking
// for agentcore/agentcore.json. We use setSessionProjectRoot() to point it at
// our temp directory.

let tmpDir: string;
let originalCwd: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'agentcore-cdk-synth-test-'));
  const agentcoreDir = join(tmpDir, 'agentcore');
  mkdirSync(agentcoreDir, { recursive: true });
  // Create minimal agentcore.json so findConfigRoot() succeeds
  writeFileSync(join(agentcoreDir, 'agentcore.json'), '{}');
  // Create agent code directories that constructs may reference
  const agentNames = [
    'myagent',
    'agent1',
    'agent2',
    'primaryagent',
    'secondaryagent',
    'containeragent',
    'mcpagent',
    'a2aagent',
    'a'.repeat(48),
  ];
  const minimalPyproject = '[project]\nname = "agent"\nversion = "0.1.0"\n';
  for (const dir of agentNames) {
    mkdirSync(join(tmpDir, 'agents', dir), { recursive: true });
    writeFileSync(join(tmpDir, 'agents', dir, 'main.py'), '# placeholder');
    writeFileSync(join(tmpDir, 'agents', dir, 'pyproject.toml'), minimalPyproject);
    writeFileSync(join(tmpDir, 'agents', dir, 'Dockerfile'), 'FROM python:3.12-slim\n');
  }
  // Tell the CDK L3 construct where the project root is so findConfigRoot() succeeds
  setSessionProjectRoot(tmpDir);
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function synthStack(
  spec: AgentCoreProjectSpec,
  mcpSpec?: unknown,
  credentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string }>
): Template {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, `TestStack${Date.now()}`, {
    spec,
    mcpSpec: mcpSpec as never,
    credentials,
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

function baseSpec(overrides: Partial<AgentCoreProjectSpec> = {}): AgentCoreProjectSpec {
  return {
    name: 'testproject',
    version: 1,
    agents: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    policyEngines: [],
    ...overrides,
  } as AgentCoreProjectSpec;
}

function makeAgent(name: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'AgentEnvironment',
    name,
    build: 'CodeZip',
    entrypoint: 'main.py',
    codeLocation: `agents/${name}`,
    runtimeVersion: 'PYTHON_3_12',
    ...overrides,
  };
}

function makeMemory(name: string, strategies: unknown[] = []) {
  return {
    type: 'AgentCoreMemory',
    name,
    eventExpiryDuration: 30,
    strategies,
  };
}

function makeEvaluator(name: string) {
  return {
    type: 'CustomEvaluator',
    name,
    level: 'SESSION',
    config: {
      type: 'LlmAsAJudge',
      llmAsAJudge: {
        model: 'anthropic.claude-3-haiku-20240307-v1:0',
        instructions: 'Rate the response quality based on helpfulness and accuracy.',
        ratingScale: {
          numerical: [
            { value: 1, label: 'Poor', definition: 'Unhelpful or incorrect' },
            { value: 3, label: 'Good', definition: 'Mostly helpful and accurate' },
            { value: 5, label: 'Excellent', definition: 'Very helpful and fully accurate' },
          ],
        },
      },
    },
  };
}

function makeOnlineEvalConfig(name: string, agent: string, evaluators: string[]) {
  return {
    type: 'OnlineEvaluationConfig',
    name,
    agent,
    evaluators,
    samplingRate: 50,
  };
}

function makeCredential(
  name: string,
  type: 'ApiKeyCredentialProvider' | 'OAuthCredentialProvider' = 'ApiKeyCredentialProvider'
) {
  if (type === 'OAuthCredentialProvider') {
    return {
      type,
      name,
      discoveryUrl: 'https://example.com/.well-known/openid-configuration',
      scopes: ['openid'],
    };
  }
  return { type, name };
}

function makePolicyEngine(name: string) {
  return {
    type: 'PolicyEngine',
    name,
    policies: [
      {
        type: 'Policy',
        name: `${name}Policy`,
        statement: 'permit(principal, action, resource);',
      },
    ],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CDK Synthesis Validation', () => {
  // ─── Empty and minimal specs ──────────────────────────────────────────────

  it('synthesizes empty spec with only StackNameOutput', () => {
    const template = synthStack(baseSpec());
    template.hasOutput('StackNameOutput', {
      Description: 'Name of the CloudFormation Stack',
    });
  });

  // ─── Agent specs ──────────────────────────────────────────────────────────

  it('synthesizes a single CodeZip agent', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('myagent')] as never,
      })
    );

    // Should create an AgentCore Runtime resource
    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('myagent'),
    });

    // Should create an IAM role for the agent
    template.hasResourceProperties(CFN_IAM_ROLE, {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: Match.objectLike({
              Service: Match.anyValue(),
            }),
          }),
        ]),
      }),
    });
  });

  it('synthesizes a Container agent with ECR and CodeBuild', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('containeragent', { build: 'Container' })] as never,
      })
    );

    // Should create an ECR repository
    template.hasResourceProperties(CFN_ECR_REPO, Match.anyValue());

    // Should create a CodeBuild project for building the container
    template.hasResourceProperties(CFN_CODEBUILD, Match.anyValue());
  });

  it('synthesizes multiple agents', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('agent1'), makeAgent('agent2')] as never,
      })
    );

    // Should create 2 runtimes
    template.resourceCountIs(CFN_RUNTIME, 2);
  });

  // ─── Memory specs ─────────────────────────────────────────────────────────

  it('synthesizes agent with short-term memory (no strategies)', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('myagent')] as never,
        memories: [makeMemory('ShortTermMem')] as never,
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, Match.anyValue());
    template.hasResourceProperties(CFN_MEMORY, {
      Name: Match.stringLikeRegexp('ShortTermMem'),
    });
  });

  it('synthesizes agent with long-term memory strategies', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('myagent')] as never,
        memories: [
          makeMemory('LongTermMem', [{ type: 'SEMANTIC' }, { type: 'SUMMARIZATION' }, { type: 'USER_PREFERENCE' }]),
        ] as never,
      })
    );

    template.hasResourceProperties(CFN_MEMORY, {
      Name: Match.stringLikeRegexp('LongTermMem'),
    });
  });

  // ─── Credential specs ─────────────────────────────────────────────────────

  it('synthesizes agent with API key credential', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('myagent')] as never,
        credentials: [makeCredential('MyApiKey')] as never,
      })
    );

    // Agent runtime should exist — credential wiring happens at deploy time
    template.hasResourceProperties(CFN_RUNTIME, Match.anyValue());
  });

  it('synthesizes agent with OAuth credential', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('myagent')] as never,
        credentials: [makeCredential('MyOAuth', 'OAuthCredentialProvider')] as never,
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, Match.anyValue());
  });

  // ─── Evaluator specs ──────────────────────────────────────────────────────

  it('synthesizes custom evaluator', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('myagent')] as never,
        evaluators: [makeEvaluator('QualityCheck')] as never,
      })
    );

    template.hasResourceProperties(CFN_EVALUATOR, {
      EvaluatorName: Match.stringLikeRegexp('QualityCheck'),
    });
  });

  // ─── Online eval config specs ─────────────────────────────────────────────

  it('synthesizes online eval config referencing project agent', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('myagent')] as never,
        evaluators: [makeEvaluator('QualityCheck')] as never,
        onlineEvalConfigs: [makeOnlineEvalConfig('MonitorQuality', 'myagent', ['QualityCheck'])] as never,
      })
    );

    template.hasResourceProperties(CFN_EVALUATOR, Match.anyValue());
  });

  it('synthesizes online eval config with builtin evaluator', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('myagent')] as never,
        onlineEvalConfigs: [makeOnlineEvalConfig('BuiltinMonitor', 'myagent', ['Builtin.GoalSuccessRate'])] as never,
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, Match.anyValue());
  });

  // ─── Policy engine specs ──────────────────────────────────────────────────

  it('synthesizes policy engine', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('myagent')] as never,
        policyEngines: [makePolicyEngine('SafetyGuard')] as never,
      })
    );

    template.hasResourceProperties(CFN_POLICY_ENGINE, Match.anyValue());
    template.hasResourceProperties(CFN_POLICY, {
      Definition: Match.objectLike({
        Cedar: Match.objectLike({
          Statement: Match.anyValue(),
        }),
      }),
    });
  });

  // ─── Full project specs ───────────────────────────────────────────────────

  it('synthesizes a complete project with all resource types', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('primaryagent'), makeAgent('secondaryagent')] as never,
        memories: [makeMemory('ProjectMemory', [{ type: 'SEMANTIC' }])] as never,
        credentials: [
          makeCredential('ProdApiKey'),
          makeCredential('OAuthProvider', 'OAuthCredentialProvider'),
        ] as never,
        evaluators: [makeEvaluator('ResponseQuality')] as never,
        onlineEvalConfigs: [
          makeOnlineEvalConfig('LiveMonitor', 'primaryagent', ['Builtin.GoalSuccessRate', 'ResponseQuality']),
        ] as never,
        policyEngines: [makePolicyEngine('ContentFilter')] as never,
      })
    );

    // Verify resource counts
    template.resourceCountIs(CFN_RUNTIME, 2);
    template.hasResourceProperties(CFN_MEMORY, Match.anyValue());
    template.hasResourceProperties(CFN_EVALUATOR, Match.anyValue());
    template.hasResourceProperties(CFN_POLICY_ENGINE, Match.anyValue());
  });

  // ─── Agent configuration variants ─────────────────────────────────────────

  it('synthesizes agent with custom environment variables', () => {
    const template = synthStack(
      baseSpec({
        agents: [
          makeAgent('myagent', {
            envVars: [
              { name: 'MODEL_ID', value: 'anthropic.claude-3-haiku-20240307-v1:0' },
              { name: 'TEMPERATURE', value: '0.7' },
            ],
          }),
        ] as never,
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('myagent'),
    });
  });

  it('synthesizes agent with MCP protocol', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('mcpagent', { protocol: 'MCP' })] as never,
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('mcpagent'),
    });
  });

  it('synthesizes agent with A2A protocol', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('a2aagent', { protocol: 'A2A' })] as never,
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, {
      AgentRuntimeName: Match.stringLikeRegexp('a2aagent'),
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────────────

  it('synthesizes with memories but no agents', () => {
    // Valid scenario: user may add memory before adding agents
    const template = synthStack(
      baseSpec({
        memories: [makeMemory('StandaloneMemory')] as never,
      })
    );

    template.hasResourceProperties(CFN_MEMORY, Match.anyValue());
    template.resourceCountIs(CFN_RUNTIME, 0);
  });

  it('synthesizes with evaluators but no online eval configs', () => {
    const template = synthStack(
      baseSpec({
        agents: [makeAgent('myagent')] as never,
        evaluators: [makeEvaluator('UnusedEval')] as never,
      })
    );

    template.hasResourceProperties(CFN_EVALUATOR, Match.anyValue());
  });

  it('synthesizes spec with maximum name lengths', () => {
    // Agent name max is 48 chars, memory name max is 48 chars
    const longAgentName = 'a'.repeat(48);
    const longMemoryName = 'M'.repeat(48);

    const template = synthStack(
      baseSpec({
        agents: [makeAgent(longAgentName)] as never,
        memories: [makeMemory(longMemoryName)] as never,
      })
    );

    template.hasResourceProperties(CFN_RUNTIME, Match.anyValue());
    template.hasResourceProperties(CFN_MEMORY, Match.anyValue());
  });
});
