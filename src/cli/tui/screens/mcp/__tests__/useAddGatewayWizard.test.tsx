import type { GatewayExceptionLevel } from '../../../../../schema';
import { useAddGatewayWizard } from '../useAddGatewayWizard';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Simple harness -- renders hook state as text for snapshot assertions
// ---------------------------------------------------------------------------

function Harness() {
  const wizard = useAddGatewayWizard();
  return (
    <Text>
      exceptionLevel:{wizard.config.exceptionLevel}
      enableSemanticSearch:{String(wizard.config.enableSemanticSearch)}
      step:{wizard.step}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Imperative harness -- exposes wizard methods via ref for act()-based tests
// ---------------------------------------------------------------------------

interface HarnessHandle {
  setAdvancedConfig: (opts: { enableSemanticSearch: boolean; exceptionLevel: GatewayExceptionLevel }) => void;
  setName: (name: string) => void;
  setAuthorizerType: (type: 'NONE' | 'AWS_IAM' | 'CUSTOM_JWT') => void;
}

const ImperativeHarness = React.forwardRef<HarnessHandle>((_, ref) => {
  const wizard = useAddGatewayWizard();
  useImperativeHandle(ref, () => ({
    setAdvancedConfig: wizard.setAdvancedConfig,
    setName: wizard.setName,
    setAuthorizerType: wizard.setAuthorizerType,
  }));
  return (
    <Text>
      exceptionLevel:{wizard.config.exceptionLevel}
      enableSemanticSearch:{String(wizard.config.enableSemanticSearch)}
      step:{wizard.step}
    </Text>
  );
});
ImperativeHarness.displayName = 'ImperativeHarness';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAddGatewayWizard', () => {
  describe('defaults', () => {
    it('default config has exceptionLevel NONE', () => {
      const { lastFrame } = render(<Harness />);
      expect(lastFrame()).toContain('exceptionLevel:NONE');
    });

    it('default config has semantic search enabled', () => {
      const { lastFrame } = render(<Harness />);
      expect(lastFrame()).toContain('enableSemanticSearch:true');
    });

    it('default step is name', () => {
      const { lastFrame } = render(<Harness />);
      expect(lastFrame()).toContain('step:name');
    });
  });

  describe('setAdvancedConfig', () => {
    it('setAdvancedConfig sets exception level to DEBUG', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAdvancedConfig({
          enableSemanticSearch: true,
          exceptionLevel: 'DEBUG',
        });
      });

      expect(lastFrame()).toContain('exceptionLevel:DEBUG');
    });

    it('setAdvancedConfig with all disabled', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => {
        ref.current!.setAdvancedConfig({
          enableSemanticSearch: false,
          exceptionLevel: 'NONE',
        });
      });

      expect(lastFrame()).toContain('enableSemanticSearch:false');
      expect(lastFrame()).toContain('exceptionLevel:NONE');
    });

    it('setAdvancedConfig advances to confirm step', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      // Initially on the name step
      expect(lastFrame()).toContain('step:name');

      act(() => {
        ref.current!.setAdvancedConfig({
          enableSemanticSearch: true,
          exceptionLevel: 'NONE',
        });
      });

      expect(lastFrame()).toContain('step:confirm');
    });
  });
});
