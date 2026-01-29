import React, { useEffect, useState } from 'react';

const DOTS = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export default function Spinner({ type = 'dots' }: { type?: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % DOTS.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return <span style={{ color: '#00bcd4' }}>{DOTS[frame]}</span>;
}
