import { MalformedServiceResponseError } from "../../../../errors/errors";
import type { AwsCredentials } from "../../../types";

/**
 * Resolves the AWS account the given credentials belong to. Omitting
 * `credentials` resolves through the default AWS SDK provider chain. Every
 * backend runs this before its first mutation so a deploy never lands in an
 * account other than the target's.
 */
export type AccountResolver = (region: string, credentials?: AwsCredentials) => Promise<string>;

export const resolveAwsAccount: AccountResolver = async (region, credentials) => {
  // Lazily imported to keep STS off the CLI startup path.
  const { GetCallerIdentityCommand, STSClient } = await import("@aws-sdk/client-sts");
  const client = new STSClient({ credentials, region });
  try {
    const { Account } = await client.send(new GetCallerIdentityCommand({}));
    if (!Account) {
      throw new MalformedServiceResponseError("STS GetCallerIdentity returned no AWS account ID");
    }
    return Account;
  } finally {
    client.destroy();
  }
};
