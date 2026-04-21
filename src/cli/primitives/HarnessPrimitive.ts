import { APP_DIR, ConfigIO, findConfigRoot } from '../../lib';
import type { HarnessModelProvider, HarnessSpec, NetworkMode } from '../../schema';
import { HarnessSpecSchema } from '../../schema';
import { deleteHarness } from '../aws/agentcore-harness';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, RemovalResult, SchemaChange } from '../operations/remove/types';
import { DEFAULT_MEMORY_EXPIRY_DAYS } from '../tui/screens/generate/defaults';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';
import { access, copyFile, mkdir, rm, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'path';

export interface AddHarnessOptions {
  name: string;
  modelProvider: HarnessModelProvider;
  modelId: string;
  apiKeyArn?: string;
  systemPrompt?: string;
  skipMemory?: boolean;
  containerUri?: string;
  dockerfilePath?: string;
  maxIterations?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  truncationStrategy?: 'sliding_window' | 'summarization';
  networkMode?: NetworkMode;
  subnets?: string[];
  securityGroups?: string[];
  idleTimeout?: number;
  maxLifetime?: number;
  configBaseDir?: string;
}

export type RemovableHarness = RemovableResource;

export class HarnessPrimitive extends BasePrimitive<AddHarnessOptions, RemovableHarness> {
  readonly kind = 'harness' as const;
  readonly label = 'Harness';
  readonly primitiveSchema = HarnessSpecSchema;

  async add(options: AddHarnessOptions): Promise<AddResult<{ harnessName: string }>> {
    try {
      const configBaseDir = options.configBaseDir ?? findConfigRoot();
      if (!configBaseDir) {
        return { success: false, error: 'No agentcore project found. Run `agentcore create` first.' };
      }

      const configIO = new ConfigIO({ baseDir: configBaseDir });
      const project = await this.readProjectSpec(configIO);

      const harnesses = project.harnesses ?? [];
      this.checkDuplicate(harnesses, options.name);

      const memoryName = options.skipMemory ? undefined : `${options.name}Memory`;

      let dockerfile: string | undefined;
      if (options.dockerfilePath) {
        const projectRoot = dirname(configBaseDir);
        const srcPath = isAbsolute(options.dockerfilePath)
          ? options.dockerfilePath
          : resolve(projectRoot, options.dockerfilePath);
        try {
          await access(srcPath);
        } catch {
          return { success: false, error: `Dockerfile not found at: ${srcPath}` };
        }
        const appDir = join(projectRoot, APP_DIR, options.name);
        await mkdir(appDir, { recursive: true });
        const destFilename = basename(srcPath);
        await copyFile(srcPath, join(appDir, destFilename));
        dockerfile = destFilename;
      }

      const harnessSpec: HarnessSpec = {
        name: options.name,
        model: {
          provider: options.modelProvider,
          modelId: options.modelId,
          ...(options.apiKeyArn && { apiKeyArn: options.apiKeyArn }),
        },
        tools: [],
        skills: [],
        ...(options.systemPrompt && { systemPrompt: options.systemPrompt }),
        ...(memoryName && { memory: { name: memoryName } }),
        ...(options.containerUri && { containerUri: options.containerUri }),
        ...(dockerfile && { dockerfile }),
        ...(options.maxIterations !== undefined && { maxIterations: options.maxIterations }),
        ...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
        ...(options.timeoutSeconds !== undefined && { timeoutSeconds: options.timeoutSeconds }),
        ...(options.truncationStrategy && { truncation: { strategy: options.truncationStrategy } }),
        ...(options.networkMode && { networkMode: options.networkMode }),
        ...(options.networkMode === 'VPC' &&
          options.subnets &&
          options.securityGroups && {
            networkConfig: {
              subnets: options.subnets,
              securityGroups: options.securityGroups,
            },
          }),
        ...(this.buildLifecycleConfig(options) && { lifecycleConfig: this.buildLifecycleConfig(options) }),
      };

      await configIO.writeHarnessSpec(options.name, harnessSpec);

      const pathResolver = configIO.getPathResolver();
      const harnessDir = pathResolver.getHarnessDir(options.name);
      const systemPromptPath = join(harnessDir, 'system-prompt.md');
      const systemPromptContent = options.systemPrompt ?? 'You are a helpful assistant';
      await writeFile(systemPromptPath, systemPromptContent, 'utf-8');

      if (memoryName) {
        project.memories.push({
          name: memoryName,
          eventExpiryDuration: DEFAULT_MEMORY_EXPIRY_DAYS,
          strategies: [],
        });
      }

      project.harnesses = [
        ...harnesses,
        {
          name: options.name,
          path: `app/${options.name}`,
        },
      ];

      await this.writeProjectSpec(project, configIO);

      return { success: true, harnessName: options.name };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  }

  async remove(harnessName: string): Promise<RemovalResult> {
    try {
      const configRoot = findConfigRoot();
      if (!configRoot) {
        return { success: false, error: 'No agentcore project found.' };
      }

      const configIO = new ConfigIO({ baseDir: configRoot });
      const project = await this.readProjectSpec(configIO);

      const harnesses = project.harnesses ?? [];
      const harnessIndex = harnesses.findIndex(h => h.name === harnessName);

      if (harnessIndex === -1) {
        return { success: false, error: `Harness "${harnessName}" not found.` };
      }

      // Delete harness from AWS if it's deployed
      try {
        const deployedState = await configIO.readDeployedState();
        for (const target of Object.values(deployedState.targets)) {
          const deployedHarness = target.resources?.harnesses?.[harnessName];
          if (deployedHarness) {
            const targets = await configIO.resolveAWSDeploymentTargets();
            const region = targets[0]?.region;
            if (region) {
              await deleteHarness({ region, harnessId: deployedHarness.harnessId });
            }
            delete target.resources!.harnesses![harnessName];
            await configIO.writeDeployedState(deployedState);
            break;
          }
        }
      } catch {
        // AWS deletion is best-effort; next deploy will clean up
      }

      harnesses.splice(harnessIndex, 1);
      project.harnesses = harnesses;

      await this.writeProjectSpec(project, configIO);

      const pathResolver = configIO.getPathResolver();
      const harnessDir = pathResolver.getHarnessDir(harnessName);
      await rm(harnessDir, { recursive: true, force: true });

      return { success: true };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  }

  async previewRemove(harnessName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    const harnesses = project.harnesses ?? [];
    const harness = harnesses.find(h => h.name === harnessName);

    if (!harness) {
      throw new Error(`Harness "${harnessName}" not found.`);
    }

    const summary: string[] = [`Removing harness: ${harnessName}`];
    const directoriesToDelete: string[] = [`app/${harnessName}`];
    const schemaChanges: SchemaChange[] = [];

    const afterSpec = {
      ...project,
      harnesses: harnesses.filter(h => h.name !== harnessName),
    };

    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterSpec,
    });

    return { summary, directoriesToDelete, schemaChanges };
  }

  async getRemovable(): Promise<RemovableHarness[]> {
    try {
      const project = await this.readProjectSpec();
      const harnesses = project.harnesses ?? [];
      return harnesses.map(h => ({ name: h.name }));
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('harness')
      .description('Add a harness to the project')
      .option('--name <name>', 'Harness name (start with letter, alphanumeric + underscores, max 48 chars)')
      .option('--model-provider <provider>', 'Model provider: bedrock, open_ai, gemini')
      .option('--model-id <id>', 'Model ID (e.g., anthropic.claude-3-5-sonnet-20240620-v1:0)')
      .option('--api-key-arn <arn>', 'API key ARN for non-Bedrock providers')
      .option('--container <uri-or-path>', 'Container image URI or path to a Dockerfile')
      .option('--no-memory', 'Skip auto-creating memory')
      .option('--max-iterations <n>', 'Max iterations', parseInt)
      .option('--max-tokens <n>', 'Max tokens', parseInt)
      .option('--timeout <seconds>', 'Timeout in seconds', parseInt)
      .option('--truncation-strategy <strategy>', 'Truncation strategy: sliding_window or summarization')
      .option('--network-mode <mode>', 'Network mode: PUBLIC or VPC')
      .option('--subnets <ids>', 'Comma-separated subnet IDs (for VPC mode)')
      .option('--security-groups <ids>', 'Comma-separated security group IDs (for VPC mode)')
      .option('--idle-timeout <seconds>', 'Idle timeout in seconds', parseInt)
      .option('--max-lifetime <seconds>', 'Max lifetime in seconds', parseInt)
      .option('--json', 'Output as JSON')
      .action(
        async (cliOptions: {
          name?: string;
          modelProvider?: string;
          modelId?: string;
          apiKeyArn?: string;
          container?: string;
          memory?: boolean;
          maxIterations?: number;
          maxTokens?: number;
          timeout?: number;
          truncationStrategy?: string;
          networkMode?: string;
          subnets?: string;
          securityGroups?: string;
          idleTimeout?: number;
          maxLifetime?: number;
          json?: boolean;
        }) => {
          try {
            if (!findConfigRoot()) {
              console.error('No agentcore project found. Run `agentcore create` first.');
              process.exit(1);
            }

            if (cliOptions.name || cliOptions.json) {
              if (!cliOptions.name) {
                const error = '--name is required';
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              }

              const { DEFAULT_MODEL_IDS } = await import('../tui/screens/harness/types');
              const provider = (cliOptions.modelProvider ?? 'bedrock') as HarnessModelProvider;
              const modelId = cliOptions.modelId ?? DEFAULT_MODEL_IDS[provider];

              const containerOption = this.parseContainerFlag(cliOptions.container);

              const result = await this.add({
                name: cliOptions.name,
                modelProvider: provider,
                modelId,
                apiKeyArn: cliOptions.apiKeyArn,
                containerUri: containerOption.containerUri,
                dockerfilePath: containerOption.dockerfilePath,
                skipMemory: cliOptions.memory === false,
                maxIterations: cliOptions.maxIterations,
                maxTokens: cliOptions.maxTokens,
                timeoutSeconds: cliOptions.timeout,
                truncationStrategy: cliOptions.truncationStrategy as 'sliding_window' | 'summarization' | undefined,
                networkMode: cliOptions.networkMode as NetworkMode | undefined,
                subnets: cliOptions.subnets?.split(',').map(s => s.trim()),
                securityGroups: cliOptions.securityGroups?.split(',').map(s => s.trim()),
                idleTimeout: cliOptions.idleTimeout,
                maxLifetime: cliOptions.maxLifetime,
              });

              if (!result.success) {
                if (cliOptions.json) {
                  console.log(JSON.stringify(result));
                } else {
                  console.error(result.error);
                }
                process.exit(1);
              }

              // Deploy harness to AWS
              if (!cliOptions.json) {
                console.log(`Added harness '${result.harnessName}'. Deploying...`);
              }
              try {
                const { handleDeploy } = await import('../commands/deploy/actions');
                const deployResult = await handleDeploy({ target: 'default', autoConfirm: true });
                if (cliOptions.json) {
                  console.log(JSON.stringify({ ...result, deployed: deployResult.success }));
                } else if (deployResult.success) {
                  console.log('Harness deployed successfully.');
                } else {
                  console.warn(`Deploy warning: ${deployResult.error}`);
                }
              } catch (err) {
                if (cliOptions.json) {
                  console.log(JSON.stringify({ ...result, deployed: false }));
                } else {
                  console.warn(`Deploy warning: ${getErrorMessage(err)}`);
                }
              }

              process.exit(0);
            } else {
              console.error('Interactive mode is not yet implemented for harnesses.');
              console.error('Use --name, --model-provider, and --model-id flags to add a harness.');
              process.exit(1);
            }
          } catch (error) {
            if (cliOptions.json) {
              console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
            } else {
              console.error(getErrorMessage(error));
            }
            process.exit(1);
          }
        }
      );

    this.registerRemoveSubcommand(removeCmd);
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  parseContainerFlag(value?: string): { containerUri?: string; dockerfilePath?: string } {
    if (!value) return {};
    // Treat as Dockerfile if it uses a relative path prefix or ends with a
    // Dockerfile extension. Bare absolute paths like /my-org/image:tag are
    // valid container URIs so we don't match on leading / alone.
    const looksLikeDockerfile =
      value.endsWith('Dockerfile') ||
      value.endsWith('.dockerfile') ||
      value.startsWith('./') ||
      value.startsWith('../');
    if (looksLikeDockerfile) {
      return { dockerfilePath: value };
    }
    return { containerUri: value };
  }

  private buildLifecycleConfig(options: { idleTimeout?: number; maxLifetime?: number }) {
    if (options.idleTimeout === undefined && options.maxLifetime === undefined) return undefined;
    return {
      ...(options.idleTimeout !== undefined && { idleRuntimeSessionTimeout: options.idleTimeout }),
      ...(options.maxLifetime !== undefined && { maxLifetime: options.maxLifetime }),
    };
  }
}
