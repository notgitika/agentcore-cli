// Mock external packages that aren't needed for UI rendering

// Mock terminal detection packages
export const supportsColor = { stdout: false, stderr: false };
export const createSupportsColor = () => ({ stdout: false, stderr: false });
export const supportsHyperlinks = { stdout: false, stderr: false };

// Mock @resvg/resvg-js
export class Resvg {
  constructor(_svg: string, _options?: any) {}
  render() {
    return { asPng: () => new Uint8Array() };
  }
}

// Mock commander
export class Command {
  constructor() {}
  name() {
    return this;
  }
  description() {
    return this;
  }
  version() {
    return '0.0.0';
  }
  option() {
    return this;
  }
  action() {
    return this;
  }
  command() {
    return new Command();
  }
  parse() {}
  commands: Command[] = [];
}

// Mock zod
export const z = {
  string: () => ({
    min: () => z.string(),
    max: () => z.string(),
    regex: () => z.string(),
    optional: () => z.string(),
    default: () => z.string(),
    describe: () => z.string(),
    parse: (v: any) => v,
    safeParse: (v: any) => ({ success: true, data: v }),
  }),
  number: () => ({
    min: () => z.number(),
    max: () => z.number(),
    optional: () => z.number(),
    default: () => z.number(),
    describe: () => z.number(),
    parse: (v: any) => v,
    safeParse: (v: any) => ({ success: true, data: v }),
  }),
  boolean: () => ({
    optional: () => z.boolean(),
    default: () => z.boolean(),
    describe: () => z.boolean(),
    parse: (v: any) => v,
    safeParse: (v: any) => ({ success: true, data: v }),
  }),
  object: (shape: any) => ({
    shape,
    optional: () => z.object(shape),
    parse: (v: any) => v,
    safeParse: (v: any) => ({ success: true, data: v }),
    extend: (ext: any) => z.object({ ...shape, ...ext }),
  }),
  array: (item: any) => ({
    element: item,
    optional: () => z.array(item),
    parse: (v: any) => v,
    safeParse: (v: any) => ({ success: true, data: v }),
  }),
  enum: (values: string[]) => ({
    options: values,
    optional: () => z.enum(values),
    parse: (v: any) => v,
    safeParse: (v: any) => ({ success: true, data: v }),
  }),
  union: (types: any[]) => ({
    options: types,
    parse: (v: any) => v,
    safeParse: (v: any) => ({ success: true, data: v }),
  }),
  literal: (value: any) => ({
    value,
    parse: () => value,
    safeParse: () => ({ success: true, data: value }),
  }),
  any: () => ({
    parse: (v: any) => v,
    safeParse: (v: any) => ({ success: true, data: v }),
  }),
};

// Mock AWS SDK clients
export class STSClient {
  constructor(_config: any) {}
  send(_command: any) {
    return Promise.resolve({});
  }
}

export class GetCallerIdentityCommand {
  constructor(_input?: any) {}
}

export class CloudFormationClient {
  constructor(_config: any) {}
  send(_command: any) {
    return Promise.resolve({});
  }
}

export class DescribeStacksCommand {
  constructor(_input?: any) {}
}

export class DescribeStackEventsCommand {
  constructor(_input?: any) {}
}

export class BedrockRuntimeClient {
  constructor(_config: any) {}
  send(_command: any) {
    return Promise.resolve({});
  }
}

export class InvokeModelCommand {
  constructor(_input?: any) {}
}

// Mock @aws-sdk/client-bedrock-agentcore
export class BedrockAgentCoreClient {
  constructor(_config: any) {}
  send(_command: any) {
    return Promise.resolve({});
  }
}

export class InvokeAgentRuntimeCommand {
  constructor(_input?: any) {}
}

// Mock @aws-sdk/client-bedrock-agentcore-control
export class BedrockAgentCoreControlClient {
  constructor(_config: any) {}
  send(_command: any) {
    return Promise.resolve({});
  }
}

export class GetAgentRuntimeCommand {
  constructor(_input?: any) {}
}

