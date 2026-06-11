import { Screen, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import React, { useMemo } from 'react';

interface RunScreenProps {
  onRunEval: () => void;
  onRunBatchEval: () => void;
  onRunRecommendation: () => void;
  onRunIngest: () => void;
  onExit: () => void;
}

export function RunScreen({ onRunEval, onRunBatchEval, onRunRecommendation, onRunIngest, onExit }: RunScreenProps) {
  const items: SelectableItem[] = useMemo(
    () => [
      {
        id: 'run-eval',
        title: 'On-demand Evaluation',
        description: 'Evaluate agent traces with selected evaluators. CLI also supports --agent-arn.',
      },
      {
        id: 'run-batch-eval',
        title: 'Batch Evaluation',
        description: 'Run a batch evaluation against agent sessions via CloudWatch.',
      },
      {
        id: 'run-recommendation',
        title: 'Recommendation',
        description: 'Optimize system prompts or tool descriptions using agent traces.',
      },
      {
        id: 'run-ingest',
        title: 'Ingest knowledge base',
        description: 'Start an ingestion job for a deployed knowledge base.',
      },
    ],
    []
  );

  const nav = useListNavigation({
    items,
    onSelect: item => {
      if (item.id === 'run-eval') onRunEval();
      else if (item.id === 'run-batch-eval') onRunBatchEval();
      else if (item.id === 'run-recommendation') onRunRecommendation();
      else if (item.id === 'run-ingest') onRunIngest();
    },
    onExit,
    isActive: true,
  });

  return (
    <Screen title="Run" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT} exitEnabled={false}>
      <WizardSelect title="Choose an operation" items={items} selectedIndex={nav.selectedIndex} />
    </Screen>
  );
}
