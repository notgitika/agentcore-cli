import { readFile } from "node:fs/promises";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketTaggingCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  type BucketLocationConstraint,
  type S3Client,
} from "@aws-sdk/client-s3";
import { ProjectStateError } from "../../../../errors";
import type { NamingScope } from "./naming";

/** Where a runtime's code lives in S3 after staging; the runtime step reads this off the stack. */
export type CodeArtifact = { bucket: string; key: string; sha256: string; sizeBytes: number };

/** One bucket per account and region, shared by every project and target. Never deleted. */
export function artifactBucketName(account: string, region: string): string {
  return `agentcore-cli-${account}-${region}`;
}

/** Content-addressed, so re-deploying unchanged code re-uses the object and a changed sha is a new key. */
export function artifactKey(scope: NamingScope, runtimeName: string, sha256: string): string {
  return `${scope.projectName}/${scope.targetName}/${runtimeName}/${sha256}.zip`;
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata
    ?.httpStatusCode;
}
function nameOf(error: unknown): string | undefined {
  return (error as { name?: string } | undefined)?.name;
}
const isMissing = (error: unknown) =>
  statusOf(error) === 404 ||
  ["NotFound", "NoSuchBucket", "NoSuchKey"].includes(nameOf(error) ?? "");

/**
 * Creates the artifact bucket if it does not exist yet: public access blocked,
 * ownership tags applied. An existing bucket is left exactly as it is.
 */
export async function ensureArtifactBucket(
  s3: S3Client,
  { bucket, region, tags }: { bucket: string; region: string; tags: Record<string, string> },
): Promise<{ created: boolean }> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return { created: false };
  } catch (error) {
    if (statusOf(error) === 403 || nameOf(error) === "Forbidden") {
      throw new ProjectStateError(
        `The artifact bucket '${bucket}' exists but is not accessible with the current credentials. ` +
          `It may belong to another AWS account; delete or rename it, or grant this principal ` +
          `s3:ListBucket on it.`,
      );
    }
    if (!isMissing(error)) throw error;
  }
  try {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        // us-east-1 is the default location and rejects an explicit constraint.
        ...(region !== "us-east-1" && {
          CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint },
        }),
      }),
    );
  } catch (error) {
    if (nameOf(error) === "BucketAlreadyExists") {
      throw new ProjectStateError(
        `The artifact bucket name '${bucket}' is already taken by another AWS account. ` +
          `Bucket names are global; this one is derived from the account and region and cannot ` +
          `be changed yet.`,
      );
    }
    if (nameOf(error) !== "BucketAlreadyOwnedByYou") throw error;
  }
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await s3.send(
    new PutBucketTaggingCommand({
      Bucket: bucket,
      Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) },
    }),
  );
  return { created: true };
}

/** Uploads the zip unless an object with the same (content-addressed) key already exists. */
export async function uploadArtifact(
  s3: S3Client,
  { bucket, key, zipPath }: { bucket: string; key: string; zipPath: string },
): Promise<{ uploaded: boolean }> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { uploaded: false };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const body = await readFile(zipPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/zip",
      ContentLength: body.byteLength,
    }),
  );
  return { uploaded: true };
}
