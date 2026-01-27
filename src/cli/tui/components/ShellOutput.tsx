import { useResponsive } from '../hooks';
import { useShellContext } from './ShellContext';
import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

// Default reserve: header(2) + input(1) + indicator(1) + padding(2) + buffer(2)
const DEFAULT_RESERVED_LINES = 8;

interface TruncatedIndicatorProps {
  /** Lines truncated from memory (permanent loss) */
  memoryTruncated: number;
  /** Lines truncated from display (still in memory) */
  displayTruncated: boolean;
}

interface ScrollIndicatorProps {
  canScrollUp: boolean;
  canScrollDown: boolean;
  currentLine: number;
  totalLines: number;
}

function ScrollIndicator({ canScrollUp, canScrollDown, currentLine, totalLines }: ScrollIndicatorProps) {
  const line = '─'.repeat(6);
  const upArrow = canScrollUp ? '↑' : ' ';
  const downArrow = canScrollDown ? '↓' : ' ';
  return (
    <Text dimColor>
      {line} {upArrow} {currentLine}/{totalLines} {downArrow} (Shift+↑↓ to scroll) {line}
    </Text>
  );
}

function TruncatedIndicator({ memoryTruncated, displayTruncated }: TruncatedIndicatorProps) {
  const line = '─'.repeat(8);
  let message: string;

  if (memoryTruncated > 0) {
    // Memory truncation is more severe - show the count
    message = `${memoryTruncated.toLocaleString()} lines truncated from memory`;
  } else if (displayTruncated) {
    message = 'more output above (Shift+↑↓ to scroll)';
  } else {
    return null;
  }

  return (
    <Text dimColor color={memoryTruncated > 0 ? 'yellow' : undefined}>
      {line} {message} {line}
    </Text>
  );
}

function formatElapsedTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function RunningIndicator() {
  const [dots, setDots] = useState(1);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const dotInterval = setInterval(() => {
      setDots(d => (d % 3) + 1);
    }, 300);

    const timeInterval = setInterval(() => {
      setElapsedSeconds(s => s + 1);
    }, 1000);

    return () => {
      clearInterval(dotInterval);
      clearInterval(timeInterval);
    };
  }, []);

  const timeDisplay = elapsedSeconds > 0 ? ` (${formatElapsedTime(elapsedSeconds)})` : '';
  return (
    <Text dimColor>
      running{'.'.repeat(dots)}
      {timeDisplay}
    </Text>
  );
}

interface ShellOutputProps {
  reservedLines?: number;
}

/**
 * Component to render shell command output with scrolling support.
 */
export function ShellOutput({ reservedLines = DEFAULT_RESERVED_LINES }: ShellOutputProps) {
  const { mode, output, truncatedLines, scrollOffset } = useShellContext();
  const { height: terminalHeight } = useResponsive();

  if (mode === 'inactive') {
    return null;
  }

  // Calculate max lines based on terminal height, reserve space for indicators
  const maxLines = Math.max(5, terminalHeight - reservedLines - 1);

  // Calculate the window of output to show based on scroll offset
  // scrollOffset 0 = show most recent (bottom), higher = scroll up (show older)
  const totalLines = output.length;
  const maxScrollOffset = Math.max(0, totalLines - maxLines);
  const clampedOffset = Math.min(scrollOffset, maxScrollOffset);

  // Calculate slice indices
  const endIndex = totalLines - clampedOffset;
  const startIndex = Math.max(0, endIndex - maxLines);
  const visibleOutput = output.slice(startIndex, endIndex);

  // Determine if there's more content above/below
  const canScrollUp = startIndex > 0 || truncatedLines > 0;
  const canScrollDown = clampedOffset > 0;
  const isScrolled = clampedOffset > 0;

  // Show running indicator when command is executing but no output yet
  const showRunningIndicator = mode === 'running' && output.length === 0;

  // Show scroll indicator when scrolled, otherwise show truncation indicator
  const showScrollIndicator = isScrolled && mode === 'done';
  const showTruncation = !isScrolled && (truncatedLines > 0 || canScrollUp);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {showRunningIndicator && <RunningIndicator />}
      {visibleOutput.map((line, idx) => (
        <Text key={`${startIndex}-${idx}`}>{line || ' '}</Text>
      ))}
      {showScrollIndicator && (
        <ScrollIndicator
          canScrollUp={canScrollUp}
          canScrollDown={canScrollDown}
          currentLine={startIndex + 1}
          totalLines={totalLines}
        />
      )}
      {showTruncation && (
        <TruncatedIndicator memoryTruncated={truncatedLines} displayTruncated={canScrollUp && truncatedLines === 0} />
      )}
    </Box>
  );
}
