import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProjectStateError } from "../../../errors/errors";
import type { DeployResult, Project, ProjectEvent } from "../../../handlers/project/types";
import {
  FsReadWriteJson,
  requireTool,
  runProcess,
  type ProcessRunner,
  type ReadWriteJson,
} from "../../../io";
import type { Logger } from "../../../logging";
import type { DeployBackendInput, ProjectBackend } from "./types";
import { assertStackHasResources, stackArtifactForTarget } from "./cdk/assembly";
import {
  assertCredentialsDeployable,
  createCredentialSynchronizer,
  type CredentialPreflight,
  type CredentialSynchronizer,
} from "./cdk/credentials";
import {
  probeBootstrap,
  resolveAwsAccount,
  type AccountResolver,
  type BootstrapProbe,
} from "./cdk/environment";
import {
  createCdkCredentialResolver,
  createCdkRunner,
  loadBootstrapTemplate,
  type BootstrapTemplateLoader,
  type CdkCredentialResolver,
  type CdkRunner,
} from "./cdk/toolkit";

export type CdkBackendConfig = {
  logger: Logger;
  runner?: ProcessRunner;
  checkTool?: typeof requireTool;
  json?: ReadWriteJson;
  cdk?: CdkRunner;
  resolveCredentials?: CdkCredentialResolver;
  bootstrap?: BootstrapProbe;
  resolveAccount?: AccountResolver;
  loadBootstrapTemplate?: BootstrapTemplateLoader;
  assertCredentials?: CredentialPreflight;
  syncCredentials?: CredentialSynchronizer;
};

/** Builds and deploys projects through the scaffolded CDK app. */
export class CdkBackend implements ProjectBackend {
  private readonly logger: Logger;
  private readonly runner: ProcessRunner;
  private readonly checkTool: typeof requireTool;
  private readonly json: ReadWriteJson;
  private readonly cdk: CdkRunner;
  private readonly resolveCredentials: CdkCredentialResolver;
  private readonly bootstrap: BootstrapProbe;
  private readonly resolveAccount: AccountResolver;
  private readonly loadBootstrapTemplate: BootstrapTemplateLoader;
  private readonly assertCredentials: CredentialPreflight;
  private readonly syncCredentials: CredentialSynchronizer;

  constructor(config: CdkBackendConfig) {
    this.logger = config.logger;
    this.runner = config.runner ?? runProcess;
    this.checkTool = config.checkTool ?? requireTool;
    this.json = config.json ?? new FsReadWriteJson({ logger: config.logger });
    this.cdk = config.cdk ?? createCdkRunner(config.logger);
    this.resolveCredentials =
      config.resolveCredentials ?? createCdkCredentialResolver(config.logger);
    this.bootstrap = config.bootstrap ?? probeBootstrap;
    this.resolveAccount = config.resolveAccount ?? resolveAwsAccount;
    this.loadBootstrapTemplate = config.loadBootstrapTemplate ?? loadBootstrapTemplate;
    this.assertCredentials = config.assertCredentials ?? assertCredentialsDeployable;
    this.syncCredentials = config.syncCredentials ?? createCredentialSynchronizer();
  }

  public async *build(project: Project): AsyncGenerator<ProjectEvent, void> {
    const cdkDir = this.cdkDirectory(project);

    if (!existsSync(join(cdkDir, "node_modules"))) {
      throw new ProjectStateError(
        `CDK dependencies are missing for project '${project.name}'. ` +
          `Run 'cd ${cdkDir} && npm install'.`,
      );
    }
    await this.checkTool("npm", "Install Node.js: https://nodejs.org/");

    yield { message: "Synthesizing CloudFormation templates" };
    await this.runner(
      ["npm", "run", "cdk", "--", "synth", "--quiet", "--output", this.assemblyDirectory(project)],
      {
        cwd: cdkDir,
        onOutput: (chunk) => this.logger.debug(chunk),
      },
    );
  }

  public async *deploy(
    project: Project,
    input: DeployBackendInput,
  ): AsyncGenerator<ProjectEvent, DeployResult> {
    const { target } = input;
    yield { message: `Verifying AWS account ${target.account}` };
    const credentials = await this.resolveCredentials(target.region);
    const account = await this.resolveAccount(target.region, credentials);
    if (account !== target.account) {
      throw new ProjectStateError(
        `Deployment target '${target.name}' expects AWS account ${target.account}, ` +
          `but the active credentials belong to ${account}.`,
      );
    }

    // Before anything is synthesized or bootstrapped: the stack creates each
    // credential provider with a placeholder secret that only the post-deploy
    // sync below can replace, so a credential with no secret to sync has to fail
    // here rather than after its provider is already live.
    await this.assertCredentials(project);

    yield* this.build(project);
    const assemblyDirectory = this.assemblyDirectory(project);
    const artifact = await stackArtifactForTarget(this.json, assemblyDirectory, target.name, {
      account: target.account,
      region: target.region,
    });
    // Checked here rather than after the fact: the Toolkit deletes an existing
    // stack whose new template has no resources, and returns as if it deployed.
    await assertStackHasResources(this.json, assemblyDirectory, artifact);
    const options = { assemblyDirectory, credentials, region: target.region };

    const bootstrap = await this.bootstrap(target.region, credentials);
    this.logger
      .child({
        account: target.account,
        region: target.region,
        bootstrapState: bootstrap.kind,
        ...("version" in bootstrap && { bootstrapVersion: bootstrap.version }),
      })
      .debug("checked CDK bootstrap stack");

    if (bootstrap.kind !== "current") {
      const environment = `aws://${target.account}/${target.region}`;
      yield { message: `Bootstrapping ${environment}` };
      const template = await this.loadBootstrapTemplate();
      try {
        await this.cdk(
          {
            kind: "bootstrap",
            environments: [environment],
            ...(template && { templateFile: template.path }),
          },
          options,
        );
      } finally {
        await template?.cleanup();
      }
    }

    yield { message: `Deploying ${artifact.id}` };
    const outputs = await this.cdk({ kind: "deploy", stackArtifactId: artifact.id }, options);

    // The credential providers exist only now that CloudFormation has made them,
    // each holding the placeholder secret its template carried. Replacing those
    // is what keeps real secret material out of the template. A failure here
    // leaves a correctly deployed stack whose providers still hold placeholders;
    // the next deploy retries the sync.
    yield* this.syncCredentials(project, { region: target.region, credentials });

    return { outputs };
  }

  private cdkDirectory(project: Project): string {
    return join(project.rootPath, "agentcore", "cdk");
  }

  private assemblyDirectory(project: Project): string {
    return join(this.cdkDirectory(project), "cdk.out");
  }
}
