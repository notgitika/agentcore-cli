import { ConfigIO } from '../../../../lib';
import { validateAwsCredentials } from '../../../aws/account';
import { getErrorMessage } from '../../../errors';
import { createJobEngine, isTerminal } from '../../../operations/jobs';
import type { ABTestJobRecord, DebugCheckResult, JobEngine } from '../../../operations/jobs';
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

/** Color for the executionStatus (stored in record.status). */
function statusColor(status: string): string {
  if (status === 'RUNNING') return 'green';
  if (status === 'PAUSED') return 'yellow';
  if (status === 'STOPPED' || status === 'NOT_FOUND') return 'red';
  return 'gray';
}

/** Color for the lifecycleStatus. */
function lifecycleColor(status: string): string {
  if (status === 'ACTIVE') return 'green';
  if (status === 'FAILED') return 'red';
  return 'gray';
}

const CHROME_LINES = 9;

// ─────────────────────────────────────────────────────────────────────────────
// List view
// ─────────────────────────────────────────────────────────────────────────────

function ABTestListView({
  records,
  onSelect,
  onExit,
  availableHeight,
}: {
  records: ABTestJobRecord[];
  onSelect: (record: ABTestJobRecord) => void;
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
        <Text bold>A/B Test Jobs</Text>
        <Text dimColor>
          {records.length} A/B test{records.length !== 1 ? 's' : ''}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {visible.items.map((rec, vIdx) => {
            const idx = visible.startIdx + vIdx;
            const selected = idx === nav.selectedIndex;
            const date = rec.createdAt ? formatShortDate(rec.createdAt) : 'unknown';
            return (
              <Text key={rec.id} wrap="truncate-end">
                <Text color={selected ? 'cyan' : undefined}>{selected ? '❯' : ' '} </Text>
                <Text dimColor>{date.padEnd(16)}</Text>
                <Text color={statusColor(rec.status)}>{rec.status.padEnd(10)}</Text>
                <Text color={lifecycleColor(rec.lifecycleStatus)}>{rec.lifecycleStatus.padEnd(10)}</Text>
                <Text>{rec.name}</Text>
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

type ActionState = 'idle' | 'working' | 'error';

function ABTestDetailView({
  record,
  engine,
  onBack,
  onUpdate,
}: {
  record: ABTestJobRecord;
  engine: JobEngine;
  onBack: () => void;
  onUpdate: (record: ABTestJobRecord) => void;
}) {
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [debugResults, setDebugResults] = useState<DebugCheckResult[] | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);

  const caps = engine.capabilities('ab-test');
  const terminal = isTerminal(record);
  const canStop = caps.canStop && !terminal;
  const canPause = caps.canPause && record.lifecycleStatus === 'RUNNING';
  const canResume = caps.canPause && record.lifecycleStatus === 'PAUSED';
  const canPromote = caps.canPromote && !terminal;

  const runAction = useCallback(
    async (fn: () => Promise<{ success: boolean; error?: { message: string } }>) => {
      setActionState('working');
      setActionError(null);
      try {
        const result = await fn();
        if (!result.success) {
          setActionState('error');
          setActionError(result.error?.message ?? 'Action failed');
          return;
        }
        const refreshed = await engine.get('ab-test', record.id);
        setActionState('idle');
        if (refreshed) onUpdate(refreshed);
      } catch (err) {
        setActionState('error');
        setActionError(getErrorMessage(err));
      }
    },
    [engine, record.id, onUpdate]
  );

  const handleDebug = useCallback(async () => {
    setDebugLoading(true);
    setDebugResults(null);
    try {
      const result = await engine.debug('ab-test', record.id);
      if (result.success) {
        setDebugResults(result.checks);
      } else {
        setDebugResults([{ label: 'Debug', status: 'fail', detail: result.error.message }]);
      }
    } catch {
      setDebugResults([{ label: 'Debug', status: 'fail', detail: 'Failed to run debug checks' }]);
    }
    setDebugLoading(false);
  }, [engine, record.id]);

  useInput((input, key) => {
    if (actionState === 'working' || debugLoading) return;
    if (key.escape || input === 'b') {
      onBack();
      return;
    }
    const ch = input.toLowerCase();
    if (ch === 's' && canStop) void runAction(() => engine.stop('ab-test', record.id));
    else if (ch === 'p' && canPause) void runAction(() => engine.pause('ab-test', record.id));
    else if (ch === 'r' && canResume) void runAction(() => engine.resume('ab-test', record.id));
    else if (ch === 'w' && canPromote) void runAction(() => engine.promote('ab-test', record.id));
    else if (ch === 'd') void handleDebug();
  });

  const metrics = record.results?.evaluatorMetrics;

  const keyHints = [
    'Esc/B back',
    canStop ? 'S stop' : null,
    canPause ? 'P pause' : null,
    canResume ? 'R resume' : null,
    canPromote ? 'W promote' : null,
    'D debug',
  ].filter(Boolean);

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text>
          <Text bold>ID:</Text> {record.id}
        </Text>
        <Text>
          <Text bold>Name:</Text> {record.name}
          {'  '}
          <Text bold>Mode:</Text> {record.mode}
        </Text>
        <Text>
          <Text bold>Execution:</Text> <Text color={statusColor(record.status)}>{record.status}</Text>
          {'  '}
          <Text bold>Lifecycle:</Text>{' '}
          <Text color={lifecycleColor(record.lifecycleStatus)}>{record.lifecycleStatus}</Text>
        </Text>
        {record.createdAt && (
          <Text>
            <Text bold>Started:</Text> {new Date(record.createdAt).toLocaleString()}
          </Text>
        )}
        {record.completedAt && (
          <Text>
            <Text bold>Stopped:</Text> {new Date(record.completedAt).toLocaleString()}
          </Text>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text bold>Variants:</Text>
          {record.variants.map(v => {
            const detail = v.bundleArn
              ? `bundle ${v.bundleArn} @ ${v.bundleVersion}`
              : v.targetName
                ? `target ${v.targetName}`
                : '(unspecified)';
            return (
              <Text key={v.name}>
                {'  '}
                <Text bold>{v.name}</Text> (weight {v.weight}): <Text dimColor>{detail}</Text>
              </Text>
            );
          })}
        </Box>

        {metrics && metrics.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Text bold>Results:</Text>
            {metrics.map(m => (
              <Box key={m.evaluatorArn} flexDirection="column">
                <Text dimColor>{m.evaluatorArn}</Text>
                <Text>
                  {'  '}C (n={m.controlStats.sampleSize}): {m.controlStats.mean.toFixed(3)}
                </Text>
                {m.variantResults.map(vr => (
                  <Text key={vr.treatmentName}>
                    {'  '}
                    {vr.treatmentName} (n={vr.sampleSize}): {vr.mean.toFixed(3)}
                    {vr.percentChange != null
                      ? ` (${vr.percentChange > 0 ? '+' : ''}${vr.percentChange.toFixed(1)}%)`
                      : ''}
                    {vr.isSignificant ? <Text color="green"> *significant*</Text> : null}
                  </Text>
                ))}
              </Box>
            ))}
          </Box>
        ) : record.failureReason ? (
          <Box marginTop={1}>
            <Text color="red">Failure: {record.failureReason}</Text>
          </Box>
        ) : (
          <Box marginTop={1}>
            <Text dimColor>No results available yet.</Text>
          </Box>
        )}

        {actionState === 'working' && (
          <Box marginTop={1}>
            <Text color="yellow">Working...</Text>
          </Box>
        )}
        {actionState === 'error' && actionError && (
          <Box marginTop={1}>
            <Text color="red">Action failed: {actionError}</Text>
          </Box>
        )}

        {debugLoading && (
          <Box marginTop={1}>
            <Text color="yellow">Running debug checks...</Text>
          </Box>
        )}
        {debugResults && (
          <Box marginTop={1} flexDirection="column">
            <Text bold>Debug Checks:</Text>
            {debugResults.map((check, i) => {
              const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
              const color = check.status === 'pass' ? 'green' : check.status === 'warn' ? 'yellow' : 'red';
              return (
                <Text key={i}>
                  {'  '}
                  <Text color={color}>{icon}</Text> {check.label}: <Text dimColor>{check.detail}</Text>
                </Text>
              );
            })}
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>{keyHints.join(' · ')}</Text>
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
  | { name: 'loaded'; records: ABTestJobRecord[] };

interface ABTestJobsHistoryScreenProps {
  onExit: () => void;
}

export function ABTestJobsHistoryScreen({ onExit }: ABTestJobsHistoryScreenProps) {
  const engine = useMemo(() => createJobEngine(new ConfigIO()), []);
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const availableHeight = Math.max(6, terminalHeight - CHROME_LINES);

  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });
  const [selectedRecord, setSelectedRecord] = useState<ABTestJobRecord | null>(null);

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
        const records = await engine.list({ type: 'ab-test' });
        if (!cancelled) setFlow({ name: 'loaded', records });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engine]);

  const handleUpdate = useCallback((updated: ABTestJobRecord) => {
    setSelectedRecord(updated);
    setFlow(prev =>
      prev.name === 'loaded' ? { ...prev, records: prev.records.map(r => (r.id === updated.id ? updated : r)) } : prev
    );
  }, []);

  if (flow.name === 'loading') {
    return (
      <Screen title="A/B Test Jobs [preview]" onExit={onExit}>
        <Text dimColor>Loading A/B test jobs...</Text>
      </Screen>
    );
  }

  if (flow.name === 'creds-error') {
    return <ErrorPrompt message="AWS credentials required" detail={flow.message} onBack={onExit} onExit={onExit} />;
  }

  if (flow.name === 'error') {
    return (
      <Screen title="A/B Test Jobs [preview]" onExit={onExit}>
        <Text color="red">{flow.message}</Text>
      </Screen>
    );
  }

  if (flow.records.length === 0) {
    return (
      <Screen title="A/B Test Jobs [preview]" onExit={onExit}>
        <Box flexDirection="column">
          <Text dimColor>No A/B test jobs found.</Text>
          <Text dimColor>Run an A/B test from the TUI or CLI to see results here.</Text>
        </Box>
      </Screen>
    );
  }

  const helpText = selectedRecord ? 'Esc/B back to list' : HELP_TEXT.NAVIGATE_SELECT;

  return (
    <Screen title="A/B Test Jobs [preview]" onExit={onExit} helpText={helpText} exitEnabled={!selectedRecord}>
      {selectedRecord ? (
        <ABTestDetailView
          record={selectedRecord}
          engine={engine}
          onBack={() => setSelectedRecord(null)}
          onUpdate={handleUpdate}
        />
      ) : (
        <ABTestListView
          records={flow.records}
          onSelect={setSelectedRecord}
          onExit={onExit}
          availableHeight={availableHeight}
        />
      )}
    </Screen>
  );
}
