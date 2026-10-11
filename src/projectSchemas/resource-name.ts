import { z } from "zod";

/**
 * The AWS name of a resource, when it must not be derived from the project and
 * resource names.
 *
 * `agentcore migrate` sets it on every resource a v0 CLI already deployed, so the
 * resource keeps the name it was created under: these names are create-only, and a
 * new one would replace the resource. When unset the name is derived as usual.
 * Validated with the service's own name rules for the resource type.
 */
export function resourceNameSchema(maxLength: number) {
  return z
    .string()
    .min(1, "Resource name is required")
    .max(maxLength, `Resource name must be ${maxLength} characters or less`)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]*$/,
      `Resource name must begin with a letter and contain only alphanumeric characters and underscores (max ${maxLength} chars)`,
    );
}

/**
 * The Identity name a credential's provider was created under, when it must not be
 * derived from the project, target, and credential names. `agentcore migrate` sets
 * it to the bare credential name a v0 CLI used, so deploys keep updating the
 * existing provider. Validated with the Identity service's name rules.
 */
export const CredentialProviderNameSchema = z
  .string()
  .min(1, "Provider name is required")
  .max(128, "Provider name must be 128 characters or less")
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "Provider name must contain only alphanumeric characters, hyphens, and underscores (max 128 chars)",
  );

/**
 * The name of a Lambda function the project creates, when it must not be derived
 * from the project, target, and resource names. `agentcore migrate` sets it on
 * managed code-based evaluators a v0 CLI already deployed, which named the function
 * `<project>-eval-<evaluator>`. Validated with Lambda's function name rules.
 */
export const LambdaFunctionNameSchema = z
  .string()
  .min(1, "Function name is required")
  .max(64, "Function name must be 64 characters or less")
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "Function name must contain only alphanumeric characters, hyphens, and underscores (max 64 chars)",
  );
