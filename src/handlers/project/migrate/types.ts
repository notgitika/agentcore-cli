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

/** A resource in a stack, by logical ID. */
export type StackResource = {
  logicalId: string;
  type: string;
};

/** A deployed resource that a stack refactor moves to a new logical ID, keeping the AWS resource. */
export type StackResourceMove = {
  type: string;
  /** Logical ID in the deployed (v0) stack. */
  from: string;
  /** Logical ID in the v1 template. */
  to: string;
};

/**
 * How much a change the v1 deploy makes after the refactor matters: a blocker
 * stops the migration (an AgentCore resource would be lost), a warning is safe
 * but worth knowing, and info is expected housekeeping.
 */
export type StackChangeSeverity = "blocker" | "warning" | "info";

/** A deployed resource the first v1 deploy after the refactor replaces or deletes. */
export type StackResourceChange = StackResource & {
  severity: StackChangeSeverity;
  /** Why it happens and what it means. */
  reason: string;
};

/** How migrating moves one deployment target's stack onto the v1 template. */
export type StackMigrationPlan = {
  target: string;
  account: string;
  region: string;
  stackName: string;
  /** Deployed resources that move to a new logical ID. */
  moves: StackResourceMove[];
  /** How many deployed resources keep their logical ID. */
  unchanged: number;
  /** Resources the first v1 deploy creates. */
  added: StackResource[];
  /** Deployed resources the first v1 deploy deletes (or, when retained, leaves in the account). */
  removed: StackResourceChange[];
  /** Deployed resources the first v1 deploy replaces with new physical resources. */
  replaced: StackResourceChange[];
  /**
   * Problems with the stack as a whole (its name, the refactor template) that stop
   * it migrating. Resource-level blockers are the removed and replaced entries
   * with severity `blocker`.
   */
  blockers: string[];
  /** No blockers of either kind: the stack can be refactored and deployed as v1 without losing a resource. */
  ready: boolean;
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
  /** One per deployment target with a deployed stack, once its checks pass and the v1 app synthesizes. */
  stacks: StackMigrationPlan[];
  /** Every check passed, nothing needs fixing first, and no stack has a blocker. */
  ready: boolean;
};

export type MigrationPlanOptions = {
  /** Called as planning starts each slow step (reading stacks, installing, synthesizing). */
  onStep?: (message: string) => void;
};

/** One action a created (not yet executed) stack refactor would take, as CloudFormation lists it. */
export type RefactorActionPreview = {
  /** `MOVE` for every resource a migration refactor moves. */
  action: string;
  entity: string;
  /** Logical ID the resource moves from. */
  from: string;
  /** Logical ID the resource moves to. */
  to: string;
  physicalResourceId?: string;
  /** CloudFormation's note, e.g. "No configuration changes detected." */
  description?: string;
};

/** The refactor created for one stack, before it runs. */
export type StackRefactorPreview = {
  target: string;
  stackName: string;
  region: string;
  /** Absent when nothing in the stack needs to move, so no refactor was created. */
  refactorId?: string;
  actions: RefactorActionPreview[];
};

/** A resource change in the change set that previews the first v1 deploy. */
export type ChangeSetResourceChange = {
  logicalId: string;
  type: string;
  /** CloudFormation's action: Add, Modify, Remove, ... */
  action: string;
  /** For a Modify: True, False, or Conditional. */
  replacement?: string;
  /**
   * For a Conditional replacement, the create-only properties that may change and
   * why, as CloudFormation explains it.
   */
  recreatedBy?: {
    property: string;
    /** Static (the template changes it) or Dynamic (it depends on another resource). */
    evaluation: string;
    source: string;
    /** The resource (`LogicalId` or `LogicalId.Attribute`) it depends on. */
    causingEntity?: string;
  }[];
};

/** What the change set previewing the first v1 deploy of a stack showed. */
export type StackVerification = {
  target: string;
  stackName: string;
  changeSetName: string;
  changes: ChangeSetResourceChange[];
  /** AgentCore resources (or ECR repositories, harness roles) it would replace or delete; empty means verified. */
  problems: string[];
};

/**
 * What became of one stack: `refactored` (and still is), `unchanged` (nothing
 * needed moving), `failed` (its refactor failed; CloudFormation rolled it back
 * unless recovery steps say otherwise), `undone` (refactored, then moved back
 * after a later failure), `undo-failed` (refactored, and couldn't be moved back),
 * or `not-started`.
 */
export type StackRefactorOutcome =
  "refactored" | "unchanged" | "failed" | "undone" | "undo-failed" | "not-started";

export type StackRefactorResult = {
  target: string;
  stackName: string;
  region: string;
  outcome: StackRefactorOutcome;
  refactorId?: string;
  /** Why it failed, for the failed outcomes. */
  message?: string;
};

/** What applying a migration did. */
export type MigrationResult = {
  /** The project is v1 and every stack was verified; next is `agentcore deploy`. */
  migrated: boolean;
  stacks: StackRefactorResult[];
  /** Project files the migration changed and left changed; empty when it didn't get that far or put them back. */
  files: FileChange[];
  verification: StackVerification[];
  /** Project-relative path of MIGRATION.md, once written. */
  report?: string;
  /** What went wrong, when the migration didn't complete. */
  error?: string;
  /**
   * After a failure, whether the project and its stacks were put back as they
   * were (so the project is still a working v0 project).
   */
  restored?: boolean;
  /** Steps only the user can take; empty unless something couldn't be undone. */
  recovery: string[];
};

export type MigrationApplyOptions = {
  /** Called as each slow step starts. */
  onStep?: (message: string) => void;
};

/**
 * A planned migration whose working copy (the converted project, its synthesized
 * v1 app) is kept until disposed, so it can be applied exactly as planned.
 */
export interface PreparedMigration {
  plan: MigrationPlan;
  /**
   * Creates each stack's refactor without executing it, so CloudFormation
   * validates it and lists what it will do. Changes nothing.
   */
  preview(options?: MigrationApplyOptions): Promise<StackRefactorPreview[]>;
  /**
   * Refactors the stacks, then writes the converted files into the project,
   * installs and synthesizes the v1 CDK app in place, and verifies with a change
   * set per stack that the first v1 deploy keeps every AgentCore resource. A
   * failure at any step puts the stacks and files back as they were.
   */
  apply(options?: MigrationApplyOptions): Promise<MigrationResult>;
  /** Deletes the working copy. */
  dispose(): Promise<void>;
}

/** Plans and applies the migration of a v0 project to v1. Implemented in src/core/project/migrate. */
export interface ProjectMigrator {
  plan(rootPath: string, options?: MigrationPlanOptions): Promise<MigrationPlan>;
  prepare(rootPath: string, options?: MigrationPlanOptions): Promise<PreparedMigration>;
}
