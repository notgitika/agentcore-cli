import { createInterface } from "node:readline/promises";
import z from "zod";
import { enclosingProjectRoot } from "../../../core/project/fsUtils";
import {
  InputValidationError,
  ProjectStateError,
  SilentCLIError,
  UserCancellationError,
} from "../../../errors";
import type { AppIO } from "../../../io";
import { projectNotFoundMessage } from "../../../middleware/withProject";
import { createHandler, flag, type Middleware } from "../../../router";
import { JsonKey } from "../../keys";
import { renderResult } from "../../utils";
import type {
  MigrationPlan,
  MigrationResult,
  ProjectMigrator,
  StackMigrationPlan,
  StackRefactorPreview,
  StackResourceChange,
} from "./types";

export type { MigrationPlan, MigrationResult, ProjectMigrator } from "./types";

type MigrateProjectHandlerConfig = {
  migrator: ProjectMigrator;
  io: AppIO;
  middlewares?: Middleware[];
  /** Directory to search upwards from for the project. Defaults to the cwd at invocation time. */
  cwd?: string;
};

export const CONFIRMATION_REQUIRED_MESSAGE =
  "Migrating refactors the project's deployed stacks and rewrites its files; re-run with --yes " +
  "to confirm non-interactively, or with --dry-run to see what it would change.";

/**
 * What `agentcore migrate --json` prints when applying: the plan, the refactors
 * created from it, and what applying did. A plan that isn't ready stops before
 * any refactor is created, so it has neither `refactors` entries nor `result`.
 */
export type MigrationOutput = {
  plan: MigrationPlan;
  refactors: StackRefactorPreview[];
  result?: MigrationResult;
};

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
      flag("yes", "migrate without asking for confirmation", z.boolean().default(false)),
    ],
    handle: async (ctx, flags) => {
      const from = config.cwd ?? process.cwd();
      const rootPath = enclosingProjectRoot(from);
      if (!rootPath) throw new ProjectStateError(projectNotFoundMessage(from));
      const { io } = config;
      // Progress goes to stderr, so it never mixes with the plan (or its JSON) on stdout.
      const onStep = (message: string) => io.stderr.write(`${message}...\n`);

      if (flags["dry-run"]) {
        const plan = await config.migrator.plan(rootPath, { onStep });
        renderResult(ctx, plan, () => io.stdout.write(formatMigrationPlan(plan)));
        // The plan is the output either way; a project that can't migrate yet still
        // exits non-zero so scripts can tell.
        if (!plan.ready) throw new SilentCLIError("the project can't be migrated yet");
        return;
      }

      // Decided before anything is read, so a script without --yes changes nothing.
      const json = ctx.require(JsonKey);
      const canPrompt = !json && io.stdin.isTTY && io.stdout.isTTY && io.stderr.isTTY;
      if (!flags.yes && !canPrompt) throw new InputValidationError(CONFIRMATION_REQUIRED_MESSAGE);

      const prepared = await config.migrator.prepare(rootPath, { onStep });
      try {
        const { plan } = prepared;
        if (!plan.ready) {
          renderResult<MigrationOutput>(ctx, { plan, refactors: [] }, () =>
            io.stdout.write(formatMigrationPlan(plan, { dryRun: false })),
          );
          throw new SilentCLIError("the project can't be migrated yet");
        }
        if (!json) io.stdout.write(formatMigrationPlan(plan, { dryRun: false }));

        // CloudFormation validates each refactor as it's created, so the user
        // confirms what it will actually do; nothing changes until it's executed.
        const refactors = await prepared.preview({ onStep });
        if (!json) io.stdout.write(formatRefactorPreviews(refactors));
        if (!flags.yes && !(await confirmMigration(io, plan, refactors))) {
          throw new UserCancellationError();
        }

        const result = await prepared.apply({ onStep });
        renderResult<MigrationOutput>(ctx, { plan, refactors, result }, () =>
          io.stdout.write(formatMigrationResult(result)),
        );
        if (!result.migrated) throw new SilentCLIError("the migration didn't complete");
      } finally {
        await prepared.dispose();
      }
    },
  });

