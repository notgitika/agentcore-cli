import type { AdvancedSettingId } from '../../generate/types';
import { computeByoSteps } from '../AddAgentScreen';
import type { ComputeByoStepsInput } from '../AddAgentScreen';
import { describe, expect, it } from 'vitest';

function makeInput(overrides: Partial<ComputeByoStepsInput> = {}): ComputeByoStepsInput {
  return {
    modelProvider: 'Bedrock',
    buildType: 'CodeZip',
    networkMode: 'PUBLIC',
    authorizerType: 'AWS_IAM',
    advancedSettings: new Set<AdvancedSettingId>(),
    ...overrides,
  };
}

describe('computeByoSteps - dockerfile', () => {
  it('Container build with dockerfile selected includes dockerfile step', () => {
    const steps = computeByoSteps(
      makeInput({
        buildType: 'Container',
        advancedSettings: new Set<AdvancedSettingId>(['dockerfile']),
      })
    );
    expect(steps).toContain('dockerfile');
    const advIdx = steps.indexOf('advanced');
    expect(steps[advIdx + 1]).toBe('dockerfile');
  });

  it('CodeZip build with dockerfile selected does NOT include dockerfile step', () => {
    const steps = computeByoSteps(
      makeInput({
        buildType: 'CodeZip',
        advancedSettings: new Set<AdvancedSettingId>(['dockerfile']),
      })
    );
    expect(steps).not.toContain('dockerfile');
  });

  it('dockerfile-only selection on Container has steps: advanced, dockerfile, confirm', () => {
    const steps = computeByoSteps(
      makeInput({
        buildType: 'Container',
        advancedSettings: new Set<AdvancedSettingId>(['dockerfile']),
      })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'dockerfile', 'confirm']);
  });

  it('dockerfile + lifecycle on Container includes both groups', () => {
    const steps = computeByoSteps(
      makeInput({
        buildType: 'Container',
        advancedSettings: new Set<AdvancedSettingId>(['dockerfile', 'lifecycle']),
      })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'dockerfile', 'idleTimeout', 'maxLifetime', 'confirm']);
    expect(steps).not.toContain('networkMode');
  });
});
