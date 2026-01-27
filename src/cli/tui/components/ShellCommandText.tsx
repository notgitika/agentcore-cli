import { useShellContext } from './ShellContext';
import { Box, Text } from 'ink';

/**
 * Renders the current shell command with cursor position indicator.
 *
 * For multi-line input (e.g., pasting multiple export statements), shows
 * the line count and a preview of the content.
 *
 * The full command (including all lines) is preserved in state and executed
 * when the user presses Enter.
 */
export function ShellCommandText() {
  const { command, cursorPosition, mode } = useShellContext();

  // Split on both \r\n (Windows) and \n (Unix)
  const lines = command.split(/\r?\n/);
  const nonEmptyLines = lines.filter(Boolean);
  const lineCount = nonEmptyLines.length;

  // Only show cursor when in input mode
  const showCursor = mode === 'input';

  if (lineCount <= 1) {
    // Single line or empty - show with cursor
    const displayCommand = command.replace(/\r/g, '');

    if (!showCursor) {
      return <Text wrap="truncate">{displayCommand}</Text>;
    }

    // Show cursor: highlight the character AT cursor position, or show block at end
    const before = displayCommand.slice(0, cursorPosition);
    // eslint-disable-next-line security/detect-object-injection
    const charAtCursor = displayCommand[cursorPosition] ?? ' ';
    const after = displayCommand.slice(cursorPosition + 1);

    return (
      <Box>
        <Text>{before}</Text>
        <Text inverse>{charAtCursor}</Text>
        <Text>{after}</Text>
      </Box>
    );
  }

  // Multi-line: show line count and first line preview
  const firstLine = nonEmptyLines[0]?.replace(/\r/g, '') ?? '';
  const preview = firstLine.length > 40 ? firstLine.slice(0, 40) + '...' : firstLine;

  return (
    <Box>
      <Text dimColor>[{lineCount} lines] </Text>
      <Text wrap="truncate">{preview}</Text>
      {showCursor && <Text inverse> </Text>}
    </Box>
  );
}
