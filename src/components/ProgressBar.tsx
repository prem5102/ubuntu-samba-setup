import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

export interface ProgressBarProps {
  percent: number;
  label?: string;
  width?: number;
  spinning?: boolean;
  color?: 'cyan' | 'green' | 'yellow' | 'red';
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const ProgressBar: React.FC<ProgressBarProps> = ({
  percent,
  label,
  width = 36,
  spinning = true,
  color = 'cyan',
}) => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!spinning) return;
    // 300ms cadence keeps terminal updates smooth without high-frequency redraw flicker
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 300);
    return () => clearInterval(timer);
  }, [spinning]);

  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filledCount = Math.round((clamped / 100) * width);
  const emptyCount = Math.max(0, width - filledCount);
  const bar = `${'█'.repeat(filledCount)}${'░'.repeat(emptyCount)}`;

  return (
    <Box flexDirection="column" height={2}>
      <Box>
        {spinning && (
          <Text color={color} bold>
            {SPINNER_FRAMES[frame]}{' '}
          </Text>
        )}
        <Text color={color}>[{bar}]</Text>
        <Text bold> {String(clamped).padStart(3, ' ')}%</Text>
      </Box>
      <Text dimColor>{label ?? ' '}</Text>
    </Box>
  );
};
