import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type {
  FileChange,
  MigrationPlan,
  StackRefactorResult,
  StackVerification,
} from "../../../handlers/project/migrate/types";

/** The report a migration leaves in the project root. */
export const REPORT_FILE = "MIGRATION.md";

/** Agent code that reads a name v1 no longer sets. */
export type CodeNote = {
  /** Project-relative path. */
  file: string;
  /** What the code reads. */
  reads: string;
  /** What v1 sets instead. */
  instead: string;
};

const SOURCE_FILE = /\.(?:py|ts|tsx|js|mjs|cjs|java|go|rs|kt)$/;
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".git",
  "dist",
  "build",
  "cdk.out",
]);

/**
 * v0 put a credential's provider name in `CREDENTIAL_<NAME>_NAME`; v1 puts it in
 * `AGENTCORE_CREDENTIAL_<NAME>_NAME` (the provider itself is kept). Memory and
 * connection variables have the same names in both, so only these need a look.
 */
const V0_CREDENTIAL_VARIABLE = /(?<![A-Z0-9_])CREDENTIAL_([A-Z0-9_]+)_NAME\b/g;

/**
 * Finds agent code under `directories` that reads environment variables v1
 * renamed, so the report can say which files to update.
 */
export async function scanAgentCode(rootPath: string, directories: string[]): Promise<CodeNote[]> {
  const notes: CodeNote[] = [];
  const seen = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await visit(path);
        continue;
      }
      if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) continue;
      const file = relative(rootPath, path).split(sep).join("/");
      if (seen.has(file)) continue;
      seen.add(file);
      const text = await readFile(path, "utf8").catch(() => "");
      const names = new Set([...text.matchAll(V0_CREDENTIAL_VARIABLE)].map((match) => match[0]));
      for (const reads of names) notes.push({ file, reads, instead: `AGENTCORE_${reads}` });
    }
  };
  for (const directory of directories) await visit(join(rootPath, directory));
  return notes;
}

export type ReportInput = {
  plan: MigrationPlan;
  stacks: StackRefactorResult[];
  verification: StackVerification[];
  files: FileChange[];
  codeNotes: CodeNote[];
  /** Whether a CDK library override was in effect (development builds only). */
  libraryOverride?: string;
  date: Date;
};

/**
 * MIGRATION.md: what the migration changed (files, stacks, kept names), what it
 * couldn't carry over, and what to do next. Written for whoever reviews the
 * migration commit.
 */
