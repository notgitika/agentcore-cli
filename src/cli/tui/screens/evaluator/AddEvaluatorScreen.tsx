import type { EvaluationLevel, EvaluatorConfig } from '../../../../schema';
import { BedrockModelIdSchema, EvaluatorNameSchema } from '../../../../schema';
import type { SelectableItem } from '../../components';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddEvaluatorConfig } from './types';
import {
  DEFAULT_INSTRUCTIONS,
  DEFAULT_MODEL,
  EVALUATION_LEVEL_OPTIONS,
  EVALUATOR_STEP_LABELS,
  LEVEL_PLACEHOLDERS,
  RATING_SCALE_PRESETS,
  validateInstructionPlaceholders,
} from './types';
import { useAddEvaluatorWizard } from './useAddEvaluatorWizard';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

interface AddEvaluatorScreenProps {
  onComplete: (config: AddEvaluatorConfig) => void;
  onExit: () => void;
  existingEvaluatorNames: string[];
}

function formatRatingScale(ratingScale: EvaluatorConfig['llmAsAJudge']['ratingScale']): string {
  if ('numerical' in ratingScale && ratingScale.numerical) {
    return ratingScale.numerical.map(r => `${r.value}=${r.label}`).join(', ');
  }
  if ('categorical' in ratingScale && ratingScale.categorical) {
    return ratingScale.categorical.map(r => r.label).join(', ');
  }
  return 'Unknown';
}

export function AddEvaluatorScreen({ onComplete, onExit, existingEvaluatorNames }: AddEvaluatorScreenProps) {
  const wizard = useAddEvaluatorWizard();

  const levelItems: SelectableItem[] = useMemo(
    () => EVALUATION_LEVEL_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const ratingScaleItems: SelectableItem[] = useMemo(
    () => RATING_SCALE_PRESETS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const isNameStep = wizard.step === 'name';
  const isLevelStep = wizard.step === 'level';
  const isModelStep = wizard.step === 'model';
  const isInstructionsStep = wizard.step === 'instructions';
  const isRatingScaleStep = wizard.step === 'ratingScale';
  const isConfirmStep = wizard.step === 'confirm';

  const levelNav = useListNavigation({
    items: levelItems,
    onSelect: item => wizard.setLevel(item.id as EvaluationLevel),
    onExit: () => wizard.goBack(),
    isActive: isLevelStep,
  });

  const ratingScaleNav = useListNavigation({
    items: ratingScaleItems,
    onSelect: item => {
      const preset = RATING_SCALE_PRESETS.find(p => p.id === item.id);
      if (preset) wizard.setRatingScale(preset.ratingScale);
    },
    onExit: () => wizard.goBack(),
    isActive: isRatingScaleStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText =
    isLevelStep || isRatingScaleStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={EVALUATOR_STEP_LABELS} />;

  return (
    <Screen title="Add Evaluator" onExit={onExit} helpText={helpText} headerContent={headerContent} exitEnabled={false}>
      <Panel fullWidth>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Evaluator name"
            initialValue={generateUniqueName('MyEvaluator', existingEvaluatorNames)}
            onSubmit={wizard.setName}
            onCancel={onExit}
            schema={EvaluatorNameSchema}
            customValidation={value => !existingEvaluatorNames.includes(value) || 'Evaluator name already exists'}
          />
        )}

        {isLevelStep && (
          <WizardSelect
            title="Evaluation level"
            description="Granularity of evaluation"
            items={levelItems}
            selectedIndex={levelNav.selectedIndex}
          />
        )}

        {isModelStep && (
          <TextInput
            key="model"
            prompt="Bedrock model ID"
            initialValue={DEFAULT_MODEL}
            onSubmit={wizard.setModel}
            onCancel={() => wizard.goBack()}
            schema={BedrockModelIdSchema}
          />
        )}

        {isInstructionsStep && (
          <Box flexDirection="column">
            <Text>Evaluation instructions</Text>
            <Text dimColor>
              Must include at least one: {LEVEL_PLACEHOLDERS[wizard.config.level].map(p => `{${p}}`).join(', ')}
            </Text>
            <TextInput
              key="instructions"
              prompt=""
              hideArrow={false}
              initialValue={DEFAULT_INSTRUCTIONS[wizard.config.level]}
              onSubmit={wizard.setInstructions}
              onCancel={() => wizard.goBack()}
              customValidation={value => validateInstructionPlaceholders(value, wizard.config.level)}
            />
          </Box>
        )}

        {isRatingScaleStep && (
          <WizardSelect
            title="Rating scale"
            description="Choose a rating scale preset"
            items={ratingScaleItems}
            selectedIndex={ratingScaleNav.selectedIndex}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: wizard.config.name },
              { label: 'Level', value: wizard.config.level },
              { label: 'Model', value: wizard.config.config.llmAsAJudge.model },
              {
                label: 'Instructions',
                value:
                  wizard.config.config.llmAsAJudge.instructions.length > 60
                    ? wizard.config.config.llmAsAJudge.instructions.slice(0, 60) + '...'
                    : wizard.config.config.llmAsAJudge.instructions,
              },
              { label: 'Rating Scale', value: formatRatingScale(wizard.config.config.llmAsAJudge.ratingScale) },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
