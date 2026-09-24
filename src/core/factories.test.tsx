import { describe, expect, test } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { createS3Client } from "./factories";

describe("createS3Client", () => {
  test("builds an S3 client for the requested region", async () => {
    const client = createS3Client({ region: "us-west-2" });
    expect(client).toBeInstanceOf(S3Client);
    expect(await client.config.region()).toBe("us-west-2");
  });
});
