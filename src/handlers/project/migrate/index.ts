import z from "zod";
import { enclosingProjectRoot } from "../../../core/project/fsUtils";
import { InputValidationError, ProjectStateError, SilentCLIError } from "../../../errors";
import type { AppIO } from "../../../io";
import { projectNotFoundMessage } from "../../../middleware/withProject";
import { createHandler, flag, type Middleware } from "../../../router";
import { renderResult } from "../../utils";
import type {
  MigrationPlan,
  ProjectMigrator,
  StackMigrationPlan,
  StackResourceChange,
} from "./types";

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

      // Progress goes to stderr, so it never mixes with the plan (or its JSON) on stdout.
      const plan = await config.migrator.plan(rootPath, {
        onStep: (message) => config.io.stderr.write(`${message}...\n`),
      });
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

    for (const stack of plan.stacks) lines.push("", ...formatStackPlan(stack));
  }

  if (plan.warnings.length > 0) {
    lines.push("", "Warnings");
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
  }

  if (plan.deployedChanges.length > 0) {
    lines.push("", "Would change deployed configuration");
    for (const change of plan.deployedChanges) {
      lines.push(`  - ${change.file} ${change.path}: ${change.message}`);
    }
  }

  if (plan.problems.length > 0) {
    lines.push("", "Fix before migrating");
    for (const problem of plan.problems) {
      lines.push(`  - ${problem.file} ${problem.path}: ${problem.message}`);
    }
  }

  const failed =
    plan.checks.filter((check) => !check.ok).length +
    plan.problems.length +
    plan.deployedChanges.length +
    plan.stacks.filter((stack) => !stack.ready).length;
  lines.push(
    "",
    plan.ready
      ? "Ready to migrate."
      : `Not ready to migrate: ${failed} ${failed === 1 ? "issue needs" : "issues need"} fixing first.`,
  );
  return `${lines.join("\n")}\n`;
}

/** One stack's refactor: what moves, then what the first v1 deploy changes, then the verdict. */
export function formatStackPlan(stack: StackMigrationPlan): string[] {
  const lines = [
    `Stack ${stack.stackName} (target '${stack.target}', ${stack.account}/${stack.region})`,
  ];
  const indent = (rows: string[]) => rows.map((row) => `    ${row}`);

  lines.push(`  Refactor: move ${count(stack.moves.length, "resource")} to new logical IDs`);
  if (stack.moves.length > 0) {
    lines.push(
      ...indent(
        table(
          ["TYPE", "FROM", "TO"],
          stack.moves.map((move) => [move.type, move.from, move.to]),
        ),
      ),
    );
  }
  lines.push(`  ${count(stack.unchanged, "resource")} keep their logical IDs`);

  lines.push("  Then the first v1 deploy:");
  const changes = (label: string, entries: StackResourceChange[]) => {
    if (entries.length === 0) return;
    lines.push(`    ${label}`);
    for (const entry of entries) {
      lines.push(`      ${severityLabel(entry)}${entry.type} ${entry.logicalId}: ${entry.reason}`);
    }
  };
  if (stack.added.length > 0) {
    lines.push("    creates");
    for (const entry of stack.added) lines.push(`      ${entry.type} ${entry.logicalId}`);
  }
  changes("deletes", stack.removed);
  changes("replaces", stack.replaced);
  if (stack.added.length + stack.removed.length + stack.replaced.length === 0) {
    lines.push("    creates, deletes, and replaces nothing");
  }

  const agentCoreReplacements = [...stack.removed, ...stack.replaced].filter(
    (change) => change.severity === "blocker",
  ).length;
  lines.push(
    agentCoreReplacements === 0
      ? `  Replacements: ${count(stack.replaced.length, "replacement")}; no AgentCore resource is replaced or deleted`
      : `  Replacements: ${count(agentCoreReplacements, "AgentCore resource")} would be replaced or deleted`,
  );
  for (const blocker of stack.blockers) lines.push(`  BLOCKER: ${blocker}`);
  return lines;
}

function severityLabel(change: StackResourceChange): string {
  return change.severity === "blocker"
    ? "BLOCKER "
    : change.severity === "warning"
      ? "warning "
      : "";
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
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
