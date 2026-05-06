#!/usr/bin/env npx tsx
/**
 * Knowledge Snapshot Refresh
 *
 * Generates cli-architecture-snapshot.yaml from the current codebase state.
 * Run at pipeline invocation time to ensure freshness.
 *
 * Usage:
 *   npx tsx refresh.ts --cli-root ../../
 *   npx tsx refresh.ts --cli-root ../../ --cdk-root /path/to/cdk-repo
 *
 * CDK root is optional. If not provided, checks:
 *   1. AGENTCORE_CDK_ROOT env var
 *   2. Sibling directory (../agentcore-l3-cdk-constructs relative to cli-root)
 *   3. Skips CDK snapshot if not found (warns)
 */
import { extractCommands } from './extractors/commands.js';
import { extractDeployFlow } from './extractors/deploy-flow.js';
import { extractPrimitives } from './extractors/primitives.js';
import { extractSchemaShape } from './extractors/schema.js';
import fs from 'fs';
import { execSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import path from 'path';
import { stringify } from 'yaml';

const SCHEMA_VERSION = 1;

interface CliSnapshot {
  schema_version: number;
  generated_at: string;
  commit: string;
  repo: string;
  primitives: ReturnType<typeof extractPrimitives>;
  schema_shape: ReturnType<typeof extractSchemaShape>;
  deploy_flow: { file: string; steps: Record<number, string> };
  commands: { verbs: ReturnType<typeof extractCommands> };
  iam_patterns: Record<string, string>;
  code_style: { rules: string[]; tui_patterns: string[] };
}

function getGitCommit(repoRoot: string): string {
  try {
    const headPath = path.join(repoRoot, '.git/HEAD');
    const head = fs.readFileSync(headPath, 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = path.join(repoRoot, '.git', head.slice(5));
      if (fs.existsSync(refPath)) {
        return fs.readFileSync(refPath, 'utf-8').trim().slice(0, 8);
      }
    }
    return head.slice(0, 8);
  } catch {
    return 'unknown';
  }
}

function resolveCdkRoot(cliRoot: string, explicitCdkRoot?: string): string | null {
  // 1. Explicit flag
  if (explicitCdkRoot) {
    const resolved = path.resolve(explicitCdkRoot);
    if (fs.existsSync(resolved)) return resolved;
    console.warn(`[warn] --cdk-root path does not exist: ${resolved}`);
    return null;
  }

  // 2. Environment variable
  const envCdkRoot = process.env.AGENTCORE_CDK_ROOT;
  if (envCdkRoot) {
    const resolved = path.resolve(envCdkRoot);
    if (fs.existsSync(resolved)) return resolved;
    console.warn(`[warn] AGENTCORE_CDK_ROOT path does not exist: ${resolved}`);
  }

  // 3. Common sibling locations (relative to cli-root's parent)
  const cliParent = path.dirname(path.resolve(cliRoot));
  const siblingPaths = [
    path.join(cliParent, 'agentcore-l3-cdk-constructs'),
    path.join(cliParent, '..', 'agentcore-l3-cdk-constructs'),
  ];

  for (const candidate of siblingPaths) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }

  // 4. Fallback: shallow clone into a temp location
  const cloneTarget = path.join(path.dirname(new URL(import.meta.url).pathname), '.cdk-clone');
  const CDK_REPO_URL = 'https://github.com/aws/agentcore-l3-cdk-constructs.git';

  if (fs.existsSync(path.join(cloneTarget, 'package.json'))) {
    console.log(`[info] Using cached CDK clone at ${cloneTarget}`);
    // Pull latest
    try {
      execSync('git pull --ff-only', { cwd: cloneTarget, stdio: 'pipe' });
    } catch {
      console.warn('[warn] Failed to update CDK clone, using cached version');
    }
    return cloneTarget;
  }

  console.log(`[info] CDK repo not found locally. Cloning ${CDK_REPO_URL} ...`);
  try {
    execSync(`git clone --depth=1 ${CDK_REPO_URL} ${cloneTarget}`, { stdio: 'pipe' });
    console.log(`[info] CDK repo cloned to ${cloneTarget}`);
    return cloneTarget;
  } catch (err) {
    console.warn(`[warn] Failed to clone CDK repo: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function generateCliSnapshot(cliRoot: string): CliSnapshot {
  const resolvedRoot = path.resolve(cliRoot);

  console.log(`[info] Extracting from CLI root: ${resolvedRoot}`);

  const primitives = extractPrimitives(resolvedRoot);
  console.log(`[info] Found ${primitives.length} primitives`);

  const schemaShape = extractSchemaShape(resolvedRoot);
  console.log(`[info] Found ${schemaShape.agentcore_json.top_level_arrays.length} schema arrays`);

  const commands = extractCommands(resolvedRoot);
  console.log(`[info] Found ${commands.length} command verbs`);

  const deployFlow = extractDeployFlow(resolvedRoot);
  console.log(`[info] Found ${deployFlow.length} deploy steps`);

  const steps: Record<number, string> = {};
  for (const step of deployFlow) {
    steps[step.order] = step.description;
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    commit: getGitCommit(resolvedRoot),
    repo: 'aws/agentcore-cli',
    primitives,
    schema_shape: schemaShape,
    deploy_flow: {
      file: 'src/cli/operations/deploy/',
      steps,
    },
    commands: { verbs: commands },
    iam_patterns: {
      service_principal: 'bedrock-agentcore.amazonaws.com',
      lambda_principal: 'lambda.amazonaws.com',
      role_creation: 'CDK: new iam.Role({ assumedBy: new iam.ServicePrincipal(AGENTCORE_SERVICE_PRINCIPAL) })',
      existing_role_support: 'executionRoleArn on agent schema allows BYO role',
      partition_utility: 'src/cli/aws/partition.ts — arnPrefix(), serviceEndpoint(), dnsSuffix()',
    },
    code_style: {
      rules: [
        'No inline imports',
        '{ success: boolean, error?: string } for results',
        'Existing types before inline',
        'Constants in closest subdirectory',
        'Never hardcode arn:aws:',
        'Tags via TagsSchema on all resources',
      ],
      tui_patterns: [
        'Screen → Flow → Wizard hook → Operation hook → Primitive',
        'MAX_CONTENT_WIDTH = 60',
        "SelectList uses wrap='wrap'",
      ],
    },
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      'cli-root': { type: 'string', default: '../../' },
      'cdk-root': { type: 'string' },
    },
  });

  const cliRoot = values['cli-root'];
  const resolvedCliRoot = path.resolve(cliRoot);

  if (!fs.existsSync(resolvedCliRoot)) {
    console.error(`[error] CLI root not found: ${resolvedCliRoot}`);
    process.exit(1);
  }

  // Generate CLI snapshot
  const cliSnapshot = generateCliSnapshot(cliRoot);
  const outputDir = path.dirname(new URL(import.meta.url).pathname);
  const cliOutputPath = path.join(outputDir, 'cli-architecture-snapshot.yaml');

  fs.writeFileSync(cliOutputPath, stringify(cliSnapshot), 'utf-8');
  console.log(`[done] CLI snapshot written to ${cliOutputPath}`);

  // Attempt CDK snapshot
  const cdkRoot = resolveCdkRoot(resolvedCliRoot, values['cdk-root']);
  if (cdkRoot) {
    console.log(`[info] CDK root found: ${cdkRoot}`);
    // CDK snapshot is simpler — just extract construct names and exports
    const cdkSnapshot = generateCdkSnapshot(cdkRoot);
    const cdkOutputPath = path.join(outputDir, 'cdk-architecture-snapshot.yaml');
    fs.writeFileSync(cdkOutputPath, stringify(cdkSnapshot), 'utf-8');
    console.log(`[done] CDK snapshot written to ${cdkOutputPath}`);
  } else {
    console.warn('[warn] CDK root not found. Skipping CDK snapshot.');
    console.warn('       Set AGENTCORE_CDK_ROOT env var or pass --cdk-root flag.');
  }
}

function generateCdkSnapshot(cdkRoot: string) {
  const resolvedRoot = path.resolve(cdkRoot);
  const constructsDir = path.join(resolvedRoot, 'src/cdk/constructs');

  const constructs: { name: string; file: string; type: string }[] = [];

  // Scan for construct files
  if (fs.existsSync(constructsDir)) {
    const scanDir = (dir: string, type: string) => {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of files) {
        if (
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.includes('test') &&
          !entry.name.includes('index')
        ) {
          constructs.push({
            name: entry.name.replace('.ts', ''),
            file: path.relative(resolvedRoot, path.join(dir, entry.name)),
            type,
          });
        }
        if (entry.isDirectory() && !entry.name.startsWith('__')) {
          scanDir(path.join(dir, entry.name), type);
        }
      }
    };

    scanDir(path.join(constructsDir, 'l3'), 'l3');
    scanDir(path.join(constructsDir, 'components/primitives'), 'primitive');
    scanDir(path.join(constructsDir, 'components/mcp'), 'mcp');
  }

  // Read constants
  let servicePrincipal = 'bedrock-agentcore.amazonaws.com';
  const constantsPath = path.join(resolvedRoot, 'src/cdk/constants.ts');
  if (fs.existsSync(constantsPath)) {
    const content = fs.readFileSync(constantsPath, 'utf-8');
    const match = /AGENTCORE_SERVICE_PRINCIPAL\s*=\s*['"]([^'"]+)['"]/.exec(content);
    if (match) servicePrincipal = match[1];
  }

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    commit: getGitCommit(resolvedRoot),
    repo: 'aws/agentcore-l3-cdk-constructs',
    service_principal: servicePrincipal,
    constructs,
  };
}

main();