export function migrationReport(input: ReportInput): string {
  const { plan } = input;
  const lines: string[] = [];
  const project = plan.projectName ?? "this project";
  lines.push(
    "# Migrated to AgentCore CLI v1",
    "",
    `\`agentcore migrate\` moved ${project === "this project" ? project : `project \`${project}\``} ` +
      `from the AgentCore CLI v0 to v1 on ${input.date.toISOString().slice(0, 10)}. Every deployed ` +
      "AgentCore resource, ECR repository, and harness role was kept: none was replaced, " +
      "renamed, or recreated, and their IDs, ARNs, URLs, and data are unchanged. What the first " +
      "v1 deploy does to the stacks' other resources is listed under each stack below.",
    "",
    "## What changed",
    "",
    "### Project files",
    "",
  );
  const cdkFiles = input.files.filter((change) => change.path.startsWith("agentcore/cdk/"));
  for (const change of input.files.filter((entry) => !entry.path.startsWith("agentcore/cdk/"))) {
    lines.push(`- ${change.kind} \`${change.path}\`${fileNote(change)}`);
  }
  if (cdkFiles.length > 0) {
    lines.push("- replaced `agentcore/cdk/` with the v1 CDK app, and installed its dependencies");
  }
  lines.push(
    "- kept `agentcore/.cli/deployed-state.json` as it was; v1 reads it",
    "",
    "No other file was changed: agent code is as it was.",
    "",
    "### Deployed stacks",
    "",
  );
  if (input.stacks.length === 0) {
    lines.push("Nothing was deployed, so no stack was changed.", "");
  }
  for (const stack of input.stacks) {
    const planned = plan.stacks.find((entry) => entry.stackName === stack.stackName);
    const moves = planned?.moves ?? [];
    lines.push(`#### \`${stack.stackName}\` (target \`${stack.target}\`, ${stack.region})`, "");
    if (stack.outcome === "unchanged" || moves.length === 0) {
      lines.push("Every resource already had its v1 logical ID, so the stack wasn't refactored.");
    } else {
      lines.push(
        `A CloudFormation stack refactor${stack.refactorId ? ` (\`${stack.refactorId}\`)` : ""} ` +
          `moved ${moves.length} ${moves.length === 1 ? "resource" : "resources"} to the logical ` +
          "IDs the v1 CDK app uses, without changing them:",
        "",
      );
      for (const move of moves) lines.push(`- ${move.type}: \`${move.from}\` → \`${move.to}\``);
    }
    const verified = input.verification.find((entry) => entry.stackName === stack.stackName);
    if (verified) lines.push("", ...firstDeploy(verified));
    lines.push("");
  }

  lines.push("## Names kept", "");
  if (plan.pins.length === 0) {
    lines.push("None: nothing was deployed, so every resource gets a v1 name on its first deploy.");
  } else {
    lines.push(
      "`agentcore.json` pins the AWS name of every deployed resource, so v1 keeps using it:",
      "",
    );
    for (const pin of plan.pins) {
      lines.push(`- ${pin.resourceType} \`${pin.name}\`: \`${pin.field}\` = \`${pin.value}\``);
    }
  }
  lines.push("");

  const todo = [
    ...plan.warnings,
    ...input.codeNotes.map(
      (note) =>
        `\`${note.file}\` reads \`${note.reads}\`, which v1 no longer sets. Read ` +
        `\`${note.instead}\` instead (the credential provider is the same).`,
    ),
    ...(input.libraryOverride
      ? [
          "`agentcore/cdk/package.json` depends on a development build of `@aws/agentcore-cdk` " +
            `(\`${input.libraryOverride}\`, from AGENTCORE_MIGRATE_CDK_LIBRARY). Point it back at a ` +
            "released version before committing.",
        ]
      : []),
  ];
  lines.push("## Left to do", "");
  if (todo.length === 0) {
    lines.push("Nothing: the migration carried everything over.");
  } else {
    for (const item of todo) lines.push(`- ${item}`);
  }
  lines.push(
    "",
    "Agent code generated by the v0 CLI keeps working: v1 sets the same environment variables " +
      "for memories (`MEMORY_<NAME>_ID`), gateways, browsers, and code interpreters.",
    "",
    "## Next step",
    "",
    "1. Review the changes with `git status` and `git diff`, and commit them.",
    "2. Run `agentcore deploy`. Its first deploy changes the stacks as previewed above.",
    "",
    "Going back to v0 takes more than restoring the files from git: the stacks' resources have " +
      "to be moved back to their v0 logical IDs first (a stack refactor with the moves above " +
      "reversed). A v0 deploy to a stack that wasn't moved back deletes and recreates them.",
    "",
  );
  return lines.join("\n");
}

function fileNote(change: FileChange): string {
  if (change.path === "agentcore/agentcore.json") return ": now a v1 (version 2) project spec";
  if (change.path.endsWith("/harness.json") && change.kind === "removed") {
    return ": replaced by harness.yaml";
  }
  if (change.path.endsWith("/harness.yaml") && change.kind === "added") {
    return ": converted from harness.json";
  }
  return "";
}

function firstDeploy(verification: StackVerification): string[] {
  const count = (action: string) =>
    verification.changes.filter((change) => change.action === action);
  const modified = count("Modify");
  const replaced = modified.filter((change) => change.replacement === "True");
  const lines = [
    "The first v1 deploy was previewed with a change set (never executed). It adds " +
      `${count("Add").length}, updates ${modified.length} (${replaced.length} by replacement), ` +
      `and removes ${count("Remove").length} of the stack's resources; no AgentCore resource is ` +
      "replaced or removed.",
  ];
  const notable = verification.changes.filter(
    (change) => change.action === "Remove" || change.replacement === "True",
  );
  if (notable.length > 0) {
    lines.push("");
    for (const change of notable) {
      lines.push(
        `- ${change.action === "Remove" ? "removes" : "replaces"} ${change.type} \`${change.logicalId}\``,
      );
    }
  }
  return lines;
}
