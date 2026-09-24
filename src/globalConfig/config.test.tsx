import { describe, expect, test } from "bun:test";
import { applyOverrides, DEFAULT_GLOBAL_CONFIG } from "./config";
import { globalConfigFileSchema } from "./types";

describe("imperative-deploy flag", () => {
  test("defaults to false", () => {
    expect(DEFAULT_GLOBAL_CONFIG["imperative-deploy"]).toBe(false);
  });

  test("is accepted by the file schema and applied as an override", () => {
    const data = globalConfigFileSchema.parse({ "imperative-deploy": true });
    expect(applyOverrides(DEFAULT_GLOBAL_CONFIG, data)["imperative-deploy"]).toBe(true);
  });

  test("an absent override keeps the default", () => {
    expect(applyOverrides(DEFAULT_GLOBAL_CONFIG, {})["imperative-deploy"]).toBe(false);
  });
});
