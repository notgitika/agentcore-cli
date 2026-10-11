/** One precondition `agentcore migrate` checks before it changes anything. */
export type MigrationCheck = {
  /** Short label, e.g. `git`. */
  name: string;
  ok: boolean;
  /** What was found, or what to do about it when the check failed. */
  message: string;
};

/**
 * Something in the project that converts to v1 only after the user changes it:
 * a field v1 validates more strictly than v0, or one v1 cannot express.
 */
export type MigrationProblem = {
  /** Project-relative file the problem is in. */
  file: string;
  /** Field path inside the file, with array entries named where they have a name. */
  path: string;
  message: string;
};

/** The resource kinds whose deployed AWS names a migration pins. */
export type PinnedResourceType =
  | "runtime"
  | "runtime-repository"
  | "memory"
  | "evaluator"
  | "evaluator-function"
  | "online-eval"
  | "policy-engine"
  | "policy"
  | "config-bundle"
  | "harness"
  | "harness-role"
  | "harness-repository"
  | "gateway"
  | "gateway-target-function"
  | "gateway-target-runtime"
  | "tool-runtime"
  | "credential";

/** A deployed resource's existing AWS name, written into agentcore.json so v1 keeps it. */
export type PinnedName = {
  resourceType: PinnedResourceType;
  /** The resource's name in agentcore.json (`engine/policy` for a policy). */
  name: string;
  /** The agentcore.json field the name is written to, relative to the resource. */
  field: string;
  /** The AWS name. */
  value: string;
};

export type FileChangeKind = "added" | "modified" | "removed";

export type FileChange = {
  /** Project-relative path, `/`-separated. */
  path: string;
  kind: FileChangeKind;
};

/** Everything a migration would do to a project, and whether it can. */
export type MigrationPlan = {
  rootPath: string;
  /** Absent when agentcore.json could not be read as a v0 project. */
  projectName?: string;
  checks: MigrationCheck[];
  problems: MigrationProblem[];
  /**
   * Fields v1 drops from already-deployed resources, which would change them on the
   * next deploy. They block the migration like problems do, but are listed apart.
   */
  deployedChanges: MigrationProblem[];
  pins: PinnedName[];
  /** Things the migration drops or the user should know about; none block it. */
  warnings: string[];
  changes: FileChange[];
  /** Every check passed and nothing needs fixing first. */
  ready: boolean;
};

/** Plans the migration of a v0 project to v1. Implemented in src/core/project/migrate. */
export interface ProjectMigrator {
  plan(rootPath: string): Promise<MigrationPlan>;
}
