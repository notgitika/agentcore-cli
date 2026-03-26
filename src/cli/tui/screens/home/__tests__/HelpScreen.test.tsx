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

  it('shows / show all hint by default', () => {
    const { lastFrame } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    expect(lastFrame()!).toContain('/ show all');
  });

  it('shows CLI-only commands after / toggle', async () => {
    const { lastFrame, stdin } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    await delay();
    stdin.write('/');
    await delay();
    const frame = lastFrame()!;
    expect(frame).toContain('logs');
    expect(frame).toContain('traces');
    expect(frame).toContain('CLI only');
  });

  it('shows / hide cli hint when toggled on', async () => {
    const { lastFrame, stdin } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    await delay();
    stdin.write('/');
    await delay();
    expect(lastFrame()!).toContain('/ hide cli');
  });

  it('hides CLI-only commands after double / toggle', async () => {
    const { lastFrame, stdin } = render(<HelpScreen commands={allCommands} onSelect={vi.fn()} onBack={vi.fn()} />);
    await delay();
    stdin.write('/'); // show
    await delay();
    stdin.write('/'); // hide
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
