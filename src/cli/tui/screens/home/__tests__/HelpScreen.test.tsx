import type { CommandMeta } from '../../../utils/commands';
import { HelpScreen } from '../HelpScreen';
import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

function delay(ms = 50) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const interactiveCommands: CommandMeta[] = [
  { id: 'add', title: 'add', description: 'Add resources', subcommands: ['agent'], disabled: false, cliOnly: false },
  { id: 'deploy', title: 'deploy', description: 'Deploy to AWS', subcommands: [], disabled: false, cliOnly: false },
];

const cliOnlyCommands: CommandMeta[] = [
  { id: 'logs', title: 'logs', description: 'Stream logs', subcommands: [], disabled: false, cliOnly: true },
  { id: 'traces', title: 'traces', description: 'View traces', subcommands: [], disabled: false, cliOnly: true },
];

const allCommands = [...interactiveCommands, ...cliOnlyCommands];

describe('HelpScreen', () => {
  it('shows interactive commands by default', () => {
    const { lastFrame } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    const frame = lastFrame()!;
    expect(frame).toContain('add');
    expect(frame).toContain('deploy');
  });

  it('hides CLI-only commands by default', () => {
    const { lastFrame } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    const frame = lastFrame()!;
    expect(frame).not.toContain('Stream logs');
    expect(frame).not.toContain('View traces');
    expect(frame).not.toContain('CLI only');
  });

  it('shows Ctrl+L show all hint by default', () => {
    const { lastFrame } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    expect(lastFrame()!).toContain('Ctrl+L show all');
  });

  it('shows CLI-only commands after Ctrl+L toggle', async () => {
    const { lastFrame, stdin } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    await delay();
    stdin.write('\x0C'); // Ctrl+L
    await delay();
    const frame = lastFrame()!;
    expect(frame).toContain('logs');
    expect(frame).toContain('traces');
    expect(frame).toContain('CLI only');
  });

  it('shows Ctrl+L hide cli hint when toggled on', async () => {
    const { lastFrame, stdin } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    await delay();
    stdin.write('\x0C'); // Ctrl+L
    await delay();
    expect(lastFrame()!).toContain('Ctrl+L hide cli');
  });

  it('hides CLI-only commands after double Ctrl+L toggle', async () => {
    const { lastFrame, stdin } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    await delay();
    stdin.write('\x0C'); // Ctrl+L — show
    await delay();
    stdin.write('\x0C'); // Ctrl+L — hide
    await delay();
    const frame = lastFrame()!;
    expect(frame).not.toContain('Stream logs');
    expect(frame).not.toContain('CLI only');
  });

  it('shows CLI-only commands in search results regardless of toggle', async () => {
    const { lastFrame, stdin } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    await delay();
    stdin.write('logs');
    await delay();
    expect(lastFrame()!).toContain('logs');
  });

  it('shows CLI-only section when search matches only CLI-only commands', async () => {
    const { lastFrame, stdin } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    await delay();
    stdin.write('trace');
    await delay();
    const frame = lastFrame()!;
    expect(frame).toContain('traces');
    expect(frame).not.toContain('Add resources');
    expect(frame).not.toContain('Deploy to AWS');
  });

  it('calls onSelect with CLI-only command id when selected via search', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<HelpScreen commands={allCommands} onSelect={onSelect} onBack={vi.fn()} />);
    await delay();
    stdin.write('logs');
    await delay();
    stdin.write('\r'); // enter
    await delay();
    expect(onSelect).toHaveBeenCalledWith('logs');
  });
});
