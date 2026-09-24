import { describe, expect, test } from "bun:test";
import { Status } from "./plan/plan";
import { fromServiceStatus } from "./status";

describe("fromServiceStatus", () => {
  test.each([
    ["READY", Status.Successful],
    ["ACTIVE", Status.Successful],
    ["CREATING", Status.Waiting],
    ["UPDATING", Status.Waiting],
    ["DELETING", Status.Waiting],
    ["SYNCHRONIZING", Status.Waiting],
    ["PROVISIONING", Status.Waiting],
    ["PENDING_AUTHENTICATION", Status.Waiting],
    ["CREATE_PENDING_AUTH", Status.Waiting],
    ["FAILED", Status.Failed],
    ["CREATE_FAILED", Status.Failed],
    ["UPDATE_FAILED", Status.Outdated],
    ["DELETE_FAILED", Status.Failed],
    ["UPDATE_UNSUCCESSFUL", Status.Outdated],
    ["SYNCHRONIZE_UNSUCCESSFUL", Status.Failed],
    ["ERROR", Status.Failed],
    ["AUTHENTICATION_FAILED", Status.Failed],
    ["AUTHENTICATION_EXPIRED", Status.Failed],
    ["AWS_MARKETPLACE_SUBSCRIPTION_REQUIRED", Status.Failed],
  ])("%s → %s", (service, expected) => {
    expect(fromServiceStatus(service).status).toBe(expected);
  });

  test("carries the service status as detail while waiting", () => {
    expect(fromServiceStatus("CREATING")).toEqual({ status: Status.Waiting, detail: "CREATING" });
  });

  test("a failure carries the status and the reason", () => {
    expect(fromServiceStatus("CREATE_FAILED", { statusReason: "role not assumable" })).toEqual({
      status: Status.Failed,
      detail: "CREATE_FAILED: role not assumable",
    });
    expect(fromServiceStatus("FAILED").detail).toBe("FAILED");
  });

  test("a failed update is outdated, so the next deploy retries it, and says why", () => {
    expect(fromServiceStatus("UPDATE_FAILED", { statusReason: "bad role" })).toEqual({
      status: Status.Outdated,
      detail: "UPDATE_FAILED: bad role",
    });
    expect(fromServiceStatus("UPDATE_UNSUCCESSFUL")).toEqual({
      status: Status.Outdated,
      detail: "UPDATE_UNSUCCESSFUL",
    });
  });

  test("no status yet is waiting, not failed", () => {
    expect(fromServiceStatus(undefined)).toEqual({
      status: Status.Waiting,
      detail: "status not reported yet",
    });
  });

  test("an unknown status keeps waiting and says so, so the step timeout bounds it", () => {
    expect(fromServiceStatus("MIGRATING")).toEqual({
      status: Status.Waiting,
      detail: "unrecognized status MIGRATING",
    });
  });
});
