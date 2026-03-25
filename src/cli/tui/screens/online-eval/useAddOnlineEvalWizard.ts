import type { AddOnlineEvalConfig, AddOnlineEvalStep, LogSourceType } from './types';
import { DEFAULT_SAMPLING_RATE } from './types';
import { useCallback, useState } from 'react';

function getAllSteps(agentCount: number, logSource: LogSourceType): AddOnlineEvalStep[] {
  if (logSource === 'external-agent') {
    return [
      'name',
      'logSource',
      'customServiceName',
      'customLogGroupName',
      'evaluators',
      'samplingRate',
      'enableOnCreate',
      'confirm',
    ];
  }
  // Project agent path — skip agent selection if only one agent
  if (agentCount <= 1) {
    return ['name', 'logSource', 'evaluators', 'samplingRate', 'enableOnCreate', 'confirm'];
  }
  return ['name', 'logSource', 'agent', 'evaluators', 'samplingRate', 'enableOnCreate', 'confirm'];
}

function getDefaultConfig(): AddOnlineEvalConfig {
  return {
    name: '',
    agent: undefined,
    evaluators: [],
    samplingRate: DEFAULT_SAMPLING_RATE,
    enableOnCreate: true,
  };
}

export function useAddOnlineEvalWizard(agentCount: number) {
  const [logSource, setLogSourceState] = useState<LogSourceType>('project-agent');
  const allSteps = getAllSteps(agentCount, logSource);
  const [config, setConfig] = useState<AddOnlineEvalConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddOnlineEvalStep>(allSteps[0]!);

  const currentIndex = allSteps.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = allSteps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [allSteps, currentIndex, setStep]);

  const nextStep = useCallback(
    (currentStep: AddOnlineEvalStep): AddOnlineEvalStep | undefined => {
      const idx = allSteps.indexOf(currentStep);
      return allSteps[idx + 1];
    },
    [allSteps]
  );

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      const next = nextStep('name');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setLogSource = useCallback(
    (source: LogSourceType) => {
      setLogSourceState(source);
      // Clear fields from the other path
      if (source === 'external-agent') {
        setConfig(c => ({ ...c, agent: undefined }));
      } else {
        setConfig(c => ({ ...c, customLogGroupName: undefined, customServiceName: undefined }));
      }
      // Steps will recalculate on next render; advance to the step after logSource
      const newSteps = getAllSteps(agentCount, source);
      const logSourceIdx = newSteps.indexOf('logSource');
      const next = newSteps[logSourceIdx + 1];
      if (next) setStep(next);
    },
    [agentCount, setConfig, setStep]
  );

  const setAgent = useCallback(
    (agent: string) => {
      setConfig(c => ({ ...c, agent }));
      const next = nextStep('agent');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setCustomServiceName = useCallback(
    (customServiceName: string) => {
      setConfig(c => ({ ...c, customServiceName }));
      const next = nextStep('customServiceName');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setCustomLogGroupName = useCallback(
    (customLogGroupName: string) => {
      setConfig(c => ({ ...c, customLogGroupName }));
      const next = nextStep('customLogGroupName');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setEvaluators = useCallback(
    (evaluators: string[]) => {
      setConfig(c => ({ ...c, evaluators }));
      const next = nextStep('evaluators');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setSamplingRate = useCallback(
    (samplingRate: number) => {
      setConfig(c => ({ ...c, samplingRate }));
      const next = nextStep('samplingRate');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const setEnableOnCreate = useCallback(
    (enableOnCreate: boolean) => {
      setConfig(c => ({ ...c, enableOnCreate }));
      const next = nextStep('enableOnCreate');
      if (next) setStep(next);
    },
    [nextStep, setConfig, setStep]
  );

  const reset = useCallback(() => {
    setLogSourceState('project-agent');
    setConfig(getDefaultConfig());
    const defaultSteps = getAllSteps(agentCount, 'project-agent');
    setStep(defaultSteps[0]!);
  }, [agentCount, setConfig, setStep]);

  return {
    config,
    step,
    steps: allSteps,
    currentIndex,
    logSource,
    goBack,
    setName,
    setLogSource,
    setAgent,
    setCustomServiceName,
    setCustomLogGroupName,
    setEvaluators,
    setSamplingRate,
    setEnableOnCreate,
    reset,
  };
}
