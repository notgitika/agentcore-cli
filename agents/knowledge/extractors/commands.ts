import fs from 'fs';
import path from 'path';

export interface CommandVerb {
  name: string;
  nouns?: string[];
  has_tui?: boolean;
}

export function extractCommands(cliRoot: string): CommandVerb[] {
  const commandsDir = path.join(cliRoot, 'src/cli/commands');

  if (!fs.existsSync(commandsDir)) {
    throw new Error(`Commands directory not found at ${commandsDir}`);
  }

  const entries = fs.readdirSync(commandsDir, { withFileTypes: true });
  const verbs: CommandVerb[] = [];

  // Each subdirectory under commands/ is a verb
  const verbDirs = entries.filter(e => e.isDirectory() && e.name !== 'shared').map(e => e.name);

  // Known nouns per verb (extracted from AGENTS.md / command structure)
  const verbConfig: Record<string, { nouns?: string[]; has_tui?: boolean }> = {
    add: { nouns: getAddNouns(commandsDir), has_tui: true },
    remove: { nouns: getRemoveNouns(commandsDir), has_tui: false },
    create: { has_tui: true },
    deploy: {},
    status: {},
    dev: {},
    invoke: {},
    run: { nouns: ['eval'] },
    logs: {},
    package: {},
    validate: {},
    update: {},
    import: {},
    fetch: { nouns: ['access'] },
    pause: { nouns: ['online-eval'] },
    resume: { nouns: ['online-eval'] },
    traces: { nouns: ['list', 'get'] },
    eval: { nouns: ['history'] },
    tag: {},
    help: {},
    telemetry: {},
  };

  for (const verb of verbDirs) {
    const config = verbConfig[verb] || {};
    verbs.push({
      name: verb,
      ...(config.nouns && { nouns: config.nouns }),
      ...(config.has_tui !== undefined && { has_tui: config.has_tui }),
    });
  }

  return verbs;
}

function getAddNouns(commandsDir: string): string[] {
  // Add nouns come from primitive registrations (primitive.registerCommands()),
  // not from the add/ directory structure. Extract from the primitives registry
  // by reading kind values, or fall back to the known list from AGENTS.md.
  const primitivesDir = path.join(commandsDir, '..', 'primitives');

  if (fs.existsSync(primitivesDir)) {
    const nouns: string[] = [];
    const files = fs
      .readdirSync(primitivesDir)
      .filter(
        f =>
          (f.endsWith('.ts') || f.endsWith('.tsx')) &&
          f.includes('Primitive') &&
          f !== 'BasePrimitive.ts' &&
          !f.includes('test')
      );

    for (const file of files) {
      const content = fs.readFileSync(path.join(primitivesDir, file), 'utf-8');
      // Match: readonly kind = 'some-kind' or readonly kind: ResourceType = 'some-kind'
      const kindMatch = /readonly\s+kind[^=]*=\s*['"]([^'"]+)['"]/.exec(content);
      if (kindMatch && !nouns.includes(kindMatch[1])) {
        nouns.push(kindMatch[1]);
      }
    }

    if (nouns.length > 0) return nouns.sort();
  }

  return [
    'agent',
    'memory',
    'credential',
    'evaluator',
    'online-eval',
    'gateway',
    'gateway-target',
    'policy-engine',
    'policy',
  ];
}

function getRemoveNouns(commandsDir: string): string[] {
  const removeDir = path.join(commandsDir, 'remove');
  if (!fs.existsSync(removeDir)) return [];

  // Check types.ts for ResourceType union
  const typesPath = path.join(removeDir, 'types.ts');
  if (fs.existsSync(typesPath)) {
    const content = fs.readFileSync(typesPath, 'utf-8');
    // Match string literal union members
    const literalPattern = /['"]([a-z-]+)['"]/g;
    const nouns: string[] = [];
    let match;
    while ((match = literalPattern.exec(content)) !== null) {
      if (!nouns.includes(match[1])) {
        nouns.push(match[1]);
      }
    }
    if (nouns.length > 0) return nouns.sort();
  }

  return [
    'agent',
    'memory',
    'credential',
    'evaluator',
    'online-eval',
    'gateway',
    'gateway-target',
    'policy-engine',
    'policy',
    'all',
  ];
}
