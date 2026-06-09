import { ConfigIO } from '../../../../lib';
import { validateAwsCredentials } from '../../../aws/account';
import { getErrorMessage } from '../../../errors';
import { createJobEngine, isTerminal } from '../../../operations/jobs';
import type { BatchEvaluationJobRecord, JobEngine } from '../../../operations/jobs';
import { ErrorPrompt, Panel, Screen } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatShortDate(timestamp: string): string {
  const d = new Date(timestamp);
  const mon = MONTHS[d.getMonth()];
  const day = d.getDate();
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${mon} ${day} ${h12}:${m} ${ampm}`;
}

function statusColor(status: string): string {
  if (status === 'COMPLETED' || status === 'SUCCEEDED') return 'green';
  if (status === 'COMPLETED_WITH_ERRORS') return 'yellow';
  if (status === 'FAILED' || status === 'STOPPED' || status === 'CANCELLED') return 'red';
  if (status === 'IN_PROGRESS' || status === 'RUNNING' || status === 'PENDING') return 'yellow';
  return 'gray';
}

function scoreColor(score: number): string {
  if (score >= 0.8) return 'green';
  if (score >= 0.5) return 'yellow';
  return 'red';
}

const CHROME_LINES = 9;

// ─────────────────────────────────────────────────────────────────────────────
// List view
// ─────────────────────────────────────────────────────────────────────────────

function BatchEvalListView({
  records,
  onSelect,
  onExit,
  availableHeight,
}: {
  records: BatchEvaluationJobRecord[];
  onSelect: (record: BatchEvaluationJobRecord) => void;
  onExit: () => void;
  availableHeight: number;
}) {
  const nav = useListNavigation({
    items: records,
    onSelect: item => onSelect(item),
    onExit,
    isActive: true,
  });

  const maxVisible = Math.max(1, availableHeight - 3);
  const visible = useMemo(() => {
    let start = 0;
    if (nav.selectedIndex >= maxVisible) {
      start = nav.selectedIndex - maxVisible + 1;
    }
    return { items: records.slice(start, start + maxVisible), startIdx: start };
  }, [records, nav.selectedIndex, maxVisible]);

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text bold>Batch Evaluation Jobs</Text>
        <Text dimColor>
          {records.length} batch evaluation{records.length !== 1 ? 's' : ''}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {visible.items.map((rec, vIdx) => {
            const idx = visible.startIdx + vIdx;
            const selected = idx === nav.selectedIndex;
            const date = rec.createdAt ? formatShortDate(rec.createdAt) : 'unknown';

            // Average score per evaluator, read straight from the API summaries in the record.
            const avgScores = (rec.evaluationResults?.evaluatorSummaries ?? [])
              .map(s => s.statistics?.averageScore)
              .filter((v): v is number => v != null);

            const datasetLabel =
              rec.source === 'dataset' && rec.dataset ? ` [${rec.dataset.id}@${rec.dataset.version}]` : '';

            return (
              <Text key={rec.id} wrap="truncate-end">
                <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '} </Text>
                <Text dimColor>{date.padEnd(16)}</Text>
                <Text color={statusColor(rec.status)}>{rec.status.padEnd(12)}</Text>
                <Text dimColor>avg </Text>
                {avgScores.length > 0 ? (
                  avgScores.map((avg, i) => (
                    <Text key={i} color={scoreColor(avg)}>
                      {avg.toFixed(2)}
                      {i < avgScores.length - 1 ? <Text dimColor>, </Text> : ' '}
                    </Text>
                  ))
                ) : (
                  <Text dimColor>{'—'.padEnd(7)}</Text>
                )}
                <Text dimColor>{rec.name}</Text>
                {datasetLabel && <Text color="blue">{datasetLabel}</Text>}
              </Text>
            );
          })}
          {visible.startIdx + maxVisible < records.length && (
            <Text dimColor> ↓ {records.length - visible.startIdx - maxVisible} more</Text>
          )}
        </Box>
      </Box>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail view
// ─────────────────────────────────────────────────────────────────────────────

function BatchEvalDetailView({
  record,
  engine,
  onBack,
  onUpdate,
}: {
  record: BatchEvaluationJobRecord;
  engine: JobEngine;
  onBack: () => void;
  onUpdate: (record: BatchEvaluationJobRecord) => void;
}) {
  const [stopState, setStopState] = useState<'idle' | 'stopping' | 'error'>('idle');
  const [stopError, setStopError] = useState<string | null>(null);

  const canStop = engine.capabilities('batch-evaluation').canStop && !isTerminal(record);

  const handleStop = useCallback(async () => {
    setStopState('stopping');
    setStopError(null);
    try {
      const result = await engine.stop('batch-evaluation', record.id);
      if (!result.success) {
        setStopState('error');
        setStopError(result.error.message);
        return;
      }
      const refreshed = await engine.get('batch-evaluation', record.id);
      setStopState('idle');
      if (refreshed) onUpdate(refreshed);
    } catch (err) {
      setStopState('error');
      setStopError(getErrorMessage(err));
    }
  }, [engine, record.id, onUpdate]);

  useInput((input, key) => {
    if (key.escape || input === 'b') {
      onBack();
      return;
    }
    if ((input === 's' || input === 'S') && canStop && stopState !== 'stopping') {
      void handleStop();
    }
  });

  const evalRes = record.evaluationResults;
  const summaries = evalRes?.evaluatorSummaries;

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text>
          <Text bold>ID:</Text> {record.id}
        </Text>
        <Text>
          <Text bold>Name:</Text> {record.name}
          {'  '}
          <Text bold>Status:</Text> <Text color={statusColor(record.status)}>{record.status}</Text>
        </Text>
        <Text>
          <Text bold>Evaluators:</Text> {record.evaluators.join(', ')}
        </Text>
        {record.source === 'dataset' && record.dataset && (
          <Text>
            <Text bold>Dataset:</Text> {record.dataset.id} (version: {record.dataset.version})
          </Text>
        )}
        {record.createdAt && (
          <Text>
            <Text bold>Created:</Text> {new Date(record.createdAt).toLocaleString()}
          </Text>
        )}
        {record.completedAt && (
          <Text>
            <Text bold>Completed:</Text> {new Date(record.completedAt).toLocaleString()}
          </Text>
        )}

        {evalRes?.totalNumberOfSessions != null && (
          <Text>
            <Text bold>Sessions:</Text> {evalRes.totalNumberOfSessions} total
            {evalRes.numberOfSessionsCompleted != null && <Text>, {evalRes.numberOfSessionsCompleted} completed</Text>}
            {evalRes.numberOfSessionsFailed ? <Text color="red">, {evalRes.numberOfSessionsFailed} failed</Text> : null}
          </Text>
        )}

        {summaries && summaries.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold>Scores (0 worst — 1 best):</Text>
            {summaries.map(s => {
              const avg = s.statistics?.averageScore;
              const avgStr = avg != null ? avg.toFixed(2) : 'N/A';
              const color = avg != null ? scoreColor(avg) : undefined;
              return (
                <Text key={s.evaluatorId}>
                  {'  '}
                  <Text bold>{s.evaluatorId}</Text>
                  {'  '}
                  <Text color={color}>{avgStr}</Text>
                  {s.totalFailed ? <Text color="red"> ({s.totalFailed} failed)</Text> : null}
                  {s.totalEvaluated != null && <Text dimColor> [{s.totalEvaluated} evaluated]</Text>}
                </Text>
              );
            })}
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text dimColor>No evaluation results available yet.</Text>
          </Box>
        )}

        {stopState === 'stopping' && (
          <Box marginTop={1}>
            <Text color="yellow">Stopping...</Text>
          </Box>
        )}
        {stopState === 'error' && stopError && (
          <Box marginTop={1}>
            <Text color="red">Could not stop: {stopError}</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>Press Esc or B to go back{canStop ? ' · S to stop' : ''}</Text>
        </Box>
      </Box>
    </Panel>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main screen
// ─────────────────────────────────────────────────────────────────────────────

type FlowState =
  | { name: 'loading' }
  | { name: 'creds-error'; message: string }
  | { name: 'error'; message: string }
  | { name: 'loaded'; records: BatchEvaluationJobRecord[] };

interface BatchEvalHistoryScreenProps {
  onExit: () => void;
}

export function BatchEvalHistoryScreen({ onExit }: BatchEvalHistoryScreenProps) {
  const engine = useMemo(() => createJobEngine(new ConfigIO()), []);
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const availableHeight = Math.max(6, terminalHeight - CHROME_LINES);

  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });
  const [selectedRecord, setSelectedRecord] = useState<BatchEvaluationJobRecord | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await validateAwsCredentials();
      } catch (err) {
        if (!cancelled) setFlow({ name: 'creds-error', message: getErrorMessage(err) });
        return;
      }

      try {
        const records = await engine.list({ type: 'batch-evaluation' });
        if (!cancelled) setFlow({ name: 'loaded', records });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engine]);

  // Apply an updated record (e.g. after a stop) into both the selection and the list.
  const handleUpdate = useCallback((updated: BatchEvaluationJobRecord) => {
    setSelectedRecord(updated);
    setFlow(prev =>
      prev.name === 'loaded' ? { ...prev, records: prev.records.map(r => (r.id === updated.id ? updated : r)) } : prev
    );
  }, []);

  if (flow.name === 'loading') {
    return (
      <Screen title="Batch Evaluation Jobs [preview]" onExit={onExit}>
        <Text dimColor>Loading batch evaluation jobs...</Text>
      </Screen>
    );
  }

  if (flow.name === 'creds-error') {
    return <ErrorPrompt message="AWS credentials required" detail={flow.message} onBack={onExit} onExit={onExit} />;
  }

  if (flow.name === 'error') {
    return (
      <Screen title="Batch Evaluation Jobs [preview]" onExit={onExit}>
        <Text color="red">{flow.message}</Text>
      </Screen>
    );
  }

  if (flow.records.length === 0) {
    return (
      <Screen title="Batch Evaluation Jobs [preview]" onExit={onExit}>
        <Box flexDirection="column">
          <Text dimColor>No batch evaluation jobs found.</Text>
          <Text dimColor>Run a batch evaluation from the TUI or CLI to see results here.</Text>
        </Box>
      </Screen>
    );
  }

  const helpText = selectedRecord ? 'Esc/B back to list' : HELP_TEXT.NAVIGATE_SELECT;

  return (
    <Screen title="Batch Evaluation Jobs [preview]" onExit={onExit} helpText={helpText} exitEnabled={!selectedRecord}>
      {selectedRecord ? (
        <BatchEvalDetailView
          record={selectedRecord}
          engine={engine}
          onBack={() => setSelectedRecord(null)}
          onUpdate={handleUpdate}
        />
      ) : (
        <BatchEvalListView
          records={flow.records}
          onSelect={setSelectedRecord}
          onExit={onExit}
          availableHeight={availableHeight}
        />
      )}
    </Screen>
  );
}
