import { useAddConfigBundleWizard } from '../useAddConfigBundleWizard';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { describe, expect, it } from 'vitest';

type WizardReturn = ReturnType<typeof useAddConfigBundleWizard>;

interface HarnessHandle {
  wizard: WizardReturn;
}

const Harness = React.forwardRef<HarnessHandle>((_props, ref) => {
  const wizard = useAddConfigBundleWizard();
  useImperativeHandle(ref, () => ({ wizard }));
  return <Text>step:{wizard.step}</Text>;
});
Harness.displayName = 'Harness';

function setup() {
  const ref = React.createRef<HarnessHandle>();
  const result = render(<Harness ref={ref} />);
  return { ref, ...result };
}

/** Drive the wizard forward to the addAnother step with one component configured. */
function advanceToAddAnother(ref: React.RefObject<HarnessHandle | null>) {
  act(() => ref.current!.wizard.setName('myBundle'));
  act(() => ref.current!.wizard.setDescription('desc'));
  act(() => ref.current!.wizard.setComponentType('runtime'));
  act(() => ref.current!.wizard.setSelectedComponent('arn:aws:runtime/r1'));
  act(() => ref.current!.wizard.setConfiguration({ systemPrompt: 'hi' }));
}

describe('useAddConfigBundleWizard — add-another back-navigation (BUG TUI-B)', () => {
  it('reaches addAnother after configuring one component', () => {
    const { ref } = setup();
    advanceToAddAnother(ref);
    expect(ref.current!.wizard.step).toBe('addAnother');
  });

  it('back from a re-entered componentType returns to addAnother, not description', () => {
    const { ref } = setup();
    advanceToAddAnother(ref);

    // User chooses "add another component" → re-enters componentType.
    act(() => ref.current!.wizard.addAnotherComponent());
    expect(ref.current!.wizard.step).toBe('componentType');

    // Backing out must return to the addAnother decision point (where "Continue" lives),
    // NOT fall through the linear order to `description` (which would strip the Continue path).
    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('addAnother');

    // And the already-configured component is preserved.
    expect(Object.keys(ref.current!.wizard.config.components)).toHaveLength(1);
  });

  it('back from re-entered componentSelect returns to componentType, then to addAnother', () => {
    const { ref } = setup();
    advanceToAddAnother(ref);
    act(() => ref.current!.wizard.addAnotherComponent());
    act(() => ref.current!.wizard.setComponentType('runtime'));
    expect(ref.current!.wizard.step).toBe('componentSelect');

    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('componentType');
    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('addAnother');
  });

  it('doneAddingComponents advances to branchName and clears the loop flag', () => {
    const { ref } = setup();
    advanceToAddAnother(ref);
    act(() => ref.current!.wizard.doneAddingComponents());
    expect(ref.current!.wizard.step).toBe('branchName');

    // Back from branchName follows the normal linear order (to addAnother), not the loop guard.
    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('addAnother');
  });

  it('first-pass back-navigation is unaffected (componentType → description)', () => {
    const { ref } = setup();
    act(() => ref.current!.wizard.setName('myBundle'));
    act(() => ref.current!.wizard.setDescription('desc'));
    expect(ref.current!.wizard.step).toBe('componentType');
    act(() => ref.current!.wizard.goBack());
    expect(ref.current!.wizard.step).toBe('description');
  });
});
