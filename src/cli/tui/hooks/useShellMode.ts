import { type ShellExecutor, type ShellMode, spawnPersistentShellCommand, truncateOutput } from '../../shell';
import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_HISTORY_SIZE = 100;

export interface UseShellModeResult {
  // State
  mode: ShellMode;
  command: string;
  output: string[];
  exitCode: number | null;
  historyIndex: number;
  /** Number of output lines that were truncated from memory (not just display) */
  truncatedLines: number;
  /** Cursor position within the command (0 = start, command.length = end) */
  cursorPosition: number;
  /** Scroll offset for output viewing (0 = bottom/most recent) */
  scrollOffset: number;

  // Actions
  activate: () => void;
  deactivate: () => void;
  setCommand: (cmd: string) => void;
  appendToCommand: (char: string) => void;
  backspaceCommand: () => void;
  deleteAtCursor: () => void;
  execute: () => void;
  interrupt: () => void;
  continueInput: () => void;
  acknowledge: () => void;
  historyUp: () => void;
  historyDown: () => void;
  cursorLeft: () => void;
  cursorRight: () => void;
  cursorToStart: () => void;
  cursorToEnd: () => void;
  scrollUp: () => void;
  scrollDown: () => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
}

interface UseShellModeOptions {
  initialCommand?: string;
}

// Persist history across shell mode activations (module-level state)
let commandHistory: string[] = [];

interface CommandState {
  text: string;
  cursor: number;
}

