import { OnlineEvalConfigNameSchema } from '../../../../schema';
import type { SelectableItem } from '../../components';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardMultiSelect } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddOnlineEvalConfig } from './types';
import { BUILTIN_EVALUATORS, DEFAULT_SAMPLING_RATE, ONLINE_EVAL_STEP_LABELS } from './types';
import { useAddOnlineEvalWizard } from './useAddOnlineEvalWizard';
import React, { useMemo } from 'react';

interface AddOnlineEvalScreenProps {
  onComplete: (config: AddOnlineEvalConfig) => void;
  onExit: () => void;
  existingConfigNames: string[];
  availableAgents: string[];
  availableEvaluators: string[];
}

export function AddOnlineEvalScreen({
  onComplete,
  onExit,
  existingConfigNames,
  availableAgents,
  availableEvaluators,
}: AddOnlineEvalScreenProps) {
  const wizard = useAddOnlineEvalWizard();

  const agentItems: SelectableItem[] = useMemo(
    () => availableAgents.map(name => ({ id: name, title: name, description: 'Agent' })),
    [availableAgents]
  );

  const evaluatorItems: SelectableItem[] = useMemo(() => {
    const custom = availableEvaluators.map(name => ({ id: name, title: name, description: 'Custom evaluator' }));
    const builtin = BUILTIN_EVALUATORS.map(b => ({ id: b.id, title: b.title, description: b.description }));
    return [...custom, ...builtin];
  }, [availableEvaluators]);

  const isNameStep = wizard.step === 'name';
  const isAgentsStep = wizard.step === 'agents';
  const isEvaluatorsStep = wizard.step === 'evaluators';
  const isSamplingRateStep = wizard.step === 'samplingRate';
  const isConfirmStep = wizard.step === 'confirm';

  const agentsNav = useMultiSelectNavigation({
    items: agentItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setAgents(ids),
    onExit: () => wizard.goBack(),
    isActive: isAgentsStep,
    requireSelection: true,
  });

  const evaluatorsNav = useMultiSelectNavigation({
    items: evaluatorItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setEvaluators(ids),
    onExit: () => wizard.goBack(),
    isActive: isEvaluatorsStep,
    requireSelection: true,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText =
    isAgentsStep || isEvaluatorsStep
      ? 'Space toggle · Enter confirm · Esc back'
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = (
    <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={ONLINE_EVAL_STEP_LABELS} />
  );

  return (
    <Screen title="Add Online Eval Config" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Config name"
            initialValue={generateUniqueName('MyOnlineEval', existingConfigNames)}
            onSubmit={wizard.setName}
            onCancel={onExit}
            schema={OnlineEvalConfigNameSchema}
            customValidation={value => !existingConfigNames.includes(value) || 'Config name already exists'}
          />
        )}

        {isAgentsStep && (
          <WizardMultiSelect
            title="Select agents to monitor"
            description="Choose which agents this config evaluates"
            items={agentItems}
            cursorIndex={agentsNav.cursorIndex}
            selectedIds={agentsNav.selectedIds}
          />
        )}

        {isEvaluatorsStep && (
          <WizardMultiSelect
            title="Select evaluators"
            description="Choose custom and/or built-in evaluators"
            items={evaluatorItems}
            cursorIndex={evaluatorsNav.cursorIndex}
            selectedIds={evaluatorsNav.selectedIds}
          />
        )}

        {isSamplingRateStep && (
          <TextInput
            key="samplingRate"
            prompt="Sampling rate (0.01–100%)"
            initialValue={String(DEFAULT_SAMPLING_RATE)}
            onSubmit={value => {
              const rate = parseFloat(value);
              if (isNaN(rate) || rate < 0.01 || rate > 100) return;
              wizard.setSamplingRate(rate);
            }}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const rate = parseFloat(value);
              if (isNaN(rate)) return 'Must be a number';
              if (rate < 0.01 || rate > 100) return 'Must be between 0.01 and 100';
              return true;
            }}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: wizard.config.name },
              { label: 'Agents', value: wizard.config.agents.join(', ') },
              { label: 'Evaluators', value: wizard.config.evaluators.join(', ') },
              { label: 'Sampling Rate', value: `${wizard.config.samplingRate}%` },
              { label: 'Enable on Create', value: 'Yes' },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
