import { Box, Text, useInput, useStdout } from 'ink';
import React, { useMemo, useState } from 'react';

/** A single resource or output change in the diff. */
export interface DiffChange {
  kind: 'add' | 'modify' | 'remove';
  resourceType: string;
  logicalId: string;
  /** Property-level changes for modifications */
  details?: string[];
}

/** A section of the diff (Resources, Outputs, etc.). */
export interface DiffSection {
  name: string;
  added: number;
  modified: number;
  removed: number;
  changes: DiffChange[];
}

/** Parsed summary of a stack diff. */
export interface StackDiffSummary {
  stackName: string;
  sections: DiffSection[];
  hasSecurityChanges: boolean;
  securitySummary?: string;
  totalChanges: number;
}

/** CDK I4002 StackDiff data shape (partial — only what we need). */
interface CdkStackDiffData {
  formattedDiff?: {
    diff?: string;
    security?: string;
  };
  permissionChanges?: string;
}

/**
 * Parse CDK I4002 structured data into a StackDiffSummary.
 * Falls back to text parsing if structured data is unavailable.
 */
export function parseStackDiff(data: unknown, messageText: string): StackDiffSummary {
  const typed = data as CdkStackDiffData | undefined;
  const diffText = typed?.formattedDiff?.diff ?? messageText;
  const securityText = typed?.formattedDiff?.security;
  const permissionChanges = typed?.permissionChanges ?? 'none';

  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  // Extract stack name from first line
  const lines = diffText.split('\n');
  let stackName = 'Unknown Stack';
  const stackLine = lines.find(l => stripAnsi(l).trimStart().startsWith('Stack '));
  if (stackLine) {
    stackName = stripAnsi(stackLine)
      .trim()
      .replace(/^Stack\s+/, '');
  }

  const sections: DiffSection[] = [];
  let currentSection: DiffSection | null = null;
  let currentChange: DiffChange | null = null;

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine).trimEnd();
    const trimmed = line.trimStart();

    // Section headers: "Resources", "Outputs", "Parameters", "Conditions"
    if (/^(Resources|Outputs|Parameters|Conditions|Mappings|Metadata)\s*$/.test(trimmed)) {
      if (currentSection && currentSection.changes.length > 0) {
        sections.push(currentSection);
      }
      currentSection = { name: trimmed.trim(), added: 0, modified: 0, removed: 0, changes: [] };
      currentChange = null;
      continue;
    }

    if (!currentSection) continue;

    // Resource/output change lines: "[+] AWS::Type LogicalId" or "[~] ..." or "[-] ..."
    const changeMatch = /^\[([+~-])\]\s+(\S+)\s+(\S+)/.exec(trimmed);
    if (changeMatch) {
      const kind: DiffChange['kind'] = changeMatch[1] === '+' ? 'add' : changeMatch[1] === '~' ? 'modify' : 'remove';
      currentChange = {
        kind,
        resourceType: changeMatch[2]!,
        logicalId: changeMatch[3]!,
        details: [],
      };
      currentSection.changes.push(currentChange);
      if (kind === 'add') currentSection.added++;
      else if (kind === 'modify') currentSection.modified++;
      else currentSection.removed++;
      continue;
    }

    // Detail lines (indented under a change): "└─ [~] PropertyName" or "├─ [+] ..."
    const detailMatch = /[└├]─\s*\[([+~-])\]\s+(.+)/.exec(trimmed);
    if (detailMatch && currentChange) {
      currentChange.details ??= [];
      currentChange.details.push(detailMatch[2]!);
    }
  }

  // Push last section
  if (currentSection && currentSection.changes.length > 0) {
    sections.push(currentSection);
  }

  const hasSecurityChanges = permissionChanges !== 'none' || !!securityText;
  const totalChanges = sections.reduce((sum, s) => sum + s.changes.length, 0);

  let securitySummary: string | undefined;
  if (hasSecurityChanges) {
    if (permissionChanges === 'broadening') {
      securitySummary = 'IAM policy broadening detected';
    } else if (securityText) {
      securitySummary = 'IAM statement changes detected';
    } else {
      securitySummary = 'IAM policy changes detected';
    }
  }

  return { stackName, sections, hasSecurityChanges, securitySummary, totalChanges };
}

/** Parse CDK I4001 overall summary data. */
export function parseDiffResult(data: unknown): { numStacksWithChanges: number } {
  const typed = data as { numStacksWithChanges?: number } | undefined;
  return { numStacksWithChanges: typed?.numStacksWithChanges ?? 0 };
}

