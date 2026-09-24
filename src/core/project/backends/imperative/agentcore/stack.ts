import type { Logger } from "../../../../../logging";
import type { CodeArtifact } from "../artifacts";
import type { AwsClients, AwsCredentials, ClientConfig } from "../../../../types";
import { recordedResources, stateKey, stepOf } from "../inventory";
import { ownershipTags, physicalName, type NamingScope, type ResourceKind } from "../naming";
import type { ImperativeState } from "../state";

export type StackScope = NamingScope & {
  account: string;
  region: string;
  /** Absolute project root; kinds resolve codeLocation-relative files (additionalPolicies) against it. */
  rootPath: string;
};

export type ResourceOutputs = { arn?: string; id?: string };

/**
 * What one deploy of one target knows: who it is deploying for, how to reach
 * AWS, and the identifiers of every resource it has seen. Steps read identifiers
 * of the resources they depend on from here (a runtime reads its memories' ids)
 * and write their own after they converge. Mirrors `wpstack` in the prior art.
 */
export class AgentCoreStack {
  private readonly data = new Map<string, ResourceOutputs>();
  /** Uploaded CodeZip per runtime name, staged by the backend before the plan runs. */
  readonly artifacts = new Map<string, CodeArtifact>();

  constructor(
    readonly scope: StackScope,
    readonly clients: AwsClients,
    readonly credentials: AwsCredentials,
    readonly logger: Logger,
    recorded: ImperativeState,
  ) {
    for (const resource of recordedResources(recorded)) {
      const record = recorded[resource.kind]?.[stateKey(resource)];
      if (!record) continue;
      this.record(stepOf(resource), {
        ...(record.arn !== undefined && { arn: record.arn }),
        ...(record.id !== undefined && { id: record.id }),
      });
    }
  }

  /** Client config for every SDK call this deploy makes. */
  options(): ClientConfig {
    return { region: this.scope.region, credentials: this.credentials };
  }

  name(kind: ResourceKind, name: string, maxLength?: number): string {
    return physicalName(this.scope, kind, name, maxLength);
  }

  tags(extra: Record<string, string> = {}): Record<string, string> {
    return { ...ownershipTags(this.scope), ...extra };
  }

  record(step: string, outputs: ResourceOutputs): void {
    this.data.set(step, { ...outputs });
  }

  forget(step: string): void {
    this.data.delete(step);
  }

  outputsOf(step: string): ResourceOutputs | undefined {
    const outputs = this.data.get(step);
    return outputs ? { ...outputs } : undefined;
  }

  /** Flat `<step>.arn` / `<step>.id` map, the shape `DeployResult.outputs` wants. */
  outputs(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [step, { arn, id }] of this.data) {
      if (arn !== undefined) out[`${step}.arn`] = arn;
      if (id !== undefined) out[`${step}.id`] = id;
    }
    return out;
  }
}
