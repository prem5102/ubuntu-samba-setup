import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
  /** Keep total rendered lines strictly below stdout.rows so Ink never falls back to full-terminal clear/flicker. */
  pageHeight: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<{ columns: number; rows: number }>(() => ({
    columns: Math.max(78, stdout.columns || 80),
    rows: Math.max(20, stdout.rows || 24),
  }));

  useEffect(() => {
    const onResize = (): void => {
      setSize({
        columns: Math.max(78, stdout.columns || 80),
        rows: Math.max(20, stdout.rows || 24),
      });
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return {
    columns: size.columns,
    rows: size.rows,
    pageHeight: Math.max(18, size.rows - 1),
  };
}
