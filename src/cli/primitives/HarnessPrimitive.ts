import { APP_DIR, ConfigIO, type Result, findConfigRoot } from '../../lib';
import type {
  AgentCoreProjectSpec,
  EndpointIpAddressType,
  HarnessApiFormat,
  HarnessGatewayOutboundAuth,
  HarnessModelProvider,
  HarnessSpec,
  MemoryStrategy,
  MemoryStrategyType,
  NetworkMode,
  PrivateEndpoint,
  RuntimeAuthorizerType,
} from '../../schema';
import { DEFAULT_EPISODIC_REFLECTION_NAMESPACES, DEFAULT_STRATEGY_NAMESPACES, HarnessSpecSchema } from '../../schema';
import { deleteHarness } from '../aws/agentcore-harness';
import { getErrorMessage } from '../errors';
import { findOrphanHarnesses } from '../operations/harness/orphan';
import type { OrphanHarness } from '../operations/harness/orphan';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { withCommandRunTelemetry } from '../telemetry/cli-command-run.js';
import type { SubCommand } from '../telemetry/schemas/command-run.js';
import { getTemplatePath } from '../templates/templateRoot';
import { requireTTY } from '../tui/guards/tty';
import { DEFAULT_MEMORY_EXPIRY_DAYS } from '../tui/screens/generate/defaults';
import { BasePrimitive } from './BasePrimitive';
import { buildAuthorizerConfigFromJwtConfig, createManagedOAuthCredential } from './auth-utils';
import type { JwtConfigOptions } from './auth-utils';
import { ADDITIONAL_PARAMS_JSON_ERROR, SOURCE_CODE_NOTE } from './constants';
import type { AddScreenComponent, RemovableResource } from './types';
import { ResourceNotFoundError, ValidationError, toError } from '@/lib/errors/types';
import type { Command } from '@commander-js/extra-typings';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'path';

export interface AddHarnessOptions {
  name: string;
  modelProvider: HarnessModelProvider;
  modelId: string;
  apiFormat?: HarnessApiFormat;
  apiKeyArn?: string;
  /** LiteLLM only: base URL for the third-party model provider's API endpoint. */
  apiBase?: string;
  /** LiteLLM only: provider-specific parameters passed through to the model provider unchanged. */
  additionalParams?: Record<string, unknown>;
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
  sessionStoragePath?: string;
  efsAccessPoints?: { accessPointArn: string; mountPath: string }[];
  s3AccessPoints?: { accessPointArn: string; mountPath: string }[];
  withInvokeScript?: boolean;
  selectedTools?: string[];
  mcpName?: string;
  mcpUrl?: string;
  gatewayArn?: string;
  gatewayOutboundAuth?: 'awsIam' | 'none' | 'oauth';
  gatewayProviderArn?: string;
  gatewayScopes?: string[];
  authorizerType?: RuntimeAuthorizerType;
  jwtConfig?: JwtConfigOptions;
  skills?: {
    path?: string;
    s3Uri?: string;
    gitUrl?: string;
    gitPath?: string;
    credentialName?: string;
    username?: string;
  }[];
  configBaseDir?: string;
}

export type RemovableHarness = RemovableResource;

/**
 * Intent for removing an imperative-build orphan harness (one not managed by CloudFormation).
 * - `keep`: delete the AWS resource but keep the agentcore.json entry (it moves to GA — the
 *   next deploy recreates it under CloudFormation).
 * - `discard`: delete the AWS resource and remove the agentcore.json entry (no longer wanted).
 */
export type OrphanAction = 'keep' | 'discard';

export interface RemoveHarnessOptions {
  /** Explicit intent when the named harness is an orphan. Required to delete one (never auto-deletes). */
  orphanAction?: OrphanAction;
}

export class HarnessPrimitive extends BasePrimitive<AddHarnessOptions, RemovableHarness> {
  readonly kind = 'harness' as const;
  readonly label = 'Harness';
  readonly primitiveSchema = HarnessSpecSchema;

