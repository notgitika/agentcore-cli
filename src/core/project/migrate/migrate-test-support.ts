import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProcessFailedError, type ProcessRunner } from "../../../io";
import type { CfnTemplate } from "./templates";

/** A deployed v0 project shaped like the live-tested F1 fixture, trimmed to one of each resource. */
export const F1_SPEC = {
  $schema: "https://schema.agentcore.aws.dev/v1/agentcore.json",
  name: "CompatA",
  version: 1,
  managedBy: "CDK",
  runtimes: [
    {
      name: "CompatAAgent",
      build: "CodeZip",
      entrypoint: "main.py",
      codeLocation: "app/CompatAAgent/",
      runtimeVersion: "PYTHON_3_14",
      networkMode: "PUBLIC",
      protocol: "HTTP",
    },
  ],
  memories: [
    {
      name: "CompatAAgentMemory",
      eventExpiryDuration: 30,
      strategies: [{ type: "SEMANTIC", namespaceTemplates: ["/users/{actorId}/facts"] }],
    },
  ],
  knowledgeBases: [],
  credentials: [
    { authorizerType: "ApiKeyCredentialProvider", name: "compatA-key" },
    {
      authorizerType: "OAuthCredentialProvider",
      name: "compatA-oauth",
      discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
      scopes: ["openid"],
      vendor: "CustomOauth2",
      usage: "outbound",
    },
  ],
  evaluators: [
    {
      name: "CompatAJudge",
      level: "TRACE",
      config: {
        llmAsAJudge: {
          model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
          instructions: "Context: {context}. Assistant turn: {assistant_turn}. Rate it.",
          ratingScale: { numerical: [{ value: 1, label: "Poor", definition: "Bad" }] },
        },
      },
    },
  ],
  onlineEvalConfigs: [
    {
      name: "CompatAOnline",
      agent: "CompatAAgent",
      evaluators: ["CompatAJudge"],
      samplingRate: 10,
    },
  ],
  agentCoreGateways: [
    {
      name: "CompatAGw",
      targets: [
        {
          name: "awsknowledge",
          targetType: "mcpServer",
          endpoint: "https://knowledge-mcp.global.api.aws",
        },
      ],
      authorizerType: "AWS_IAM",
      policyEngineConfiguration: { policyEngineName: "CompatAPE", mode: "LOG_ONLY" },
    },
  ],
  policyEngines: [
    {
      name: "CompatAPE",
      policies: [{ name: "CompatAPolicy", statement: "permit(principal, action, resource);" }],
    },
  ],
  configBundles: [
    {
      name: "CompatABundle",
      type: "ConfigurationBundle",
      components: { "{{runtime:CompatAAgent}}": { configuration: { systemPrompt: "Hi." } } },
    },
  ],
  abTests: [],
  harnesses: [{ name: "CompatAHarness", path: "app/CompatAHarness" }],
  datasets: [],
  capacityProviders: [],
  payments: [],
};

const ARN = "arn:aws:bedrock-agentcore:us-east-1:998846730471";

/** F1's deployed state as v0 0.31.1 recorded it after a deploy to `default`. */
export const F1_DEPLOYED_STATE = {
  targets: {
    default: {
      resources: {
        runtimes: {
          CompatAAgent: {
            runtimeId: "CompatA_CompatAAgent-5ITOUFEJg5",
            runtimeArn: `${ARN}:runtime/CompatA_CompatAAgent-5ITOUFEJg5`,
            roleArn: "arn:aws:iam::998846730471:role/r",
          },
        },
        memories: {
          CompatAAgentMemory: {
            memoryId: "CompatA_CompatAAgentMemory-ZnaBgH2oeH",
            memoryArn: `${ARN}:memory/CompatA_CompatAAgentMemory-ZnaBgH2oeH`,
          },
        },
        gateways: {
          CompatAGw: {
            gatewayId: "compata-compatagw-nmv1g37e5a",
            gatewayArn: `${ARN}:gateway/compata-compatagw-nmv1g37e5a`,
          },
        },
        credentials: {
          "compatA-key": {
            credentialProviderArn: `${ARN}:token-vault/default/apikeycredentialprovider/compatA-key`,
          },
          "compatA-oauth": {
            credentialProviderArn: `${ARN}:token-vault/default/oauth2credentialprovider/compatA-oauth`,
          },
        },
        evaluators: {
          CompatAJudge: {
            evaluatorId: "CompatA_CompatAJudge-e9RwOP3mWm",
            evaluatorArn: `${ARN}:evaluator/CompatA_CompatAJudge-e9RwOP3mWm`,
          },
        },
        onlineEvalConfigs: {
          CompatAOnline: {
            onlineEvaluationConfigId: "CompatA_CompatAOnline-rfslDjHfL1",
            onlineEvaluationConfigArn: `${ARN}:online-evaluation-config/CompatA_CompatAOnline-rfslDjHfL1`,
          },
        },
        configBundles: {
          CompatABundle: {
            bundleId: "CompatACompatABundle-40Z0rLD2Ri",
            bundleArn: `${ARN}:configuration-bundle/CompatACompatABundle-40Z0rLD2Ri`,
            versionId: "64dcd57f-bdaa-4493-834c-a813e53a0a9a",
          },
        },
        policyEngines: {
          CompatAPE: {
            policyEngineId: "CompatA_CompatAPE-xmuuz2hdnb",
            policyEngineArn: `${ARN}:policy-engine/CompatA_CompatAPE-xmuuz2hdnb`,
          },
        },
        policies: {
          "CompatAPE/CompatAPolicy": {
            policyId: "CompatAPolicy-mh6mcusj2j",
            policyArn: `${ARN}:policy-engine/CompatA_CompatAPE-xmuuz2hdnb/policy/CompatAPolicy-mh6mcusj2j`,
            engineName: "CompatAPE",
          },
        },
        harnesses: {
          CompatAHarness: {
            harnessId: "CompatA_CompatAHarness-frP175fqBI",
            harnessArn: `${ARN}:harness/CompatA_CompatAHarness-frP175fqBI`,
            roleArn: "arn:aws:iam::998846730471:role/CompatA_CompatAHarness",
            status: "READY",
            provisioner: "cloudformation",
          },
        },
        stackName: "AgentCore-CompatA-default",
      },
    },
  },
};

