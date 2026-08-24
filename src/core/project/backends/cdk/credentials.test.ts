import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Oauth2ProviderConfigInput } from "@aws-sdk/client-bedrock-agentcore-control";
import type { Project, ProjectEvent } from "../../../../handlers/project/types";
import { ProjectSpecSchema } from "../../../../projectSchemas/project";
import { ENV_LOCAL_RELATIVE_PATH } from "../../envLocal";
import {
  assertCredentialsDeployable,
  createCredentialSynchronizer,
  type IdentitySecretClientFactory,
} from "./credentials";
import type { CdkCredentialProvider } from "./toolkit";

const REGION = "us-east-1";
const SECRET_REF = { secretId: "arn:aws:secretsmanager:us-east-1:1:secret:s", jsonKey: "key" };
const DISCOVERY_URL = "https://idp.example.com/.well-known/openid-configuration";

const credentials: CdkCredentialProvider = async () => ({
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
});

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A project declaring `declared`, with `env` written to its `.env.local`. */
async function project(declared: unknown[], env: Record<string, string> = {}): Promise<Project> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentcore-credentials-"));
  tempDirectories.push(rootPath);
  const entries = Object.entries(env);
  if (entries.length > 0) {
    await mkdir(join(rootPath, "agentcore"), { recursive: true });
    await writeFile(
      join(rootPath, ENV_LOCAL_RELATIVE_PATH),
      entries.map(([key, value]) => `${key}=${value}`).join("\n"),
    );
  }
  return {
    name: "example",
    rootPath,
    spec: ProjectSpecSchema.parse({ name: "example", version: 1, credentials: declared }),
  };
}

function apiKey(name: string, overrides: Record<string, unknown> = {}) {
  return { authorizerType: "ApiKeyCredentialProvider", name, ...overrides };
}

function oauth(name: string, overrides: Record<string, unknown> = {}) {
  return {
    authorizerType: "OAuthCredentialProvider",
    name,
    discoveryUrl: DISCOVERY_URL,
    ...overrides,
  };
}

function recorder() {
  const apiKeys: { name: string; apiKey: string }[] = [];
  const oauth2: { name: string; vendor: string; config: Oauth2ProviderConfigInput }[] = [];
  const clients: { region: string; credentials: CdkCredentialProvider }[] = [];

  const factory: IdentitySecretClientFactory = async (region, provider) => {
    clients.push({ region, credentials: provider });
    return {
      async setApiKey(name, key) {
        apiKeys.push({ name, apiKey: key });
      },
      async setOauth2ClientSecret(name, vendor, config) {
        oauth2.push({ name, vendor, config });
      },
    };
  };

  return { apiKeys, clients, factory, oauth2 };
}

async function sync(input: Project, factory: IdentitySecretClientFactory): Promise<ProjectEvent[]> {
  const events: ProjectEvent[] = [];
  for await (const event of createCredentialSynchronizer(factory)(input, {
    region: REGION,
    credentials,
  })) {
    events.push(event);
  }
  return events;
}

describe("assertCredentialsDeployable", () => {
  test("accepts a project that declares no credentials", async () => {
    expect(await assertCredentialsDeployable(await project([]))).toBeUndefined();
  });

  test("rejects a payment credential, naming the missing CloudFormation resource", async () => {
    const input = await project([
      { authorizerType: "PaymentCredentialProvider", name: "pay-1", provider: "CoinbaseCDP" },
    ]);

    await expect(assertCredentialsDeployable(input)).rejects.toThrow(
      /CloudFormation has no payment credential provider resource/,
    );
  });

  test.each([
    ["ready", { AGENTCORE_CREDENTIAL_OPENAI_KEY: "sk-live" }],
    ["itself missing a secret", {}],
  ])(
    "blames the payment credential when the project's other credential is %s",
    async (_label, env) => {
      const input = await project(
        [
          apiKey("openai-key"),
          { authorizerType: "PaymentCredentialProvider", name: "pay-1", provider: "CoinbaseCDP" },
        ],
        env,
      );

      // The unsupported credential is the reason this project cannot deploy, so
      // it is what the error names either way — not whichever one comes first.
      await expect(assertCredentialsDeployable(input)).rejects.toThrow(/PaymentCredentialProvider/);
    },
  );

  test("names the variable and the file when an API key has no secret", async () => {
    const input = await project([apiKey("openai-key")]);

    await expect(assertCredentialsDeployable(input)).rejects.toThrow(
      new RegExp(
        `Set AGENTCORE_CREDENTIAL_OPENAI_KEY in ${join(input.rootPath, ENV_LOCAL_RELATIVE_PATH)}`,
      ),
    );
  });

  test("names the client-secret variable when an OAuth credential has no secret", async () => {
    const input = await project([oauth("my-idp")]);

    await expect(assertCredentialsDeployable(input)).rejects.toThrow(
      /Set AGENTCORE_CREDENTIAL_MY_IDP_CLIENT_SECRET in .*clientSecretRef/s,
    );
  });

  test("accepts credentials whose secrets are in .env.local", async () => {
    const input = await project([apiKey("openai-key"), oauth("my-idp")], {
      AGENTCORE_CREDENTIAL_OPENAI_KEY: "sk-live",
      AGENTCORE_CREDENTIAL_MY_IDP_CLIENT_SECRET: "shhh",
    });

    expect(await assertCredentialsDeployable(input)).toBeUndefined();
  });

  test.each([
    ["an API key", apiKey("openai-key", { secretRef: SECRET_REF })],
    ["an OAuth credential", oauth("my-idp", { clientSecretRef: SECRET_REF })],
  ])(
    "accepts %s pointing at Secrets Manager with no .env.local at all",
    async (_label, declared) => {
      expect(await assertCredentialsDeployable(await project([declared]))).toBeUndefined();
    },
  );
});

