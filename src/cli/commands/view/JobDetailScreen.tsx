import { ConfigIO } from '../../../lib';
import { validateAwsCredentials } from '../../aws/account';
import { getErrorMessage } from '../../errors';
import { createJobEngine, isTerminal } from '../../operations/jobs';
import type {
  ABTestJobRecord,
  BatchEvaluationJobRecord,
  DebugCheckResult,
  JobEngine,
  JobRecord,
  JobType,
} from '../../operations/jobs';
import { getInvocationUrl } from '../../operations/jobs/ab-test/format';
import { ErrorPrompt, Panel, Screen } from '../../tui/components';
import { Box, Text, useInput } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

interface JobDetailScreenProps {
  type: JobType;
  id: string;
  onExit: () => void;
}

type State = { name: 'loading' } | { name: 'error'; message: string } | { name: 'loaded'; record: JobRecord };

export function JobDetailScreen({ type, id, onExit }: JobDetailScreenProps) {
  const engine = useMemo(() => createJobEngine(new ConfigIO()), []);
  const [state, setState] = useState<State>({ name: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await validateAwsCredentials();
      } catch (err) {
        if (!cancelled) setState({ name: 'error', message: `AWS credentials required: ${getErrorMessage(err)}` });
        return;
      }
      try {
        const record = await engine.get(type, id);
        if (!record) {
          if (!cancelled) setState({ name: 'error', message: `Job "${id}" not found.` });
          return;
        }
        if (!cancelled) setState({ name: 'loaded', record });
      } catch (err) {
        if (!cancelled) setState({ name: 'error', message: getErrorMessage(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, type, id]);

  const handleUpdate = useCallback((updated: JobRecord) => {
    setState({ name: 'loaded', record: updated });
  }, []);

  if (state.name === 'loading') {
    return (
      <Screen title="Job Detail" onExit={onExit}>
        <Text dimColor>Loading job {id}...</Text>
      </Screen>
    );
  }

  if (state.name === 'error') {
    return <ErrorPrompt message="Job not found" detail={state.message} onBack={onExit} onExit={onExit} />;
  }

  const { record } = state;

  if (record.type === 'ab-test') {
    return <ABTestDetail record={record} engine={engine} onExit={onExit} onUpdate={handleUpdate} />;
  }
  if (record.type === 'batch-evaluation') {
    return <BatchEvalDetail record={record} engine={engine} onExit={onExit} onUpdate={handleUpdate} />;
  }
  return <RecommendationDetail record={record} onExit={onExit} />;
}

// ─────────────────────────────────────────────────────────────────────────────

function statusColor(status: string): string {
  if (status === 'COMPLETED' || status === 'SUCCEEDED' || status === 'RUNNING') return 'green';
  if (status === 'PAUSED' || status === 'IN_PROGRESS' || status === 'PENDING' || status === 'COMPLETED_WITH_ERRORS')
    return 'yellow';
  if (status === 'FAILED' || status === 'STOPPED' || status === 'CANCELLED' || status === 'NOT_FOUND') return 'red';
  return 'gray';
}

// ─────────────────────────────────────────────────────────────────────────────

function ABTestDetail({
  record,
  engine,
  onExit,
  onUpdate,
}: {
  record: ABTestJobRecord;
  engine: JobEngine;
  onExit: () => void;
  onUpdate: (r: JobRecord) => void;
}) {
  const [actionState, setActionState] = useState<'idle' | 'working' | 'error'>('idle');
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
    if (key.escape || input === 'q') {
      onExit();
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
    'Esc/Q exit',
    canStop ? 'S stop' : null,
    canPause ? 'P pause' : null,
    canResume ? 'R resume' : null,
    canPromote ? 'W promote' : null,
    'D debug',
  ].filter(Boolean);

  return (
    <Screen title="A/B Test Detail" onExit={onExit}>
      <Panel fullWidth>
        <Box flexDirection="column">
          <Text>
            <Text bold>ID:</Text> {record.id}
          </Text>
          <Text>
            <Text bold>Name:</Text> {record.name} <Text bold>Mode:</Text> {record.mode}
          </Text>
          <Text>
            <Text bold>Execution:</Text> <Text color={statusColor(record.status)}>{record.status}</Text>{' '}
            <Text bold>Lifecycle:</Text>{' '}
            <Text color={statusColor(record.lifecycleStatus)}>{record.lifecycleStatus}</Text>
          </Text>
          <Text>
            <Text bold>Gateway:</Text> {record.gatewayArn}
          </Text>
          {getInvocationUrl(record) && (
            <Text>
              <Text bold>Invocation URL:</Text> {getInvocationUrl(record)}
            </Text>
          )}
          {record.createdAt && (
            <Text>
              <Text bold>Started:</Text> {new Date(record.createdAt).toLocaleString()}
            </Text>
          )}

          <Box marginTop={1} flexDirection="column">
            <Text bold>Variants:</Text>
            {record.variants.map(v => (
              <Text key={v.name}>
                {'  '}
                {v.name} (weight {v.weight}):{' '}
                {v.bundleArn ? `bundle @ ${v.bundleVersion}` : v.targetName ? `target ${v.targetName}` : '—'}
              </Text>
            ))}
          </Box>

          {metrics && metrics.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text bold>Results:</Text>
              {metrics.map(m => (
                <Box key={m.evaluatorArn} flexDirection="column">
                  <Text dimColor>
                    {'  '}
                    {m.evaluatorArn}
                  </Text>
                  <Text>
                    {'    '}C (n={m.controlStats.sampleSize}): {m.controlStats.mean.toFixed(3)}
                  </Text>
                  {m.variantResults.map(vr => (
                    <Text key={vr.treatmentName}>
                      {'    '}
                      {vr.treatmentName} (n={vr.sampleSize}): {vr.mean.toFixed(3)}
                      {vr.isSignificant ? <Text color="green"> *sig*</Text> : null}
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
              <Text dimColor>No results yet.</Text>
            </Box>
          )}

          {actionState === 'working' && <Text color="yellow">Working...</Text>}
          {actionState === 'error' && <Text color="red">{actionError}</Text>}

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
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function BatchEvalDetail({
  record,
  engine,
  onExit,
  onUpdate,
}: {
  record: BatchEvaluationJobRecord;
  engine: JobEngine;
  onExit: () => void;
  onUpdate: (r: JobRecord) => void;
}) {
  const [stopState, setStopState] = useState<'idle' | 'stopping' | 'error'>('idle');
  const [stopError, setStopError] = useState<string | null>(null);
  const canStop = engine.capabilities('batch-evaluation').canStop && !isTerminal(record);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onExit();
      return;
    }
    if ((input === 's' || input === 'S') && canStop && stopState !== 'stopping') {
      setStopState('stopping');
      void (async () => {
        const result = await engine.stop('batch-evaluation', record.id);
        if (!result.success) {
          setStopState('error');
          setStopError(result.error.message);
          return;
        }
        const refreshed = await engine.get('batch-evaluation', record.id);
        setStopState('idle');
        if (refreshed) onUpdate(refreshed);
      })();
    }
  });

  const summaries = record.evaluationResults?.evaluatorSummaries;

  return (
    <Screen title="Batch Evaluation Detail" onExit={onExit}>
      <Panel fullWidth>
        <Box flexDirection="column">
          <Text>
            <Text bold>ID:</Text> {record.id}
          </Text>
          <Text>
            <Text bold>Name:</Text> {record.name} <Text bold>Status:</Text>{' '}
            <Text color={statusColor(record.status)}>{record.status}</Text>
          </Text>
          <Text>
            <Text bold>Agent:</Text> {record.agent} <Text bold>Evaluators:</Text> {record.evaluators.join(', ')}
          </Text>
          {record.createdAt && (
            <Text>
              <Text bold>Created:</Text> {new Date(record.createdAt).toLocaleString()}
            </Text>
          )}

          {summaries && summaries.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Text bold>Scores:</Text>
              {summaries.map(s => (
                <Text key={s.evaluatorId}>
                  {'  '}
                  {s.evaluatorId}: {s.statistics?.averageScore?.toFixed(2) ?? 'N/A'}
                  {s.totalFailed ? <Text color="red"> ({s.totalFailed} failed)</Text> : null}
                </Text>
              ))}
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text dimColor>No results yet.</Text>
            </Box>
          )}

          {stopState === 'stopping' && <Text color="yellow">Stopping...</Text>}
          {stopState === 'error' && <Text color="red">{stopError}</Text>}

          <Box marginTop={1}>
            <Text dimColor>Esc/Q exit{canStop ? ' · S stop' : ''}</Text>
          </Box>
        </Box>
      </Panel>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function RecommendationDetail({ record, onExit }: { record: JobRecord; onExit: () => void }) {
  useInput((_input, key) => {
    if (key.escape) onExit();
  });

  const rec = record as import('../../operations/jobs').RecommendationJobRecord;
  const result = rec.result;
  const sysPrompt = result?.systemPromptRecommendationResult;
  const toolDesc = result?.toolDescriptionRecommendationResult;

  return (
    <Screen title="Recommendation Detail" onExit={onExit}>
      <Panel fullWidth>
        <Box flexDirection="column">
          <Text>
            <Text bold>ID:</Text> {rec.id}
          </Text>
          <Text>
            <Text bold>Type:</Text> {rec.recommendationType} <Text bold>Status:</Text>{' '}
            <Text color={statusColor(rec.status)}>{rec.status}</Text>
          </Text>
          <Text>
            <Text bold>Agent:</Text> {rec.agent} <Text bold>Evaluators:</Text> {rec.evaluators.join(', ')}
          </Text>
          {rec.createdAt && (
            <Text>
              <Text bold>Created:</Text> {new Date(rec.createdAt).toLocaleString()}
            </Text>
          )}

          {sysPrompt?.recommendedSystemPrompt ? (
            <Box marginTop={1} flexDirection="column">
              {sysPrompt.explanation && <Text dimColor>{sysPrompt.explanation}</Text>}
              <Text bold>Recommended prompt:</Text>
              <Text>{sysPrompt.recommendedSystemPrompt}</Text>
            </Box>
          ) : toolDesc?.tools?.length ? (
            <Box marginTop={1} flexDirection="column">
              <Text bold>Recommended tool descriptions:</Text>
              {toolDesc.tools.map(t => (
                <Text key={t.toolName}>
                  {'  '}
                  {t.toolName}: {t.recommendedToolDescription}
                </Text>
              ))}
            </Box>
          ) : rec.status === 'FAILED' ? (
            <Box marginTop={1}>
              <Text color="red">Failed: {rec.failureDetail ?? rec.statusReasons?.join('; ') ?? 'unknown'}</Text>
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text dimColor>No results yet.</Text>
            </Box>
          )}

          <Box marginTop={1}>
            <Text dimColor>Esc/Q exit</Text>
          </Box>
        </Box>
      </Panel>
    </Screen>
  );
}
