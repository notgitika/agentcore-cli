import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess, type ProcessRunner } from "../../../io";
import type {
  MigrationPlan,
  MigrationProblem,
  ProjectMigrator,
} from "../../../handlers/project/migrate/types";
import { defaultSource, type AssetSource } from "../source";
import { convertHarness } from "./convertHarness";
import { AWS_TARGETS_RELATIVE_PATH, convertSpec, convertTargets } from "./convertSpec";
import { preflight } from "./preflight";
import { buildMigrationWorkspace } from "./workspace";

export type FsProjectMigratorConfig = {
  /** Runs git; injectable so tests never spawn processes. */
  runner?: ProcessRunner;
  /** Where v1's vended CDK app is read from. */
  assetSource?: AssetSource;
};

/**
 * Plans a v0 → v1 migration from the project on disk. Planning reads the project
 * and builds the converted copy in a temporary directory; it never writes to the
 * project or calls AWS.
 */
export class FsProjectMigrator implements ProjectMigrator {
  private readonly runner: ProcessRunner;
  private readonly assetSource: AssetSource;

  constructor(config: FsProjectMigratorConfig = {}) {
    this.runner = config.runner ?? runProcess;
    this.assetSource = config.assetSource ?? defaultSource();
  }

  public async plan(rootPath: string): Promise<MigrationPlan> {
    const { checks, context } = await preflight(rootPath, this.runner);
    if (!context) {
      return { rootPath, checks, problems: [], pins: [], warnings: [], changes: [], ready: false };
    }
    const { v0Spec, deployedState } = context;

    const converted = convertSpec(v0Spec, deployedState);
    const harnesses = await Promise.all(
      v0Spec.harnesses.map((entry) => convertHarness(rootPath, entry)),
    );
    const problems: MigrationProblem[] = [
      ...converted.problems,
      ...harnesses.flatMap((harness) => harness.problems),
      ...(await this.targetProblems(rootPath)),
    ];

    const workspace = await buildMigrationWorkspace({
      rootPath,
      spec: converted.json,
      harnesses: harnesses.flatMap(({ directory, yaml }) =>
        yaml === undefined ? [] : [{ directory, yaml }],
      ),
      assetSource: this.assetSource,
    });
    try {
      return {
        rootPath,
        projectName: v0Spec.name,
        checks,
        problems,
        pins: converted.pins,
        warnings: converted.warnings,
        changes: workspace.changes,
        ready: checks.every((check) => check.ok) && problems.length === 0,
      };
    } finally {
      await workspace.dispose();
    }
  }

  private async targetProblems(rootPath: string): Promise<MigrationProblem[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(rootPath, AWS_TARGETS_RELATIVE_PATH), "utf8"));
    } catch (error) {
      return [
        {
          file: AWS_TARGETS_RELATIVE_PATH,
          path: "(file)",
          message: `Couldn't read it: ${(error as Error).message}`,
        },
      ];
    }
    return convertTargets(raw);
  }
}
