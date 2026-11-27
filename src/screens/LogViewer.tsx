import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useTerminalSize } from '../components/useTerminalSize.js';
import { readLogEntries } from '../modules/logger.js';
import type { LogEntry } from '../types/index.js';

export interface LogViewerProps {
  onBack: () => void;
}

const LEVELS = ['all', 'info', 'warn', 'error'] as const;

export const LogViewer: React.FC<LogViewerProps> = ({ onBack }) => {
  const { columns, pageHeight } = useTerminalSize();
  const pageSize = Math.max(6, pageHeight - 9);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [levelIdx, setLevelIdx] = useState(0);
  const [pageIdx, setPageIdx] = useState(0);

  const activeLevel = LEVELS[levelIdx] ?? 'all';

  const loadLogs = useCallback(async () => {
    const loaded = await readLogEntries(400, activeLevel);
    setEntries(loaded);
    const lastPage = Math.max(0, Math.ceil(loaded.length / pageSize) - 1);
    setPageIdx(lastPage);
  }, [activeLevel, pageSize]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
  const safePage = Math.min(pageIdx, totalPages - 1);

  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === 'b' || input.toLowerCase() === 'q') {
      onBack();
      return;
    }
    if (input.toLowerCase() === 'r') {
      void loadLogs();
      return;
    }
    if (input.toLowerCase() === 'f' || key.tab) {
      setLevelIdx((prev) => (prev + 1) % LEVELS.length);
      return;
    }
    if (key.leftArrow || key.pageUp || key.upArrow || input === 'k' || input.toLowerCase() === 'p') {
      setPageIdx((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow || key.pageDown || key.downArrow || input === 'j' || input.toLowerCase() === 'n') {
      setPageIdx((prev) => Math.min(totalPages - 1, prev + 1));
      return;
    }
    if (input === 'g') {
      setPageIdx(0);
      return;
    }
    if (input === 'G') {
      setPageIdx(totalPages - 1);
    }
  });

  const visible = entries.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const maxMsgWidth = Math.max(30, columns - 32);

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box flexDirection="column">
        <ScreenHeader
          title="Installation Logs (Secrets Redacted)"
          badgeText={`Page ${safePage + 1}/${totalPages}`}
          badgeColor="cyan"
        />

        <Box justifyContent="space-between" paddingX={1} height={1}>
          <Box gap={1}>
            <Text dimColor>Filter:</Text>
            {LEVELS.map((lvl, idx) => {
              const active = idx === levelIdx;
              return (
                <Text
                  key={lvl}
                  bold={active}
                  color={active ? 'black' : 'gray'}
                  backgroundColor={active ? 'cyan' : undefined}
                >
                  {' '}
                  {lvl.toUpperCase()}{' '}
                </Text>
              );
            })}
          </Box>
          <Text dimColor>{entries.length} entries</Text>
        </Box>

        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} height={pageSize + 2}>
          {visible.length === 0 ? (
            <Text dimColor>No log entries recorded yet for level "{activeLevel}".</Text>
          ) : (
            visible.map((entry, idx) => {
              const lvlColor =
                entry.level === 'error' ? 'red' : entry.level === 'warn' ? 'yellow' : entry.level === 'info' ? 'green' : 'gray';
              return (
                <Box key={`${safePage}-${idx}`} height={1}>
                  <Text dimColor>{entry.time.slice(11, 19) || '--:--:--'} </Text>
                  <Text bold color={lvlColor}>
                    [{entry.level.toUpperCase().padEnd(5)}]
                  </Text>
                  <Text color="cyan"> {entry.module ? `${entry.module}: ` : ''}</Text>
                  <Text>{entry.msg.slice(0, maxMsgWidth)}</Text>
                </Box>
              );
            })
          )}
        </Box>
      </Box>

      <Box height={1} paddingX={1}>
        <Text dimColor>[←/→/PgUp/PgDn] Page  •  [g/G] First/Last Page  •  [F/Tab] Filter  •  [R] Refresh  •  [B/Esc] Menu</Text>
      </Box>
    </Box>
  );
};