describe("createCredentialSynchronizer", () => {
  test("builds no client for a project that declares no credentials", async () => {
    const client = recorder();

    expect(await sync(await project([]), client.factory)).toEqual([]);
    expect(client.clients).toEqual([]);
  });

  test("sets an API key read from .env.local", async () => {
    const client = recorder();
    const input = await project([apiKey("openai-key")], {
      AGENTCORE_CREDENTIAL_OPENAI_KEY: "sk-live",
    });

    expect(await sync(input, client.factory)).toEqual([
      { message: "Setting the secret for credential provider 'openai-key'" },
    ]);
    expect(client.apiKeys).toEqual([{ name: "openai-key", apiKey: "sk-live" }]);
    expect(client.clients).toEqual([{ region: REGION, credentials }]);
  });

  test.each([
    ["an API key", apiKey("openai-key", { secretRef: SECRET_REF })],
    ["an OAuth credential", oauth("my-idp", { clientSecretRef: SECRET_REF })],
  ])(
    "leaves %s pointing at Secrets Manager alone, building no client",
    async (_label, declared) => {
      const client = recorder();

      expect(await sync(await project([declared]), client.factory)).toEqual([]);
      expect(client.clients).toEqual([]);
      expect(client.apiKeys).toEqual([]);
      expect(client.oauth2).toEqual([]);
    },
  );

  test("rebuilds a guided OAuth config around the secret, without forwarding scopes", async () => {
    const client = recorder();
    const input = await project(
      [oauth("my-idp", { clientId: "client-1", scopes: ["read", "write"] })],
      { AGENTCORE_CREDENTIAL_MY_IDP_CLIENT_SECRET: "shhh" },
    );

    await sync(input, client.factory);

    expect(client.oauth2).toEqual([
      {
        name: "my-idp",
        vendor: "CustomOauth2",
        config: {
          customOauth2ProviderConfig: {
            oauthDiscovery: { discoveryUrl: DISCOVERY_URL },
            clientId: "client-1",
            clientSecret: "shhh",
          },
        },
      },
    ]);
  });

  test("injects the secret into a spec-supplied vendor config", async () => {
    const client = recorder();
    const input = await project(
      [
        {
          authorizerType: "OAuthCredentialProvider",
          name: "github",
          vendor: "GithubOauth2",
          providerConfig: { githubOauth2ProviderConfig: { clientId: "gh-client" } },
        },
      ],
      { AGENTCORE_CREDENTIAL_GITHUB_CLIENT_SECRET: "gh-secret" },
    );

    await sync(input, client.factory);

    expect(client.oauth2).toEqual([
      {
        name: "github",
        vendor: "GithubOauth2",
        config: {
          githubOauth2ProviderConfig: { clientId: "gh-client", clientSecret: "gh-secret" },
        },
      },
    ]);
  });

  test("rejects a providerConfig that is not exactly one vendor config", async () => {
    const client = recorder();
    const input = await project(
      [
        {
          authorizerType: "OAuthCredentialProvider",
          name: "github",
          vendor: "GithubOauth2",
          providerConfig: { githubOauth2ProviderConfig: {}, googleOauth2ProviderConfig: {} },
        },
      ],
      { AGENTCORE_CREDENTIAL_GITHUB_CLIENT_SECRET: "gh-secret" },
    );

    await expect(sync(input, client.factory)).rejects.toThrow(
      /providerConfig with 2 entries; it must hold exactly one vendor config/,
    );
  });

  test("syncs every credential that needs it, in the order the spec declares them", async () => {
    const client = recorder();
    const input = await project(
      [apiKey("first"), apiKey("with-ref", { secretRef: SECRET_REF }), oauth("last")],
      {
        AGENTCORE_CREDENTIAL_FIRST: "key-1",
        AGENTCORE_CREDENTIAL_LAST_CLIENT_SECRET: "secret-2",
      },
    );

    expect(await sync(input, client.factory)).toEqual([
      { message: "Setting the secret for credential provider 'first'" },
      { message: "Setting the secret for credential provider 'last'" },
    ]);
    expect(client.apiKeys.map(({ name }) => name)).toEqual(["first"]);
    expect(client.oauth2.map(({ name }) => name)).toEqual(["last"]);
    // One client for the whole run, not one per credential.
    expect(client.clients).toHaveLength(1);
  });
});
