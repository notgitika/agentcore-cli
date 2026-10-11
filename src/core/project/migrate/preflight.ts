import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ProcessFailedError, type ProcessRunner } from "../../../io";
import type { MigrationCheck } from "../../../handlers/project/migrate/types";
import {
  V0AgentCoreProjectSpecSchema,
  V0DeployedStateSchema,
  type V0DeployedState,
  type V0ProjectSpec,
} from "../../../projectSchemas/v0";
import { PROJECT_SPEC_RELATIVE_PATH } from "../fsUtils";
import { projectFormat } from "../legacy/detect";
import { DEPLOYED_STATE_RELATIVE_PATH } from "../backends/cdk/deployedState";

/** The CDK app's manifest, relative to the project root. */
export const CDK_PACKAGE_RELATIVE_PATH = join("agentcore", "cdk", "package.json");

/** The first `@aws/agentcore-cdk` release the v0.24.2 CLI vended; older apps can't be migrated. */
const MIN_CDK_ALPHA = 45;
const CDK_PIN_PATTERN = /^0\.1\.0-alpha\.(\d+)$/;

export const OLD_CDK_MESSAGE =
  "This project's CDK dependencies are older than v0.24.2. Run `npx @aws/agentcore@0 deploy` " +
  "once to update them, then try again.";

/** What later steps need from a project that passed the format check. */
export type PreflightContext = {
  v0Spec: V0ProjectSpec;
  /** Empty when the project was never deployed. */
  deployedState: V0DeployedState;
};

export type PreflightResult = {
  checks: MigrationCheck[];
  /** Absent when the project could not be read as a v0 project; nothing else can run. */
  context?: PreflightContext;
};

/**
 * Checks whether a project can be migrated. Every check runs, so one dry run shows
 * everything to fix, except when agentcore.json isn't a v0 project at all.
 */
export async function preflight(rootPath: string, runner: ProcessRunner): Promise<PreflightResult> {
  const format = await checkProjectFormat(rootPath);
  if (!format.v0Spec) return { checks: [format.check] };

  const deployed = await checkDeployedState(rootPath);
  return {
    checks: [
      format.check,
      await checkGit(rootPath, runner),
      await checkCdkPin(rootPath),
      checkSupportedResources(format.v0Spec),
      deployed.check,
    ],
    context: { v0Spec: format.v0Spec, deployedState: deployed.state },
  };
}

/** The project's agentcore.json must be a valid v0 (version 1) spec. */
export async function checkProjectFormat(
  rootPath: string,
): Promise<{ check: MigrationCheck; v0Spec?: V0ProjectSpec }> {
  const fail = (message: string) => ({ check: { name: "v0 project", ok: false, message } });
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(rootPath, PROJECT_SPEC_RELATIVE_PATH), "utf8"));
  } catch (error) {
    return fail(`Couldn't read ${PROJECT_SPEC_RELATIVE_PATH}: ${(error as Error).message}`);
  }
  const version =
    typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
  if (version === 2) {
    return fail(
      "This project is already a v1 project (agentcore.json version 2); there is nothing to migrate.",
    );
  }
  if (projectFormat(raw) !== "v0") {
    return fail(
      `${PROJECT_SPEC_RELATIVE_PATH} has version ${JSON.stringify(version)}; only v0 projects (version 1) can be migrated.`,
    );
  }
  const parsed = V0AgentCoreProjectSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      `${PROJECT_SPEC_RELATIVE_PATH} isn't a valid v0 project. Fix it with the v0 CLI first:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return {
    check: { name: "v0 project", ok: true, message: `'${parsed.data.name}' is a v0 project` },
    v0Spec: parsed.data,
  };
}

const GIT_REQUIRED =
  "agentcore migrate needs the project in a git repository with a clean working tree, so the " +
  "migration can be reviewed and undone.";

/** A spawn failure (no exit code), which for git means it isn't installed or isn't on PATH. */
function gitMissing(error: unknown): boolean {
  return error instanceof ProcessFailedError && error.meta.exitCode === null;
}

const GIT_NOT_INSTALLED =
  `${GIT_REQUIRED} git isn't installed or isn't on your PATH: install it from ` +
  "https://git-scm.com/downloads, then try again.";

/**
 * The project must be in a git repository, with agentcore.json committed and a
 * clean working tree.
 */
export async function checkGit(rootPath: string, runner: ProcessRunner): Promise<MigrationCheck> {
  const fail = (message: string): MigrationCheck => ({ name: "git", ok: false, message });
  const run = async (command: string[]): Promise<string> => {
    let output = "";
    await runner(command, { cwd: rootPath, onOutput: (chunk) => (output += chunk) });
    return output;
  };
  try {
    await run(["git", "rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    if (gitMissing(error)) return fail(GIT_NOT_INSTALLED);
    return fail(
      `${GIT_REQUIRED} This project isn't in one: run 'git init' and commit the project, then try again.`,
    );
  }
  try {
    await run(["git", "ls-files", "--error-unmatch", "agentcore/agentcore.json"]);
  } catch (error) {
    if (gitMissing(error)) return fail(GIT_NOT_INSTALLED);
    return fail(
      `${GIT_REQUIRED} ${PROJECT_SPEC_RELATIVE_PATH} isn't committed: commit the project, then try again.`,
    );
  }
  let status: string;
  try {
    // --no-optional-locks: a read-only check must not take git's index lock and
    // race an editor or another git process.
    status = await run(["git", "--no-optional-locks", "status", "--porcelain", "--", "."]);
  } catch (error) {
    if (gitMissing(error)) return fail(GIT_NOT_INSTALLED);
    return fail(`Couldn't read git status: ${(error as Error).message}`);
  }
  // The runner merges stderr into the output; only porcelain status lines
  // ("XY path") are changes, so a git warning can't fail the check.
  const dirty = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /^[ MTADRCU?!]{2} /.test(line));
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 5).map((line) => `  ${line}`);
    if (dirty.length > shown.length) shown.push(`  ...and ${dirty.length - shown.length} more`);
    return fail(`${GIT_REQUIRED} Commit or stash these changes first:\n${shown.join("\n")}`);
  }
  return { name: "git", ok: true, message: "working tree is clean" };
}

