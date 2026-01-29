import { App } from '../src/cli/tui/App';
import { TerminalContext } from './ink-browser-shim';
import React, { Component, ErrorInfo, ReactNode, useState } from 'react';
import ReactDOM from 'react-dom/client';

// Error boundary to catch and display render errors
class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('React Error Boundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ color: 'red', padding: '10px', fontFamily: 'monospace', fontSize: '12px' }}>
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>Render Error:</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{this.state.error?.message}</div>
          <div style={{ marginTop: '8px', color: '#888', fontSize: '10px' }}>{this.state.error?.stack}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface VirtualTerminalProps {
  columns: number;
  rows: number;
  label: string;
  children: React.ReactNode;
  isActive?: boolean;
  onFocus?: () => void;
}

const VirtualTerminal = ({ columns, rows, label, children, isActive, onFocus }: VirtualTerminalProps) => (
  <div
    onClick={onFocus}
    style={{
      margin: '20px',
      display: 'inline-block',
      verticalAlign: 'top',
      cursor: 'pointer',
    }}
  >
    <div
      style={{
        marginBottom: '5px',
        color: isActive ? '#4fc3f7' : '#888',
        fontSize: '12px',
        fontFamily: 'sans-serif',
      }}
    >
      {label} ({columns}x{rows}) {isActive && '← active'}
    </div>
    <div
      style={{
        width: `${columns}ch`,
        height: `${rows * 1.4}em`,
        backgroundColor: '#0d0d0d',
        color: '#e0e0e0',
        fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
        fontSize: '14px',
        lineHeight: '1.4',
        overflow: 'hidden',
        border: isActive ? '2px solid #4fc3f7' : '2px solid #333',
        borderRadius: '8px',
        padding: '8px',
        boxSizing: 'border-box',
      }}
    >
      <TerminalContext.Provider value={{ columns, rows }}>{children}</TerminalContext.Provider>
    </div>
  </div>
);

function TestHarness() {
  const [activeTerminal, setActiveTerminal] = useState<string>('standard');

  return (
    <div
      style={{
        padding: '20px',
        background: '#1a1a1a',
        minHeight: '100vh',
        fontFamily: 'sans-serif',
      }}
    >
      <h1 style={{ color: '#fff', marginBottom: '10px' }}>AgentCore CLI - Browser Test Harness</h1>
      <p style={{ color: '#888', marginBottom: '20px' }}>
        Click a terminal to focus keyboard input. Test responsive layouts at different sizes.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        <VirtualTerminal
          columns={80}
          rows={24}
          label="Standard"
          isActive={activeTerminal === 'standard'}
          onFocus={() => setActiveTerminal('standard')}
        >
          {activeTerminal === 'standard' && (
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          )}
        </VirtualTerminal>

        <VirtualTerminal
          columns={50}
          rows={20}
          label="Narrow / Split"
          isActive={activeTerminal === 'narrow'}
          onFocus={() => setActiveTerminal('narrow')}
        >
          {activeTerminal === 'narrow' && (
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          )}
        </VirtualTerminal>

        <VirtualTerminal
          columns={120}
          rows={40}
          label="Large HD"
          isActive={activeTerminal === 'large'}
          onFocus={() => setActiveTerminal('large')}
        >
          {activeTerminal === 'large' && (
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          )}
        </VirtualTerminal>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TestHarness />
  </React.StrictMode>
);
