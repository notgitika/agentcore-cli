import { join } from "node:path";
import type { Oauth2ProviderConfigInput } from "@aws-sdk/client-bedrock-agentcore-control";
import { ProjectStateError } from "../../../../errors/errors";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import type { Credential, OAuthCredential } from "../../../../projectSchemas/credential";
import {
  CLIENT_SECRET_SUFFIX,
  credentialEnvVarName,
  ENV_LOCAL_RELATIVE_PATH,
  EnvLocalFile,
} from "../../envLocal";
import type { CdkCredentialProvider } from "./toolkit";

/**
 * The two Identity calls the deploy-time secret sync needs. Narrowed to the
 * update half of the API so tests can substitute a recorder without standing up
 * an SDK client, following the seam style of this directory's collaborators.
 */
export type IdentitySecretClient = {
  setApiKey(name: string, apiKey: string): Promise<void>;
  setOauth2ClientSecret(
    name: string,
    vendor: string,
    config: Oauth2ProviderConfigInput,
  ): Promise<void>;
};

export type IdentitySecretClientFactory = (
  region: string,
  credentials: CdkCredentialProvider,
) => Promise<IdentitySecretClient>;

export type CredentialPreflight = (project: Project) => Promise<void>;

export type CredentialSyncInput = {
  region: string;
  /** Credential provider shared with the rest of the deployment. */
  credentials: CdkCredentialProvider;
};

export type CredentialSynchronizer = (
  project: Project,
  input: CredentialSyncInput,
) => AsyncGenerator<ProjectEvent, void>;

/**
 * Refuses a project whose declared credentials cannot be deployed, before any
 * template is synthesized.
 *
 * CloudFormation owns the credential providers, but it cannot own an API key or
 * client secret that only exists in `.env.local` — the stack is created with a
 * placeholder and {@link createCredentialSynchronizer} replaces it once the
 * deploy succeeds. That sync has no secret to push if the variable `add` told
 * the user to set is missing, and by then the provider is already live holding
 * the placeholder. Checking here instead means a missing secret costs nothing:
 * no synth, no bootstrap, no stack.
 */
export const assertCredentialsDeployable: CredentialPreflight = async (project) => {
  const declared = project.spec.credentials;
  if (declared.length === 0) return;

  // Rejected first so a project carrying one fails the same way whether or not
  // its other credentials have their secrets.
  const payment = declared.find(
    (credential) => credential.authorizerType === "PaymentCredentialProvider",
  );
  if (payment) throw paymentUnsupported(payment.name);

  const env = await new EnvLocalFile(project.rootPath).read();
  for (const credential of declared) {
    const secret = resolveSecret(credential, env);
    if (secret.kind === "missing") {
      throw missingSecret(credential.name, secret.envKey, secret.refField, project.rootPath);
    }
  }
};

/**
 * Replaces the placeholder secret CloudFormation created each credential
 * provider with, for the credentials whose secret lives in `.env.local`.
 *
 * Runs after the deploy rather than before it because the providers do not exist
 * until CloudFormation makes them. Credentials pointing at a Secrets Manager
 * secret of the customer's own are skipped: those deploy as an `EXTERNAL` source
 * that already resolves to the real value.
 *
 * Every applicable provider is updated on every deploy. The placeholder cannot
 * be told apart from a real key by reading the provider back — `ApiKey` is a
 * write-only CloudFormation property and `GetApiKeyCredentialProvider` returns
 * only the secret's ARN — so there is nothing to compare against, and skipping
 * the update would leave a provider stuck on the placeholder.
 */
export function createCredentialSynchronizer(
  createClient: IdentitySecretClientFactory = createIdentitySecretClient,
): CredentialSynchronizer {
  return async function* syncCredentialSecrets(project, { region, credentials }) {
    const declared = project.spec.credentials;
    if (declared.length === 0) return;

    const env = await new EnvLocalFile(project.rootPath).read();
    const pending: { credential: Credential; secret: string }[] = [];
    for (const credential of declared) {
      const secret = resolveSecret(credential, env);
      // A missing secret is unreachable: the preflight refused the deploy.
      if (secret.kind === "inline") pending.push({ credential, secret: secret.value });
    }
    if (pending.length === 0) return;

    const client = await createClient(region, credentials);
    for (const { credential, secret } of pending) {
      yield { message: `Setting the secret for credential provider '${credential.name}'` };
      await setSecret(client, credential, secret);
    }
  };
}

/**
 * Builds an Identity client against the deployment target's own credentials. The
 * SDK is imported lazily so projects without credentials never pay for loading
 * it, matching how the CloudFormation and STS clients are built.
 */
export const createIdentitySecretClient: IdentitySecretClientFactory = async (
  region,
  credentials,
) => {
  const {
    BedrockAgentCoreControlClient,
    UpdateApiKeyCredentialProviderCommand,
    UpdateOauth2CredentialProviderCommand,
  } = await import("@aws-sdk/client-bedrock-agentcore-control");
  const client = new BedrockAgentCoreControlClient({ credentials, region });

  return {
    async setApiKey(name, apiKey) {
      await client.send(new UpdateApiKeyCredentialProviderCommand({ name, apiKey }));
    },
    async setOauth2ClientSecret(name, vendor, config) {
      await client.send(
        new UpdateOauth2CredentialProviderCommand({
          name,
          // The spec's vendor is free-form so a new service vendor works without
          // a CLI release; the service rejects values it does not know.
          credentialProviderVendor: vendor as never,
          oauth2ProviderConfigInput: config,
        }),
      );
    },
  };
};

