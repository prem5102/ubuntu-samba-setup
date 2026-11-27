import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export type ErrorAction = 'retry' | 'back' | 'exit';

export interface ErrorScreenProps {
  title: string;
  message: string;
  details?: string[];
  recoveryInstructions?: string[];
  allowRetry?: boolean;
  onAction: (action: ErrorAction) => void;
}

export const ErrorScreen: React.FC<ErrorScreenProps> = ({
  title,
  message,
  details = [],
  recoveryInstructions = [],
  allowRetry = true,
  onAction,
}) => {
  const options: Array<{ id: ErrorAction; label: string }> = [
    ...(allowRetry ? [{ id: 'retry' as const, label: 'Retry' }] : []),
    { id: 'back', label: 'Back (Preserve State)' },
    { id: 'exit', label: 'Exit Application' },
  ];

  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow || key.leftArrow || input === 'k') {
      setSelectedIndex((prev) => (prev - 1 + options.length) % options.length);
      return;
    }
    if (key.downArrow || key.rightArrow || key.tab || input === 'j') {
      setSelectedIndex((prev) => (prev + 1) % options.length);
      return;
    }
    if (key.return) {
      const chosen = options[selectedIndex];
      if (chosen) onAction(chosen.id);
      return;
    }
    if (input.toLowerCase() === 'r' && allowRetry) {
      onAction('retry');
      return;
    }
    if (input.toLowerCase() === 'b' || key.escape) {
      onAction('back');
      return;
    }
    if (input.toLowerCase() === 'q') {
      onAction('exit');
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={2} paddingY={0} marginY={1}>
      <Text bold color="red">
        ✖ {title}
      </Text>
      <Box marginTop={1}>
        <Text color="white">{message}</Text>
      </Box>

      {details.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="yellow">
            Diagnostics:
          </Text>
          {details.slice(0, 6).map((line, i) => (
            <Text key={i} dimColor>
              • {line}
            </Text>
          ))}
        </Box>
      )}

      {recoveryInstructions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="cyan">
            Recovery Instructions:
          </Text>
          {recoveryInstructions.map((step, i) => (
            <Text key={i}>
              {i + 1}. {step}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1} gap={2}>
        {options.map((opt, idx) => {
          const isSelected = idx === selectedIndex;
          return (
            <Text
              key={opt.id}
              bold={isSelected}
              color={isSelected ? 'black' : 'gray'}
              backgroundColor={isSelected ? (opt.id === 'exit' ? 'red' : 'cyan') : undefined}
            >
              {' '}
              {opt.label}{' '}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>[←/→/Tab] Select  [Enter] Run  [R] Retry  [B/Esc] Back  [Q] Exit</Text>
      </Box>
    </Box>
  );
};
