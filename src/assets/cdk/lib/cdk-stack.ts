import {
  AgentCoreApiKeyCredentialProvider,
  AgentCoreApplication,
  AgentCoreMcp,
  AgentCoreOauth2CredentialProvider,
  AgentCorePaymentManager,
  AgentCorePaymentConnector,
  type AgentCoreProjectSpec,
  type AgentCoreMcpSpec,
  type CustomJWTAuthorizerConfig,
  type HarnessDeploymentConfig,
} from '@aws/agentcore-cdk';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Harness deployment config: role-scoped fields (for IAM role + container build)
 * plus the full validated spec + its config directory so the L3 construct can
 * synthesize the AWS::BedrockAgentCore::Harness resource.
 */
export type HarnessConfig = HarnessDeploymentConfig;

export interface PaymentConnectorSpec {
  name: string;
  provider: 'CoinbaseCDP' | 'StripePrivy';
  /**
   * Name of the credential this connector authorizes with. Resolved to the ARN of
   * the provider this stack creates, so the connector depends on it rather than
   * on a provider that had to exist before synth.
   */
  credentialName: string;
}

/** A reference to a secret the customer already keeps in AWS Secrets Manager. */
interface CredentialSecretRef {
  secretId: string;
  jsonKey: string;
}

/**
 * The credential fields this stack reads off the project spec. The published
 * @aws/agentcore-cdk spec type can lag the CLI's own schema, so these are read
 * from a local shape the same way bin/cdk.ts reads not-yet-published fields.
 */
interface CredentialDeclaration {
  authorizerType:
    | 'ApiKeyCredentialProvider'
    | 'OAuthCredentialProvider'
    | 'PaymentCredentialProvider';
  name: string;
  /** API key credentials: external secret for the key itself. */
  secretRef?: CredentialSecretRef;
  /** OAuth credentials: external secret for the client secret. */
  clientSecretRef?: CredentialSecretRef;
  vendor?: string;
  clientId?: string;
  discoveryUrl?: string;
  providerConfig?: Record<string, unknown>;
}

export interface PaymentSpec {
  name: string;
  description?: string;
  authorizerType: 'AWS_IAM' | 'CUSTOM_JWT';
  authorizerConfiguration?: { customJWTAuthorizer: CustomJWTAuthorizerConfig };
  autoPayment?: boolean;
  paymentToolAllowlist?: string[];
  networkPreferences?: string[];
  connectors: PaymentConnectorSpec[];
}

export interface AgentCoreStackProps extends StackProps {
  /**
   * The AgentCore project specification containing agents, memories, and credentials.
   */
  spec: AgentCoreProjectSpec;
  /**
   * The MCP specification containing gateways and servers.
   */
  mcpSpec?: AgentCoreMcpSpec;
  /**
   * Harness role configurations.
   */
  harnesses?: HarnessConfig[];
  /**
   * Parsed connectorParameters for non-S3 KB data sources, keyed by
   * connectorConfigFile path. Forwarded to AgentCoreApplication.
   */
  connectorParametersByFile?: Record<string, Record<string, unknown>>;
  /**
   * Payment specifications with resolved credential provider ARNs.
   */
  paymentSpec?: PaymentSpec[];
}

function toCdkId(name: string): string {
  return name.replace(/_/g, '');
}

/**
 * Decide whether a deployed runtime should receive payment env vars + IAM grants.
 * Payments today only ships a runtime shim for Python HTTP runtimes; injecting
 * AGENTCORE_PAYMENT_* env vars into TypeScript / MCP / A2A / AGUI runtimes
 * would surface env vars they cannot consume and would dilute least-privilege
 * IAM grants for runtimes that never call ProcessPayment.
 */
function isPaymentEligibleAgent(agent: { entrypoint?: string; protocol?: string }): boolean {
  if (agent.protocol && agent.protocol !== 'HTTP') {
    return false;
  }
  const entrypoint = typeof agent.entrypoint === 'string' ? agent.entrypoint : '';
  const entrypointFile = entrypoint.split(':')[0] ?? '';
  return entrypointFile.endsWith('.py');
}

/**
 * CDK Stack that deploys AgentCore infrastructure.
 *
 * This is a thin wrapper that instantiates L3 constructs.
 * All resource logic and outputs are contained within the L3 constructs.
 */
export class AgentCoreStack extends Stack {
  /** The AgentCore application containing all agent environments */
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    const { spec, mcpSpec, harnesses, connectorParametersByFile, paymentSpec } = props;

    // Create the credential providers the spec declares, before anything that
    // consumes them. CloudFormation owns their lifecycle; the ARNs below are
    // synth-time tokens, so no provider has to exist before this stack deploys.
    const credentials = this.createCredentialProviders(spec);

