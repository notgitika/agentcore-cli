import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessSpecSchema } from "../../../../projectSchemas/harness";
import { ProjectRuntimeSchema } from "../../../../projectSchemas/runtime";
import {
  assertNewLocalWorkloads,
  buildArgumentRedactor,
  checkLocalContainerBuilder,
  redactBuildError,
  type ContainerTemplate,
} from "./localContainers";

describe("local container builder prerequisites", () => {
  const projects: string[] = [];
  const projectDirectory = () => {
    const path = mkdtempSync(join(tmpdir(), "agentcore-builder-test-"));
    projects.push(path);
    return path;
  };
  afterEach(() => {
    for (const path of projects.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  test("accepts a native Linux ARM64 daemon without probing or creating builders", async () => {
    const commands: string[][] = [];
    await checkLocalContainerBuilder(
      async (command, options) => {
        commands.push(command);
        options.onOutput?.('{"OSType":"linux","Architecture":"aarch64"}');
      },
      "/project",
      "/tools/docker-wrapper",
    );
    expect(commands).toEqual([["/tools/docker-wrapper", "info", "--format", "{{json .}}"]]);
  });
  test("accepts formatted daemon information alongside Finch stderr diagnostics", async () => {
    const commands: string[][] = [];
    await checkLocalContainerBuilder(
      async (command, options) => {
        commands.push(command);
        options.onOutput?.('time="now" level=warning msg="config {defaults}"\n');
        options.onOutput?.('{"OSType":"linux","Architecture":"arm64"}\n');
        options.onOutput?.('{"diagnostic":"after daemon output"}\n');
      },
      "/project",
      "finch",
    );
    expect(commands).toHaveLength(1);
  });

  test.each(["linux/arm64", "linux/arm64/v8", "linux/arm64*"])(
    "accepts advertised %s support without building or provisioning a builder",
    async (platform) => {
      const commands: string[][] = [];
      await checkLocalContainerBuilder(
        async (command, options) => {
          commands.push(command);
          options.onOutput?.(
            command[1] === "info"
              ? '{"OSType":"linux","Architecture":"x86_64"}'
              : `Platforms: linux/amd64*, ${platform}\n`,
          );
        },
        "/project",
        "docker",
      );
      expect(commands).toEqual([
        ["docker", "info", "--format", "{{json .}}"],
        ["docker", "buildx", "inspect"],
      ]);
    },
  );

  test.each(["unsupported buildx", "unadvertised ARM64", "failed buildx with partial output"])(
    "checks real ARM64 execution for a compatible builder with %s",
    async (capabilities) => {
      const commands: string[][] = [];
      const project = projectDirectory();
      let context = "";
      await checkLocalContainerBuilder(
        async (command, options) => {
          commands.push(command);
          if (command[1] === "info") {
            options.onOutput?.('{"OSType":"linux","Architecture":"x86_64"}');
          } else if (command[1] === "buildx") {
            if (capabilities === "unadvertised ARM64") {
              options.onOutput?.("Platforms: linux/amd64\n");
              return;
            }
            if (capabilities === "failed buildx with partial output") {
              options.onOutput?.("Platforms: linux/arm64\n");
            }
            throw new Error('unknown command "buildx"');
          } else if (command[1] === "build") {
            context = options.cwd;
            expect(context.startsWith(join(project, ".agentcore-arm64-"))).toBe(true);
            expect(readFileSync(join(context, "Dockerfile"), "utf8")).toBe(
              'FROM scratch\nCOPY --chmod=0555 arm64-check /arm64-check\nRUN ["/arm64-check"]\n',
            );
            const executable = readFileSync(join(context, "arm64-check"));
            expect(executable.subarray(0, 4).toString("hex")).toBe("7f454c46");
            expect(executable.readUInt16LE(18)).toBe(183); // ELF machine: AArch64.
            expect(options.signal).toBeInstanceOf(AbortSignal);
            expect(existsSync(join(context, "output"))).toBe(true);
            writeFileSync(join(context, "output", "arm64-check"), executable);
          } else {
            throw new Error(`Unexpected builder command: ${command.join(" ")}`);
          }
        },
        project,
        "/tools/finch wrapper",
      );
      expect(commands[2]).toEqual([
        "/tools/finch wrapper",
        "build",
        "--platform",
        "linux/arm64",
        "--network",
        "none",
        "--no-cache",
        "--output",
        "type=local,dest=output",
        "--file",
        "Dockerfile",
        ".",
      ]);
      expect(existsSync(context)).toBe(false);
    },
  );

  test("refuses an unavailable daemon with an actionable error", async () => {
    await expect(
      checkLocalContainerBuilder(
        async () => {
          throw new Error("daemon denied");
        },
        "/project",
        "docker",
      ),
    ).rejects.toThrow("daemon is running");
  });

  test("refuses an x86 builder without Linux ARM64 capability", async () => {
    const project = projectDirectory();
    let context = "";
    const buildError = new Error("exec format error");
    await expect(
      checkLocalContainerBuilder(
        async (command, options) => {
          if (command[1] === "build") {
            context = options.cwd;
            throw buildError;
          }
          options.onOutput?.(
            command[1] === "info"
              ? '{"OSType":"linux","Architecture":"x86_64"}'
              : "Platforms: linux/amd64\n",
          );
        },
        project,
        "docker",
      ),
    ).rejects.toThrow("Linux ARM64 build support");
    expect(context).not.toBe("");
    expect(existsSync(context)).toBe(false);
  });

  test("reports a failed Finch build and cleans up its context", async () => {
    const project = projectDirectory();
    let context = "";
    const buildError = new Error("configured BuildKit is unavailable");
    let caught: unknown;
    try {
      await checkLocalContainerBuilder(
        async (command, options) => {
          if (command[1] === "info") {
            options.onOutput?.('{"OSType":"linux","Architecture":"x86_64"}');
          } else if (command[1] === "buildx") {
            throw new Error('unknown command "buildx"');
          } else {
            context = options.cwd;
            throw buildError;
          }
        },
        project,
        "finch",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("network-free ARM64 test build failed");
    expect((caught as Error).cause).toBe(buildError);
    expect(context).not.toBe("");
    expect(existsSync(context)).toBe(false);
  });

  test("refuses invalid daemon information before building", async () => {
    const commands: string[][] = [];
    await expect(
      checkLocalContainerBuilder(
        async (command, options) => {
          commands.push(command);
          options.onOutput?.("not JSON");
        },
        "/project",
        "finch",
      ),
    ).rejects.toThrow("invalid daemon information");
    expect(commands).toHaveLength(1);
  });
});

describe("container configuration", () => {
  const networkConfig = {
    subnets: ["subnet-0123456789abcdef0"],
    securityGroups: Array.from({ length: 6 }, (_, index) => `sg-0123456789abcde${index}0`),
  };
  test("local runtime builds use workload networking limits rather than CodeBuild requirements", () => {
    expect(
      ProjectRuntimeSchema.safeParse({
        name: "agent",
        build: "Container-local",
        codeLocation: "app/agent",
        entrypoint: "main.py",
        dockerfile: "Dockerfile",
        networkMode: "VPC",
        networkConfig,
      }).success,
    ).toBe(true);
  });
  test("local harness builds accept workload networking without a CodeBuild VPC ID", () => {
    expect(
      HarnessSpecSchema.safeParse({
        name: "agent",
        model: { provider: "bedrock", modelId: "test-model" },
        build: "Container-local",
        dockerfile: "Dockerfile",
        networkMode: "VPC",
        networkConfig,
      }).success,
    ).toBe(true);
  });
  test.each(["Container", "Container-local"])(
    "rejects explicit %s build settings for a prebuilt harness image",
    (build) => {
      expect(
        HarnessSpecSchema.safeParse({
          name: "agent",
          model: { provider: "bedrock", modelId: "test-model" },
          build,
          containerUri: "111122223333.dkr.ecr.us-east-1.amazonaws.com/image:latest",
        }).success,
      ).toBe(false);
    },
  );
  test("redacts supplied build argument values in output and captured errors", () => {
    const redact = buildArgumentRedactor(["example-value", "example", ""]);
    expect(redact("ARG=example-value and example")).toBe("ARG=[REDACTED] and [REDACTED]");
    const error = new Error("build example-value failed", { cause: new Error("cause example") });
    redactBuildError(error, redact);
    expect(error.message).toBe("build [REDACTED] failed");
    expect((error.cause as Error).message).toBe("cause [REDACTED]");
    expect(error.stack).not.toContain("example-value");
  });
  test("redacts multiline arguments from separate output lines and escaped diagnostics", () => {
    const value = 'first"line\nsecond\\line';
    const redact = buildArgumentRedactor([value]);
    expect(value.split("\n").map(redact)).toEqual(["[REDACTED]", "[REDACTED]"]);
    expect(redact(JSON.stringify({ argument: value }))).toBe('{"argument":"[REDACTED]"}');
    const error = new Error(JSON.stringify({ argument: value }));
    redactBuildError(error, redact);
    expect(error.message).toBe('{"argument":"[REDACTED]"}');
  });
});

describe("new workloads only", () => {
  test.each([
    ["Container", "Container-local"],
    ["CodeZip", "Container-local"],
    ["Container-local", "Container"],
    ["Container-local", "CodeZip"],
  ])("rejects a deployed %s to %s transition", (before, after) => {
    for (const kind of ["runtime", "harness"]) {
      const key = `${kind}/agent`;
      expect(() =>
        assertNewLocalWorkloads(
          { Metadata: { "agentcore:builds": { [key]: before } } },
          { [key]: after },
          "example",
          "default",
        ),
      ).toThrow("supported only for new workloads");
    }
  });
  test("allows unchanged local workloads and new workloads in an existing mixed project", () => {
    expect(() =>
      assertNewLocalWorkloads(
        {
          Metadata: {
            "agentcore:builds": {
              "runtime/existing": "Container",
              "harness/local": "Container-local",
            },
          },
        },
        {
          "runtime/existing": "Container",
          "harness/local": "Container-local",
          "runtime/new": "Container-local",
        },
        "example",
        "default",
      ),
    ).not.toThrow();
  });
  test.each(["runtime", "harness"])(
    "detects pre-feature %s templates without local state",
    (kind) => {
      const previous: ContainerTemplate = {
        Resources: {
          Workload: {
            Type:
              kind === "runtime"
                ? "AWS::BedrockAgentCore::Runtime"
                : "AWS::BedrockAgentCore::Harness",
            Properties: {
              [kind === "runtime" ? "AgentRuntimeName" : "HarnessName"]: "example_prod_us_agent",
            },
          },
        },
      };
      expect(() =>
        assertNewLocalWorkloads(
          previous,
          { [`${kind}/agent`]: "Container-local" },
          "example",
          "prod-us",
        ),
      ).toThrow("supported only for new workloads");
    },
  );
  test("recognizes target-less legacy names and previously published local image URIs", () => {
    const previous: ContainerTemplate = {
      Resources: {
        Runtime: {
          Type: "AWS::BedrockAgentCore::Runtime",
          Properties: {
            AgentRuntimeName: "example_agent",
            AgentRuntimeArtifact: {
              ContainerConfiguration: { ContainerUri: "registry/cdk-custom-container-assets:hash" },
            },
          },
        },
      },
    };
    expect(() =>
      assertNewLocalWorkloads(previous, { "runtime/agent": "Container" }, "example", undefined),
    ).toThrow("Cannot change runtime/agent from Container-local to Container");
    expect(() =>
      assertNewLocalWorkloads(
        previous,
        { "runtime/agent": "Container-local" },
        "example",
        undefined,
      ),
    ).not.toThrow();
  });
  test("fails closed on malformed deployed build metadata", () => {
    expect(() =>
      assertNewLocalWorkloads({ Metadata: { "agentcore:builds": [] } }, {}, "example", "default"),
    ).toThrow("invalid build metadata");
  });
  test("rejects adopting an existing legacy role-only Harness into local mode", () => {
    const previous: ContainerTemplate = {
      Outputs: {
        HarnessRole: { Export: { Name: "AgentCore-example-default-Harness-assistant-RoleArn" } },
      },
    };
    expect(() =>
      assertNewLocalWorkloads(
        previous,
        { "harness/assistant": "Container-local" },
        "example",
        "default",
      ),
    ).toThrow("supported only for new workloads");
    expect(() =>
      assertNewLocalWorkloads(previous, { "harness/assistant": "Container" }, "example", "default"),
    ).not.toThrow();
  });
});
