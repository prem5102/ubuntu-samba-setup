import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface InputFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  mask?: string;
  placeholder?: string;
  error?: string;
  focused?: boolean;
  hint?: string;
  labelWidth?: number;
  compact?: boolean;
  suppressInlineError?: boolean;
}

export const InputField: React.FC<InputFieldProps> = ({
  label,
  value,
  onChange,
  onSubmit,
  mask,
  placeholder = '',
  error,
  focused = true,
  hint,
  labelWidth = 22,
  compact = false,
  suppressInlineError = false,
}) => {
  const [cursorIndex, setCursorIndex] = useState<number>(value.length);
  const prevValueRef = React.useRef<string>(value);

  useEffect(() => {
    if (prevValueRef.current === '' && value.length > 0 && cursorIndex === 0) {
      setCursorIndex(value.length);
    } else if (cursorIndex > value.length) {
      setCursorIndex(value.length);
    }
    prevValueRef.current = value;
  }, [value, cursorIndex]);

  useInput(
    (input, key) => {
      if (!focused) return;

      if (key.return) {
        onSubmit?.(value);
        return;
      }

      if (key.ctrl && input.toLowerCase() === 'u') {
        onChange('');
        setCursorIndex(0);
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'w') {
        if (cursorIndex > 0) {
          const left = value.slice(0, cursorIndex);
          const trimmedLeft = left.replace(/\S+\s*$/, '');
          const next = trimmedLeft + value.slice(cursorIndex);
          onChange(next);
          setCursorIndex(trimmedLeft.length);
        }
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'a') {
        setCursorIndex(0);
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'e') {
        setCursorIndex(value.length);
        return;
      }

      if (key.leftArrow) {
        setCursorIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.rightArrow) {
        setCursorIndex((prev) => Math.min(value.length, prev + 1));
        return;
      }

      if (key.backspace || key.delete || input === '\x7f' || input === '\b') {
        if (cursorIndex > 0) {
          const next = value.slice(0, cursorIndex - 1) + value.slice(cursorIndex);
          onChange(next);
          setCursorIndex(cursorIndex - 1);
        }
        return;
      }

      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow) {
        return;
      }

      if (input && input.length > 0) {
        const clean = input.replace(/[\x00-\x1f\x7f]/g, '');
        if (clean.length > 0) {
          const next = value.slice(0, cursorIndex) + clean + value.slice(cursorIndex);
          onChange(next);
          setCursorIndex(cursorIndex + clean.length);
        }
      }
    },
    { isActive: focused },
  );

  const displayText = mask ? mask.repeat(value.length) : value;
  const showPlaceholder = displayText.length === 0 && placeholder.length > 0;

  let renderedValue: React.ReactNode;
  if (showPlaceholder) {
    renderedValue = (
      <>
        {focused && <Text inverse> </Text>}
        <Text dimColor>{placeholder}</Text>
      </>
    );
  } else if (!focused) {
    renderedValue = <Text>{displayText || ' '}</Text>;
  } else {
    const before = displayText.slice(0, cursorIndex);
    const atCursor = displayText[cursorIndex] ?? ' ';
    const after = displayText.slice(cursorIndex + 1);
    renderedValue = (
      <>
        <Text>{before}</Text>
        <Text inverse>{atCursor}</Text>
        <Text>{after}</Text>
      </>
    );
  }

  const paddedLabel = `${label}:`.padEnd(labelWidth, ' ');

  return (
    <Box flexDirection="column" marginBottom={compact ? 0 : 1}>
      <Box alignItems="center">
        <Text bold color={error ? 'red' : focused ? 'cyan' : 'white'}>
          {focused ? '▸ ' : '  '}
          {paddedLabel}
        </Text>
        <Box
          borderStyle={compact ? 'single' : 'round'}
          borderColor={error ? 'red' : focused ? 'cyan' : 'gray'}
          paddingX={1}
          minWidth={36}
        >
          {renderedValue}
        </Box>
        {!error && value.length > 0 && (
          <Text color="green"> ✓</Text>
        )}
      </Box>
      {!suppressInlineError && hint && !error && (
        <Box marginLeft={2} height={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      )}
      {!suppressInlineError && error && (
        <Box marginLeft={2} height={1}>
          <Text color="red">✖ {error}</Text>
        </Box>
      )}
    </Box>
  );
};