  async add(options: AddHarnessOptions): Promise<Result<{ harnessName: string }>> {
    try {
      const configBaseDir = options.configBaseDir ?? findConfigRoot();
      if (!configBaseDir) {
        return {
          success: false,
          error: new ResourceNotFoundError('No agentcore project found. Run `agentcore create` first.'),
        };
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
          return { success: false, error: new ResourceNotFoundError(`Dockerfile not found at: ${srcPath}`) };
        }
        const appDir = join(projectRoot, APP_DIR, options.name);
        await mkdir(appDir, { recursive: true });
        const destFilename = basename(srcPath);
        await copyFile(srcPath, join(appDir, destFilename));
        dockerfile = destFilename;
      }

      const tools: HarnessSpec['tools'] = [];
      if (options.selectedTools) {
        for (const toolType of options.selectedTools) {
          if (toolType === 'agentcore_browser') {
            tools.push({ type: 'agentcore_browser', name: 'browser' });
          } else if (toolType === 'agentcore_code_interpreter') {
            tools.push({ type: 'agentcore_code_interpreter', name: 'code-interpreter' });
          } else if (toolType === 'remote_mcp' && options.mcpName && options.mcpUrl) {
            tools.push({
              type: 'remote_mcp',
              name: options.mcpName,
              config: { remoteMcp: { url: options.mcpUrl } },
            });
          } else if (toolType === 'agentcore_gateway' && options.gatewayArn) {
            let outboundAuth: HarnessGatewayOutboundAuth | undefined;
            if (options.gatewayOutboundAuth === 'awsIam') {
              outboundAuth = { awsIam: {} };
            } else if (options.gatewayOutboundAuth === 'none') {
              outboundAuth = { none: {} };
            } else if (
              options.gatewayOutboundAuth === 'oauth' &&
              options.gatewayProviderArn &&
              options.gatewayScopes &&
              options.gatewayScopes.length > 0
            ) {
              outboundAuth = {
                oauth: {
                  providerArn: options.gatewayProviderArn,
                  scopes: options.gatewayScopes,
                },
              };
            }
            tools.push({
              type: 'agentcore_gateway',
              name: 'gateway',
              config: {
                agentCoreGateway: {
                  gatewayArn: options.gatewayArn,
                  ...(outboundAuth && { outboundAuth }),
                },
              },
            });
          }
        }
      }

      const harnessSpec: HarnessSpec = {
        name: options.name,
        model: {
          provider: options.modelProvider,
          modelId: options.modelId,
          ...(options.apiFormat && { apiFormat: options.apiFormat }),
          ...(options.apiKeyArn && { apiKeyArn: options.apiKeyArn }),
          ...(options.apiBase && { apiBase: options.apiBase }),
          ...(options.additionalParams && { additionalParams: options.additionalParams }),
        },
        tools,
        skills: (options.skills ?? []).map(s => {
          if (s.s3Uri) return { s3Uri: s.s3Uri };
          if (s.gitUrl)
            return {
              gitUrl: s.gitUrl,
              ...(s.gitPath && { path: s.gitPath }),
              ...(s.credentialName && {
                auth: { credentialName: s.credentialName, ...(s.username && { username: s.username }) },
              }),
            };
          return { path: s.path! };
        }),
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
        ...(options.sessionStoragePath && { sessionStoragePath: options.sessionStoragePath }),
        ...(options.efsAccessPoints?.length && { efsAccessPoints: options.efsAccessPoints }),
        ...(options.s3AccessPoints?.length && { s3AccessPoints: options.s3AccessPoints }),
        ...(options.authorizerType && { authorizerType: options.authorizerType }),
        ...(options.authorizerType === 'CUSTOM_JWT' && options.jwtConfig
          ? { authorizerConfiguration: buildAuthorizerConfigFromJwtConfig(options.jwtConfig) }
          : {}),
      };

      await configIO.writeHarnessSpec(options.name, harnessSpec);

      const pathResolver = configIO.getPathResolver();
      const harnessDir = pathResolver.getHarnessDir(options.name);
      const systemPromptPath = join(harnessDir, 'system-prompt.md');
      const systemPromptContent = options.systemPrompt ?? 'You are a helpful assistant';
      await writeFile(systemPromptPath, systemPromptContent, 'utf-8');

      if (options.withInvokeScript) {
        const templatePath = getTemplatePath('harness', 'invoke.py.template');
        const invokeScriptPath = join(harnessDir, 'invoke.py');
        let template = await readFile(templatePath, 'utf-8');
        template = template.replace('{{HARNESS_ARN}}', '<your-harness-arn>');
        template = template.replace('{{REGION}}', '<your-region>');
        await writeFile(invokeScriptPath, template, 'utf-8');
      }

      if (memoryName) {
        const strategyTypes: MemoryStrategyType[] = ['SEMANTIC', 'USER_PREFERENCE', 'SUMMARIZATION', 'EPISODIC'];
        const strategies: MemoryStrategy[] = strategyTypes.map(type => ({
          type,
          ...(DEFAULT_STRATEGY_NAMESPACES[type] && { namespaces: DEFAULT_STRATEGY_NAMESPACES[type] }),
          ...(type === 'EPISODIC' && { reflectionNamespaces: DEFAULT_EPISODIC_REFLECTION_NAMESPACES }),
        }));

        project.memories.push({
          name: memoryName,
          eventExpiryDuration: DEFAULT_MEMORY_EXPIRY_DAYS,
          strategies,
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

      if (options.jwtConfig?.clientId && options.jwtConfig?.clientSecret) {
        await createManagedOAuthCredential(
          options.name,
          options.jwtConfig,
          spec => this.writeProjectSpec(spec, configIO),
          () => this.readProjectSpec(configIO)
        );
      }

      return { success: true, harnessName: options.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(harnessName: string, opts?: RemoveHarnessOptions): Promise<Result> {
    try {
      const configRoot = findConfigRoot();
      if (!configRoot) {
        return { success: false, error: new ResourceNotFoundError('No agentcore project found.') };
      }

      const configIO = new ConfigIO({ baseDir: configRoot });
      const project = await this.readProjectSpec(configIO);
      const deployedState = await configIO.readDeployedState().catch(() => undefined);

      // An orphan is an imperative-build harness recorded in deployed-state but not managed by
      // CloudFormation (no `provisioner: 'cloudformation'` marker). CFN can't delete it, so it
      // keeps billing and would 409 a same-named CFN deploy. It must be deleted directly from
      // AWS — but only with the user's explicit intent (never auto-delete).
      const orphans = findOrphanHarnesses(deployedState, harnessName);
      if (orphans.length > 0) {
        return this.removeOrphan(harnessName, orphans, opts?.orphanAction, configIO, project);
      }

      const inSpec = (project.harnesses ?? []).some(h => h.name === harnessName);
      if (!inSpec) {
        return { success: false, error: new ResourceNotFoundError(`Harness "${harnessName}" not found.`) };
      }

      // CDK-managed harness: drop it from the project spec. The harness is part of the
      // CloudFormation stack, so the next deploy removes the AWS::BedrockAgentCore::Harness.
      await this.removeFromSpec(harnessName, configIO, project);
      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  /**
   * Delete an imperative-build orphan harness directly from AWS, then reconcile local state
   * per the user's chosen intent. Never auto-deletes: an unspecified action returns an
   * actionable error rather than guessing.
   */
  private async removeOrphan(
    harnessName: string,
    orphans: OrphanHarness[],
    action: OrphanAction | undefined,
    configIO: ConfigIO,
    project: AgentCoreProjectSpec
  ): Promise<Result> {
    if (!action) {
      return {
        success: false,
        error: new ValidationError(
          `No changes were made — "${harnessName}" was not deleted. It was created by the preview ` +
            `build and is not managed by CloudFormation, so CloudFormation cannot delete it. Removing ` +
            `it deletes the resource directly from your AWS account. Re-run with an explicit choice:\n` +
            `  --keep     delete it from AWS but keep it in agentcore.json (it moves to GA; the ` +
            `next \`agentcore deploy\` recreates it under CloudFormation)\n` +
            `  --discard  delete it from AWS and remove it from agentcore.json (you no longer want it)`
        ),
      };
    }

    // Delete each recorded orphan resource using its recorded id + ARN-derived region — never
    // re-resolve by name. A 404/NotFound means it's already gone, which is success for our
    // purposes; any other error aborts so local state still points at the live resource for a
    // retry.
    for (const orphan of orphans) {
      try {
        await deleteHarness({ region: orphan.region, harnessId: orphan.harnessId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/404|NotFound|ResourceNotFound|does not exist/i.test(msg)) {
          return {
            success: false,
            error: toError(
              `Failed to delete orphan harness "${harnessName}" (${orphan.harnessId}) in ${orphan.region}: ${msg}. ` +
                `Local state was left unchanged — resolve the error and retry.`
            ),
          };
        }
      }
    }

    // Drop the orphan records from deployed-state so the harness is no longer flagged.
    const deployedState = await configIO.readDeployedState().catch(() => undefined);
    if (deployedState) {
      for (const orphan of orphans) {
        const harnesses = deployedState.targets?.[orphan.targetName]?.resources?.harnesses;
        if (harnesses) delete harnesses[orphan.name];
      }
      await configIO.writeDeployedState(deployedState);
    }

    // delete-and-discard also removes the spec entry, its memory, and its directory.
    // delete-and-keep leaves the spec entry so the next deploy recreates it under CloudFormation.
    if (action === 'discard' && (project.harnesses ?? []).some(h => h.name === harnessName)) {
      await this.removeFromSpec(harnessName, configIO, project);
    }

    return { success: true };
  }

  /**
   * Remove a harness from the project spec: drop its entry, its convention-named memory
   * (`<name>Memory`), persist agentcore.json, and delete its on-disk directory.
   */
  private async removeFromSpec(harnessName: string, configIO: ConfigIO, project: AgentCoreProjectSpec): Promise<void> {
    project.harnesses = (project.harnesses ?? []).filter(h => h.name !== harnessName);

    const associatedMemoryName = `${harnessName}Memory`;
    if (project.memories) {
      project.memories = project.memories.filter(m => m.name !== associatedMemoryName);
    }

    await this.writeProjectSpec(project, configIO);

    const pathResolver = configIO.getPathResolver();
    const harnessDir = pathResolver.getHarnessDir(harnessName);
    await rm(harnessDir, { recursive: true, force: true });
  }

  async previewRemove(harnessName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    const harnesses = project.harnesses ?? [];
    const harness = harnesses.find(h => h.name === harnessName);

    if (!harness) {
      throw new Error(`Harness "${harnessName}" not found.`);
    }

    const associatedMemoryName = `${harnessName}Memory`;
    const hasAssociatedMemory = (project.memories ?? []).some(m => m.name === associatedMemoryName);

    const summary: string[] = [`Removing harness: ${harnessName}`];
    if (hasAssociatedMemory) {
      summary.push(`Removing associated memory: ${associatedMemoryName}`);
    }
    const directoriesToDelete: string[] = [`app/${harnessName}`];
    const schemaChanges: SchemaChange[] = [];

    const afterSpec = {
      ...project,
      harnesses: harnesses.filter(h => h.name !== harnessName),
      ...(hasAssociatedMemory && { memories: (project.memories ?? []).filter(m => m.name !== associatedMemoryName) }),
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

  /**
   * Whether the named harness is an imperative-build orphan (recorded in deployed-state but
   * not managed by CloudFormation). Local check, no AWS calls. The TUI uses this to decide
   * whether to show the delete-and-keep / delete-and-discard choice instead of a plain confirm.
   */
  async isOrphan(harnessName: string): Promise<boolean> {
    try {
      const configRoot = findConfigRoot();
      if (!configRoot) return false;
      const configIO = new ConfigIO({ baseDir: configRoot });
      const deployedState = await configIO.readDeployedState().catch(() => undefined);
      return findOrphanHarnesses(deployedState, harnessName).length > 0;
    } catch {
      return false;
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('harness')
      .description('Add a harness to the project')
      .option('--name <name>', 'Harness name (start with letter, alphanumeric + underscores, max 48 chars)')
      .option('--model-provider <provider>', 'Model provider: bedrock, open_ai, gemini, lite_llm')
      .option('--model-id <id>', 'Model ID (e.g., anthropic.claude-3-5-sonnet-20240620-v1:0)')
      .option(
        '--api-format <format>',
        'API format: converse_stream, responses, chat_completions (bedrock); responses, chat_completions (open_ai)'
      )
      .option('--api-key-arn <arn>', 'API key ARN for non-Bedrock providers (optional for lite_llm)')
      .option('--api-base <url>', 'Base URL for the model provider API endpoint (lite_llm only)')
      .option(
        '--additional-params <json>',
        'Provider-specific params passed through unchanged, as a JSON object (lite_llm only)'
      )
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
      .option('--session-storage <path>', 'Mount path for persistent session storage (e.g., /mnt/data/)')
      .option('--with-invoke-script', 'Generate a standalone Python invoke script')
      .option(
        '--system-prompt <text>',
        'System prompt text (written to system-prompt.md; defaults to "You are a helpful assistant")'
      )
      .option(
        '--tools <tools>',
        'Comma-separated tools: agentcore_browser, agentcore_code_interpreter, remote_mcp, agentcore_gateway'
      )
      .option('--mcp-name <name>', 'Remote MCP tool name (required when --tools includes remote_mcp)')
      .option('--mcp-url <url>', 'Remote MCP endpoint URL (required when --tools includes remote_mcp)')
      .option('--gateway-arn <arn>', 'Gateway ARN (required when --tools includes agentcore_gateway)')
      .option(
        '--gateway-outbound-auth <type>',
        'Gateway outbound auth: awsIam, none, oauth (requires --gateway-provider-arn and --gateway-scopes)'
      )
      .option('--gateway-provider-arn <arn>', 'OAuth provider ARN for gateway outbound auth')
      .option('--gateway-scopes <scopes>', 'Comma-separated OAuth scopes for gateway outbound auth')
      .option('--authorizer-type <type>', 'Authorizer type: AWS_IAM or CUSTOM_JWT')
      .option('--discovery-url <url>', 'OIDC discovery URL (for CUSTOM_JWT)')
      .option('--allowed-audience <audiences>', 'Comma-separated allowed audiences (for CUSTOM_JWT)')
      .option('--allowed-clients <clients>', 'Comma-separated allowed client IDs (for CUSTOM_JWT)')
      .option('--allowed-scopes <scopes>', 'Comma-separated allowed scopes (for CUSTOM_JWT)')
      .option('--custom-claims <json>', 'Custom claims JSON array (for CUSTOM_JWT)')
      .option('--client-id <id>', 'OAuth client ID (for CUSTOM_JWT)')
      .option('--client-secret <secret>', 'OAuth client secret (for CUSTOM_JWT)')
      .option(
        '--private-endpoint-lattice-arn <id-or-arn>',
        'PrivateLink: VPC Lattice resource-config id/ARN to reach the OIDC discovery endpoint (for CUSTOM_JWT)'
      )
      .option(
        '--private-endpoint-vpc-id <vpc-id>',
        'PrivateLink: VPC id for a service-managed endpoint to the OIDC discovery endpoint (for CUSTOM_JWT)'
      )
      .option('--private-endpoint-subnets <ids>', 'PrivateLink: comma-separated subnet IDs (with --private-endpoint-vpc-id)')
      .option('--private-endpoint-ip-type <type>', 'PrivateLink: endpoint IP address type: IPV4 or IPV6 (with --private-endpoint-vpc-id)')
      .option(
        '--private-endpoint-security-groups <ids>',
        'PrivateLink: comma-separated security group IDs, max 5 (with --private-endpoint-vpc-id)'
      )
      .option('--private-endpoint-routing-domain <domain>', 'PrivateLink: routing domain (with --private-endpoint-vpc-id)')
      .option('--private-endpoint-tags <json>', 'PrivateLink: tags JSON object (with --private-endpoint-vpc-id)')
      .option(
        '--private-endpoint-overrides <json>',
        'PrivateLink: JSON array (max 5) of {domain, privateEndpoint} per-domain overrides (for CUSTOM_JWT)'
      )
      .option('--json', 'Output as JSON')
      .action(
        async (cliOptions: {
          name?: string;
          modelProvider?: string;
          modelId?: string;
          apiFormat?: string;
          apiKeyArn?: string;
          apiBase?: string;
          additionalParams?: string;
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
          sessionStorage?: string;
          withInvokeScript?: boolean;
          systemPrompt?: string;
          tools?: string;
          mcpName?: string;
          mcpUrl?: string;
          gatewayArn?: string;
          gatewayOutboundAuth?: string;
          gatewayProviderArn?: string;
          gatewayScopes?: string;
          authorizerType?: string;
          discoveryUrl?: string;
          allowedAudience?: string;
          allowedClients?: string;
          allowedScopes?: string;
          customClaims?: string;
          clientId?: string;
          clientSecret?: string;
          privateEndpointLatticeArn?: string;
          privateEndpointVpcId?: string;
          privateEndpointSubnets?: string;
          privateEndpointIpType?: string;
          privateEndpointSecurityGroups?: string;
          privateEndpointRoutingDomain?: string;
          privateEndpointTags?: string;
          privateEndpointOverrides?: string;
          json?: boolean;
        }) => {
          try {
            if (!findConfigRoot()) {
              console.error('No agentcore project found. Run `agentcore create` first.');
              process.exit(1);
            }

            // Validate auth options
            const { validateAddHarnessOptions } = await import('../commands/add/validate');
            const authValidation = validateAddHarnessOptions({
              ...cliOptions,
              authorizerType: cliOptions.authorizerType as RuntimeAuthorizerType | undefined,
            });
            if (!authValidation.valid) {
              if (cliOptions.json) {
                console.log(JSON.stringify({ success: false, error: authValidation.error }));
              } else {
                console.error(authValidation.error);
              }
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

              const { DEFAULT_BEDROCK_MANTLE_MODEL_ID, DEFAULT_MODEL_IDS } =
                await import('../tui/screens/harness/types');
              const provider = (cliOptions.modelProvider ?? 'bedrock') as HarnessModelProvider;
              const isBedrockMantle =
                provider === 'bedrock' &&
                (cliOptions.apiFormat === 'responses' || cliOptions.apiFormat === 'chat_completions');
              const modelId =
                cliOptions.modelId ?? (isBedrockMantle ? DEFAULT_BEDROCK_MANTLE_MODEL_ID : DEFAULT_MODEL_IDS[provider]);

              const containerOption = this.parseContainerFlag(cliOptions.container);

              let additionalParams: Record<string, unknown> | undefined;
              if (cliOptions.additionalParams) {
                try {
                  additionalParams = JSON.parse(cliOptions.additionalParams) as Record<string, unknown>;
                } catch {
                  if (cliOptions.json) {
                    console.log(JSON.stringify({ success: false, error: ADDITIONAL_PARAMS_JSON_ERROR }));
                  } else {
                    console.error(ADDITIONAL_PARAMS_JSON_ERROR);
                  }
                  process.exit(1);
                }
              }

              const result = await this.add({
                name: cliOptions.name,
                modelProvider: provider,
                modelId,
                apiFormat: cliOptions.apiFormat as HarnessApiFormat | undefined,
                apiKeyArn: cliOptions.apiKeyArn,
                apiBase: cliOptions.apiBase,
                additionalParams,
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
                sessionStoragePath: cliOptions.sessionStorage,
                withInvokeScript: cliOptions.withInvokeScript,
                systemPrompt: cliOptions.systemPrompt,
                selectedTools: cliOptions.tools?.split(',').map(s => s.trim()),
                mcpName: cliOptions.mcpName,
                mcpUrl: cliOptions.mcpUrl,
                gatewayArn: cliOptions.gatewayArn,
                gatewayOutboundAuth: cliOptions.gatewayOutboundAuth as 'awsIam' | 'none' | 'oauth' | undefined,
                gatewayProviderArn: cliOptions.gatewayProviderArn,
                gatewayScopes: cliOptions.gatewayScopes?.split(',').map(s => s.trim()),
                authorizerType: cliOptions.authorizerType as RuntimeAuthorizerType | undefined,
                jwtConfig:
                  cliOptions.authorizerType === 'CUSTOM_JWT' && cliOptions.discoveryUrl
                    ? {
                        discoveryUrl: cliOptions.discoveryUrl,
                        allowedAudience: cliOptions.allowedAudience?.split(',').map(s => s.trim()),
                        allowedClients: cliOptions.allowedClients?.split(',').map(s => s.trim()),
                        allowedScopes: cliOptions.allowedScopes?.split(',').map(s => s.trim()),
                        customClaims: cliOptions.customClaims
                          ? (JSON.parse(cliOptions.customClaims) as JwtConfigOptions['customClaims'])
                          : undefined,
                        clientId: cliOptions.clientId,
                        clientSecret: cliOptions.clientSecret,
                        privateEndpoint: this.buildPrivateEndpointFromFlags(cliOptions),
                        privateEndpointOverrides: cliOptions.privateEndpointOverrides
                          ? (JSON.parse(cliOptions.privateEndpointOverrides) as JwtConfigOptions['privateEndpointOverrides'])
                          : undefined,
                      }
                    : undefined,
              });

              if (!result.success) {
                if (cliOptions.json) {
                  console.log(JSON.stringify(result));
                } else {
                  console.error(result.error);
                }
                process.exit(1);
              }

              if (cliOptions.json) {
                console.log(JSON.stringify(result));
              } else {
                console.log(`Added harness '${result.harnessName}'.`);
              }

              process.exit(0);
            } else {
              const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
                import('ink'),
                import('react'),
                import('../tui/screens/add/AddFlow'),
              ]);
              const { clear, unmount } = render(
                React.createElement(AddFlow, {
                  isInteractive: false,
                  initialResource: 'harness' as const,
                  onExit: () => {
                    clear();
                    unmount();
                    process.exit(0);
                  },
                })
              );
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

    this.registerHarnessRemoveSubcommand(removeCmd);
  }

  /**
   * Harness remove subcommand. Mirrors the shared base remove flow but adds the
   * `--keep` / `--discard` flags needed to express intent when removing an imperative-build
   * orphan harness (one not managed by CloudFormation — see {@link removeOrphan}). For a
   * normal CDK-managed harness these flags are ignored and behavior is identical to the base.
   */
  private registerHarnessRemoveSubcommand(removeCmd: Command): void {
    removeCmd
      .command(this.kind)
      .description(`Remove ${this.article} ${this.label.toLowerCase()} from the project`)
      .option('--name <name>', 'Name of resource to remove [non-interactive]')
      .option('-y, --yes', 'Skip confirmation prompt [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .option(
        '--keep',
        'For a preview-build orphan: delete it from AWS but keep it in agentcore.json (it moves to GA; the next deploy recreates it under CloudFormation)'
      )
      .option('--discard', 'For a preview-build orphan: delete it from AWS and remove it from agentcore.json')
      .action(
        async (cliOptions: { name?: string; yes?: boolean; json?: boolean; keep?: boolean; discard?: boolean }) => {
          try {
            if (!findConfigRoot()) {
              console.error('No agentcore project found. Run `agentcore create` first.');
              process.exit(1);
            }

            if (cliOptions.keep && cliOptions.discard) {
              const error = '--keep and --discard are mutually exclusive';
              console.log(JSON.stringify({ success: false, error }));
              process.exit(1);
            }
            const orphanAction: OrphanAction | undefined = cliOptions.keep
              ? 'keep'
              : cliOptions.discard
                ? 'discard'
                : undefined;

            // Any flag triggers non-interactive CLI mode
            if (cliOptions.name || cliOptions.yes || cliOptions.json || orphanAction) {
              if (!cliOptions.name) {
                console.log(JSON.stringify({ success: false, error: '--name is required' }));
                process.exit(1);
              }

              const result = await withCommandRunTelemetry<SubCommand<'remove', typeof this.kind>, Result>(
                `remove.${this.kind}`,
                {},
                () => this.remove(cliOptions.name!, { orphanAction })
              );
              // The orphan no-flag refusal made no changes — surface it as a clean human error on
              // stderr (with a non-zero exit) rather than a JSON blob, so a user who expected a
              // deletion plainly sees that nothing happened and what to do. Scoped to that exact
              // case (orphan + no --keep/--discard, non-JSON); every other path keeps the
              // machine-readable JSON convention untouched.
              if (!result.success && !orphanAction && !cliOptions.json && (await this.isOrphan(cliOptions.name))) {
                console.error(`Error: ${result.error.message}`);
                process.exit(1);
              }
              console.log(
                JSON.stringify({
                  success: result.success,
                  resourceType: this.kind,
                  resourceName: cliOptions.name,
                  message: result.success ? `Removed ${this.label.toLowerCase()} '${cliOptions.name}'` : undefined,
                  note: result.success ? SOURCE_CODE_NOTE : undefined,
                  error: !result.success ? result.error.message : undefined,
                })
              );
              process.exit(result.success ? 0 : 1);
            } else {
              // TUI fallback — dynamic imports to avoid pulling ink (async) into registry
              requireTTY();
              const [{ render }, { default: React }, { RemoveFlow }] = await Promise.all([
                import('ink'),
                import('react'),
                import('../tui/screens/remove'),
              ]);
              const { clear, unmount } = render(
                React.createElement(RemoveFlow, {
                  isInteractive: false,
                  force: cliOptions.yes,
                  initialResourceType: this.kind,
                  initialResourceName: cliOptions.name,
                  onExit: () => {
                    clear();
                    unmount();
                    process.exit(0);
                  },
                })
              );
            }
          } catch (error) {
            if (cliOptions.json) {
              console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
            } else {
              console.error(`Error: ${getErrorMessage(error)}`);
            }
            process.exit(1);
          }
        }
      );
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

  /**
   * Build the PrivateLink `privateEndpoint` (PrivateLink inbound) from CLI flags. Returns the
   * self-managed-lattice arm when --private-endpoint-lattice-arn is set, the managed-vpc arm when
   * --private-endpoint-vpc-id is set, or undefined when neither. The schema enforces exactly-one-of
   * downstream; this just shapes whichever the user provided.
   */
  private buildPrivateEndpointFromFlags(options: {
    privateEndpointLatticeArn?: string;
    privateEndpointVpcId?: string;
    privateEndpointSubnets?: string;
    privateEndpointIpType?: string;
    privateEndpointSecurityGroups?: string;
    privateEndpointRoutingDomain?: string;
    privateEndpointTags?: string;
  }): PrivateEndpoint | undefined {
    if (options.privateEndpointLatticeArn) {
      return { selfManagedLatticeResource: { resourceConfigurationIdentifier: options.privateEndpointLatticeArn } };
    }
    if (options.privateEndpointVpcId) {
      return {
        managedVpcResource: {
          vpcIdentifier: options.privateEndpointVpcId,
          subnetIds: options.privateEndpointSubnets?.split(',').map(s => s.trim()) ?? [],
          endpointIpAddressType: options.privateEndpointIpType as EndpointIpAddressType,
          ...(options.privateEndpointSecurityGroups && {
            securityGroupIds: options.privateEndpointSecurityGroups.split(',').map(s => s.trim()),
          }),
          ...(options.privateEndpointRoutingDomain && { routingDomain: options.privateEndpointRoutingDomain }),
          ...(options.privateEndpointTags && {
            tags: JSON.parse(options.privateEndpointTags) as Record<string, string>,
          }),
        },
      };
    }
    return undefined;
  }
}
