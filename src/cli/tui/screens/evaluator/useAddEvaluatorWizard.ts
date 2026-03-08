import type { EvaluationLevel, EvaluatorConfig } from '../../../../schema';
import type { AddEvaluatorConfig, AddEvaluatorStep } from './types';
import { DEFAULT_MODEL } from './types';
import { useCallback, useState } from 'react';

const ALL_STEPS: AddEvaluatorStep[] = ['name', 'level', 'model', 'instructions', 'ratingScale', 'confirm'];

function getDefaultConfig(): AddEvaluatorConfig {
  return {
    name: '',
    level: 'SESSION',
    config: {
      llmAsAJudge: {
        model: DEFAULT_MODEL,
        instructions: '',
        ratingScale: {
          numerical: [
            { value: 1, label: 'Poor', definition: 'Fails to meet expectations' },
            { value: 5, label: 'Excellent', definition: 'Far exceeds expectations' },
          ],
        },
      },
    },
  };
}

export function useAddEvaluatorWizard() {
  const [config, setConfig] = useState<AddEvaluatorConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddEvaluatorStep>('name');

  const currentIndex = ALL_STEPS.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = ALL_STEPS[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex]);

  const nextStep = useCallback((currentStep: AddEvaluatorStep): AddEvaluatorStep | undefined => {
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

  const setLevel = useCallback(
    (level: EvaluationLevel) => {
      setConfig(c => ({ ...c, level }));
      const next = nextStep('level');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setModel = useCallback(
    (model: string) => {
      setConfig(c => ({
        ...c,
        config: {
          llmAsAJudge: { ...c.config.llmAsAJudge, model },
        },
      }));
      const next = nextStep('model');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setInstructions = useCallback(
    (instructions: string) => {
      setConfig(c => ({
        ...c,
        config: {
          llmAsAJudge: { ...c.config.llmAsAJudge, instructions },
        },
      }));
      const next = nextStep('instructions');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setRatingScale = useCallback(
    (ratingScale: EvaluatorConfig['llmAsAJudge']['ratingScale']) => {
      setConfig(c => ({
        ...c,
        config: {
          llmAsAJudge: { ...c.config.llmAsAJudge, ratingScale },
        },
      }));
      const next = nextStep('ratingScale');
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
    setLevel,
    setModel,
    setInstructions,
    setRatingScale,
    reset,
  };
}
