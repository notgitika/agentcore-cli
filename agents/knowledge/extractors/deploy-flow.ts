import fs from 'fs';
import path from 'path';

export interface DeployStep {
  order: number;
  description: string;
  type: 'imperative' | 'cdk' | 'validation' | 'post-deploy';
  file?: string;
}

export function extractDeployFlow(cliRoot: string): DeployStep[] {
  const deployDir = path.join(cliRoot, 'src/cli/operations/deploy');

  if (!fs.existsSync(deployDir)) {
    throw new Error(`Deploy directory not found at ${deployDir}`);
  }

  // The deploy flow is defined by the sequence of operations in the deploy command.
  // We extract this from the deploy operation files and their ordering.
  const steps: DeployStep[] = [];

  // Check for the main deploy orchestrator
  const deployFiles = fs.readdirSync(deployDir).filter(f => f.endsWith('.ts') && !f.includes('test'));

  // Known deploy flow structure (extracted from reading the actual code)
  // We verify each step's file exists
  const knownSteps: DeployStep[] = [
    {
      order: 1,
      description: 'Preflight validation (schema parse, credentials check, target resolution)',
      type: 'validation',
    },
    {
      order: 2,
      description: 'IMPERATIVE: Create/update API key providers',
      type: 'imperative',
      file: 'src/cli/operations/deploy/pre-deploy-identity.ts',
    },
    {
      order: 3,
      description: 'IMPERATIVE: Create/update OAuth2 providers',
      type: 'imperative',
      file: 'src/cli/operations/deploy/pre-deploy-identity.ts',
    },
    {
      order: 4,
      description: 'CDK synth + deploy (CloudFormation via CDK toolkit)',
      type: 'cdk',
    },
    {
      order: 5,
      description: 'Parse CFN outputs → build deployed-state.json',
      type: 'post-deploy',
    },
    {
      order: 6,
      description: 'Post-deploy: setup transaction search',
      type: 'post-deploy',
    },
  ];

  // Verify files exist and add to output
  for (const step of knownSteps) {
    if (step.file) {
      const fullPath = path.join(cliRoot, step.file);
      if (!fs.existsSync(fullPath)) {
        step.description += ' [FILE NOT FOUND]';
      }
    }
    steps.push(step);
  }

  // Scan for additional pre-deploy or post-deploy files we may have missed
  const preDeployFiles = deployFiles.filter(f => f.startsWith('pre-deploy') && f !== 'pre-deploy-identity.ts');
  for (const file of preDeployFiles) {
    const existingFile = steps.find(s => s.file?.endsWith(file));
    if (!existingFile) {
      steps.push({
        order: steps.length + 1,
        description: `IMPERATIVE: ${file.replace('pre-deploy-', '').replace('.ts', '')} (discovered)`,
        type: 'imperative',
        file: `src/cli/operations/deploy/${file}`,
      });
    }
  }

  return steps;
}
