import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CreateChangeSetCommand,
  CreateStackRefactorCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackRefactorCommand,
  DescribeStacksCommand,
  ExecuteStackRefactorCommand,
  GetStackPolicyCommand,
  GetTemplateCommand,
  ListStackRefactorActionsCommand,
  type Change,
  type CloudFormationClient,
  type ResourceMapping,
} from "@aws-sdk/client-cloudformation";
import { ProcessFailedError, type ProcessRunner } from "../../../io";
import type { CreateCloudFormationClient } from "../../types";
import type { AccountResolver } from "../backends/cdk/environment";
import type { CdkCredentialResolver } from "../backends/cdk/toolkit";
import type { WorkspaceSynthesizer } from "./synth";
import type { CfnTemplate } from "./templates";
import type { TemplateStore } from "./templateStore";

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

/** A stack as the fake CloudFormation client reports it. */
export type FakeStack = {
  status?: string;
  /** A stack policy document; absent means none. */
  policy?: string;
  template?: CfnTemplate;
  /** Raw TemplateBody, overriding `template`. */
  templateBody?: string;
};

/** How a fake stack refactor turns out; by default it's created and executes. */
export type FakeRefactorOutcome = {
  /** The refactor's Status after creation; anything but CREATE_COMPLETE fails it. */
  create?: { status: string; reason?: string };
  /** Its ExecutionStatus once executed; anything but EXECUTE_COMPLETE fails it. */
  execute?: { status: string; reason?: string };
  /**
   * ExecutionStatus for successive reads after execution, before `execute`'s
   * (which every later read returns), e.g. a rollback in progress.
   */
  executeSteps?: string[];
  /** ExecuteStackRefactor throws this; `started` says whether CloudFormation ran it anyway. */
  executeThrows?: { message: string; started: boolean };
  /** How many reads after execution throw before the refactor reads normally again. */
  failedReads?: number;
};

/** A change set as the fake reports it: the changes, or a failed creation. */
export type FakeChangeSet = { changes: Change[] } | { status: "FAILED"; reason: string };

export type FakeCloudFormationOptions = {
  /** Decides each refactor's outcome; `index` counts refactors created for that stack, from 0. */
  refactors?: (call: { stackName: string; index: number }) => FakeRefactorOutcome;
  /** The change set created for each stack; defaults to one with no changes. */
  changeSets?: Record<string, FakeChangeSet>;
  /** The CDK bootstrap bucket CDKToolkit reports. */
  bootstrapBucket?: string;
};

type FakeRefactor = {
  stackName: string;
  template: CfnTemplate;
  mappings: ResourceMapping[];
  outcome: FakeRefactorOutcome;
  /** DescribeStackRefactor calls so far; the first reads still in progress. */
  reads: number;
  executed: boolean;
};

/**
 * A CloudFormation client factory answering, from `stacks`: DescribeStacks,
 * GetStackPolicy, and GetTemplate; stack refactors (created, listed, and executed,
 * moving the stack to the refactor's template); and change sets (created from
 * `options.changeSets`, described, deleted). Any other command fails the test.
 * Records every request, with the region the client was built for; `stacks` is
 * updated as refactors execute.
 */