async function setSecret(
  client: IdentitySecretClient,
  credential: Credential,
  secret: string,
): Promise<void> {
  switch (credential.authorizerType) {
    case "ApiKeyCredentialProvider":
      return client.setApiKey(credential.name, secret);
    case "OAuthCredentialProvider":
      // UpdateOauth2CredentialProvider replaces the whole provider config, so
      // the secret-free config from the spec is rebuilt with the secret in it.
      return client.setOauth2ClientSecret(
        credential.name,
        credential.vendor,
        oauth2ConfigWithSecret(credential, secret),
      );
    case "PaymentCredentialProvider":
      // Unreachable: the preflight refuses a project declaring one.
      throw paymentUnsupported(credential.name);
  }
}

/** Where a credential's secret material comes from, resolved once for both passes. */
type ResolvedSecret =
  /** A Secrets Manager secret the customer owns: CloudFormation resolves it. */
  | { kind: "external" }
  /** Read from `.env.local`, so the deploy-time sync has to push it. */
  | { kind: "inline"; value: string }
  | { kind: "missing"; envKey: string; refField: "secretRef" | "clientSecretRef" };

/**
 * The preflight and the sync must agree on which credentials need a secret
 * pushed and where it comes from, so both read it from here.
 */
function resolveSecret(credential: Credential, env: Record<string, string>): ResolvedSecret {
  switch (credential.authorizerType) {
    case "ApiKeyCredentialProvider": {
      if (credential.secretRef) return { kind: "external" };
      return fromEnv(env, credentialEnvVarName(credential.name), "secretRef");
    }
    case "OAuthCredentialProvider": {
      if (credential.clientSecretRef) return { kind: "external" };
      const envKey = credentialEnvVarName(credential.name, CLIENT_SECRET_SUFFIX);
      return fromEnv(env, envKey, "clientSecretRef");
    }
    case "PaymentCredentialProvider":
      // Unreachable: the preflight rejects payment credentials before this runs.
      throw paymentUnsupported(credential.name);
  }
}

function fromEnv(
  env: Record<string, string>,
  envKey: string,
  refField: "secretRef" | "clientSecretRef",
): ResolvedSecret {
  const value = env[envKey];
  return value ? { kind: "inline", value } : { kind: "missing", envKey, refField };
}

function oauth2ConfigWithSecret(
  credential: OAuthCredential,
  clientSecret: string,
): Oauth2ProviderConfigInput {
  return credential.providerConfig
    ? vendorConfigWithSecret(credential.name, credential.providerConfig, clientSecret)
    : guidedCustomConfig(credential, clientSecret);
}

/**
 * Injects the secret into a complete, spec-supplied vendor config. The spec
 * keeps provider configs secret-free, so the one vendor key it carries is the
 * only place the secret can go.
 */
function vendorConfigWithSecret(
  name: string,
  providerConfig: Record<string, unknown>,
  clientSecret: string,
): Oauth2ProviderConfigInput {
  const entries = Object.entries(providerConfig);
  const [configKey, vendorConfig] = entries[0] ?? [];
  if (
    entries.length !== 1 ||
    !configKey ||
    typeof vendorConfig !== "object" ||
    vendorConfig === null ||
    Array.isArray(vendorConfig)
  ) {
    throw new ProjectStateError(
      `Credential '${name}' has a providerConfig with ${entries.length} entries; it must hold ` +
        `exactly one vendor config object (for example { "customOauth2ProviderConfig": { ... } }).`,
    );
  }
  return { [configKey]: { ...vendorConfig, clientSecret } } as unknown as Oauth2ProviderConfigInput;
}

function guidedCustomConfig(
  credential: OAuthCredential,
  clientSecret: string,
): Oauth2ProviderConfigInput {
  // The spec's schema requires discoveryUrl for a guided credential; this guards
  // a spec written before that rule rather than a reachable state.
  if (!credential.discoveryUrl) {
    throw new ProjectStateError(
      `Credential '${credential.name}' needs either a discoveryUrl or a providerConfig ` +
        `to set its OAuth2 client secret.`,
    );
  }
  // `scopes` is deliberately not forwarded: the provider config has no scopes
  // field, and the spec's scopes are consumed where the credential is used.
  return {
    customOauth2ProviderConfig: {
      oauthDiscovery: { discoveryUrl: credential.discoveryUrl },
      ...(credential.clientId !== undefined && { clientId: credential.clientId }),
      clientSecret,
    },
  };
}

function missingSecret(
  name: string,
  envKey: string,
  refField: "secretRef" | "clientSecretRef",
  rootPath: string,
): ProjectStateError {
  return new ProjectStateError(
    `Credential '${name}' has no secret for 'agentcore project deploy' to set on its ` +
      `credential provider. Set ${envKey} in ${join(rootPath, ENV_LOCAL_RELATIVE_PATH)}, or give ` +
      `the credential a '${refField}' in agentcore.json pointing at a secret you keep in AWS ` +
      `Secrets Manager.`,
  );
}

function paymentUnsupported(name: string): ProjectStateError {
  return new ProjectStateError(
    `Credential '${name}' is a PaymentCredentialProvider, which 'agentcore project deploy' ` +
      `cannot create: CloudFormation has no payment credential provider resource, and a payment ` +
      `provider needs vendor configuration (API key, wallet and authorization secrets) that ` +
      `agentcore.json has no fields for. Remove the credential and any payment connector ` +
      `referencing it to deploy the rest of the project.`,
  );
}
