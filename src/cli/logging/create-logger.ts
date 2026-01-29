import { CLI_LOGS_DIR, CLI_SYSTEM_DIR, CONFIG_DIR } from '../../lib';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface CreateLoggerOptions {
  /** Project root directory (the new project being created) */
  projectRoot: string;
}

interface StepInfo {
  name: string;
  startTime: number;
}

/**
 * Structured logger for the create command.
 * Creates log files in <projectRoot>/agentcore/.cli/logs/ with timestamped filenames.
 * Tracks execution steps with timing and status information.
 */
export class CreateLogger {
  readonly logFilePath: string;
  private readonly startTime: Date;
  private currentStep: StepInfo | null = null;
  private initialized = false;
  private pendingLines: string[] = [];

  constructor(options: CreateLoggerOptions) {
    this.startTime = new Date();

    // Log file will be in <projectRoot>/agentcore/.cli/logs/create/create-TIMESTAMP.log
    const logsDir = path.join(options.projectRoot, CONFIG_DIR, CLI_SYSTEM_DIR, CLI_LOGS_DIR, 'create');
    const timestamp = this.formatTimestampForFilename(this.startTime);
    this.logFilePath = path.join(logsDir, `create-${timestamp}.log`);
  }

  /**
   * Initialize the log file. Call this after the config directory is created.
   */
  initialize(): void {
    if (this.initialized) return;

    const logsDir = path.dirname(this.logFilePath);

    // Ensure logs directory exists
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    // Write header
    this.writeHeader();
    this.initialized = true;

    // Flush any pending lines
    for (const line of this.pendingLines) {
      appendFileSync(this.logFilePath, line + '\n', 'utf-8');
    }
    this.pendingLines = [];
  }

  /**
   * Format a date for use in filename: YYYYMMDD-HHMMSS
   */
  private formatTimestampForFilename(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}-${hours}${minutes}${seconds}`;
  }

  /**
   * Format a date for log entries: HH:MM:SS
   */
  private formatTime(date: Date = new Date()): string {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }

  /**
   * Format duration in human-readable form
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    const seconds = ms / 1000;
    if (seconds < 60) {
      return `${seconds.toFixed(1)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes}m ${remainingSeconds}s`;
  }

  /**
   * Write the log file header
   */
  private writeHeader(): void {
    const separator = '='.repeat(80);
    const header = `${separator}
AGENTCORE CREATE LOG
Started: ${this.startTime.toISOString()}
${separator}

`;
    writeFileSync(this.logFilePath, header, 'utf-8');
  }

  /**
   * Append a line to the log file (or queue it if not yet initialized)
   */
  appendLine(line: string): void {
    if (!this.initialized) {
      this.pendingLines.push(line);
      return;
    }
    appendFileSync(this.logFilePath, line + '\n', 'utf-8');
  }

  /**
   * Mark the start of a step
   */
  startStep(name: string): void {
    // End previous step if any
    if (this.currentStep) {
      this.endStep('success');
    }

    this.currentStep = {
      name,
      startTime: Date.now(),
    };

    this.appendLine('');
    this.appendLine(`[${this.formatTime()}] STEP: ${name}`);
  }

  /**
   * Mark the end of the current step
   */
  endStep(status: 'success' | 'error' | 'warn', error?: string): void {
    if (!this.currentStep) {
      return;
    }

    const duration = Date.now() - this.currentStep.startTime;
    const statusText = status === 'success' ? 'SUCCESS' : status === 'warn' ? 'WARNING' : 'FAILED';

    if ((status === 'error' || status === 'warn') && error) {
      this.appendLine(`[${this.formatTime()}] ${status === 'error' ? 'Error' : 'Warning'}: ${error}`);
    }

    this.appendLine(`[${this.formatTime()}] Status: ${statusText}`);
    this.appendLine(`[${this.formatTime()}] Duration: ${this.formatDuration(duration)}`);

    this.currentStep = null;
  }

  /**
   * Log a message with optional level
   */
  log(message: string, level?: 'info' | 'warn' | 'error' | 'debug'): void {
    const levelPrefix = level && level !== 'info' ? `[${level.toUpperCase()}] ` : '';
    this.appendLine(`[${this.formatTime()}] ${levelPrefix}${message}`);
  }

  /**
   * Log a sub-operation within a step
   */
  logSubStep(message: string): void {
    this.appendLine(`[${this.formatTime()}]   - ${message}`);
  }

  /**
   * Log command execution
   */
  logCommand(command: string, args: string[]): void {
    this.appendLine(`[${this.formatTime()}]   Running: ${command} ${args.join(' ')}`);
  }

  /**
   * Log command output
   */
  logCommandOutput(output: string): void {
    if (!output.trim()) return;
    const lines = output.trim().split('\n');
    for (const line of lines) {
      this.appendLine(`[${this.formatTime()}]     > ${line}`);
    }
  }

  /**
   * Finalize the log file with a summary
   */
  finalize(success: boolean): void {
    // End any in-progress step
    if (this.currentStep) {
      this.endStep(success ? 'success' : 'error');
    }

    const totalDuration = Date.now() - this.startTime.getTime();
    const separator = '='.repeat(80);
    const statusText = success ? 'COMPLETED SUCCESSFULLY' : 'FAILED';

    this.appendLine('');
    this.appendLine(separator);
    this.appendLine(statusText);
    this.appendLine(`Total Duration: ${this.formatDuration(totalDuration)}`);
    this.appendLine(separator);
  }

  /**
   * Get the relative path to the log file (for cleaner display)
   */
  getRelativeLogPath(): string {
    return path.relative(process.cwd(), this.logFilePath);
  }

  /**
   * Get a clickable terminal hyperlink to the log file.
   */
  getClickableLogPath(): string {
    const url = `file://${this.logFilePath}`;
    const displayText = this.getRelativeLogPath();
    return `\x1b]8;;${url}\x1b\\${displayText}\x1b]8;;\x1b\\`;
  }
}
