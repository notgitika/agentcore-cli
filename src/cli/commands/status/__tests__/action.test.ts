import type { AgentCoreMcpSpec, AgentCoreProjectSpec, DeployedResourceState } from '../../../../schema/index.js';
import { computeResourceStatuses } from '../action.js';
import { describe, expect, it } from 'vitest';

const baseProject: AgentCoreProjectSpec = {
  name: 'test-project',
  version: 1,
  agents: [],
  memories: [],
  credentials: [],
} as unknown as AgentCoreProjectSpec;

describe('computeResourceStatuses', () => {
  it('returns empty array for empty project with no deployed state', () => {
    const result = computeResourceStatuses(baseProject, undefined);
    expect(result).toEqual([]);
  });

  it('marks agent as deployed when in both local and deployed state', () => {
    const project = {
      ...baseProject,
      agents: [{ name: 'my-agent' }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      agents: {
        'my-agent': {
          runtimeId: 'rt-123',
          runtimeArn: 'arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-123',
          roleArn: 'arn:aws:iam::123456789:role/test',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const agentEntry = result.find(r => r.resourceType === 'agent' && r.name === 'my-agent');

    expect(agentEntry).toBeDefined();
    expect(agentEntry!.deploymentState).toBe('deployed');
    expect(agentEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-123');
  });

  it('marks agent as local-only when not in deployed state', () => {
    const project = {
      ...baseProject,
      agents: [{ name: 'my-agent' }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const agentEntry = result.find(r => r.resourceType === 'agent' && r.name === 'my-agent');

    expect(agentEntry).toBeDefined();
    expect(agentEntry!.deploymentState).toBe('local-only');
    expect(agentEntry!.identifier).toBeUndefined();
  });

  it('marks agent as pending-removal when in deployed state but not in local schema', () => {
    const resources: DeployedResourceState = {
      agents: {
        'removed-agent': {
          runtimeId: 'rt-456',
          runtimeArn: 'arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-456',
          roleArn: 'arn:aws:iam::123456789:role/test',
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const agentEntry = result.find(r => r.resourceType === 'agent' && r.name === 'removed-agent');

    expect(agentEntry).toBeDefined();
    expect(agentEntry!.deploymentState).toBe('pending-removal');
    expect(agentEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-456');
  });

  it('marks credential as deployed when in both local and deployed state', () => {
    const project = {
      ...baseProject,
      credentials: [{ name: 'my-cred', type: 'OAuthCredentialProvider' }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      credentials: {
        'my-cred': {
          credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789:credential-provider/my-cred',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const credEntry = result.find(r => r.resourceType === 'credential' && r.name === 'my-cred');

    expect(credEntry).toBeDefined();
    expect(credEntry!.deploymentState).toBe('deployed');
    expect(credEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:credential-provider/my-cred');
    expect(credEntry!.detail).toBe('OAuth');
  });

  it('marks credential as local-only when not in deployed state', () => {
    const project = {
      ...baseProject,
      credentials: [{ name: 'my-cred', type: 'ApiKeyCredentialProvider' }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const credEntry = result.find(r => r.resourceType === 'credential' && r.name === 'my-cred');

    expect(credEntry).toBeDefined();
    expect(credEntry!.deploymentState).toBe('local-only');
    expect(credEntry!.detail).toBe('ApiKey');
  });

  it('marks credential as pending-removal when in deployed state but not in local schema', () => {
    const resources: DeployedResourceState = {
      credentials: {
        'removed-cred': {
          credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789:credential-provider/removed-cred',
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const credEntry = result.find(r => r.resourceType === 'credential' && r.name === 'removed-cred');

    expect(credEntry).toBeDefined();
    expect(credEntry!.deploymentState).toBe('pending-removal');
    expect(credEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:credential-provider/removed-cred');
  });

  it('marks memory as deployed when in both local and deployed state', () => {
    const project = {
      ...baseProject,
      memories: [{ name: 'my-memory', strategies: [{ type: 'SEMANTIC' }] }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      memories: {
        'my-memory': {
          memoryId: 'mem-123',
          memoryArn: 'arn:aws:bedrock:us-east-1:123456789:memory/mem-123',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const memEntry = result.find(r => r.resourceType === 'memory' && r.name === 'my-memory');

    expect(memEntry).toBeDefined();
    expect(memEntry!.deploymentState).toBe('deployed');
    expect(memEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:memory/mem-123');
    expect(memEntry!.detail).toBe('SEMANTIC');
  });

  it('marks memory as local-only when not in deployed state', () => {
    const project = {
      ...baseProject,
      memories: [{ name: 'my-memory', strategies: [{ type: 'SUMMARIZATION' }] }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const memEntry = result.find(r => r.resourceType === 'memory' && r.name === 'my-memory');

    expect(memEntry).toBeDefined();
    expect(memEntry!.deploymentState).toBe('local-only');
    expect(memEntry!.detail).toBe('SUMMARIZATION');
  });

  it('marks memory as pending-removal when in deployed state but not in local schema', () => {
    const resources: DeployedResourceState = {
      memories: {
        'removed-memory': {
          memoryId: 'mem-456',
          memoryArn: 'arn:aws:bedrock:us-east-1:123456789:memory/mem-456',
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const pendingMemEntry = result.find(r => r.resourceType === 'memory' && r.deploymentState === 'pending-removal');

    expect(pendingMemEntry).toBeDefined();
    expect(pendingMemEntry!.name).toBe('removed-memory');
    expect(pendingMemEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:memory/mem-456');
  });

  it('marks all resources as local-only when never deployed', () => {
    const project = {
      ...baseProject,
      agents: [{ name: 'agent-a' }],
      memories: [{ name: 'mem-a', strategies: [] }],
      credentials: [{ name: 'cred-a', type: 'ApiKeyCredentialProvider' }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);

    expect(result).toHaveLength(3);
    expect(result.every(r => r.deploymentState === 'local-only')).toBe(true);
  });

  it('marks gateway as deployed when in both local mcp spec and deployed state', () => {
    const mcpSpec = {
      agentCoreGateways: [{ name: 'my-gateway', targets: [{ name: 't1' }, { name: 't2' }] }],
    } as unknown as AgentCoreMcpSpec;

    const resources: DeployedResourceState = {
      mcp: {
        gateways: {
          'my-gateway': {
            gatewayId: 'gw-123',
            gatewayArn: 'arn:aws:bedrock:us-east-1:123456789:gateway/gw-123',
          },
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources, mcpSpec);
    const gwEntry = result.find(r => r.resourceType === 'gateway' && r.name === 'my-gateway');

    expect(gwEntry).toBeDefined();
    expect(gwEntry!.deploymentState).toBe('deployed');
    expect(gwEntry!.identifier).toBe('gw-123');
    expect(gwEntry!.detail).toBe('2 targets');
  });

  it('marks gateway as local-only when not in deployed state', () => {
    const mcpSpec = {
      agentCoreGateways: [{ name: 'my-gateway', targets: [{ name: 't1' }] }],
    } as unknown as AgentCoreMcpSpec;

    const result = computeResourceStatuses(baseProject, undefined, mcpSpec);
    const gwEntry = result.find(r => r.resourceType === 'gateway' && r.name === 'my-gateway');

    expect(gwEntry).toBeDefined();
    expect(gwEntry!.deploymentState).toBe('local-only');
    expect(gwEntry!.detail).toBe('1 target');
  });

  it('marks gateway as pending-removal when in deployed state but not in local mcp spec', () => {
    const mcpSpec = {
      agentCoreGateways: [],
    } as unknown as AgentCoreMcpSpec;

    const resources: DeployedResourceState = {
      mcp: {
        gateways: {
          'removed-gateway': {
            gatewayId: 'gw-456',
            gatewayArn: 'arn:aws:bedrock:us-east-1:123456789:gateway/gw-456',
          },
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources, mcpSpec);
    const gwEntry = result.find(r => r.resourceType === 'gateway' && r.name === 'removed-gateway');

    expect(gwEntry).toBeDefined();
    expect(gwEntry!.deploymentState).toBe('pending-removal');
    expect(gwEntry!.identifier).toBe('gw-456');
  });

  it('marks evaluator as deployed when in both local and deployed state', () => {
    const project = {
      ...baseProject,
      evaluators: [{ name: 'MyEval', level: 'SESSION', config: {} }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      evaluators: {
        MyEval: {
          evaluatorId: 'proj_MyEval-abc123',
          evaluatorArn: 'arn:aws:bedrock:us-east-1:123456789:evaluator/proj_MyEval-abc123',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const evalEntry = result.find(r => r.resourceType === 'evaluator' && r.name === 'MyEval');

    expect(evalEntry).toBeDefined();
    expect(evalEntry!.deploymentState).toBe('deployed');
    expect(evalEntry!.identifier).toBe('arn:aws:bedrock:us-east-1:123456789:evaluator/proj_MyEval-abc123');
    expect(evalEntry!.detail).toBe('SESSION — LLM-as-a-Judge');
  });

  it('marks evaluator as local-only when not deployed', () => {
    const project = {
      ...baseProject,
      evaluators: [{ name: 'MyEval', level: 'TRACE', config: {} }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const evalEntry = result.find(r => r.resourceType === 'evaluator' && r.name === 'MyEval');

    expect(evalEntry).toBeDefined();
    expect(evalEntry!.deploymentState).toBe('local-only');
    expect(evalEntry!.detail).toBe('TRACE — LLM-as-a-Judge');
  });

  it('marks evaluator as pending-removal when deployed but removed from schema', () => {
    const resources: DeployedResourceState = {
      evaluators: {
        RemovedEval: {
          evaluatorId: 'proj_RemovedEval-xyz',
          evaluatorArn: 'arn:aws:bedrock:us-east-1:123456789:evaluator/proj_RemovedEval-xyz',
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const evalEntry = result.find(r => r.resourceType === 'evaluator' && r.name === 'RemovedEval');

    expect(evalEntry).toBeDefined();
    expect(evalEntry!.deploymentState).toBe('pending-removal');
  });

  it('marks online-eval config as deployed when in both local and deployed state', () => {
    const project = {
      ...baseProject,
      onlineEvalConfigs: [{ name: 'TestConfig', agents: ['Agent1'], evaluators: ['Builtin.Helpfulness'] }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      onlineEvalConfigs: {
        TestConfig: {
          onlineEvaluationConfigId: 'proj_TestConfig-abc',
          onlineEvaluationConfigArn: 'arn:aws:bedrock:us-east-1:123456789:online-evaluation-config/proj_TestConfig-abc',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);
    const configEntry = result.find(r => r.resourceType === 'online-eval' && r.name === 'TestConfig');

    expect(configEntry).toBeDefined();
    expect(configEntry!.deploymentState).toBe('deployed');
    expect(configEntry!.detail).toBe('1 agent, 1 evaluator');
  });

  it('marks online-eval config as local-only when not deployed', () => {
    const project = {
      ...baseProject,
      onlineEvalConfigs: [{ name: 'TestConfig', agents: ['A', 'B'], evaluators: ['Builtin.X', 'Builtin.Y', 'Custom'] }],
    } as unknown as AgentCoreProjectSpec;

    const result = computeResourceStatuses(project, undefined);
    const configEntry = result.find(r => r.resourceType === 'online-eval' && r.name === 'TestConfig');

    expect(configEntry).toBeDefined();
    expect(configEntry!.deploymentState).toBe('local-only');
    expect(configEntry!.detail).toBe('2 agents, 3 evaluators');
  });

  it('marks online-eval config as pending-removal when deployed but removed from schema', () => {
    const resources: DeployedResourceState = {
      onlineEvalConfigs: {
        RemovedConfig: {
          onlineEvaluationConfigId: 'proj_RemovedConfig-xyz',
          onlineEvaluationConfigArn:
            'arn:aws:bedrock:us-east-1:123456789:online-evaluation-config/proj_RemovedConfig-xyz',
        },
      },
    };

    const result = computeResourceStatuses(baseProject, resources);
    const configEntry = result.find(r => r.resourceType === 'online-eval' && r.name === 'RemovedConfig');

    expect(configEntry).toBeDefined();
    expect(configEntry!.deploymentState).toBe('pending-removal');
  });

  it('handles mixed deployed and local-only resources', () => {
    const project = {
      ...baseProject,
      agents: [{ name: 'deployed-agent' }, { name: 'new-agent' }],
      credentials: [{ name: 'deployed-cred', type: 'OAuthCredentialProvider' }],
    } as unknown as AgentCoreProjectSpec;

    const resources: DeployedResourceState = {
      agents: {
        'deployed-agent': {
          runtimeId: 'rt-123',
          runtimeArn: 'arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-123',
          roleArn: 'arn:aws:iam::123456789:role/test',
        },
        'old-agent': {
          runtimeId: 'rt-old',
          runtimeArn: 'arn:aws:bedrock:us-east-1:123456789:agent-runtime/rt-old',
          roleArn: 'arn:aws:iam::123456789:role/test',
        },
      },
      credentials: {
        'deployed-cred': {
          credentialProviderArn: 'arn:aws:bedrock:us-east-1:123456789:credential-provider/deployed-cred',
        },
      },
    };

    const result = computeResourceStatuses(project, resources);

    const deployedAgent = result.find(r => r.name === 'deployed-agent');
    expect(deployedAgent!.deploymentState).toBe('deployed');

    const newAgent = result.find(r => r.name === 'new-agent');
    expect(newAgent!.deploymentState).toBe('local-only');

    const oldAgent = result.find(r => r.name === 'old-agent');
    expect(oldAgent!.deploymentState).toBe('pending-removal');

    const deployedCred = result.find(r => r.name === 'deployed-cred');
    expect(deployedCred!.deploymentState).toBe('deployed');
  });
});
