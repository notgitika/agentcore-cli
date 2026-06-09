import { ConfigIO } from '../../../../lib';
import { validateAwsCredentials } from '../../../aws/account';
import { getErrorMessage } from '../../../errors';
import { createJobEngine } from '../../../operations/jobs';
import type { RecommendationJobRecord } from '../../../operations/jobs';
import { ErrorPrompt, Panel, Screen } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { Box, Text, useInput, useStdout } from 'ink';
import React, { useEffect, useMemo, useState } from 'react';

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

function shortTypeName(type: string): string {
  if (type === 'SYSTEM_PROMPT_RECOMMENDATION') return 'System Prompt';
  if (type === 'TOOL_DESCRIPTION_RECOMMENDATION') return 'Tool Description';
  return type;
}

function statusColor(status: string): string {
  if (status === 'COMPLETED' || status === 'SUCCEEDED') return 'green';
  if (status === 'FAILED') return 'red';
  if (status === 'IN_PROGRESS' || status === 'RUNNING' || status === 'PENDING') return 'yellow';
  return 'gray';
}

const CHROME_LINES = 9;

// ─────────────────────────────────────────────────────────────────────────────
// List view
// ─────────────────────────────────────────────────────────────────────────────

function RecommendationListView({
  records,
  onSelect,
  onExit,
  availableHeight,
}: {
  records: RecommendationJobRecord[];
  onSelect: (record: RecommendationJobRecord) => void;
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
        <Text bold>Recommendation Jobs</Text>
        <Text dimColor>
          {records.length} recommendation{records.length !== 1 ? 's' : ''}
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
                <Text color={statusColor(rec.status)}>{rec.status.padEnd(12)}</Text>
                <Text>{shortTypeName(rec.recommendationType).padEnd(18)}</Text>
                <Text dimColor>{rec.agent}</Text>
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

function RecommendationDetailView({ record, onBack }: { record: RecommendationJobRecord; onBack: () => void }) {
  useInput((input, key) => {
    if (key.escape || input === 'b') {
      onBack();
    }
  });

  const sysResult = record.result?.systemPromptRecommendationResult;
  const toolResult = record.result?.toolDescriptionRecommendationResult;
  const isFailed = record.status === 'FAILED';

  return (
    <Panel fullWidth>
      <Box flexDirection="column">
        <Text>
          <Text bold>ID:</Text> {record.id}
        </Text>
        <Text>
          <Text bold>Type:</Text> {shortTypeName(record.recommendationType)}
          {'  '}
          <Text bold>Agent:</Text> {record.agent}
          {'  '}
          <Text bold>Status:</Text> <Text color={statusColor(record.status)}>{record.status}</Text>
        </Text>
        <Text>
          <Text bold>Evaluators:</Text> {record.evaluators.join(', ') || '(none)'}
        </Text>
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

        {isFailed && record.failureDetail && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="red">
              Failure:
            </Text>
            <Box marginLeft={2}>
              <Text color="red">{record.failureDetail}</Text>
            </Box>
          </Box>
        )}

        {sysResult?.explanation && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="yellow">
              Explanation:
            </Text>
            <Box marginLeft={2} marginTop={1}>
              <Text>{sysResult.explanation}</Text>
            </Box>
          </Box>
        )}

        {sysResult?.recommendedSystemPrompt && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="cyan">
              Recommended System Prompt:
            </Text>
            <Box marginLeft={2} marginTop={1}>
              <Text>{sysResult.recommendedSystemPrompt}</Text>
            </Box>
          </Box>
        )}

        {toolResult?.tools && toolResult.tools.length > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="cyan">
              Recommended Tool Descriptions:
            </Text>
            {toolResult.tools.map(tool => (
              <Box key={tool.toolName} marginTop={1} marginLeft={2} flexDirection="column">
                <Text bold>{tool.toolName}</Text>
                {tool.explanation && (
                  <Box marginTop={1}>
                    <Text color="yellow">Explanation: </Text>
                    <Text>{tool.explanation}</Text>
                  </Box>
                )}
                <Text>{tool.recommendedToolDescription}</Text>
              </Box>
            ))}
          </Box>
        )}

        {!isFailed && !sysResult?.recommendedSystemPrompt && !(toolResult?.tools && toolResult.tools.length > 0) && (
          <Box marginTop={1}>
            <Text dimColor>No recommendation results available yet.</Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text dimColor>Press Esc or B to go back</Text>
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
  | { name: 'loaded'; records: RecommendationJobRecord[] };

interface RecommendationHistoryScreenProps {
  onExit: () => void;
}

export function RecommendationHistoryScreen({ onExit }: RecommendationHistoryScreenProps) {
  const engine = useMemo(() => createJobEngine(new ConfigIO()), []);
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;
  const availableHeight = Math.max(6, terminalHeight - CHROME_LINES);

  const [flow, setFlow] = useState<FlowState>({ name: 'loading' });
  const [selectedRecord, setSelectedRecord] = useState<RecommendationJobRecord | null>(null);

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
        const records = await engine.list({ type: 'recommendation' });
        if (!cancelled) setFlow({ name: 'loaded', records });
      } catch (err) {
        if (!cancelled) setFlow({ name: 'error', message: getErrorMessage(err) });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [engine]);

  if (flow.name === 'loading') {
    return (
      <Screen title="Recommendation Jobs [preview]" onExit={onExit}>
        <Text dimColor>Loading recommendation jobs...</Text>
      </Screen>
    );
  }

  if (flow.name === 'creds-error') {
    return <ErrorPrompt message="AWS credentials required" detail={flow.message} onBack={onExit} onExit={onExit} />;
  }

  if (flow.name === 'error') {
    return (
      <Screen title="Recommendation Jobs [preview]" onExit={onExit}>
        <Text color="red">{flow.message}</Text>
      </Screen>
    );
  }

  if (flow.records.length === 0) {
    return (
      <Screen title="Recommendation Jobs [preview]" onExit={onExit}>
        <Box flexDirection="column">
          <Text dimColor>No recommendation jobs found.</Text>
          <Text dimColor>Run `agentcore run recommendation` to create one.</Text>
        </Box>
      </Screen>
    );
  }

  const helpText = selectedRecord ? 'Esc/B back to list' : HELP_TEXT.NAVIGATE_SELECT;

  return (
    <Screen title="Recommendation Jobs [preview]" onExit={onExit} helpText={helpText} exitEnabled={!selectedRecord}>
      {selectedRecord ? (
        <RecommendationDetailView record={selectedRecord} onBack={() => setSelectedRecord(null)} />
      ) : (
        <RecommendationListView
          records={flow.records}
          onSelect={setSelectedRecord}
          onExit={onExit}
          availableHeight={availableHeight}
        />
      )}
    </Screen>
  );
}
