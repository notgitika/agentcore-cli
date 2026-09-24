import { NotImplementedError } from "../../../../../errors";
import type { Project } from "../../../../../handlers/project/types";
import type { DeclaredResource } from "../inventory";
import type { ResourceKind } from "../naming";
import type { Doer, Statuser } from "../plan/plan";
import type { AgentCoreStack } from "./stack";

/**
 * One kind's four operations, the `Create*`/`Poll*` pairs of the prior art.
 * `create` and `remove` start work; `poll` and `pollGone` observe it. Each
 * returns a closure the plan installs as a step's `do` or `status`.
 */
export type KindHandlers = {
  create(stack: AgentCoreStack, resource: DeclaredResource, spec: Project["spec"]): Doer;
  poll(stack: AgentCoreStack, resource: DeclaredResource, spec: Project["spec"]): Statuser;
  remove(stack: AgentCoreStack, resource: DeclaredResource): Doer;
  pollGone(stack: AgentCoreStack, resource: DeclaredResource): Statuser;
};

/**
 * The handlers every kind starts with. `assertImperativelyDeployable` keeps a
 * plan holding one of these from ever executing, so the throw is a backstop for
 * a registry mistake, not a user-facing path.
 */
export function notImplemented(kind: ResourceKind): KindHandlers {
  const fail = () => {
    throw new NotImplementedError(`imperative deploy of ${kind} is not implemented yet`);
  };
  return {
    create: () => async () => fail(),
    poll: () => async () => fail(),
    remove: () => async () => fail(),
    pollGone: () => async () => fail(),
  };
}
