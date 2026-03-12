import { handleListEvalRuns } from '../../../operations/eval';
import type { EvalRunResult } from '../../../operations/eval/types';
import { Screen } from '../../components';
import { STATUS_COLORS } from '../../theme';
import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

interface EvalScreenProps {
  isInteractive: boolean;
  onExit: () => void;
}

type Phase = 'loading' | 'loaded' | 'error';

interface EvalState {
  phase: Phase;
  runs: EvalRunResult[];
  error: string | null;
}

export function EvalScreen({ isInteractive, onExit }: EvalScreenProps) {
  const [state, setState] = useState<EvalState>({
    phase: 'loading',
    runs: [],
    error: null,
  });

  useEffect(() => {
    const load = async () => {
      // Yield to allow React to paint the loading state
      await new Promise(resolve => setTimeout(resolve, 0));

      const result = handleListEvalRuns({});

      if (!result.success) {
        setState({ phase: 'error', runs: [], error: result.error ?? 'Unknown error' });
        return;
      }

      setState({ phase: 'loaded', runs: result.runs ?? [], error: null });
    };

    void load();
  }, []);

  return (
    <Screen title="Eval Runs" onExit={onExit}>
      <Box flexDirection="column" marginTop={1}>
        {state.phase === 'loading' && <Text dimColor>Loading eval runs...</Text>}

        {state.phase === 'error' && <Text color={STATUS_COLORS.error}>{state.error}</Text>}

        {state.phase === 'loaded' && state.runs.length === 0 && (
          <Text dimColor>No eval runs found. Run `agentcore run eval` to create one.</Text>
        )}

        {state.phase === 'loaded' && state.runs.length > 0 && (
          <Box flexDirection="column">
            <Box>
              <Text bold>
                {'Run ID'.padEnd(42)} {'Agent'.padEnd(20)} {'Score'.padEnd(30)} {'Sessions'.padEnd(10)} {'Date'}
              </Text>
            </Box>
            <Text dimColor>{'─'.repeat(110)}</Text>
            {state.runs.map(run => {
              const scores = run.results.map(r => `${r.evaluator}=${r.aggregateScore.toFixed(2)}`).join(', ');
              const date = new Date(run.timestamp).toLocaleDateString();
              return (
                <Box key={run.runId}>
                  <Text>
                    {run.runId.padEnd(42)} {run.agent.padEnd(20)} {scores.padEnd(30)}{' '}
                    {String(run.sessionCount).padEnd(10)} {date}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}

        {state.phase !== 'loading' && (
          <Box marginTop={1}>
            <Text dimColor>{isInteractive ? 'Esc/B back' : ''}</Text>
          </Box>
        )}
      </Box>
    </Screen>
  );
}
