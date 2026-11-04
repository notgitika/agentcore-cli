import z from "zod";
import { flag } from "../../../router";
import { InputValidationError } from "../../../errors";

/** CLI spellings map to the canonical build values written to project configuration. */
export const ContainerBuildFlagSchema = z
  .string()
  .toLowerCase()
  .pipe(z.enum(["container", "container-local"]))
  .transform((value): "Container" | "Container-local" =>
    value === "container" ? "Container" : "Container-local",
  );

/** JSON parse diagnostics can contain argument values, so keep this error value-free. */
export function parseContainerBuildArgs(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new InputValidationError(
      "Invalid JSON for option '--custom-docker-build-args': expected a JSON object",
    );
  }
}

export function containerFlags(group: string) {
  return [
    flag(
      "build",
      "container builds in CodeBuild; container-local builds locally and publishes through CDK",
      ContainerBuildFlagSchema.optional(),
      { group },
    ),
    flag(
      "build-context-path",
      "Docker build context relative to the project root",
      z.string().optional(),
      {
        group,
      },
    ),
    flag(
      "custom-docker-build-args",
      "nonsecret Docker build arguments (JSON object)",
      z.string().optional(),
      {
        group,
        sensitive: true,
      },
    ),
  ];
}