export const F1_HARNESS = {
  name: "CompatAHarness",
  model: { provider: "bedrock", modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" },
  tools: [],
  skills: [],
  memory: { mode: "disabled" },
};

export type V0ProjectFiles = {
  spec?: unknown;
  /** `null` leaves the file out. */
  deployedState?: unknown;
  targets?: unknown;
  /** The `@aws/agentcore-cdk` pin in agentcore/cdk/package.json; `null` leaves the file out. */
  cdkPin?: string | null;
  /** Extra files by project-relative path. */
  files?: Record<string, string>;
};

/** Writes a v0 project into a fresh temporary directory and returns its root. */
export async function writeV0Project(
  options: V0ProjectFiles = {},
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-migrate-test-"));
  const files: Record<string, string> = {
    "agentcore/agentcore.json": json(options.spec ?? F1_SPEC),
    "agentcore/aws-targets.json": json(
      options.targets ?? [{ name: "default", account: "998846730471", region: "us-east-1" }],
    ),
    "agentcore/.gitignore":
      ".env.local\ncdk/cdk.out/\ncdk/node_modules/\n.cli/*\n!.cli/deployed-state.json\n",
    "agentcore/cdk/bin/cdk.ts": "// v0 CDK app\n",
    "agentcore/cdk/jest.config.js": "module.exports = {};\n",
    "agentcore/cdk/node_modules/@aws/agentcore-cdk/index.js": "// dependency\n",
    "agentcore/cdk/cdk.out/manifest.json": "{}\n",
    "app/CompatAHarness/harness.json": json(F1_HARNESS),
    "app/CompatAHarness/system-prompt.md": "You are helpful.\n",
    "app/CompatAAgent/main.py": "print('hi')\n",
    ...options.files,
  };
  if (options.deployedState !== null) {
    files["agentcore/.cli/deployed-state.json"] = json(options.deployedState ?? F1_DEPLOYED_STATE);
  }
  if (options.cdkPin !== null) {
    files["agentcore/cdk/package.json"] = json({
      name: "agentcore-cdk-app",
      dependencies: { "@aws/agentcore-cdk": options.cdkPin ?? "0.1.0-alpha.54" },
    });
  }
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Commits everything in `root` to a new git repository, with a fixed identity. */
export function commitAll(root: string): void {
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: root, stdio: "ignore" },
    );
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "v0 project");
}

/** A process runner that answers git commands from a script instead of spawning git. */
export function fakeGit(responses: {
  /** git isn't installed: every command fails to spawn. */
  missing?: boolean;
  insideWorkTree?: boolean;
  /** agentcore/agentcore.json is tracked; defaults to true. */
  specTracked?: boolean;
  status?: string;
}): ProcessRunner {
  return async (command, options) => {
    if (responses.missing) {
      throw new ProcessFailedError(command, options.cwd, null, "Error: spawn git ENOENT");
    }
    const joined = command.join(" ");
    if (joined === "git rev-parse --is-inside-work-tree") {
      if (responses.insideWorkTree === false) {
        throw new ProcessFailedError(command, options.cwd, 128, "fatal: not a git repository");
      }
      options.onOutput?.("true\n");
      return;
    }
    if (joined === "git ls-files --error-unmatch agentcore/agentcore.json") {
      if (responses.specTracked === false) {
        throw new ProcessFailedError(command, options.cwd, 1, "error: pathspec did not match");
      }
      options.onOutput?.("agentcore/agentcore.json\n");
      return;
    }
    if (joined === "git --no-optional-locks status --porcelain -- .") {
      options.onOutput?.(responses.status ?? "");
      return;
    }
    throw new Error(`unexpected command: ${joined}`);
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A saved CloudFormation template from `__fixtures__/templates` (account IDs sanitized). */
export function templateFixture(name: string): CfnTemplate {
  return JSON.parse(
    readFileSync(join(import.meta.dir, "__fixtures__", "templates", `${name}.json`), "utf8"),
  ) as CfnTemplate;
}
