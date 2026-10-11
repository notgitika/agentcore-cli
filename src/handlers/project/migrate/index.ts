import z from "zod";
import { enclosingProjectRoot } from "../../../core/project/fsUtils";
import { InputValidationError, ProjectStateError, SilentCLIError } from "../../../errors";
import type { AppIO } from "../../../io";
import { projectNotFoundMessage } from "../../../middleware/withProject";
import { createHandler, flag, type Middleware } from "../../../router";
import { renderResult } from "../../utils";
import type { MigrationPlan, ProjectMigrator } from "./types";

export type { MigrationPlan, ProjectMigrator } from "./types";

type MigrateProjectHandlerConfig = {
  migrator: ProjectMigrator;
  io: AppIO;
  middlewares?: Middleware[];
  /** Directory to search upwards from for the project. Defaults to the cwd at invocation time. */
  cwd?: string;
};

export const APPLY_UNAVAILABLE_MESSAGE =
  "Applying a migration isn't available yet; run with --dry-run to see what it would change.";

/**
 * `agentcore migrate`: upgrades a v0 project to v1. Resolves the project root itself
 * rather than through withProject, because v1's project loader can't read v0 specs.
 */
export const createMigrateProjectHandler = (config: MigrateProjectHandlerConfig) =>
  createHandler({
    name: "migrate",
    description: "upgrade a v0 project to v1",
    middlewares: config.middlewares,
    flags: [
      flag(
        "dry-run",
        "show what migrating would change, without changing anything",
        z.boolean().default(false),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags["dry-run"]) throw new InputValidationError(APPLY_UNAVAILABLE_MESSAGE);

      const from = config.cwd ?? process.cwd();
      const rootPath = enclosingProjectRoot(from);
      if (!rootPath) throw new ProjectStateError(projectNotFoundMessage(from));

      const plan = await config.migrator.plan(rootPath);
      renderResult(ctx, plan, () => config.io.stdout.write(formatMigrationPlan(plan)));
      // The plan is the output either way; a project that can't migrate yet still
      // exits non-zero so scripts can tell.
      if (!plan.ready) throw new SilentCLIError("the project can't be migrated yet");
    },
  });

/** The human-readable dry-run report. */
export function formatMigrationPlan(plan: MigrationPlan): string {
  const lines: string[] = [];
  const title = plan.projectName ? `project '${plan.projectName}'` : plan.rootPath;
  lines.push(`Migration plan for ${title} (dry run: nothing was changed)`, "");

  lines.push("Checks");
  const nameWidth = Math.max(...plan.checks.map((check) => check.name.length));
  for (const check of plan.checks) {
    const [first = "", ...rest] = check.message.split("\n");
    lines.push(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name.padEnd(nameWidth)}  ${first}`);
    for (const line of rest) lines.push(`        ${" ".repeat(nameWidth)}  ${line}`);
  }

  if (plan.projectName !== undefined) {
    lines.push("", "Names kept for deployed resources");
    if (plan.pins.length === 0) {
      lines.push("  none (nothing is deployed yet)");
    } else {
      lines.push(
        ...table(
          ["TYPE", "NAME", "FIELD", "AWS NAME"],
          plan.pins.map((pin) => [pin.resourceType, pin.name, pin.field, pin.value]),
        ).map((line) => `  ${line}`),
      );
    }

    lines.push("", "File changes");
    if (plan.changes.length === 0) lines.push("  none");
    for (const change of plan.changes) lines.push(`  ${change.kind.padEnd(8)}  ${change.path}`);
  }

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings");
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
  }

  if (plan.problems.length > 0) {
    lines.push("", "Fix before migrating");
    for (const problem of plan.problems) {
      lines.push(`  - ${problem.file} ${problem.path}: ${problem.message}`);
    }
  }

  const failed = plan.checks.filter((check) => !check.ok).length + plan.problems.length;
  lines.push(
    "",
    plan.ready
      ? "Ready to migrate."
      : `Not ready to migrate: ${failed} ${failed === 1 ? "issue needs" : "issues need"} fixing first.`,
  );
  return `${lines.join("\n")}\n`;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const render = (row: string[]) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join("  ");
  return [header, ...rows].map(render);
}
