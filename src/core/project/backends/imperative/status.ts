import { Status, type StatusReport } from "./plan/plan";

const CONVERGED = new Set(["READY", "ACTIVE"]);
const IN_PROGRESS = new Set([
  "CREATING",
  "UPDATING",
  "DELETING",
  "SYNCHRONIZING",
  "PROVISIONING",
  "PENDING_AUTHENTICATION",
]);
const FAILED = new Set([
  "FAILED",
  "CREATE_FAILED",
  "UPDATE_FAILED",
  "DELETE_FAILED",
  "UPDATE_UNSUCCESSFUL",
  "SYNCHRONIZE_UNSUCCESSFUL",
  "ERROR",
  "AUTHENTICATION_FAILED",
  "AUTHENTICATION_EXPIRED",
  "AWS_MARKETPLACE_SUBSCRIPTION_REQUIRED",
]);

/**
 * Maps an AgentCore resource status to the plan engine's vocabulary. Every kind
 * uses one of two converged words and a shared set of failure words, so one
 * table serves all of them. An unknown status is treated as still in progress:
 * the step timeout bounds how long that can last, and the detail says why.
 */
export function fromServiceStatus(
  status: string | undefined,
  options: { statusReason?: string } = {},
): StatusReport {
  if (status === undefined) return { status: Status.Waiting, detail: "status not reported yet" };
  if (CONVERGED.has(status)) return { status: Status.Successful };
  if (FAILED.has(status)) {
    const detail = options.statusReason ? `${status}: ${options.statusReason}` : status;
    return { status: Status.Failed, detail };
  }
  if (IN_PROGRESS.has(status) || status.endsWith("_PENDING_AUTH")) {
    return { status: Status.Waiting, detail: status };
  }
  return { status: Status.Waiting, detail: `unrecognized status ${status}` };
}
