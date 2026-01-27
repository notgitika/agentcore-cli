import type { ShellMode } from '../../shell';
import { createContext, useContext } from 'react';

export interface ShellContextValue {
  mode: ShellMode;
  command: string;
  output: string[];
  exitCode: number | null;
  isActive: boolean;
  /** Number of output lines that were truncated from memory */
  truncatedLines: number;
  /** Cursor position within the command */
  cursorPosition: number;
  /** Scroll offset for output (0 = bottom) */
  scrollOffset: number;
}

const defaultValue: ShellContextValue = {
  mode: 'inactive',
  command: '',
  output: [],
  exitCode: null,
  isActive: false,
  truncatedLines: 0,
  cursorPosition: 0,
  scrollOffset: 0,
};

export const ShellContext = createContext<ShellContextValue>(defaultValue);

export function useShellContext(): ShellContextValue {
  return useContext(ShellContext);
}
