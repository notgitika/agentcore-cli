import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Everything under backends/shared/ is meant for every backend, so nothing in
// it may reach back into the CDK backend or the CDK Toolkit. A second backend
// importing shared code must not drag toolkit-lib into its import graph.
describe("backends/shared boundary", () => {
  const dir = import.meta.dir;
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  test("has at least the modules this test protects", () => {
    expect(sources).toEqual(
      expect.arrayContaining(["account.ts", "credentials.ts", "deployedState.ts", "types.ts"]),
    );
  });

  for (const file of sources) {
    test(`${file} does not import CDK code`, () => {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text).not.toMatch(/from "\.\.?\/cdk/);
      expect(text).not.toMatch(/@aws-cdk\//);
    });
  }
});