/** The project's CDK app must pin an `@aws/agentcore-cdk` new enough to migrate from. */
export async function checkCdkPin(rootPath: string): Promise<MigrationCheck> {
  const name = "cdk dependencies";
  let manifest: { dependencies?: Record<string, unknown> };
  try {
    manifest = JSON.parse(
      await readFile(join(rootPath, CDK_PACKAGE_RELATIVE_PATH), "utf8"),
    ) as typeof manifest;
  } catch (error) {
    return {
      name,
      ok: false,
      message: `Couldn't read ${CDK_PACKAGE_RELATIVE_PATH}: ${(error as Error).message}`,
    };
  }
  const pin = manifest.dependencies?.["@aws/agentcore-cdk"];
  const match = typeof pin === "string" ? CDK_PIN_PATTERN.exec(pin) : null;
  if (!match || Number(match[1]) < MIN_CDK_ALPHA) {
    return { name, ok: false, message: OLD_CDK_MESSAGE };
  }
  return { name, ok: true, message: `@aws/agentcore-cdk ${String(pin)}` };
}

/** Knowledge bases, datasets, and capacity providers have no v1 equivalent yet. */
export function checkSupportedResources(v0: V0ProjectSpec): MigrationCheck {
  const name = "supported resources";
  const runtimesOnCapacityProviders = v0.runtimes.filter(
    (runtime) =>
      runtime.capacityProviderConfiguration !== undefined ||
      (runtime.filesystemConfigurations ?? []).some((mount) => "capacityProviderVolume" in mount),
  );
  const unsupported = [
    ["knowledge bases", v0.knowledgeBases.map((kb) => kb.name)],
    ["datasets", (v0.datasets ?? []).map((dataset) => dataset.name)],
    ["capacity providers", (v0.capacityProviders ?? []).map((provider) => provider.name)],
    ["runtimes on capacity providers", runtimesOnCapacityProviders.map((runtime) => runtime.name)],
  ] as const;
  const found = unsupported.filter(([, names]) => names.length > 0);
  if (found.length === 0) {
    return { name, ok: true, message: "no knowledge bases, datasets, or capacity providers" };
  }
  const listed = found.map(([label, names]) => `${label} (${names.join(", ")})`).join("; ");
  return {
    name,
    ok: false,
    message:
      `This project uses ${listed}, which v1 doesn't support yet. To migrate, remove them from ` +
      `${PROJECT_SPEC_RELATIVE_PATH} first (the next v0 deploy then deletes them from AWS), or ` +
      "keep the project unmigrated and use it in compatibility mode.",
  };
}

/** The v0 deployed state, which says which resources already exist in AWS. */
export async function checkDeployedState(
  rootPath: string,
): Promise<{ check: MigrationCheck; state: V0DeployedState }> {
  const name = "deployed state";
  const empty: V0DeployedState = { targets: {} };
  let text: string;
  try {
    text = await readFile(join(rootPath, DEPLOYED_STATE_RELATIVE_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        check: { name, ok: true, message: "never deployed; no names to keep" },
        state: empty,
      };
    }
    return {
      check: {
        name,
        ok: false,
        message: `Couldn't read ${DEPLOYED_STATE_RELATIVE_PATH}: ${(error as Error).message}`,
      },
      state: empty,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      check: {
        name,
        ok: false,
        message: `${DEPLOYED_STATE_RELATIVE_PATH} isn't valid JSON: ${(error as Error).message}`,
      },
      state: empty,
    };
  }
  const parsed = V0DeployedStateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      check: {
        name,
        ok: false,
        message: `${DEPLOYED_STATE_RELATIVE_PATH} isn't valid v0 deployed state:\n${z.prettifyError(parsed.error)}`,
      },
      state: empty,
    };
  }
  const targets = Object.keys(parsed.data.targets);
  return {
    check: {
      name,
      ok: true,
      message: targets.length
        ? `deployed to ${targets.map((t) => `'${t}'`).join(", ")}`
        : "never deployed; no names to keep",
    },
    state: parsed.data,
  };
}