export function useShellMode(options?: UseShellModeOptions): UseShellModeResult {
  const initialCommand = options?.initialCommand;
  // Use explicit undefined check so empty string '' still activates shell mode
  const [mode, setMode] = useState<ShellMode>(initialCommand !== undefined ? 'input' : 'inactive');
  // Combined state for command text and cursor position to ensure atomic updates
  const [cmdState, setCmdState] = useState<CommandState>({
    text: initialCommand ?? '',
    cursor: initialCommand?.length ?? 0,
  });
  const [output, setOutput] = useState<string[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [truncatedLines, setTruncatedLines] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Derived values for easier access
  const command = cmdState.text;
  const cursorPosition = cmdState.cursor;

  // History navigation: -1 means current input, 0+ means index into history (0 = most recent)
  const [historyIndex, setHistoryIndex] = useState(-1);
  // Store the current input when navigating history so we can restore it
  const savedInputRef = useRef('');

  const executorRef = useRef<ShellExecutor | null>(null);

  const appendOutput = useCallback((lines: string[]) => {
    setOutput(prev => {
      const result = truncateOutput([...prev, ...lines]);
      if (result.truncatedCount > 0) {
        setTruncatedLines(count => count + result.truncatedCount);
      }
      return result.lines;
    });
    // Auto-scroll to bottom when new output arrives
    setScrollOffset(0);
  }, []);

  const activate = useCallback(() => {
    setMode('input');
    setCmdState({ text: '', cursor: 0 });
    setOutput([]);
    setExitCode(null);
    setTruncatedLines(0);
    setScrollOffset(0);
  }, []);

  const deactivate = useCallback(() => {
    if (executorRef.current) {
      executorRef.current.kill();
      executorRef.current = null;
    }
    setMode('inactive');
    setCmdState({ text: '', cursor: 0 });
    setOutput([]);
    setExitCode(null);
    setTruncatedLines(0);
    setScrollOffset(0);
  }, []);

  const setCommand = useCallback((cmd: string) => {
    // Filter out carriage returns which can cause display issues in the TUI
    const filtered = cmd.replace(/\r/g, '');
    setCmdState({ text: filtered, cursor: filtered.length });
  }, []);

  const appendToCommand = useCallback((char: string) => {
    // Filter out carriage returns which can cause display issues in the TUI
    // Newlines are preserved for multi-line command execution
    if (char === '\r') return;
    setCmdState(prev => {
      const before = prev.text.slice(0, prev.cursor);
      const after = prev.text.slice(prev.cursor);
      return {
        text: before + char + after,
        cursor: prev.cursor + char.length,
      };
    });
  }, []);

  const backspaceCommand = useCallback(() => {
    setCmdState(prev => {
      if (prev.text.length === 0) return prev;
      if (prev.cursor === 0) return prev;
      // Delete character before cursor
      return {
        text: prev.text.slice(0, prev.cursor - 1) + prev.text.slice(prev.cursor),
        cursor: prev.cursor - 1,
      };
    });
  }, []);

  const deleteAtCursor = useCallback(() => {
    setCmdState(prev => {
      if (prev.cursor >= prev.text.length) return prev;
      const before = prev.text.slice(0, prev.cursor);
      const after = prev.text.slice(prev.cursor + 1);
      return {
        text: before + after,
        cursor: prev.cursor,
      };
    });
  }, []);

  const execute = useCallback(() => {
    if (!command.trim() || (mode !== 'input' && mode !== 'done')) return;

    // Save command to history (avoid duplicates of the most recent command)
    const trimmedCmd = command.trim();
    if (trimmedCmd && commandHistory[0] !== trimmedCmd) {
      commandHistory = [trimmedCmd, ...commandHistory].slice(0, MAX_HISTORY_SIZE);
    }

    // Reset history navigation
    setHistoryIndex(-1);
    savedInputRef.current = '';

    setMode('running');
    setOutput([]);
    setExitCode(null);
    setTruncatedLines(0);

    executorRef.current = spawnPersistentShellCommand(command, {
      onOutput: appendOutput,
      onComplete: code => {
        setExitCode(code);
        setMode('done');
        executorRef.current = null;
      },
      onError: error => {
        appendOutput([error]);
      },
    });
  }, [command, mode, appendOutput]);

  const interrupt = useCallback(() => {
    if (mode === 'running' && executorRef.current) {
      executorRef.current.kill('SIGINT');
    }
  }, [mode]);

  // Transition from done to input without clearing output
  // Output only clears when next command executes
  const continueInput = useCallback(() => {
    setMode('input');
  }, []);

  const acknowledge = useCallback(() => {
    setMode('input');
    setCmdState({ text: '', cursor: 0 });
    setOutput([]);
    setExitCode(null);
    setTruncatedLines(0);
  }, []);

  const historyUp = useCallback(() => {
    if (commandHistory.length === 0) return;

    // Save current input when starting to navigate
    if (historyIndex === -1) {
      savedInputRef.current = command;
    }

    const newIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
    // eslint-disable-next-line security/detect-object-injection
    const newCommand = commandHistory[newIndex] ?? '';
    setHistoryIndex(newIndex);
    setCmdState({ text: newCommand, cursor: newCommand.length });
  }, [historyIndex, command]);

  const historyDown = useCallback(() => {
    if (historyIndex < 0) return;

    const newIndex = historyIndex - 1;
    setHistoryIndex(newIndex);

    if (newIndex < 0) {
      // Restore saved input
      const saved = savedInputRef.current;
      setCmdState({ text: saved, cursor: saved.length });
    } else {
      // eslint-disable-next-line security/detect-object-injection
      const newCommand = commandHistory[newIndex] ?? '';
      setCmdState({ text: newCommand, cursor: newCommand.length });
    }
  }, [historyIndex]);

  const cursorLeft = useCallback(() => {
    setCmdState(prev => ({
      ...prev,
      cursor: Math.max(0, prev.cursor - 1),
    }));
  }, []);

  const cursorRight = useCallback(() => {
    setCmdState(prev => ({
      ...prev,
      cursor: Math.min(prev.text.length, prev.cursor + 1),
    }));
  }, []);

  const cursorToStart = useCallback(() => {
    setCmdState(prev => ({ ...prev, cursor: 0 }));
  }, []);

  const cursorToEnd = useCallback(() => {
    setCmdState(prev => ({ ...prev, cursor: prev.text.length }));
  }, []);

  const scrollUp = useCallback(() => {
    setScrollOffset(prev => prev + 1);
  }, []);

  const scrollDown = useCallback(() => {
    setScrollOffset(prev => Math.max(0, prev - 1));
  }, []);

  const scrollToTop = useCallback(() => {
    setScrollOffset(output.length);
  }, [output.length]);

  const scrollToBottom = useCallback(() => {
    setScrollOffset(0);
  }, []);

  useEffect(() => {
    return () => {
      if (executorRef.current) {
        executorRef.current.kill();
      }
    };
  }, []);

  return {
    mode,
    command,
    output,
    exitCode,
    historyIndex,
    truncatedLines,
    cursorPosition,
    scrollOffset,
    activate,
    deactivate,
    setCommand,
    appendToCommand,
    backspaceCommand,
    deleteAtCursor,
    execute,
    interrupt,
    continueInput,
    acknowledge,
    historyUp,
    historyDown,
    cursorLeft,
    cursorRight,
    cursorToStart,
    cursorToEnd,
    scrollUp,
    scrollDown,
    scrollToTop,
    scrollToBottom,
  };
}
