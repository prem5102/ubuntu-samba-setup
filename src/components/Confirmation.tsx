import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { InputField } from './InputField.js';

export interface ConfirmationProps {
  title: string;
  message: string[];
  danger?: boolean;
  requiredKeyword?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const Confirmation: React.FC<ConfirmationProps> = ({
  title,
  message,
  danger = false,
  requiredKeyword,
  confirmLabel = 'Confirm',
  cancelLabel = 'Back / Cancel',
  onConfirm,
  onCancel,
}) => {
  const [selected, setSelected] = useState<'confirm' | 'cancel'>(danger ? 'cancel' : 'confirm');
  const [keywordInput, setKeywordInput] = useState('');
  const [keywordError, setKeywordError] = useState<string | undefined>();

  useInput(
    (input, key) => {
      if (requiredKeyword) {
        if (key.escape) {
          onCancel();
        }
        return;
      }

      if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow || key.tab) {
        setSelected((prev) => (prev === 'confirm' ? 'cancel' : 'confirm'));
        return;
      }
      if (input.toLowerCase() === 'y') {
        onConfirm();
        return;
      }
      if (input.toLowerCase() === 'n' || key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        if (selected === 'confirm') onConfirm();
        else onCancel();
      }
    },
    { isActive: true },
  );

  const handleKeywordSubmit = (val: string): void => {
    if (!requiredKeyword) return;
    if (val.trim() === requiredKeyword) {
      setKeywordError(undefined);
      onConfirm();
    } else {
      setKeywordError(`Input rejected: type exact keyword "${requiredKeyword}" to proceed, or press Esc to go back.`);
    }
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={danger ? 'red' : 'yellow'}
      paddingX={2}
      paddingY={0}
      marginY={1}
    >
      <Text bold color={danger ? 'red' : 'yellow'}>
        {danger ? '⚠ DESTRUCTIVE OPERATION CONFIRMATION: ' : '? CONFIRMATION: '}
        {title}
      </Text>
      <Box flexDirection="column" marginY={1}>
        {message.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>

      {requiredKeyword ? (
        <Box flexDirection="column">
          <InputField
            label={`Type "${requiredKeyword}"`}
            value={keywordInput}
            onChange={(v) => {
              setKeywordInput(v);
              setKeywordError(undefined);
            }}
            onSubmit={handleKeywordSubmit}
            error={keywordError}
            compact
            hint="Press Enter to execute, or Esc to cancel and go back."
          />
        </Box>
      ) : (
        <Box gap={3} marginBottom={1}>
          <Text
            bold
            color={selected === 'confirm' ? 'black' : 'gray'}
            backgroundColor={selected === 'confirm' ? (danger ? 'red' : 'green') : undefined}
          >
            {' '}
            ✓ {confirmLabel} (Y){' '}
          </Text>
          <Text
            bold
            color={selected === 'cancel' ? 'black' : 'gray'}
            backgroundColor={selected === 'cancel' ? 'cyan' : undefined}
          >
            {' '}
            ← {cancelLabel} (N/Esc){' '}
          </Text>
        </Box>
      )}
    </Box>
  );
};
