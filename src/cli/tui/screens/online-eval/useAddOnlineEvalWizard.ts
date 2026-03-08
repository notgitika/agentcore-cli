import type { AddOnlineEvalConfig, AddOnlineEvalStep } from './types';
import { DEFAULT_SAMPLING_RATE } from './types';
import { useCallback, useState } from 'react';

const ALL_STEPS: AddOnlineEvalStep[] = ['name', 'agents', 'evaluators', 'samplingRate', 'confirm'];

function getDefaultConfig(): AddOnlineEvalConfig {
  return {
    name: '',
    agents: [],
    evaluators: [],
    samplingRate: DEFAULT_SAMPLING_RATE,
    enableOnCreate: true,
  };
}

export function useAddOnlineEvalWizard() {
  const [config, setConfig] = useState<AddOnlineEvalConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddOnlineEvalStep>('name');

  const currentIndex = ALL_STEPS.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = ALL_STEPS[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex]);

  const nextStep = useCallback((currentStep: AddOnlineEvalStep): AddOnlineEvalStep | undefined => {
    const idx = ALL_STEPS.indexOf(currentStep);
    return ALL_STEPS[idx + 1];
  }, []);

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      const next = nextStep('name');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setAgents = useCallback(
    (agents: string[]) => {
      setConfig(c => ({ ...c, agents }));
      const next = nextStep('agents');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setEvaluators = useCallback(
    (evaluators: string[]) => {
      setConfig(c => ({ ...c, evaluators }));
      const next = nextStep('evaluators');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setSamplingRate = useCallback(
    (samplingRate: number) => {
      setConfig(c => ({ ...c, samplingRate }));
      const next = nextStep('samplingRate');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('name');
  }, []);

  return {
    config,
    step,
    steps: ALL_STEPS,
    currentIndex,
    goBack,
    setName,
    setAgents,
    setEvaluators,
    setSamplingRate,
    reset,
  };
}
