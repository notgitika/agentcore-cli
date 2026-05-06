import fs from 'fs';
import path from 'path';
import { Project } from 'ts-morph';

export interface PrimitiveInfo {
  name: string;
  file: string;
  kind: string;
  label: string;
  resources_managed: string[];
  schema_key: string;
  supports_tui: boolean;
  supports_remove: boolean;
  has_cross_references: boolean;
  references?: string[];
}

export function extractPrimitives(cliRoot: string): PrimitiveInfo[] {
  const registryPath = path.join(cliRoot, 'src/cli/primitives/registry.ts');
  if (!fs.existsSync(registryPath)) {
    throw new Error(`Registry not found at ${registryPath}`);
  }

  const project = new Project({
    tsConfigFilePath: path.join(cliRoot, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });

  // Add only the files we need
  const primitivesDir = path.join(cliRoot, 'src/cli/primitives');
  const primitiveFiles = fs
    .readdirSync(primitivesDir)
    .filter(f => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('__tests__') && !f.includes('.test.'))
    .map(f => path.join(primitivesDir, f));

  primitiveFiles.forEach(f => project.addSourceFileAtPath(f));

  const registrySource = project.getSourceFileOrThrow(registryPath);
  const primitives: PrimitiveInfo[] = [];

  // Find ALL_PRIMITIVES array to get the list of registered primitives
  const allPrimitivesVar = registrySource.getVariableDeclaration('ALL_PRIMITIVES');
  if (!allPrimitivesVar) {
    throw new Error('ALL_PRIMITIVES not found in registry.ts');
  }

  // Extract import paths to find primitive class files
  const imports = registrySource.getImportDeclarations();
  const primitiveClassFiles = new Map<string, string>();

  for (const imp of imports) {
    const namedImports = imp.getNamedImports();
    const moduleSpecifier = imp.getModuleSpecifierValue();
    for (const named of namedImports) {
      const importName = named.getName();
      if (importName.endsWith('Primitive') && importName !== 'BasePrimitive') {
        const resolvedPath = path.resolve(primitivesDir, moduleSpecifier);
        primitiveClassFiles.set(importName, resolvedPath);
      }
    }
  }

  // For each primitive class, extract metadata
  for (const [className, filePath] of primitiveClassFiles) {
    const extensions = ['', '.ts', '.tsx'];
    let sourceFile = null;

    for (const ext of extensions) {
      const fullPath = filePath + ext;
      sourceFile = project.getSourceFile(fullPath);
      if (sourceFile) break;
    }

    if (!sourceFile) continue;

    const classDecl = sourceFile.getClass(className);
    if (!classDecl) continue;

    // Extract kind
    const kindProp = classDecl.getProperty('kind');
    let kind = '';
    if (kindProp) {
      const initializer = kindProp.getInitializer();
      if (initializer) {
        kind = initializer.getText().replace(/['"]/g, '').replace(' as const', '');
      }
    }

    // Extract label
    const labelProp = classDecl.getProperty('label');
    let label = '';
    if (labelProp) {
      const initializer = labelProp.getInitializer();
      if (initializer) {
        label = initializer.getText().replace(/['"]/g, '');
      }
    }

    // Check for addScreen (indicates TUI support)
    const addScreenMethod = classDecl.getMethod('addScreen');
    const supportsTui = addScreenMethod !== undefined;

    // Check for remove method implementation (not just the abstract)
    const removeMethod = classDecl.getMethod('remove');
    const supportsRemove = removeMethod !== undefined;

    // Determine schema_key from kind (convention: kind maps to schema array key)
    const schemaKeyMap: Record<string, string> = {
      agent: 'agents',
      memory: 'memories',
      credential: 'credentials',
      evaluator: 'evaluators',
      'online-eval': 'onlineEvalConfigs',
      gateway: 'gateways',
      'gateway-target': 'gatewayTargets',
      'policy-engine': 'policyEngines',
      policy: 'policies',
      'runtime-endpoint': 'runtimeEndpoints',
    };

    const schemaKey = schemaKeyMap[kind] || kind;
    const relativeFile = path.relative(cliRoot, sourceFile.getFilePath());

    primitives.push({
      name: className,
      file: relativeFile,
      kind,
      label,
      resources_managed: [schemaKey],
      schema_key: schemaKey,
      supports_tui: supportsTui,
      supports_remove: supportsRemove,
      has_cross_references: false, // will be enriched by schema extractor
      references: undefined,
    });
  }

  return primitives;
}