export function fakeCloudFormation(
  stacks: Record<string, FakeStack>,
  options: FakeCloudFormationOptions = {},
): {
  create: CreateCloudFormationClient;
  calls: { command: string; input: Record<string, unknown>; region: string }[];
  stacks: Record<string, FakeStack>;
} {
  const calls: { command: string; input: Record<string, unknown>; region: string }[] = [];
  const refactors = new Map<string, FakeRefactor>();
  const created = new Map<string, number>();
  const changeSets = new Map<string, FakeChangeSet>();
  const notFound = (id: string) =>
    Object.assign(new Error(`Stack with id ${id} does not exist`), { name: "ValidationError" });

  const refactorCommand = (name: string, input: Record<string, unknown>) => {
    if (name === CreateStackRefactorCommand.name) {
      const [definition] = input.StackDefinitions as {
        StackName: string;
        TemplateBody?: string;
        TemplateURL?: string;
      }[];
      const stackName = definition!.StackName;
      if (!stacks[stackName]) throw notFound(stackName);
      const index = created.get(stackName) ?? 0;
      created.set(stackName, index + 1);
      const id = `refactor-${refactors.size + 1}`;
      refactors.set(id, {
        stackName,
        template: JSON.parse(
          definition!.TemplateBody ??
            JSON.stringify(TEMPLATES_BY_URL.get(definition!.TemplateURL!)),
        ) as CfnTemplate,
        mappings: (input.ResourceMappings as ResourceMapping[]) ?? [],
        outcome: options.refactors?.({ stackName, index }) ?? {},
        reads: 0,
        executed: false,
      });
      return { StackRefactorId: id };
    }
    const id = String(input.StackRefactorId);
    const refactor = refactors.get(id);
    if (!refactor) throw new Error(`no stack refactor ${id}`);
    if (name === DescribeStackRefactorCommand.name) {
      refactor.reads += 1;
      const create = refactor.outcome.create ?? { status: "CREATE_COMPLETE" };
      if (!refactor.executed) {
        return refactor.reads === 1
          ? { StackRefactorId: id, Status: "CREATE_IN_PROGRESS", ExecutionStatus: "UNAVAILABLE" }
          : {
              StackRefactorId: id,
              Status: create.status,
              StatusReason: create.reason,
              ExecutionStatus: create.status === "CREATE_COMPLETE" ? "AVAILABLE" : "UNAVAILABLE",
            };
      }
      if ((refactor.outcome.failedReads ?? 0) > 0) {
        refactor.outcome.failedReads! -= 1;
        throw Object.assign(new Error("Rate exceeded"), { name: "Throttling" });
      }
      const step = refactor.outcome.executeSteps?.shift();
      if (step) return { StackRefactorId: id, Status: "CREATE_COMPLETE", ExecutionStatus: step };
      const execute = refactor.outcome.execute ?? { status: "EXECUTE_COMPLETE" };
      return {
        StackRefactorId: id,
        Status: "CREATE_COMPLETE",
        ExecutionStatus: execute.status,
        ExecutionStatusReason: execute.reason,
      };
    }
    if (name === ListStackRefactorActionsCommand.name) {
      // Pages of two, so callers have to follow NextToken.
      const start = Number(input.NextToken ?? 0);
      const page = refactor.mappings.slice(start, start + 2);
      return {
        StackRefactorActions: page.map((mapping) => ({
          Action: "MOVE",
          Entity: "RESOURCE",
          PhysicalResourceId: `physical-${mapping.Source!.LogicalResourceId}`,
          Description: "No configuration changes detected.",
          ResourceMapping: mapping,
        })),
        ...(start + 2 < refactor.mappings.length && { NextToken: String(start + 2) }),
      };
    }
    if (name === ExecuteStackRefactorCommand.name) {
      const throws = refactor.outcome.executeThrows;
      if (throws && !throws.started) throw new Error(throws.message);
      refactor.executed = true;
      // A completed refactor leaves the stack on the refactor's template; a failed
      // one rolls back, and one that couldn't roll back is left as it was here.
      if ((refactor.outcome.execute?.status ?? "EXECUTE_COMPLETE") === "EXECUTE_COMPLETE") {
        stacks[refactor.stackName]!.template = refactor.template;
        delete stacks[refactor.stackName]!.templateBody;
      }
      if (throws) throw new Error(throws.message);
      return {};
    }
    return undefined;
  };

  const create: CreateCloudFormationClient = (config) =>
    ({
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        calls.push({ command: name, input: command.input, region: config.region });
        if (name.includes("StackRefactor")) {
          const response = refactorCommand(name, command.input);
          if (response !== undefined) return response;
        }
        const stackName = String(command.input.StackName);
        if (name === DescribeStacksCommand.name && stackName === "CDKToolkit") {
          if (!options.bootstrapBucket) throw notFound(stackName);
          return {
            Stacks: [
              {
                StackName: stackName,
                StackStatus: "UPDATE_COMPLETE",
                Outputs: [{ OutputKey: "BucketName", OutputValue: options.bootstrapBucket }],
              },
            ],
          };
        }
        const stack = stacks[stackName];
        if (!stack) throw notFound(stackName);
        if (name === DescribeStacksCommand.name) {
          return {
            Stacks: [{ StackName: stackName, StackStatus: stack.status ?? "UPDATE_COMPLETE" }],
          };
        }
        if (name === GetStackPolicyCommand.name) return { StackPolicyBody: stack.policy };
        if (name === GetTemplateCommand.name) {
          return { TemplateBody: stack.templateBody ?? JSON.stringify(stack.template ?? {}) };
        }
        const changeSetKey = `${stackName}/${String(command.input.ChangeSetName)}`;
        if (name === CreateChangeSetCommand.name) {
          changeSets.set(changeSetKey, options.changeSets?.[stackName] ?? { changes: [] });
          return { Id: changeSetKey };
        }
        if (name === DescribeChangeSetCommand.name) {
          const changeSet = changeSets.get(changeSetKey);
          if (!changeSet) throw new Error(`no change set ${changeSetKey}`);
          if ("status" in changeSet) {
            return { Status: "FAILED", StatusReason: changeSet.reason };
          }
          if (changeSet.changes.length === 0) {
            return {
              Status: "FAILED",
              StatusReason: "The submitted information didn't contain changes.",
            };
          }
          return { Status: "CREATE_COMPLETE", Changes: changeSet.changes };
        }
        if (name === DeleteChangeSetCommand.name) {
          changeSets.delete(changeSetKey);
          return {};
        }
        throw new Error(`unexpected CloudFormation command ${name}`);
      },
    }) as unknown as CloudFormationClient;
  return { create, calls, stacks };
}

