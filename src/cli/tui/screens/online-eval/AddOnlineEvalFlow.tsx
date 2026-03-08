import { ErrorPrompt } from '../../components';
import { useExistingEvaluatorNames } from '../../hooks/useCreateEvaluator';
import { useAvailableAgents } from '../../hooks/useCreateMcp';
import { useCreateOnlineEval, useExistingOnlineEvalNames } from '../../hooks/useCreateOnlineEval';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddOnlineEvalScreen } from './AddOnlineEvalScreen';
import type { AddOnlineEvalConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; configName: string }
  | { name: 'error'; message: string };

interface AddOnlineEvalFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddOnlineEvalFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddOnlineEvalFlowProps) {
  const { createOnlineEval, reset: resetCreate } = useCreateOnlineEval();
  const { names: existingConfigNames } = useExistingOnlineEvalNames();
  const { agents: availableAgents } = useAvailableAgents();
  const { names: availableEvaluators } = useExistingEvaluatorNames();
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });

  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleCreateComplete = useCallback(
    (config: AddOnlineEvalConfig) => {
      void createOnlineEval(config).then(result => {
        if (result.ok) {
          setFlow({ name: 'create-success', configName: result.configName });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createOnlineEval]
  );

  if (flow.name === 'create-wizard') {
    return (
      <AddOnlineEvalScreen
        existingConfigNames={existingConfigNames}
        availableAgents={availableAgents}
        availableEvaluators={availableEvaluators}
        onComplete={handleCreateComplete}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added online eval config: ${flow.configName}`}
        detail="Online eval config added to project in `agentcore/agentcore.json`. Deploy with `agentcore deploy`."
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to add online eval config"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
