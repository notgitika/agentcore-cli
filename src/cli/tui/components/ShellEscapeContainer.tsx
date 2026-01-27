import { useShellMode } from '../hooks';
import { ShellContext } from './ShellContext';
import { ShellOutput } from './ShellOutput';
import { Box, Text, useInput } from 'ink';
import React, { useEffect, useMemo, useRef } from 'react';

function ShellModeIndicator({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <Box paddingLeft={2} marginBottom={1}>
      <Text color="yellow">shell mode (esc to exit)</Text>
    </Box>
  );
}

interface ShellEscapeContainerProps {
  children: React.ReactNode;
  enabled?: boolean;
  reservedLines?: number;
  initialShellCommand?: string;
  /** Called when shell command completes. Used to auto-return to previous screen. */
  onShellComplete?: () => void;
}

/**
 * Wraps a screen to provide shell escape functionality.
 * When `!` is pressed, enters shell mode. The screen content stays visible,
 * and the prompt changes from `>` to `!` via ShellContext.
 * Command output appears below the screen content.
 */
export function ShellEscapeContainer({
  children,
  enabled = true,
  reservedLines,
  initialShellCommand,
  onShellComplete,
}: ShellEscapeContainerProps) {
  const shell = useShellMode({ initialCommand: initialShellCommand });
  const hasExecutedCommand = useRef(false);

  // Track when a command has been executed
  useEffect(() => {
    if (shell.mode === 'done' && shell.exitCode !== null) {
      hasExecutedCommand.current = true;
    }
  }, [shell.mode, shell.exitCode]);

  // Call onShellComplete when shell deactivates after executing a command
  useEffect(() => {
    if (shell.mode === 'inactive' && hasExecutedCommand.current && onShellComplete) {
      hasExecutedCommand.current = false;
      onShellComplete();
    }
  }, [shell.mode, onShellComplete]);

  useInput(
    (input, key) => {
      // Handle shell mode input
      if (shell.mode !== 'inactive') {
        if (key.ctrl && input === 'c') {
          if (shell.mode === 'running') {
            shell.interrupt();
          } else {
            shell.deactivate();
          }
          return;
        }

        // Escape should always deactivate, even when running
        if (key.escape) {
          if (shell.mode === 'running') {
            shell.interrupt();
          }
          shell.deactivate();
          return;
        }

        if (shell.mode === 'input') {
          // Handle special keys first (before paste detection)
          // On Mac, the "delete" key sends key.delete, not key.backspace
          // So we treat both as backspace (delete char before cursor)
          if (key.backspace || key.delete || (key.ctrl && input === 'h')) {
            shell.backspaceCommand();
            return;
          }
          if (key.upArrow) {
            shell.historyUp();
            return;
          }
          if (key.downArrow) {
            shell.historyDown();
            return;
          }
          if (key.leftArrow) {
            shell.cursorLeft();
            return;
          }
          if (key.rightArrow) {
            shell.cursorRight();
            return;
          }
          // Ctrl+A = cursor to start, Ctrl+E = cursor to end
          if (key.ctrl && input === 'a') {
            shell.cursorToStart();
            return;
          }
          if (key.ctrl && input === 'e') {
            shell.cursorToEnd();
            return;
          }

          // Detect paste: multiple printable characters at once
          const isPaste = input.length > 1;

          if (isPaste) {
            // Pasted content: append everything, normalize line endings
            shell.appendToCommand(input.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
            return;
          }

          // Single character input
          if (key.return) {
            if (shell.command.trim()) {
              shell.execute();
            }
            return;
          }

          // Filter out control characters and special keys before appending
          if (input && !key.ctrl && !key.meta && !key.backspace && !key.delete) {
            // Also filter out actual backspace/delete characters (DEL=0x7F, BS=0x08)
            // Using RegExp constructor to avoid lint errors about control characters
            // eslint-disable-next-line security/detect-non-literal-regexp
            const controlChars = new RegExp('[' + String.fromCharCode(0x7f, 0x08) + ']', 'g');
            const filtered = input.replace(controlChars, '');
            if (filtered) {
              shell.appendToCommand(filtered);
            }
          }
        } else if (shell.mode === 'done') {
          // Scroll controls in done mode (Shift+arrows or Page Up/Down)
          if (key.upArrow && key.shift) {
            shell.scrollUp();
            return;
          }
          if (key.downArrow && key.shift) {
            shell.scrollDown();
            return;
          }
          // Ctrl+Home/End for top/bottom
          if (key.ctrl && input === 'u') {
            shell.scrollToTop();
            return;
          }
          if (key.ctrl && input === 'd') {
            shell.scrollToBottom();
            return;
          }

          if (key.return && shell.command.trim()) {
            // Re-run same command
            shell.execute();
          } else if (key.backspace || key.delete || (key.ctrl && input === 'h')) {
            // Edit the previous command (Mac sends key.delete for backspace key)
            shell.backspaceCommand();
          } else if (input && !key.ctrl && !key.meta) {
            // Start fresh command
            shell.setCommand(input);
            shell.continueInput();
          }
        }
        return;
      }

      // ! enters shell mode (only when enabled and inactive)
      if (input === '!' && enabled) {
        shell.activate();
      }
    },
    { isActive: enabled }
  );

  const isActive = shell.mode !== 'inactive';

  const contextValue = useMemo(
    () => ({
      mode: shell.mode,
      command: shell.command,
      output: shell.output,
      exitCode: shell.exitCode,
      isActive,
      truncatedLines: shell.truncatedLines,
      cursorPosition: shell.cursorPosition,
      scrollOffset: shell.scrollOffset,
    }),
    [
      shell.mode,
      shell.command,
      shell.output,
      shell.exitCode,
      isActive,
      shell.truncatedLines,
      shell.cursorPosition,
      shell.scrollOffset,
    ]
  );

  return (
    <ShellContext.Provider value={contextValue}>
      <Box flexDirection="column">
        {children}
        <ShellModeIndicator active={isActive} />
        <ShellOutput reservedLines={reservedLines} />
      </Box>
    </ShellContext.Provider>
  );
}
