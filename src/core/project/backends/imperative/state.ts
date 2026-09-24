import { z } from "zod";
import type { ReadWriteJson } from "../../../../io";
import {
  readDeployedState,
  stackReferenceOf,
  updateTargetState,
  type TargetState,
} from "../shared/deployedState";
import type { ResourceKind } from "./naming";

export const ImperativeResourceRecordSchema = z
  .object({
    arn: z.string().optional(),
    id: z.string().optional(),
    updatedAt: z.string(),
  })
  .passthrough();
export type ImperativeResourceRecord = z.infer<typeof ImperativeResourceRecordSchema>;

/** `targets.<target>.resources.imperative`, keyed by kind, then by name or `parent/child`. */
export type ImperativeState = Partial<
  Record<ResourceKind, Record<string, ImperativeResourceRecord>>
>;

/** Parses the ledger out of a target's state, dropping entries that do not parse. */
export function imperativeStateOf(state: TargetState | undefined): ImperativeState {
  const raw = state?.resources?.imperative ?? {};
  const result: ImperativeState = {};
  for (const [kind, byKey] of Object.entries(raw)) {
    if (typeof byKey !== "object" || byKey === null) continue;
    const records: Record<string, ImperativeResourceRecord> = {};
    for (const [key, value] of Object.entries(byKey as Record<string, unknown>)) {
      const parsed = ImperativeResourceRecordSchema.safeParse(value);
      if (parsed.success) records[key] = parsed.data;
    }
    if (Object.keys(records).length > 0) result[kind as ResourceKind] = records;
  }
  return result;
}

export async function readImperativeState(
  json: ReadWriteJson,
  rootPath: string,
  targetName: string,
): Promise<ImperativeState> {
  const state = await readDeployedState(json, rootPath);
  return imperativeStateOf(state.targets[targetName]);
}

/** True when the CDK backend deployed this target (a stack ARN or name is recorded). */
export function hasCdkBinding(state: TargetState | undefined): boolean {
  return stackReferenceOf(state) !== undefined;
}

export async function recordImperativeResource(
  json: ReadWriteJson,
  rootPath: string,
  targetName: string,
  kind: ResourceKind,
  key: string,
  outputs: { arn?: string; id?: string },
  now: () => Date,
): Promise<void> {
  const current = await readImperativeState(json, rootPath, targetName);
  const record: ImperativeResourceRecord = {
    ...(outputs.arn !== undefined && { arn: outputs.arn }),
    ...(outputs.id !== undefined && { id: outputs.id }),
    updatedAt: now().toISOString(),
  };
  const imperative: ImperativeState = {
    ...current,
    [kind]: { ...current[kind], [key]: record },
  };
  // updateTargetState merges `resources` one level deep, so the whole ledger is
  // rewritten but credentials and unknown siblings survive.
  await updateTargetState(json, rootPath, targetName, { resources: { imperative } });
}

export async function forgetImperativeResource(
  json: ReadWriteJson,
  rootPath: string,
  targetName: string,
  kind: ResourceKind,
  key: string,
): Promise<void> {
  const current = await readImperativeState(json, rootPath, targetName);
  const byKey = { ...current[kind] };
  if (!(key in byKey)) return;
  delete byKey[key];
  const imperative: ImperativeState = { ...current };
  if (Object.keys(byKey).length === 0) delete imperative[kind];
  else imperative[kind] = byKey;
  await updateTargetState(json, rootPath, targetName, { resources: { imperative } });
}