export class CreateApiKeyCredentialProviderCommand {
  constructor(_input?: any) {}
}

export class GetApiKeyCredentialProviderCommand {
  constructor(_input?: any) {}
}

// Mock AWS SDK exceptions
export class ResourceNotFoundException extends Error {
  name = 'ResourceNotFoundException';
  constructor(message?: string) {
    super(message || 'Resource not found');
  }
}

// Mock credential providers
export const fromNodeProviderChain = () => async () => ({
  accessKeyId: 'mock',
  secretAccessKey: 'mock',
});

export const fromEnv = () => async () => ({
  accessKeyId: 'mock',
  secretAccessKey: 'mock',
});

// Mock shared ini file loader
export const loadSharedConfigFiles = async () => ({
  configFile: {},
  credentialsFile: {},
});

// Mock @aws-sdk/client-resource-groups-tagging-api
export class ResourceGroupsTaggingAPIClient {
  constructor(_config: any) {}
  send(_command: any) {
    return Promise.resolve({ ResourceTagMappingList: [] });
  }
}

export class GetResourcesCommand {
  constructor(_input?: any) {}
}

// Mock CDK toolkit-lib
export const StackSelectionStrategy = {
  ALL_STACKS: 'ALL_STACKS',
  PATTERN_MUST_MATCH: 'PATTERN_MUST_MATCH',
  PATTERN_MUST_MATCH_SINGLE: 'PATTERN_MUST_MATCH_SINGLE',
  NONE: 'NONE',
};

export class Toolkit {
  constructor(_options: any) {}

  async fromCdkApp(_command: string, _options?: any) {
    // Return a mock ICloudAssemblySource
    return {
      produce: async () => ({
        cloudAssembly: {
          directory: '/mock/cdk.out',
          stacks: [{ stackName: 'MockStack' }],
        },
        dispose: async () => {},
      }),
    };
  }

  fromAssemblyDirectory(_directory: string) {
    return {
      produce: async () => ({
        cloudAssembly: {
          directory: '/mock/cdk.out',
          stacks: [{ stackName: 'MockStack' }],
        },
        dispose: async () => {},
      }),
    };
  }

  synth(_source: any, _options?: any) {
    // Return a synth result that matches the expected interface
    return Promise.resolve({
      produce: async () => ({
        cloudAssembly: {
          directory: '/mock/cdk.out',
          stacks: [{ stackName: 'AgentCoreStack-us-west-2' }, { stackName: 'AgentCoreStack-us-east-1' }],
        },
        dispose: async () => {},
      }),
      dispose: async () => {},
    });
  }

  deploy(_source: any, _options?: any) {
    return Promise.resolve({});
  }

  destroy(_source: any, _options?: any) {
    return Promise.resolve({});
  }

  diff(_source: any, _options?: any) {
    return Promise.resolve({});
  }

  list(_source: any, _options?: any) {
    return Promise.resolve([{ stackName: 'MockStack' }]);
  }

  bootstrap(_environments: any) {
    return Promise.resolve({});
  }
}

export const BaseCredentials = {
  awsCliCompatible: (_options?: any) => ({}),
};
export const BootstrapEnvironments = {
  fromList: (_environments: string[]) => ({}),
};

// Mock Handlebars
const Handlebars = {
  compile: (template: string) => (context: any) => template,
  parse: (template: string) => ({ type: 'Program', body: [] }),
  precompile: (template: string) => 'function() { return ""; }',
  registerHelper: () => {},
  registerPartial: () => {},
  SafeString: class SafeString {
    constructor(public value: string) {}
    toString() {
      return this.value;
    }
  },
};

export default Handlebars;
export { Handlebars };
export const parse = Handlebars.parse;
export const compile = Handlebars.compile;

// Mock @agentcore/cdk
export const logicalId = (name: string) => `Mock${name}`;
export const toPascalId = (name: string) =>
  name.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^./, s => s.toUpperCase());
export class AgentCoreApplication {
  constructor(_scope: any, _id: string, _props: any) {}
}
export class AgentCoreMcp {
  constructor(_scope: any, _id: string, _props: any) {}
}
