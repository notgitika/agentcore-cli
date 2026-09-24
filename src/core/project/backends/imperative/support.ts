import { NotImplementedError, ProjectStateError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";
import { declaredResources } from "./inventory";
import type { ResourceKind } from "./naming";

/**
 * Kinds the imperative backend can create today. Each phase adds to this set as
 * its kind module lands (design §4.7). Phase 1 ships the engine and no kinds.
 */
export const SUPPORTED_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>([]);

const CDK_ESCAPE_HATCH = `Set managedBy to "CDK" in agentcore/agentcore.json to deploy it with CloudFormation.`;

/**
 * Fails before any AWS call when the spec declares something this backend
 * cannot deploy: a container-built runtime (deferred until the build strategy is
 * decided, design §2) or a resource kind whose module has not shipped.
 */
export function assertImperativelyDeployable(
  project: Project,
  supported: ReadonlySet<ResourceKind>,
): void {
  const container = project.spec.runtimes.find((runtime) => runtime.build === "Container");
  if (container) {
    throw new ProjectStateError(
      `Project '${project.name}' cannot be deployed imperatively: runtime '${container.name}' ` +
        `is built as a Container, which imperative deploy does not support yet. Switch it to a ` +
        `CodeZip build, or ${CDK_ESCAPE_HATCH}`,
    );
  }

  // Tool runtimes are not in the declared inventory at all, so without this they
  // would pass the gate unseen.
  if (project.spec.toolRuntimes?.length) {
    throw new NotImplementedError(
      `Project '${project.name}' cannot be deployed imperatively: imperative deploy does not ` +
        `support toolRuntimes yet. ${CDK_ESCAPE_HATCH}`,
    );
  }

  const unsupported = [...new Set(declaredResources(project.spec).map(({ kind }) => kind))].filter(
    (kind) => !supported.has(kind),
  );
  if (unsupported.length > 0) {
    throw new NotImplementedError(
      `Project '${project.name}' cannot be deployed imperatively: imperative deploy does not ` +
        `support these resource kinds yet: ${unsupported.join(", ")}. ${CDK_ESCAPE_HATCH}`,
    );
  }
}