    // Create AgentCoreApplication with all agents and harness roles
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appProps: Record<string, unknown> = { spec };
    if (harnesses?.length) {
      appProps.harnesses = harnesses;
    }
    if (connectorParametersByFile && Object.keys(connectorParametersByFile).length > 0) {
      appProps.connectorParametersByFile = connectorParametersByFile;
    }
    if (Object.keys(credentials).length > 0) {
      appProps.credentials = credentials;
    }
    this.application = new AgentCoreApplication(this, 'Application', appProps as any);

    // Create AgentCoreMcp if there are gateways configured
    if (mcpSpec?.agentCoreGateways && mcpSpec.agentCoreGateways.length > 0) {
      new AgentCoreMcp(this, 'Mcp', {
        projectName: spec.name,
        mcpSpec,
        agentCoreApplication: this.application,
        credentials,
        projectTags: spec.tags,
      });
    }

    // Create payment infrastructure via CFN constructs
    if (paymentSpec && paymentSpec.length > 0) {
      for (const payment of paymentSpec) {
        const mgrId = toCdkId(payment.name);
        const manager = new AgentCorePaymentManager(this, `Payment${mgrId}`, {
          projectName: spec.name,
          name: payment.name,
          authorizerType: payment.authorizerType,
          description: payment.description,
          authorizerConfiguration: payment.authorizerConfiguration,
          tags: spec.tags,
        });

        const prefix = `AGENTCORE_PAYMENT_${payment.name.toUpperCase().replace(/-/g, '_')}`;

        // Wire env vars from construct output tokens into eligible agent environments only.
        // See isPaymentEligibleAgent — non-Python or non-HTTP runtimes have no shim that
        // can consume these env vars, and giving them sts:AssumeRole on the
        // ProcessPaymentRole would broaden the privilege surface unnecessarily.
        for (const env of this.application.environments.values()) {
          if (!isPaymentEligibleAgent(env.agent)) {
            continue;
          }
          env.runtime.addEnvironmentVariable(`${prefix}_MANAGER_ARN`, manager.paymentManagerArn);
          env.runtime.addEnvironmentVariable(`${prefix}_PROCESS_PAYMENT_ROLE_ARN`, manager.processPaymentRoleArn);

          // Grant runtime execution role permission to assume the ProcessPaymentRole.
          // The ProcessPaymentRole's trust policy allows AccountRootPrincipal, but the
          // caller still needs sts:AssumeRole on its own role to perform the assumption.
          env.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: ['sts:AssumeRole'],
              resources: [manager.processPaymentRoleArn],
            })
          );

