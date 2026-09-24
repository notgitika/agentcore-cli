import { describe, expect, test } from "bun:test";
import {
  MANAGED_BY_TAG,
  MANAGED_BY_VALUE,
  ownershipTags,
  ownsResource,
  parseStepName,
  physicalName,
  PROJECT_TAG,
  stepName,
  TARGET_TAG,
} from "./naming";

const scope = { projectName: "Shop", targetName: "dev" };

describe("physicalName", () => {
  test("joins project, target and name with underscores", () => {
    expect(physicalName(scope, "runtime", "checkout")).toBe("Shop_dev_checkout");
    expect(physicalName(scope, "memory", "orders")).toBe("Shop_dev_orders");
  });

  test("gateways use hyphens and rewrite underscores, because their names forbid them", () => {
    expect(physicalName(scope, "gateway", "tool_gw")).toBe("Shop-dev-tool-gw");
    expect(physicalName(scope, "gateway-target", "get_order")).toBe("Shop-dev-get-order");
  });

  test("rewrites hyphens for underscore kinds", () => {
    expect(physicalName({ projectName: "Shop", targetName: "us-west" }, "runtime", "a")).toBe(
      "Shop_us_west_a",
    );
  });

  test("is deterministic and unique when shortened to a limit", () => {
    const long = { projectName: "AVeryLongProjectNameHere", targetName: "productionEuropeWest1" };
    const a = physicalName(long, "runtime", "checkout_service_frontend", 48);
    const b = physicalName(long, "runtime", "checkout_service_frontend", 48);
    const c = physicalName(long, "runtime", "checkout_service_backend", 48);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBeLessThanOrEqual(48);
    expect(c.length).toBeLessThanOrEqual(48);
    // The head stays readable; only the tail is replaced by a digest.
    expect(a.startsWith("AVeryLongProjectNameHere_productionEurope")).toBe(true);
  });

  test("leaves a name alone when it fits the limit", () => {
    expect(physicalName(scope, "runtime", "checkout", 48)).toBe("Shop_dev_checkout");
  });
});

describe("ownership tags", () => {
  test("names the project, the target and the backend", () => {
    expect(ownershipTags(scope)).toEqual({
      [PROJECT_TAG]: "Shop",
      [TARGET_TAG]: "dev",
      [MANAGED_BY_TAG]: MANAGED_BY_VALUE,
    });
  });

  test("ownsResource requires all three tags to match", () => {
    expect(ownsResource(scope, ownershipTags(scope))).toBe(true);
    expect(ownsResource(scope, { ...ownershipTags(scope), extra: "x" })).toBe(true);
    expect(ownsResource(scope, { ...ownershipTags(scope), [TARGET_TAG]: "prod" })).toBe(false);
    expect(ownsResource(scope, { [PROJECT_TAG]: "Shop" })).toBe(false);
    expect(ownsResource(scope, undefined)).toBe(false);
  });
});

describe("step names", () => {
  test("round-trips top-level and child resources", () => {
    expect(stepName("runtime", "checkout")).toBe("runtime:checkout");
    expect(stepName("gateway-target", "orders", "tools")).toBe("gateway-target:tools/orders");
    expect(parseStepName("runtime:checkout")).toEqual({ kind: "runtime", name: "checkout" });
    expect(parseStepName("gateway-target:tools/orders")).toEqual({
      kind: "gateway-target",
      name: "orders",
      parent: "tools",
    });
  });

  test("rejects a step name without a kind", () => {
    expect(() => parseStepName("checkout")).toThrow(/not a resource step name/);
  });
});