async function confirmMigration(
  io: AppIO,
  plan: MigrationPlan,
  refactors: StackRefactorPreview[],
): Promise<boolean> {
  const readline = createInterface({ input: io.stdin, output: io.stderr });
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = () => reject(new UserCancellationError());
      readline.once("SIGINT", cancel);
      readline.once("close", cancel);
    });
    const stacks = refactors.filter((refactor) => refactor.refactorId !== undefined).length;
    const answer = await Promise.race([
      readline.question(
        `Migrate project '${plan.projectName ?? plan.rootPath}' to v1? This ` +
          (stacks === 0
            ? "rewrites the project's files as listed above (no stack needs refactoring). "
            : `refactors ${stacks} deployed ${stacks === 1 ? "stack" : "stacks"} and rewrites ` +
              "the project's files as listed above. ") +
          "(y/N) ",
      ),
      cancelled,
    ]);
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

/** What each stack's refactor will do, as CloudFormation listed it once created. */
export function formatRefactorPreviews(previews: StackRefactorPreview[]): string {
  if (previews.length === 0) return "";
  const lines: string[] = [];
  for (const preview of previews) {
    lines.push("");
    if (preview.refactorId === undefined) {
      lines.push(`Stack ${preview.stackName}: nothing to move, so no refactor is needed`);
      continue;
    }
    lines.push(
      `Stack refactor ${preview.refactorId} for ${preview.stackName}, validated by CloudFormation:`,
    );
    lines.push(
      ...table(
        ["ACTION", "FROM", "TO", "NOTE"],
        preview.actions.map((action) => [
          action.action,
          action.from,
          action.to,
          action.description ?? "",
        ]),
      ).map((line) => `  ${line}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

const OUTCOME_LABELS: Record<MigrationResult["stacks"][number]["outcome"], string> = {
  refactored: "refactored",
  unchanged: "nothing to move",
  failed: "FAILED",
  undone: "refactored, then moved back",
  "undo-failed": "refactored; moving it back FAILED",
  "not-started": "not refactored",
};

/** The summary printed after applying. */
export function formatMigrationResult(result: MigrationResult): string {
  const lines: string[] = [""];
  lines.push(result.migrated ? "Migrated to v1." : "Migration didn't complete.");
  if (result.stacks.length > 0) {
    lines.push("", "Stacks");
    for (const stack of result.stacks) {
      lines.push(`  ${stack.stackName}: ${OUTCOME_LABELS[stack.outcome]}`);
      if (stack.message && stack.outcome !== "failed") lines.push(`    ${stack.message}`);
    }
  }
  if (result.verification.length > 0) {
    lines.push("", "First v1 deploy (previewed with a change set, not executed)");
    for (const entry of result.verification) {
      if (entry.error) {
        lines.push(`  ${entry.stackName}: not verified: ${entry.error}`);
        continue;
      }
      const removes = entry.changes.filter((change) => change.action === "Remove").length;
      const replaces = entry.changes.filter((change) => change.replacement === "True").length;
      lines.push(
        `  ${entry.stackName}: ${entry.changes.length} ${entry.changes.length === 1 ? "change" : "changes"} ` +
          `(${replaces} ${replaces === 1 ? "replacement" : "replacements"}, ${removes} ` +
          `${removes === 1 ? "removal" : "removals"}); ` +
          (entry.problems.length === 0
            ? "no AgentCore resource is replaced or removed"
            : `${entry.problems.length} kept ${entry.problems.length === 1 ? "resource" : "resources"} would be replaced or removed`),
      );
      for (const problem of entry.problems) lines.push(`    ${problem}`);
    }
  }
  if (result.migrated) {
    lines.push("", "Files changed");
    for (const change of result.files) lines.push(`  ${change.kind.padEnd(8)}  ${change.path}`);
    if (result.warnings?.length) {
      lines.push("", "Warnings");
      for (const warning of result.warnings) lines.push(`  - ${warning}`);
    }
    lines.push("");
    if (result.report) lines.push(`What changed and what's left to do is in ${result.report}.`);
    lines.push("Next: review the changes (git diff), commit them, then run `agentcore deploy`.");
  } else {
    if (result.error) lines.push("", `Error: ${result.error}`);
    if (result.restored) {
      lines.push(
        "",
        "Nothing was changed: every stack and file is as it was, so the project is still a v0 project.",
      );
    }
    if (result.recovery.length > 0) {
      lines.push("", "To recover");
      result.recovery.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The human-readable plan, printed by a dry run and before applying. */
export function formatMigrationPlan(
  plan: MigrationPlan,
  options: { dryRun?: boolean } = {},
): string {
  const lines: string[] = [];
  const title = plan.projectName ? `project '${plan.projectName}'` : plan.rootPath;
  lines.push(
    `Migration plan for ${title}${options.dryRun === false ? "" : " (dry run: nothing was changed)"}`,
    "",
  );

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
