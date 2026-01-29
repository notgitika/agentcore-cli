import React, { createContext, useContext, useEffect } from 'react';

// Terminal dimensions context
export const TerminalContext = createContext({ columns: 80, rows: 24 });

// Box component - flexbox container
// Ink uses character units: 1 padding = 1 character width
export const Box = ({
  children,
  flexDirection = 'row',
  borderStyle,
  borderColor,
  padding,
  paddingX,
  paddingY,
  paddingLeft,
  paddingRight,
  paddingTop,
  paddingBottom,
  margin,
  marginTop,
  marginBottom,
  marginLeft,
  marginRight,
  marginX,
  marginY,
  width,
  height,
  minWidth,
  minHeight,
  flexGrow,
  flexShrink,
  flexBasis,
  justifyContent,
  alignItems,
  alignSelf,
  gap,
  overflowX,
  overflowY,
  ...rest
}: any) => {
  // Calculate padding - specific overrides general
  const pl = paddingLeft ?? paddingX ?? padding ?? 0;
  const pr = paddingRight ?? paddingX ?? padding ?? 0;
  const pt = paddingTop ?? paddingY ?? padding ?? 0;
  const pb = paddingBottom ?? paddingY ?? padding ?? 0;

  // Calculate margin - specific overrides general
  const ml = marginLeft ?? marginX ?? margin ?? 0;
  const mr = marginRight ?? marginX ?? margin ?? 0;
  const mt = marginTop ?? marginY ?? margin ?? 0;
  const mb = marginBottom ?? marginY ?? margin ?? 0;

  const style: React.CSSProperties = {
    display: 'flex',
    flexDirection,
    justifyContent,
    alignItems,
    alignSelf,
    gap: gap ? `${gap}ch` : undefined,
    paddingLeft: pl ? `${pl}ch` : undefined,
    paddingRight: pr ? `${pr}ch` : undefined,
    paddingTop: pt ? `${pt * 1.2}em` : undefined,
    paddingBottom: pb ? `${pb * 1.2}em` : undefined,
    marginLeft: ml ? `${ml}ch` : undefined,
    marginRight: mr ? `${mr}ch` : undefined,
    marginTop: mt ? `${mt * 1.2}em` : undefined,
    marginBottom: mb ? `${mb * 1.2}em` : undefined,
    width: width === '100%' ? '100%' : typeof width === 'number' ? `${width}ch` : width,
    height: typeof height === 'number' ? `${height * 1.2}em` : height,
    minWidth: typeof minWidth === 'number' ? `${minWidth}ch` : minWidth,
    minHeight: typeof minHeight === 'number' ? `${minHeight * 1.2}em` : minHeight,
    flexGrow,
    flexShrink,
    flexBasis,
    border: borderStyle ? `1px solid ${borderColor || '#666'}` : undefined,
    borderRadius: borderStyle === 'round' ? '4px' : undefined,
    boxSizing: 'border-box',
    overflowX,
    overflowY,
  };
  return <div style={style}>{children}</div>;
};

// Text component
export const Text = ({ children, color, bold, dimColor, underline, wrap, ...rest }: any) => {
  const style: React.CSSProperties = {
    color: color || 'inherit',
    fontWeight: bold ? 'bold' : 'normal',
    opacity: dimColor ? 0.5 : 1,
    textDecoration: underline ? 'underline' : undefined,
    fontFamily: 'monospace',
    whiteSpace: wrap === 'truncate' ? 'nowrap' : 'pre-wrap',
    overflow: wrap === 'truncate' ? 'hidden' : undefined,
    textOverflow: wrap === 'truncate' ? 'ellipsis' : undefined,
  };
  return <span style={style}>{children}</span>;
};

export const Newline = () => <br />;

// Transform component - transforms children text
export const Transform = ({
  children,
  transform,
}: {
  children?: React.ReactNode;
  transform?: (text: string) => string;
}) => {
  if (typeof children === 'string' && transform) {
    return <>{transform(children)}</>;
  }
  return <>{children}</>;
};

// useInput hook - keyboard handling
export const useInput = (handler: (input: string, key: any) => void, options?: { isActive?: boolean }) => {
  const isActive = options?.isActive ?? true;

  useEffect(() => {
    if (!isActive) return;

    const listener = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', ' '].includes(e.key)) {
        e.preventDefault();
      }

      const key = {
        return: e.key === 'Enter',
        escape: e.key === 'Escape',
        upArrow: e.key === 'ArrowUp',
        downArrow: e.key === 'ArrowDown',
        leftArrow: e.key === 'ArrowLeft',
        rightArrow: e.key === 'ArrowRight',
        backspace: e.key === 'Backspace',
        delete: e.key === 'Delete',
        tab: e.key === 'Tab',
        ctrl: e.ctrlKey,
        meta: e.metaKey,
      };

      const input = e.key.length === 1 ? e.key : '';
      handler(input, key);
    };

    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [handler, isActive]);
};

// useApp hook
export const useApp = () => ({
  exit: () => console.log('[Browser] App exit called'),
});

// useStdout hook - reads from TerminalContext
export const useStdout = () => {
  const { columns, rows } = useContext(TerminalContext);
  return {
    stdout: {
      columns,
      rows,
      on: () => {}, // Resize event listener (no-op in browser)
      off: () => {},
    },
    write: (str: string) => console.log('[stdout]', str),
  };
};

// render function (no-op, we use ReactDOM)
export const render = () => ({
  clear: () => {},
  unmount: () => {},
  waitUntilExit: () => Promise.resolve(),
});
