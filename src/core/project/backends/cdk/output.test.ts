import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetManifest, AssetPublishing, type IAws } from "@aws-cdk/cdk-assets-lib";
import { redactValues } from "../../../../io/redact";
import { withCdkOutput } from "./output";
import { createCdkRunner, type LoadedCdkToolkit } from "./toolkit";
import { createSilentLogger } from "../../../../testing";

test("reassembles direct process writes and restores both streams after failure", async () => {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const lines: string[] = [];
  const redact = redactValues(["configured-value"]);
  let callbackCalled = false;
  await expect(
    withCdkOutput(
      (line, destination) => lines.push(`${destination}: ${redact(line)}`),
      async () => {
        process.stdout.write("configured-");
        process.stdout.write("value\n", () => {
          callbackCalled = true;
        });
        const unicode = Buffer.from("snowman ☃\n");
        process.stderr.write(unicode.subarray(0, 9));
        process.stderr.write(unicode.subarray(9));
        process.stderr.write("unterminated configured-value");
        await new Promise<void>((resolve) => process.nextTick(resolve));
        throw new Error("operation failed");
      },
    ),
  ).rejects.toThrow("operation failed");
  expect(callbackCalled).toBe(true);
  expect(lines).toEqual([
    "stdout: [REDACTED]",
    "stderr: snowman ☃",
    "stderr: unterminated [REDACTED]",
  ]);
  expect(process.stdout.write).toBe(stdout);
  expect(process.stderr.write).toBe(stderr);
});

test("isolates concurrent operations and does not recapture sink output", async () => {
  const first: string[] = [];
  const second: string[] = [];
  const rendered: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    rendered.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await Promise.all([
      withCdkOutput(
        (line) => {
          first.push(line);
          process.stdout.write("rendered\n");
        },
        async () => {
          process.stdout.write("first ");
          await new Promise<void>((resolve) => setImmediate(resolve));
          process.stdout.write("operation\n");
        },
      ),
      withCdkOutput(
        (line) => second.push(line),
        async () => {
          process.stderr.write("second operation\n");
          await new Promise<void>((resolve) => setImmediate(resolve));
        },
      ),
    ]);
    expect(first).toEqual(["first operation"]);
    expect(second).toEqual(["second operation"]);
    expect(rendered).toEqual(["rendered\n"]);
  } finally {
    process.stdout.write = original;
  }
});

test.skipIf(process.platform === "win32")(
  "redacts actual CDK asset-publisher subprocess output through the runner",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-publisher-output-"));
    const builder = join(directory, "builder.mjs");
    const previous = process.env.CDK_DOCKER;
    const previousCredentials = process.env.CDK_DOCKER_CREDS_FILE;
    try {
      await writeFile(
        builder,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "inspect") process.exit(1);
if (args[0] === "build") {
  const arg = args[args.indexOf("--build-arg") + 1];
  const value = arg.slice(arg.indexOf("=") + 1);
  process.stdout.write("builder " + value.slice(0, 8));
  await new Promise(resolve => setTimeout(resolve, 5));
  process.stdout.write(value.slice(8) + "\\n");
  process.stderr.write(JSON.stringify({argument: value}) + "\\n");
}
`,
        { mode: 0o755 },
      );
      process.env.CDK_DOCKER = builder;
      process.env.CDK_DOCKER_CREDS_FILE = join(directory, "no-registry-credentials");
      const value = 'configured"value';
      const aws: IAws = {
        discoverPartition: async () => "aws",
        discoverDefaultRegion: async () => "us-east-1",
        discoverCurrentAccount: async () => ({ accountId: "111122223333", partition: "aws" }),
        discoverTargetAccount: async () => ({ accountId: "111122223333", partition: "aws" }),
        ecrClient: async () => ({
          describeRepositories: async () => ({
            $metadata: {},
            repositories: [{ repositoryUri: "111122223333.dkr.ecr.us-east-1.amazonaws.com/test" }],
          }),
          describeImages: async () => {
            throw Object.assign(new Error("missing"), { name: "ImageNotFoundException" });
          },
          getAuthorizationToken: async () => ({
            $metadata: {},
            authorizationData: [
              {
                authorizationToken: Buffer.from("AWS:test-password").toString("base64"),
                proxyEndpoint: "https://111122223333.dkr.ecr.us-east-1.amazonaws.com",
              },
            ],
          }),
        }),
        s3Client: async () => {
          throw new Error("S3 must not be used");
        },
        secretsManagerClient: async () => {
          throw new Error("Secrets Manager must not be used");
        },
      };
      const manifest = new AssetManifest(directory, {
        version: "54.0.0",
        dockerImages: {
          image: {
            source: {
              directory: ".",
              dockerBuildArgs: { EXAMPLE: value },
              platform: "linux/arm64",
            },
            destinations: {
              target: { repositoryName: "test", imageTag: "image", region: "us-east-1" },
            },
          },
        },
      });
      const publisher = new AssetPublishing(manifest, { aws });
      const lines: string[] = [];
      const loaded = {
        lib: { StackSelectionStrategy: { PATTERN_MUST_MATCH_SINGLE: "single" } },
        toolkit: {
          fromAssemblyDirectory: async () => ({}),
          deploy: async () => {
            expect(await publisher.buildEntry(manifest.entries[0]!)).toBe(true);
            return { stacks: [{ outputs: {} }] };
          },
        },
      } as unknown as LoadedCdkToolkit;
      await createCdkRunner(createSilentLogger(), async () => loaded)(
        { kind: "deploy", stackArtifactId: "example" },
        {
          assemblyDirectory: directory,
          credentials: async () => ({ accessKeyId: "test", secretAccessKey: "test" }),
          region: "us-east-1",
          redactOutput: redactValues([value]),
          onOutput: (line) => lines.push(line),
        },
      );
      expect(lines).toContain("builder [REDACTED]");
      expect(lines).toContain('{"argument":"[REDACTED]"}');
      expect(lines.join("\n")).not.toContain(value);
    } finally {
      if (previous === undefined) delete process.env.CDK_DOCKER;
      else process.env.CDK_DOCKER = previous;
      if (previousCredentials === undefined) delete process.env.CDK_DOCKER_CREDS_FILE;
      else process.env.CDK_DOCKER_CREDS_FILE = previousCredentials;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
