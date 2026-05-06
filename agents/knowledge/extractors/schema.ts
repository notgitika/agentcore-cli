import fs from 'fs';
import path from 'path';

export interface SchemaArrayInfo {
  key: string;
  schema_file: string;
}

export interface CrossFieldValidation {
  source: string;
  target: string;
  rule: string;
}

export interface DeployedStateResource {
  key: string;
  fields: string[];
}

export interface SchemaShape {
  agentcore_json: {
    top_level_arrays: SchemaArrayInfo[];
    cross_field_validations: CrossFieldValidation[];
  };
  deployed_state: {
    file: string;
    resource_types: DeployedStateResource[];
  };
}

export function extractSchemaShape(cliRoot: string): SchemaShape {
  const projectSpecPath = path.join(cliRoot, 'src/schema/schemas/agentcore-project.ts');
  const deployedStatePath = path.join(cliRoot, 'src/schema/schemas/deployed-state.ts');

  // Extract top-level arrays from agentcore-project.ts by reading the file content
  // and finding z.array patterns within the main schema object
  const projectContent = fs.readFileSync(projectSpecPath, 'utf-8');
  const deployedContent = fs.readFileSync(deployedStatePath, 'utf-8');

  const topLevelArrays = extractTopLevelArrays(projectContent, cliRoot);
  const crossFieldValidations = extractCrossFieldValidations(projectContent);
  const deployedStateResources = extractDeployedStateResources(deployedContent);

  return {
    agentcore_json: {
      top_level_arrays: topLevelArrays,
      cross_field_validations: crossFieldValidations,
    },
    deployed_state: {
      file: 'src/schema/schemas/deployed-state.ts',
      resource_types: deployedStateResources,
    },
  };
}

function extractTopLevelArrays(content: string, _cliRoot: string): SchemaArrayInfo[] {
  // The project schema uses multiline format:
  //   runtimes: z
  //     .array(AgentEnvSpecSchema)
  // Match: key: z\n  .array( OR key: z.array(
  const arrayPattern = /(\w+):\s*z\s*\n?\s*\.array\(/g;
  const arrays: SchemaArrayInfo[] = [];
  let match;

  // Known mappings of actual schema keys to their source files
  const schemaFileMap: Record<string, string> = {
    runtimes: 'src/schema/schemas/agent-env.ts',
    memories: 'src/schema/schemas/agentcore-project.ts',
    credentials: 'src/schema/schemas/agentcore-project.ts',
    evaluators: 'src/schema/schemas/primitives/evaluator.ts',
    onlineEvalConfigs: 'src/schema/schemas/primitives/online-eval-config.ts',
    agentCoreGateways: 'src/schema/schemas/mcp.ts',
    mcpRuntimeTools: 'src/schema/schemas/mcp.ts',
    unassignedTargets: 'src/schema/schemas/mcp.ts',
    policyEngines: 'src/schema/schemas/primitives/policy.ts',
  };

  while ((match = arrayPattern.exec(content)) !== null) {
    const key = match[1];
    if (schemaFileMap[key]) {
      arrays.push({
        key,
        schema_file: schemaFileMap[key],
      });
    }
  }

  return arrays;
}

function extractCrossFieldValidations(content: string): CrossFieldValidation[] {
  const validations: CrossFieldValidation[] = [];

  // Extract cross-field validations from the superRefine at the bottom of AgentCoreProjectSpecSchema.
  // Look for patterns like: spec.runtimes.map(a => a.name) ... config.agent ... config.evaluators
  // These reference other resource arrays for referential integrity.

  // Pattern: check for sets built from one array and validated against another
  const setPatterns = [
    {
      regex: /agentNames.*runtimes|runtimes.*agentNames/s,
      source: 'onlineEvalConfigs[].agent',
      target: 'runtimes[].name',
      rule: 'must_exist',
    },
    {
      regex: /evaluatorNames.*evaluators|evaluators.*evaluatorNames/s,
      source: 'onlineEvalConfigs[].evaluators[]',
      target: 'evaluators[].name',
      rule: 'must_exist',
    },
  ];

  // Only extract the superRefine block at the end of the schema
  const superRefineMatch = /\.strict\(\)\s*\.superRefine\(\(spec,[\s\S]+$/.exec(content);
  if (!superRefineMatch) return validations;

  const superRefineContent = superRefineMatch[0];

  for (const pattern of setPatterns) {
    if (pattern.regex.test(superRefineContent)) {
      validations.push({ source: pattern.source, target: pattern.target, rule: pattern.rule });
    }
  }

  return validations;
}

function extractDeployedStateResources(content: string): DeployedStateResource[] {
  const resources: DeployedStateResource[] = [];

  // Match schema definitions: XxxDeployedStateSchema = z.object({...})
  const schemaPattern = /export const (\w+)DeployedStateSchema = z\.object\(\{([^}]+)\}/gs;
  let match;

  // Map from schema name prefix to the key in DeployedResourceStateSchema
  const keyMap: Record<string, string> = {
    AgentCore: 'runtimes',
    Memory: 'memories',
    Gateway: 'gateways',
    McpRuntime: 'mcpRuntimes',
    McpLambda: 'mcpLambdas',
    PolicyEngine: 'policyEngines',
    Policy: 'policies',
    Credential: 'credentials',
    Evaluator: 'evaluators',
    OnlineEval: 'onlineEvalConfigs',
    RuntimeEndpoint: 'runtimeEndpoints',
  };

  while ((match = schemaPattern.exec(content)) !== null) {
    const schemaPrefix = match[1];
    const fieldsBlock = match[2];
    const key = keyMap[schemaPrefix];

    if (!key) continue;

    // Extract field names from the object definition
    const fieldPattern = /(\w+):\s*z\./g;
    const fields: string[] = [];
    let fieldMatch;
    while ((fieldMatch = fieldPattern.exec(fieldsBlock)) !== null) {
      fields.push(fieldMatch[1]);
    }

    if (fields.length > 0) {
      resources.push({ key, fields });
    }
  }

  return resources;
}
