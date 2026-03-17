import type { SelectableItem } from '../../components';
import {
  ConfirmReview,
  Panel,
  Screen,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import type { EvaluatorItem } from '../online-eval/types';
import type { AgentItem, RunEvalConfig } from './types';
import { DEFAULT_LOOKBACK_DAYS, RUN_EVAL_STEP_LABELS } from './types';
import { useRunEvalWizard } from './useRunEvalWizard';
import React, { useMemo } from 'react';

interface RunEvalScreenProps {
  agents: AgentItem[];
  evaluatorItems: EvaluatorItem[];
  onComplete: (config: RunEvalConfig) => void;
  onExit: () => void;
}

export function RunEvalScreen({ agents, evaluatorItems: rawEvaluatorItems, onComplete, onExit }: RunEvalScreenProps) {
  const wizard = useRunEvalWizard(agents.length);

  // Auto-select agent if only one
  const singleAgent = agents.length === 1 ? agents[0]!.name : null;
  if (singleAgent && !wizard.config.agent) {
    wizard.setAgent(singleAgent);
  }

  const agentItems: SelectableItem[] = useMemo(
    () => agents.map(a => ({ id: a.name, title: a.name, description: a.build })),
    [agents]
  );

  const evaluatorItems: SelectableItem[] = useMemo(
    () =>
      rawEvaluatorItems.map(e => ({
        id: e.arn,
        title: e.name,
        description: e.type === 'Builtin' ? 'Built-in evaluator' : (e.description ?? 'Custom evaluator'),
      })),
    [rawEvaluatorItems]
  );

  const isAgentStep = wizard.step === 'agent';
  const isEvaluatorsStep = wizard.step === 'evaluators';
  const isDaysStep = wizard.step === 'days';
  const isConfirmStep = wizard.step === 'confirm';

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => wizard.setAgent(item.id),
    onExit,
    isActive: isAgentStep,
  });

  const evaluatorsNav = useMultiSelectNavigation({
    items: evaluatorItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setEvaluators(ids),
    onExit: () => (agents.length <= 1 ? onExit() : wizard.goBack()),
    isActive: isEvaluatorsStep,
    requireSelection: true,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isAgentStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isEvaluatorsStep
      ? 'Space toggle · Enter confirm · Esc back'
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={RUN_EVAL_STEP_LABELS} />;

  return (
    <Screen title="Run On-demand Evaluation" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isAgentStep && (
          <WizardSelect
            title="Select agent to evaluate"
            description="Choose a project agent"
            items={agentItems}
            selectedIndex={agentNav.selectedIndex}
          />
        )}

        {isEvaluatorsStep && (
          <WizardMultiSelect
            title="Select evaluators"
            description="Choose evaluators to run against agent traces"
            items={evaluatorItems}
            cursorIndex={evaluatorsNav.cursorIndex}
            selectedIds={evaluatorsNav.selectedIds}
          />
        )}

        {isDaysStep && (
          <TextInput
            key="days"
            prompt="Lookback window (days)"
            initialValue={String(DEFAULT_LOOKBACK_DAYS)}
            onSubmit={value => {
              const days = parseInt(value, 10);
              if (isNaN(days) || days < 1 || days > 90) return;
              wizard.setDays(days);
            }}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const days = parseInt(value, 10);
              if (isNaN(days)) return 'Must be a number';
              if (days < 1 || days > 90) return 'Must be between 1 and 90';
              return true;
            }}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Agent', value: wizard.config.agent },
              { label: 'Evaluators', value: wizard.config.evaluators.join(', ') },
              { label: 'Lookback', value: `${wizard.config.days} day${wizard.config.days !== 1 ? 's' : ''}` },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
