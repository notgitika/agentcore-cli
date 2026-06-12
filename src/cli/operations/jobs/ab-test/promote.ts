import { ConfigIO } from '../../../../lib';
import type { ABTestJobRecord, ABTestVariantSummary } from '../shared/types';

export interface PromoteABTestResult {
  promoted: boolean;
  mode?: string;
  promotionDetail: string;
}

/** Reverse-resolve a deployed config-bundle ARN to its spec name (the key in configBundles[]). */
function bundleNameFromArn(
  deployedState: { targets: Record<string, { resources?: { configBundles?: Record<string, { bundleArn: string }> } }> },
  bundleArn: string
): string | undefined {
  for (const target of Object.values(deployedState.targets)) {
    const bundles = target.resources?.configBundles;
    if (!bundles) continue;
    for (const [name, entry] of Object.entries(bundles)) {
      if (entry.bundleArn === bundleArn) return name;
    }
  }
  return undefined;
}

/**
 * Apply A/B test promotion to agentcore.json, sourcing the winning (treatment / T1) variant
 * from the job record's persisted `variants` — NOT from project.abTests[] (which the fire-and-forget
 * jobs model never populates). Does NOT stop the test — the handler does that first.
 *
 * - config-bundle mode: copy the treatment bundle's component configuration onto the control bundle.
 * - target-based mode:  bump the control runtime endpoint's version to the treatment endpoint's version.
 */
export async function promoteABTestConfig(record: ABTestJobRecord): Promise<PromoteABTestResult> {
  const configIO = new ConfigIO();
  const project = await configIO.readProjectSpec();
  const mode = record.mode;

  const control = record.variants.find((v: ABTestVariantSummary) => v.name === 'C');
  const treatment = record.variants.find((v: ABTestVariantSummary) => v.name === 'T1');
  if (!control || !treatment) {
    return {
      promoted: false,
      mode,
      promotionDetail: 'A/B test record is missing control (C) or treatment (T1) variant.',
    };
  }

  if (mode === 'target-based') {
    if (!record.gatewayName) {
      return {
        promoted: false,
        mode,
        promotionDetail: 'A/B test record is missing the gateway name; cannot locate targets.',
      };
    }
    const gateway = (project.agentCoreGateways ?? []).find(g => g.name === record.gatewayName);
    if (!gateway?.targets) {
      return { promoted: false, mode, promotionDetail: `Gateway "${record.gatewayName}" not found in agentcore.json.` };
    }
    const controlTarget = gateway.targets.find(t => t.name === control.targetName);
    const treatmentTarget = gateway.targets.find(t => t.name === treatment.targetName);
    if (
      !controlTarget?.httpRuntime?.runtime ||
      !controlTarget.httpRuntime.runtimeEndpoint ||
      !treatmentTarget?.httpRuntime?.runtimeEndpoint
    ) {
      return {
        promoted: false,
        mode,
        promotionDetail: 'Could not resolve control/treatment runtime endpoints for promotion.',
      };
    }
    const runtime = project.runtimes.find(r => r.name === controlTarget.httpRuntime!.runtime);
    const controlEp = runtime?.endpoints?.[controlTarget.httpRuntime.runtimeEndpoint];
    const treatmentEp = runtime?.endpoints?.[treatmentTarget.httpRuntime.runtimeEndpoint];
    if (!controlEp || !treatmentEp) {
      return {
        promoted: false,
        mode,
        promotionDetail: 'Could not resolve control/treatment endpoint versions for promotion.',
      };
    }
    controlEp.version = treatmentEp.version;
    await configIO.writeProjectSpec(project);
    return {
      promoted: true,
      mode,
      promotionDetail: `Control endpoint "${controlTarget.httpRuntime.runtimeEndpoint}" updated to version ${treatmentEp.version} (from treatment "${treatmentTarget.httpRuntime.runtimeEndpoint}").`,
    };
  }

  // config-bundle mode: copy the treatment bundle's components onto the control bundle.
  if (!control.bundleArn || !treatment.bundleArn) {
    return { promoted: false, mode, promotionDetail: 'A/B test record is missing control/treatment bundle ARNs.' };
  }

  let controlName: string | undefined;
  let treatmentName: string | undefined;
  try {
    const deployedState = await configIO.readDeployedState();
    controlName = bundleNameFromArn(deployedState, control.bundleArn);
    treatmentName = bundleNameFromArn(deployedState, treatment.bundleArn);
  } catch {
    // deployed state unavailable
  }
  if (!controlName || !treatmentName) {
    return {
      promoted: false,
      mode,
      promotionDetail:
        'Could not resolve control/treatment config bundles from deployed state (deploy the bundles first).',
    };
  }

  const controlBundle = (project.configBundles ?? []).find(b => b.name === controlName);
  const treatmentBundle = (project.configBundles ?? []).find(b => b.name === treatmentName);
  if (!controlBundle || !treatmentBundle) {
    return {
      promoted: false,
      mode,
      promotionDetail: `Could not find config bundle "${controlName}" or "${treatmentName}" in agentcore.json.`,
    };
  }

  // Promote: the control bundle adopts the treatment bundle's component configuration.
  controlBundle.components = structuredClone(treatmentBundle.components);
  await configIO.writeProjectSpec(project);
  return {
    promoted: true,
    mode,
    promotionDetail: `Config bundle "${controlName}" updated to match treatment bundle "${treatmentName}".`,
  };
}