/** Templates uploaded to a {@link fakeTemplateStore}, by URL, so refactors made from a URL can read them. */
const TEMPLATES_BY_URL = new Map<string, unknown>();

/** A template store that keeps uploads in memory and records them. */
export function fakeTemplateStore(): TemplateStore & { puts: string[]; removed: string[] } {
  const puts: string[] = [];
  const removed: string[] = [];
  return {
    puts,
    removed,
    async put(key, body) {
      puts.push(key);
      const url = `https://bootstrap.example/${key}`;
      TEMPLATES_BY_URL.set(url, JSON.parse(body));
      return url;
    },
    async remove(key) {
      removed.push(key);
    },
  };
}

/**
 * A synthesizer that writes a cloud assembly with one stack per target instead
 * of installing and running the CDK app. Records the workspaces it was given.
 */
export function fakeSynth(
  stacks: { target: string; stackName: string; template: CfnTemplate }[],
): WorkspaceSynthesizer & { workspaces: string[] } {
  const workspaces: string[] = [];
  const synthesize = async (workspaceDirectory: string) => {
    workspaces.push(workspaceDirectory);
    const assembly = join(workspaceDirectory, "agentcore", "cdk", "cdk.out");
    await mkdir(assembly, { recursive: true });
    const artifacts: Record<string, unknown> = {};
    for (const stack of stacks) {
      const templateFile = `${stack.stackName}.template.json`;
      artifacts[stack.stackName] = {
        type: "aws:cloudformation:stack",
        properties: {
          templateFile,
          stackName: stack.stackName,
          tags: { "agentcore:target-name": stack.target },
        },
      };
      await writeFile(join(assembly, templateFile), JSON.stringify(stack.template));
    }
    await writeFile(join(assembly, "manifest.json"), JSON.stringify({ artifacts }));
    return assembly;
  };
  return Object.assign(synthesize, { workspaces });
}

/** Credentials and an account lookup that never leave the process. */
export const FAKE_AWS_IDENTITY: {
  resolveCredentials: CdkCredentialResolver;
  resolveAccount: AccountResolver;
} = {
  resolveCredentials: async () => async () => ({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
  }),
  resolveAccount: async () => "998846730471",
};
