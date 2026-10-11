import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { FileChange } from "../../../handlers/project/migrate/types";

/** Where the v0 files a migration replaces are kept until it completes, relative to the project root. */
export const BACKUP_RELATIVE_PATH = join("agentcore", ".cli", "migrate-backup");

const CDK_RELATIVE_PATH = join("agentcore", "cdk");

/** Never copied out of the workspace's CDK app: they're rebuilt in place. */
const NOT_COPIED = new Set(["node_modules", "cdk.out"]);

/** Undoes or keeps a set of file writes. */
export type ProjectFilesBackup = {
  /** Puts every file back as it was before the writes. */
  restore(): Promise<void>;
  /** Keeps the writes and deletes the backup. */
  discard(): Promise<void>;
};

/**
 * Writes the migrated project from the workspace into the project: the workspace's
 * v1 CDK app replaces agentcore/cdk wholesale (the v0 app, with its installed
 * dependencies, is moved aside), and every other changed file is copied over or
 * deleted. Each file is backed up first, under agentcore/.cli (which git ignores),
 * so a later failure can put the project back exactly; agentcore.json is written
 * last, so until it is the project still reads as v0.
 */
export async function writeMigratedFiles(input: {
  rootPath: string;
  workspaceDirectory: string;
  changes: FileChange[];
}): Promise<ProjectFilesBackup> {
  const { rootPath, workspaceDirectory } = input;
  const backup = join(rootPath, BACKUP_RELATIVE_PATH);
  await rm(backup, { recursive: true, force: true });
  await mkdir(backup, { recursive: true });

  const files = input.changes
    .filter((change) => !isUnder(change.path, CDK_RELATIVE_PATH))
    // agentcore.json last: an interrupted write leaves a project that is still v0.
    .sort((a, b) => Number(isSpec(a.path)) - Number(isSpec(b.path)));
  const written: FileChange[] = [];
  let cdkMoved = false;

  const restore = async () => {
    for (const change of [...written].reverse()) {
      const target = join(rootPath, change.path);
      if (change.kind === "added") {
        await rm(target, { force: true });
        await removeEmptyParents(rootPath, dirname(target));
      } else {
        await mkdir(dirname(target), { recursive: true });
        await cp(join(backup, "files", change.path), target);
      }
    }
    if (cdkMoved) {
      const cdk = join(rootPath, CDK_RELATIVE_PATH);
      await rm(cdk, { recursive: true, force: true });
      if (existsSync(join(backup, "cdk"))) await rename(join(backup, "cdk"), cdk);
    }
    await rm(backup, { recursive: true, force: true });
  };

  try {
    const cdk = join(rootPath, CDK_RELATIVE_PATH);
    if (existsSync(cdk)) await rename(cdk, join(backup, "cdk"));
    cdkMoved = true;
    const workspaceCdk = join(workspaceDirectory, CDK_RELATIVE_PATH);
    await cp(workspaceCdk, cdk, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (source) =>
        !relative(workspaceCdk, source)
          .split(sep)
          .some((part) => NOT_COPIED.has(part)),
    });

    for (const change of files) {
      const target = join(rootPath, change.path);
      if (change.kind !== "added") {
        const saved = join(backup, "files", change.path);
        await mkdir(dirname(saved), { recursive: true });
        await cp(target, saved);
      }
      written.push(change);
      if (change.kind === "removed") {
        await rm(target, { force: true });
        await removeEmptyParents(rootPath, dirname(target));
      } else {
        await mkdir(dirname(target), { recursive: true });
        await cp(join(workspaceDirectory, change.path), target);
      }
    }
  } catch (error) {
    await restore();
    throw error;
  }
  return { restore, discard: () => rm(backup, { recursive: true, force: true }) };
}

function isUnder(path: string, directory: string): boolean {
  const normalized = path.split("/").join(sep);
  return normalized === directory || normalized.startsWith(`${directory}${sep}`);
}

function isSpec(path: string): boolean {
  return path === "agentcore/agentcore.json";
}

/** Deletes `directory` and its parents while they're empty, stopping at the project root. */
async function removeEmptyParents(rootPath: string, directory: string): Promise<void> {
  for (let current = directory; current !== rootPath && current.startsWith(rootPath);) {
    try {
      await rmdir(current);
    } catch {
      // Not empty (or already gone): nothing above it can be empty either.
      return;
    }
    current = dirname(current);
  }
}