// ─── Component ───────────────────────────────────────────────────────────

interface DiffSummaryViewProps {
  summaries: StackDiffSummary[];
  numStacksWithChanges?: number;
  isActive?: boolean;
  maxHeight?: number;
}

const CHANGE_ICON = { add: '+', modify: '~', remove: '-' } as const;
const CHANGE_COLOR = { add: 'green', modify: 'yellow', remove: 'red' } as const;

/** Structured, scrollable CDK diff summary view. */
export function DiffSummaryView({ summaries, numStacksWithChanges, isActive = true, maxHeight }: DiffSummaryViewProps) {
  const { stdout } = useStdout();
  const [scrollOffset, setScrollOffset] = useState(0);

  // Build all display lines as structured data for rendering
  const displayLines = useMemo(() => {
    const lines: { text: string; color?: string; bold?: boolean; dim?: boolean }[] = [];

    for (const summary of summaries) {
      if (summary.totalChanges === 0) {
        lines.push({ text: `Stack ${summary.stackName}`, color: 'cyan', bold: true });
        lines.push({ text: '  No differences', dim: true });
        lines.push({ text: '' });
        continue;
      }

      lines.push({ text: `Stack ${summary.stackName}`, color: 'cyan', bold: true });
      lines.push({ text: '' });

      for (const section of summary.sections) {
        // Section header with counts
        const counts = [
          section.added > 0 ? `${section.added} added` : '',
          section.modified > 0 ? `${section.modified} modified` : '',
          section.removed > 0 ? `${section.removed} removed` : '',
        ]
          .filter(Boolean)
          .join(', ');
        lines.push({ text: `  ${section.name} (${counts})`, bold: true });
        lines.push({ text: '' });

        for (const change of section.changes) {
          const icon = CHANGE_ICON[change.kind];
          const color = CHANGE_COLOR[change.kind];
          // Pad resource type for alignment
          const typeStr = change.resourceType.padEnd(30);
          lines.push({ text: `  [${icon}] ${typeStr} ${change.logicalId}`, color });

          // Show property-level details for modifications
          if (change.details && change.details.length > 0) {
            for (const detail of change.details) {
              lines.push({ text: `       └─ ${detail}`, dim: true });
            }
          }
        }
        lines.push({ text: '' });
      }

      // Security warning
      if (summary.hasSecurityChanges && summary.securitySummary) {
        lines.push({ text: `  ⚠ Security: ${summary.securitySummary}`, color: 'yellow', bold: true });
        lines.push({ text: '' });
      }
    }

    // Overall summary
    if (numStacksWithChanges !== undefined) {
      lines.push({ text: `✨ ${numStacksWithChanges} stack(s) with differences`, dim: true });
    }

    return lines;
  }, [summaries, numStacksWithChanges]);

  const terminalHeight = stdout?.rows ?? 24;
  // Use caller-supplied maxHeight, or fall back to terminal height with generous chrome margin
  const effectiveMax = maxHeight ?? Math.max(6, terminalHeight - 16);
  const displayHeight = Math.min(effectiveMax, displayLines.length);
  const totalLines = displayLines.length;
  const maxScroll = Math.max(0, totalLines - displayHeight);
  const needsScroll = totalLines > displayHeight;

  useInput(
    (_input, key) => {
      if (!needsScroll) return;
      if (key.upArrow) setScrollOffset(prev => Math.max(0, prev - 1));
      if (key.downArrow) setScrollOffset(prev => Math.min(maxScroll, prev + 1));
      if (key.pageUp) setScrollOffset(prev => Math.max(0, prev - displayHeight));
      if (key.pageDown) setScrollOffset(prev => Math.min(maxScroll, prev + displayHeight));
    },
    { isActive: isActive && needsScroll }
  );

  const visibleLines = displayLines.slice(scrollOffset, scrollOffset + displayHeight);

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={needsScroll ? displayHeight : undefined}>
        {visibleLines.map((line, idx) => (
          <Text
            key={scrollOffset + idx}
            color={line.color}
            bold={line.bold}
            dimColor={line.dim && !line.color}
            wrap="truncate"
          >
            {line.text || ' '}
          </Text>
        ))}
      </Box>
      {needsScroll && (
        <Text dimColor>
          [{scrollOffset + 1}-{Math.min(scrollOffset + displayHeight, totalLines)} of {totalLines}] ↑↓ PgUp/PgDn
        </Text>
      )}
    </Box>
  );
}
