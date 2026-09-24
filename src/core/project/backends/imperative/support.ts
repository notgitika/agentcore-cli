import { NotImplementedError, ProjectStateError } from "../../../../errors";
import type { Project } from "../../../../handlers/project/types";
import { declaredResources } from "./inventory";
import type { ResourceKind } from "./naming";

/**
 * Kinds the imperative backend can create today. Each phase adds to this set as
 * its kind module lands (design §4.7). Phase 2 adds runtimes, their endpoints and memories.
 */
export const SUPPORTED_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  "runtime",
  "runtime-endpoint",
  "memory",
]);

const CDK_ESCAPE_HATCH = `Set managedBy to "CDK" in agentcore/agentcore.json to deploy it with CloudFormation.`;

/** The first runtime feature the imperative runtime handler does not deploy, if any. */
function unsupportedRuntimeFeature(
  runtime: Project["spec"]["runtimes"][number],
): string | undefined {
  if (runtime.runtimeVersion?.startsWith("NODE_")) {
    return `runtimeVersion ${runtime.runtimeVersion} (Node.js CodeZip runtimes)`;
  }
  if (runtime.authorizerConfiguration || runtime.authorizerType) {
    return "an authorizer (authorizerType / authorizerConfiguration)";
  }
  if (runtime.filesystemConfigurations?.length) return "filesystemConfigurations";
  if (runtime.connections?.length) return "connections";
  return undefined;
}

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
  for (const runtime of project.spec.runtimes) {
    const feature = unsupportedRuntimeFeature(runtime);
    if (feature) {
      throw new NotImplementedError(
        `Project '${project.name}' cannot be deployed imperatively: runtime '${runtime.name}' uses ` +
          `${feature}, which imperative deploy does not support yet. ${CDK_ESCAPE_HATCH}`,
      );
    }
  }
  const streaming = project.spec.memories.find((memory) => memory.streamDeliveryResources);
  if (streaming) {
    throw new NotImplementedError(
      `Project '${project.name}' cannot be deployed imperatively: memory '${streaming.name}' ` +
        `declares streamDeliveryResources, which imperative deploy does not support yet. ` +
        CDK_ESCAPE_HATCH,
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
