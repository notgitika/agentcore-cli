import { ExecLogger } from '../exec-logger.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('ExecLogger.logDiff', () => {
  let tempDir: string;
  let logger: ExecLogger;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'exec-logger-test-'));
    // Create the agentcore/.cli/logs/deploy directory structure
    const agentcoreDir = path.join(tempDir, 'agentcore');
    logger = new ExecLogger({ command: 'deploy', baseDir: agentcoreDir });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function getLogContent(): string {
    return readFileSync(logger.logFilePath, 'utf-8');
  }

  it('writes I4002 messages as a section with dividers', () => {
    logger.logDiff('CDK_TOOLKIT_I4002', 'Stack MyStack\nResources\n[+] AWS::S3::Bucket MyBucket');

    const content = getLogContent();
    expect(content).toContain('─'.repeat(80));
    expect(content).toContain('Stack MyStack');
    expect(content).toContain('Resources');
    expect(content).toContain('[+] AWS::S3::Bucket MyBucket');
  });

  it('strips ANSI escape codes from logged output', () => {
    const ansiMessage = 'Stack \x1b[1mMyStack\x1b[22m\n\x1b[32m[+]\x1b[39m Resource';

    logger.logDiff('CDK_TOOLKIT_I4002', ansiMessage);

    const content = getLogContent();
    expect(content).toContain('Stack MyStack');
    expect(content).toContain('[+] Resource');
    expect(content).not.toContain('\x1b[');
  });

  it('strips underline and other ANSI sequences (not just color)', () => {
    const ansiMessage = '\x1b[4m\x1b[1mResources\x1b[22m\x1b[24m';

    logger.logDiff('CDK_TOOLKIT_I4002', ansiMessage);

    const content = getLogContent();
    expect(content).toContain('Resources');
    expect(content).not.toContain('\x1b[');
  });

  it('writes I4001 messages as a plain summary line', () => {
    logger.logDiff('CDK_TOOLKIT_I4001', '✨ Number of stacks with differences: 2');

    const content = getLogContent();
    expect(content).toContain('✨ Number of stacks with differences: 2');
    // Should NOT have section dividers
    expect(content.split('─'.repeat(80))).toHaveLength(1);
  });

  it('logs other multi-line messages line by line with timestamps', () => {
    logger.logDiff('UNKNOWN', 'Line one\nLine two\nLine three');

    const content = getLogContent();
    // Each non-empty line should have a timestamp
    const lines = content.split('\n');
    const loggedLines = lines.filter(l => l.includes('Line'));
    expect(loggedLines).toHaveLength(3);
    for (const line of loggedLines) {
      expect(line).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
    }
  });

  it('logs single-line messages with a timestamp', () => {
    logger.logDiff('CDK_SDK_I0100', 'STS.AssumeRole -> OK');

    const content = getLogContent();
    expect(content).toContain('STS.AssumeRole -> OK');
    const line = content.split('\n').find(l => l.includes('STS.AssumeRole'));
    expect(line).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });

  it('skips empty messages', () => {
    const before = getLogContent();
    logger.logDiff('UNKNOWN', '');
    const after = getLogContent();

    expect(after).toBe(before);
  });

  it('skips blank lines in multi-line other messages', () => {
    logger.logDiff('UNKNOWN', 'Line one\n\n\nLine two');

    const content = getLogContent();
    const loggedLines = content.split('\n').filter(l => l.includes('Line'));
    expect(loggedLines).toHaveLength(2);
  });
});
