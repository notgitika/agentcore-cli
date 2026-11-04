import { describe, expect, test } from "bun:test";
import { HarnessSpecSchema } from "../../../../projectSchemas/harness";
import { ProjectRuntimeSchema } from "../../../../projectSchemas/runtime";
import {
  assertRetainedContainerImages,
  buildArgumentRedactor,
  checkLocalContainerBuilder,
  redactBuildError,
  type ContainerTemplate,
} from "./localContainers";

describe("local container builder prerequisites", () => {
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

  test("checks configured ARM64 support on x86 without provisioning a builder", async () => {
    const commands: string[][] = [];
    await checkLocalContainerBuilder(
      async (command, options) => {
        commands.push(command);
        options.onOutput?.(
          command[1] === "info"
            ? '{"OSType":"linux","Architecture":"x86_64"}'
            : "Platforms: linux/amd64*, linux/arm64\n",
        );
      },
      "/project",
      "docker",
    );
    expect(commands[1]).toEqual(["docker", "buildx", "inspect"]);
  });

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
    await expect(
      checkLocalContainerBuilder(
        async (command, options) => {
          options.onOutput?.(
            command[1] === "info"
              ? '{"OSType":"linux","Architecture":"x86_64"}'
              : "Platforms: linux/amd64\n",
          );
        },
        "/project",
        "docker",
      ),
    ).rejects.toThrow("Linux ARM64 build support");
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
});

describe("retention before switching from CodeBuild", () => {
  const previous = (retained: boolean): ContainerTemplate => ({
    Resources: {
      Repository: {
        Type: "AWS::ECR::Repository",
        Properties: {
          RepositoryName: "example/default/agent",
          EncryptionConfiguration: [{ KmsKey: { "Fn::GetAtt": ["Key", "Arn"] } }],
        },
        DeletionPolicy: retained ? "Retain" : "Delete",
      },
      Key: { Type: "AWS::KMS::Key", DeletionPolicy: retained ? "Retain" : "Delete" },
    },
  });
  test("rejects removing the managed repository and its key until retention is deployed", () => {
    expect(() =>
      assertRetainedContainerImages(previous(false), {}, ["example/default/agent"]),
    ).toThrow("Repository, Key");
  });
  test("allows a switch after both resources have a deployed retention policy", () => {
    expect(() =>
      assertRetainedContainerImages(previous(true), {}, ["example/default/agent"]),
    ).not.toThrow();
  });
  test("does not block unrelated repositories or resources that remain in the stack", () => {
    expect(() =>
      assertRetainedContainerImages(previous(false), {}, ["example/default/other"]),
    ).not.toThrow();
    expect(() =>
      assertRetainedContainerImages(previous(false), previous(false), ["example/default/agent"]),
    ).not.toThrow();
  });
});
