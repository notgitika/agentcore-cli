import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "@aws-sdk/client-s3";
import { artifactBucketName, artifactKey, ensureArtifactBucket, uploadArtifact } from "./artifacts";
import { fakeClient, sdkError } from "./testing";

const scope = { projectName: "orders", targetName: "staging" };
const s3 = (handlers: Parameters<typeof fakeClient>[0]) => {
  const client = fakeClient(handlers);
  return { client: client as unknown as S3Client, sent: client.sent };
};
const missing = () => {
  throw sdkError("NotFound", 404);
};

describe("names", () => {
  test("bucket is per account and region", () => {
    expect(artifactBucketName("111122223333", "us-west-2")).toBe(
      "agentcore-cli-111122223333-us-west-2",
    );
  });
  test("key is project/target/runtime/sha.zip", () => {
    expect(artifactKey(scope, "agent", "abc123")).toBe("orders/staging/agent/abc123.zip");
  });
});

describe("ensureArtifactBucket", () => {
  const input = {
    bucket: "agentcore-cli-111122223333-us-west-2",
    region: "us-west-2",
    tags: { "agentcore:managed-by": "imperative" },
  };

  test("does nothing when the bucket exists", async () => {
    const { client, sent } = s3({ HeadBucketCommand: () => ({}) });
    expect(await ensureArtifactBucket(client, input)).toEqual({ created: false });
    expect(sent.map((c) => c.name)).toEqual(["HeadBucketCommand"]);
  });

  test("creates, blocks public access and tags a missing bucket", async () => {
    const { client, sent } = s3({
      HeadBucketCommand: missing,
      CreateBucketCommand: () => ({}),
      PutPublicAccessBlockCommand: () => ({}),
      PutBucketTaggingCommand: () => ({}),
    });
    expect(await ensureArtifactBucket(client, input)).toEqual({ created: true });
    expect(sent.map((c) => c.name)).toEqual([
      "HeadBucketCommand",
      "CreateBucketCommand",
      "PutPublicAccessBlockCommand",
      "PutBucketTaggingCommand",
    ]);
    expect(sent[1]!.input).toEqual({
      Bucket: input.bucket,
      CreateBucketConfiguration: { LocationConstraint: "us-west-2" },
    });
    expect(sent[2]!.input).toEqual({
      Bucket: input.bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    });
    expect(sent[3]!.input).toEqual({
      Bucket: input.bucket,
      Tagging: { TagSet: [{ Key: "agentcore:managed-by", Value: "imperative" }] },
    });
  });

  test("omits the location constraint in us-east-1", async () => {
    const { client, sent } = s3({
      HeadBucketCommand: missing,
      CreateBucketCommand: () => ({}),
      PutPublicAccessBlockCommand: () => ({}),
      PutBucketTaggingCommand: () => ({}),
    });
    await ensureArtifactBucket(client, {
      ...input,
      bucket: "agentcore-cli-111122223333-us-east-1",
      region: "us-east-1",
    });
    expect(sent[1]!.input).toEqual({ Bucket: "agentcore-cli-111122223333-us-east-1" });
  });

  test("treats BucketAlreadyOwnedByYou as created", async () => {
    const { client } = s3({
      HeadBucketCommand: missing,
      CreateBucketCommand: () => {
        throw sdkError("BucketAlreadyOwnedByYou", 409);
      },
      PutPublicAccessBlockCommand: () => ({}),
      PutBucketTaggingCommand: () => ({}),
    });
    expect(await ensureArtifactBucket(client, input)).toEqual({ created: true });
  });

  test("a bucket owned by another account fails with guidance", async () => {
    const { client, sent } = s3({
      HeadBucketCommand: missing,
      CreateBucketCommand: () => {
        throw sdkError("BucketAlreadyExists", 409);
      },
    });
    await expect(ensureArtifactBucket(client, input)).rejects.toThrow(
      /agentcore-cli-111122223333-us-west-2.*another AWS account/,
    );
    expect(sent.map((c) => c.name)).not.toContain("PutPublicAccessBlockCommand");
  });

  test("a forbidden HeadBucket fails with guidance", async () => {
    const { client } = s3({
      HeadBucketCommand: () => {
        throw sdkError("Forbidden", 403);
      },
    });
    await expect(ensureArtifactBucket(client, input)).rejects.toThrow(/not accessible/);
  });
});

describe("uploadArtifact", () => {
  test("skips an object that already exists", async () => {
    const { client, sent } = s3({ HeadObjectCommand: () => ({}) });
    expect(
      await uploadArtifact(client, { bucket: "b", key: "k", zipPath: "/nowhere.zip" }),
    ).toEqual({ uploaded: false });
    expect(sent.map((c) => c.name)).toEqual(["HeadObjectCommand"]);
  });

  test("uploads a missing object with its bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "artifact-"));
    const zipPath = join(dir, "code.zip");
    await writeFile(zipPath, "PK-bytes");
    const { client, sent } = s3({
      HeadObjectCommand: missing,
      PutObjectCommand: () => ({}),
    });
    expect(await uploadArtifact(client, { bucket: "b", key: "k", zipPath })).toEqual({
      uploaded: true,
    });
    const put = sent[1]!.input;
    expect(put.Bucket).toBe("b");
    expect(put.Key).toBe("k");
    expect(put.ContentType).toBe("application/zip");
    expect(Buffer.from(put.Body as Uint8Array).toString()).toBe("PK-bytes");
  });
});
