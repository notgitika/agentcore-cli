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
  "DELETE_FAILED",
  "SYNCHRONIZE_UNSUCCESSFUL",
  "ERROR",
  "AUTHENTICATION_FAILED",
  "AUTHENTICATION_EXPIRED",
  "AWS_MARKETPLACE_SUBSCRIPTION_REQUIRED",
]);
/**
 * A failed update leaves the resource in place but not at the spec. Reporting it
 * as outdated makes the next deploy run `do` again instead of refusing forever.
 */
const UPDATE_FAILED = new Set(["UPDATE_FAILED", "UPDATE_UNSUCCESSFUL"]);

/**
 * Maps an AgentCore resource status to the plan engine's vocabulary. Every kind
 * uses one of two converged words and a shared set of failure words, so one
 * table serves all of them. A failed update maps to OUTDATED so a re-deploy
 * repairs it. An unknown status is treated as still in progress:
 * the step timeout bounds how long that can last, and the detail says why.
 */
export function fromServiceStatus(
  status: string | undefined,
  options: { statusReason?: string } = {},
): StatusReport {
  if (status === undefined) return { status: Status.Waiting, detail: "status not reported yet" };
  if (CONVERGED.has(status)) return { status: Status.Successful };
  const detail = options.statusReason ? `${status}: ${options.statusReason}` : status;
  if (UPDATE_FAILED.has(status)) return { status: Status.Outdated, detail };
  if (FAILED.has(status)) return { status: Status.Failed, detail };
  if (IN_PROGRESS.has(status) || status.endsWith("_PENDING_AUTH")) {
    return { status: Status.Waiting, detail: status };
  }
  return { status: Status.Waiting, detail: `unrecognized status ${status}` };
}