          // Grant payment data-plane actions directly to the runtime role.
          //
          // NOTE: This deviates from the canonical role model in the AgentCore Payments
          // beta guide, which assigns Get/List/Create instrument+session actions to a
          // separate ManagementRole and limits the agent's role to ProcessPayment only.
          // The current SDK plugin (AgentCorePaymentsPlugin.generate_payment_header)
          // calls GetPaymentInstrument internally during the 402 auto-pay path, so the
          // runtime role needs read access. CreatePaymentSession is included so
          // `agentcore invoke --auto-session` works without a separate ManagementRole
          // call. Tighten this if the SDK is updated to accept pre-fetched instrument
          // details and split create-session into a backend-only flow.
          env.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: [
                'bedrock-agentcore:GetPaymentInstrument',
                'bedrock-agentcore:ListPaymentInstruments',
                'bedrock-agentcore:GetPaymentInstrumentBalance',
                'bedrock-agentcore:GetPaymentSession',
                'bedrock-agentcore:ListPaymentSessions',
                'bedrock-agentcore:CreatePaymentSession',
                'bedrock-agentcore:ProcessPayment',
              ],
              resources: [manager.paymentManagerArn, `${manager.paymentManagerArn}/*`],
            })
          );

          if (payment.autoPayment !== undefined) {
            env.runtime.addEnvironmentVariable(`${prefix}_AUTO_PAYMENT`, String(payment.autoPayment));
          }
          if (payment.paymentToolAllowlist) {
            env.runtime.addEnvironmentVariable(`${prefix}_TOOL_ALLOWLIST`, payment.paymentToolAllowlist.join(','));
          }
          if (payment.networkPreferences) {
            env.runtime.addEnvironmentVariable(`${prefix}_NETWORK_PREFERENCES`, payment.networkPreferences.join(','));
          }
          if (payment.authorizerType === 'CUSTOM_JWT') {
            env.runtime.addEnvironmentVariable(`${prefix}_AUTH_MODE`, 'bearer');
          }
        }

        // Create connectors for this manager
        for (const connector of payment.connectors) {
          const connId = toCdkId(connector.name);
          const credential = credentials[connector.credentialName];
          if (!credential) {
            // The spec cross-validates that this name is a declared credential,
            // so reaching here means the credential exists but no provider was
            // created for it — today only a PaymentCredentialProvider, which
            // CloudFormation cannot create.
            throw new Error(
              `Payment connector "${connector.name}" on manager "${payment.name}" references ` +
                `credential "${connector.credentialName}", which this stack cannot create a ` +
                `credential provider for. CloudFormation has no payment credential provider ` +
                `resource; remove the connector to deploy the rest of the project.`
            );
          }
          const conn = new AgentCorePaymentConnector(this, `Payment${mgrId}${connId}`, {
            projectName: spec.name,
            paymentManager: manager,
            connectorName: connector.name,
            connectorType: connector.provider,
            credentialProviderArn: credential.credentialProviderArn,
          });

          // Wire first connector's ID as env var (eligible agents only)
          if (connector === payment.connectors[0]) {
            for (const env of this.application.environments.values()) {
              if (!isPaymentEligibleAgent(env.agent)) continue;
              env.runtime.addEnvironmentVariable(`${prefix}_CONNECTOR_ID`, conn.paymentConnectorId);
            }
          }

          new CfnOutput(this, `Payment${mgrId}${connId}ConnectorId`, {
            value: conn.paymentConnectorId,
          });
        }

        // CFN Outputs for post-deploy state parsing
        new CfnOutput(this, `Payment${mgrId}ManagerArn`, {
          value: manager.paymentManagerArn,
        });
        new CfnOutput(this, `Payment${mgrId}ManagerId`, {
          value: manager.paymentManagerId,
        });
        new CfnOutput(this, `Payment${mgrId}ProcessPaymentRoleArn`, {
          value: manager.processPaymentRoleArn,
        });
        new CfnOutput(this, `Payment${mgrId}ResourceRetrievalRoleArn`, {
          value: manager.resourceRetrievalRoleArn,
        });
      }
    }

    // Stack-level output
    new CfnOutput(this, 'StackNameOutput', {
      description: 'Name of the CloudFormation Stack',
      value: this.stackName,
    });
  }

  /**
   * Creates a credential provider for every credential the spec declares, and
   * returns their ARNs keyed by credential name for the constructs that consume
   * them.
   *
   * Real secret material never reaches the template. A credential carrying an
   * external Secrets Manager reference deploys pointing at that secret; one whose
   * secret lives in `.env.local` is created with the L3's placeholder, which
   * `agentcore project deploy` replaces over the Identity API once the stack is
   * up. Payment credentials get no provider — CloudFormation has no resource for
   * them — so they are absent from the map and any connector naming one fails.
   */
  private createCredentialProviders(
    spec: AgentCoreProjectSpec
  ): Record<string, { credentialProviderArn: string }> {
    const declared = (spec.credentials ?? []) as CredentialDeclaration[];
    const created: Record<string, { credentialProviderArn: string }> = {};

    for (const credential of declared) {
      const id = `Credential${toCdkId(credential.name)}`;
      let credentialProviderArn: string;

      switch (credential.authorizerType) {
        case 'ApiKeyCredentialProvider':
          credentialProviderArn = new AgentCoreApiKeyCredentialProvider(this, id, {
            projectName: spec.name,
            name: credential.name,
            ...(credential.secretRef && { secretRef: credential.secretRef }),
            projectTags: spec.tags,
          }).credentialProviderArn;
          break;
        case 'OAuthCredentialProvider':
          credentialProviderArn = new AgentCoreOauth2CredentialProvider(this, id, {
            projectName: spec.name,
            name: credential.name,
            vendor: credential.vendor ?? 'CustomOauth2',
            ...(credential.clientId !== undefined && { clientId: credential.clientId }),
            ...(credential.discoveryUrl !== undefined && { discoveryUrl: credential.discoveryUrl }),
            ...(credential.providerConfig && { providerConfig: credential.providerConfig }),
            // The spec names the OAuth external reference clientSecretRef; the
            // construct takes one secretRef whichever credential kind it is on.
            ...(credential.clientSecretRef && { secretRef: credential.clientSecretRef }),
            projectTags: spec.tags,
          }).credentialProviderArn;
          break;
        case 'PaymentCredentialProvider':
          // Deliberately left out of the map rather than thrown on here: a
          // payment credential with no connector referencing it is inert, and
          // `agentcore project deploy` rejects the project before synth anyway.
          continue;
      }

      created[credential.name] = { credentialProviderArn };
    }

    return created;
  }
}
