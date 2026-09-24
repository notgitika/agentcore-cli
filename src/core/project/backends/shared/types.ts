import type { AwsDeploymentTarget } from "../../../../projectSchemas/aws-targets";
import type { AwsCredentialProvider, AwsCredentials } from "../../../types";

/** Enables CloudWatch Transaction Search for a deploy target. Shared by every backend. */
export type TransactionSearchEnabler = (
  target: AwsDeploymentTarget,
  credentials: AwsCredentials,
) => Promise<void>;

/**
 * Resolves the credential provider a deploy runs under for a region. The CDK
 * backend supplies the AWS-CLI-compatible chain from the CDK Toolkit; any
 * backend may be handed the same resolver.
 */
export type AwsCredentialResolver = (region: string) => Promise<AwsCredentialProvider>;
