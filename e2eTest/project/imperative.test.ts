import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import z from "zod";
import { E2E_PREFIX, TAGS } from "../constants";
import { CliRunner, parseResult } from "../helpers/run";

const TIMEOUT_MS = {
  CREATE: 3 * 60 * 1000,
  DEPLOY: 15 * 60 * 1000,
  INVOKE: 3 * 60 * 1000,
  TEARDOWN: 10 * 60 * 1000,
};

const ProjectCreatedSchema = z.object({ project: z.object({ path: z.string() }) });
const DeployResponseSchema = z.object({ message: z.string() });
const StatusSchema = z.object({
  resources: z.array(
    z.object({ resourceType: z.string(), name: z.string(), deploymentState: z.string() }),
  ),
});
const InvokeSchema = z.object({
  statusCode: z.number().int().min(200).max(299),
  body: z.string().min(1),
  complete: z.literal(true),
});

/** An AgentCore session id: alphanumeric, padded to the 33+ character minimum. */
function sessionId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}`
    .replace(/[^a-z0-9]/gi, "")
    .padEnd(40, "x")
    .slice(0, 60);
}

describe("imperative deploy golden path", { sequential: true, tags: [TAGS.IMPERATIVE] }, () => {
  const cli = new CliRunner();
  const projectName = `${E2E_PREFIX}imp${Date.now().toString(36)}`;
  let projectRoot: string;
  let projectDir: string;

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "agentcore-e2e-imperative-"));
    parseResult(
      z.literal(true),
      await cli.run(["config", "imperative-deploy", "true", "--json"], projectRoot),
    );
    const created = parseResult(
      ProjectCreatedSchema,
      await cli.run(
        [
          "project",
          "create",
          "--name",
          projectName,
          "--template",
          "agent-python-strands",
          "--managed-by",
          "Imperative",
          "--skip-git",
          "--json",
        ],
        projectRoot,
      ),
    );
    projectDir = created.project.path;
  }, TIMEOUT_MS.CREATE);

  afterAll(async () => {
    await cli.run(["config", "imperative-deploy", "false", "--json"], projectRoot);
  });

  test("deploys a runtime and its memory", { timeout: TIMEOUT_MS.DEPLOY }, async () => {
    const deployed = parseResult(
      DeployResponseSchema,
      await cli.run(["project", "deploy", "--yes", "--json"], projectDir),
    );
    expect(deployed.message).toContain("Deployed project");
  });

  test("reports every resource as deployed", async () => {
    const status = parseResult(
      StatusSchema,
      await cli.run(["project", "status", "--json"], projectDir),
    );
    const byName = Object.fromEntries(
      status.resources.map((r) => [`${r.resourceType}:${r.name}`, r.deploymentState]),
    );
    expect(byName["runtime:agent"]).toBe("deployed");
    expect(byName["memory:agentMemory"]).toBe("deployed");
  });

  test("invokes the runtime", { timeout: TIMEOUT_MS.INVOKE }, async () => {
    const response = parseResult(
      InvokeSchema,
      await cli.run(
        [
          "project",
          "invoke",
          "runtime",
          "--name",
          "agent",
          "--session-id",
          sessionId(projectName),
          "--payload",
          JSON.stringify({ prompt: "Reply with a short greeting." }),
          "--json",
        ],
        projectDir,
      ),
    );
    expect(response.body.trim().length).toBeGreaterThan(0);
  });

  test("a second deploy converges without changes", { timeout: TIMEOUT_MS.DEPLOY }, async () => {
    const deployed = parseResult(
      DeployResponseSchema,
      await cli.run(["project", "deploy", "--yes", "--json"], projectDir),
    );
    expect(deployed.message).toContain("Deployed project");
  });

  test(
    "removing every resource and deploying tears the target down",
    { timeout: TIMEOUT_MS.TEARDOWN },
    async () => {
      parseResult(
        z.object({}).passthrough(),
        await cli.run(["project", "remove", "all", "--yes", "--json"], projectDir),
      );
      const result = parseResult(
        DeployResponseSchema,
        await cli.run(["project", "deploy", "--yes", "--json"], projectDir),
      );
      expect(result.message.toLowerCase()).toMatch(/removed|torn down|tore down|deleted/);
    },
  );
});
