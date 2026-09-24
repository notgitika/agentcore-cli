import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { AwsCredentialResolver } from "../shared/types";

/**
 * The SDK's default chain (env, shared config and SSO profiles, web identity,
 * container and instance metadata), pinned to the target's region so STS
 * regional endpoints and profile `region` settings agree. The CDK backend gets
 * the equivalent chain from the CDK Toolkit; this backend must not depend on it.
 */
export function createDefaultCredentialResolver(): AwsCredentialResolver {
  return async (region) => fromNodeProviderChain({ clientConfig: { region } });
}
