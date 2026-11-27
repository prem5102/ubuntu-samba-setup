import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Confirmation } from '../components/Confirmation.js';
import { ErrorScreen, type ErrorAction } from '../components/ErrorScreen.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useTerminalSize } from '../components/useTerminalSize.js';
import { DiskDetector, formatBytes } from '../modules/diskDetection.js';
import type { BlockDeviceInfo, DiskDetectionResult } from '../types/index.js';

const DEFAULT_DISK_DETECTOR = new DiskDetector();

export interface DiskSelectionProps {
  initialSelected?: string[];
  diskDetector?: DiskDetector;
  onComplete: (selectedDevices: string[], totalBytes: number) => void;
  onBack: () => void;
  onExit: () => void;
}

type Phase = 'scanning' | 'select' | 'confirm' | 'error';

export const DiskSelection: React.FC<DiskSelectionProps> = ({
  initialSelected = [],
  diskDetector = DEFAULT_DISK_DETECTOR,
  onComplete,
  onBack,
  onExit,
}) => {
  const { pageHeight } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>('scanning');
  const [scanResult, setScanResult] = useState<DiskDetectionResult | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set(initialSelected));
  const [selectionError, setSelectionError] = useState<string | undefined>();
  const [fatalError, setFatalError] = useState<string>('');

  const runScan = useCallback(async () => {
    setPhase('scanning');
    setSelectionError(undefined);
    try {
      const res = await diskDetector.detectDisks();
      setScanResult(res);
      const eligiblePaths = new Set(res.eligibleDisks.map((d) => d.path));
      setSelectedSet((prev) => new Set(Array.from(prev).filter((p) => eligiblePaths.has(p))));
      setCursorIndex(0);
      setPhase('select');
    } catch (err) {
      setFatalError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [diskDetector]);

  useEffect(() => {
    void runScan();
  }, [runScan]);

  const disks: BlockDeviceInfo[] = scanResult?.disks ?? [];
  const selectedDisks = disks.filter((d) => d.eligible && selectedSet.has(d.path));
  const combinedBytes = selectedDisks.reduce((acc, d) => acc + d.sizeBytes, 0);

  const disksPerPage = Math.max(4, pageHeight - 13);
  const totalPages = Math.max(1, Math.ceil(disks.length / disksPerPage));
  const currentPage = Math.min(Math.floor(cursorIndex / disksPerPage), totalPages - 1);
  const visibleDisks = disks.slice(currentPage * disksPerPage, (currentPage + 1) * disksPerPage);

  useInput((input, key) => {
    if (phase !== 'select') return;

    if (key.escape || input.toLowerCase() === 'b') {
      onBack();
      return;
    }
    if (input.toLowerCase() === 'r') {
      void runScan();
      return;
    }
    if (disks.length === 0) return;

    if (key.upArrow || input === 'k') {
      setCursorIndex((prev) => (prev - 1 + disks.length) % disks.length);
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursorIndex((prev) => (prev + 1) % disks.length);
      return;
    }
    if ((key.leftArrow || key.pageUp) && totalPages > 1) {
      const targetPage = Math.max(0, currentPage - 1);
      setCursorIndex(targetPage * disksPerPage);
      return;
    }
    if ((key.rightArrow || key.pageDown) && totalPages > 1) {
      const targetPage = Math.min(totalPages - 1, currentPage + 1);
      setCursorIndex(targetPage * disksPerPage);
      return;
    }
    if (input === ' ') {
      const current = disks[cursorIndex];
      if (!current) return;
      if (!current.eligible) {
        setSelectionError(`Cannot select ${current.path}: ${current.exclusionReasons.join('; ')}`);
        return;
      }
      setSelectionError(undefined);
      setSelectedSet((prev) => {
        const next = new Set(prev);
        if (next.has(current.path)) next.delete(current.path);
        else next.add(current.path);
        return next;
      });
      return;
    }
    if (input.toLowerCase() === 'a' && scanResult) {
      setSelectionError(undefined);
      setSelectedSet(new Set(scanResult.eligibleDisks.map((d) => d.path)));
      return;
    }
    if (input.toLowerCase() === 'c') {
      setSelectionError(undefined);
      setSelectedSet(new Set());
      return;
    }
    if (key.return) {
      if (selectedDisks.length === 0) {
        setSelectionError('Select at least one eligible unused disk using Space before continuing.');
        return;
      }
      setSelectionError(undefined);
      setPhase('confirm');
    }
  });

  const handleErrorAction = (action: ErrorAction): void => {
    if (action === 'retry') void runScan();
    else if (action === 'back') onBack();
    else onExit();
  };

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box flexDirection="column">
        <ScreenHeader
          title="Automatic Disk Detection & Selection"
          stageId="disk_selection"
          badgeText={scanResult ? `${scanResult.eligibleDisks.length} eligible` : 'SCANNING'}
          badgeColor={scanResult && scanResult.eligibleDisks.length > 0 ? 'green' : 'yellow'}
        />

        {phase === 'scanning' && (
          <Box marginTop={1}>
            <ProgressBar percent={45} label="Scanning block devices (lsblk, blkid, pvs, findmnt)..." />
          </Box>
        )}

        {phase === 'select' && scanResult && (
          <Box flexDirection="column">
            <Box justifyContent="space-between" paddingX={1} height={1}>
              <Text dimColor>
                {scanResult.warnings[0] ? `⚠ ${scanResult.warnings[0]}` : 'Only unused, unpartitioned non-OS disks can be selected.'}
              </Text>
              {totalPages > 1 && (
                <Text color="cyan">
                  Page {currentPage + 1}/{totalPages}
                </Text>
              )}
            </Box>

            <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1}>
              <Text bold underline>
                {'Sel'.padEnd(5)} {'Device'.padEnd(13)} {'Model'.padEnd(20)} {'Capacity'.padEnd(10)} {'Layout'.padEnd(16)} Status
              </Text>
              {visibleDisks.map((d, relIdx) => {
                const absIdx = currentPage * disksPerPage + relIdx;
                const isFocused = absIdx === cursorIndex;
                const isChecked = d.eligible && selectedSet.has(d.path);
                const boxMark = d.eligible ? (isChecked ? '◉' : '○') : '⊘';
                const metaSummary = [
                  d.children.length > 0 ? `${d.children.length}p` : '0p',
                  d.fstype ?? (d.pttype ? `pt:${d.pttype}` : 'raw'),
                  d.mountpoint ?? '',
                ]
                  .filter(Boolean)
                  .join('/');

                return (
                  <Box key={d.path} height={1}>
                    <Text
                      backgroundColor={isFocused ? 'cyan' : undefined}
                      color={isFocused ? 'black' : d.eligible ? (isChecked ? 'green' : 'white') : 'gray'}
                      bold={isFocused || isChecked}
                    >
                      {` ${boxMark}   `} {d.path.padEnd(13)} {d.model.slice(0, 18).padEnd(20)} {d.sizeFormatted.padEnd(10)}{' '}
                      {metaSummary.slice(0, 14).padEnd(16)}{' '}
                      {d.eligible ? 'ELIGIBLE' : `EXCLUDED: ${d.exclusionReasons[0] ?? 'In use'}`}
                    </Text>
                  </Box>
                );
              })}
            </Box>

            <Box justifyContent="space-between" borderStyle="single" borderColor="green" paddingX={1} height={3}>
              <Text bold color="green">
                Selected ({selectedDisks.length}): {selectedDisks.length > 0 ? selectedDisks.map((d) => d.path).join(', ') : 'None'}
              </Text>
              <Text bold color="cyan">
                Total: {formatBytes(combinedBytes)}
              </Text>
            </Box>
          </Box>
        )}

        {phase === 'confirm' && (
          <Confirmation
            title="Confirm Selected Data Disks"
            message={[
              `Selected Disks (${selectedDisks.length}): ${selectedDisks.map((d) => `${d.path} (${d.sizeFormatted})`).join(', ')}`,
              `Combined Capacity: ${formatBytes(combinedBytes)}`,
              'No data has been modified yet. Next step configures LVM names and requires explicit WIPE confirmation.',
            ]}
            confirmLabel="Proceed to LVM Configuration"
            cancelLabel="Modify Selection"
            onConfirm={() =>
              onComplete(
                selectedDisks.map((d) => d.path),
                combinedBytes,
              )
            }
            onCancel={() => setPhase('select')}
          />
        )}

        {phase === 'error' && (
          <ErrorScreen
            title="Disk Detection Failed"
            message={fatalError}
            recoveryInstructions={['Verify lsblk, blkid, findmnt, and lvm2 utilities are available.']}
            onAction={handleErrorAction}
          />
        )}
      </Box>

      <Box flexDirection="column" height={2} paddingX={1}>
        {phase === 'select' && (
          <>
            <Text color={selectionError ? 'red' : scanResult?.eligibleDisks.length === 0 ? 'yellow' : 'gray'}>
              {selectionError
                ? `✖ ${selectionError}`
                : scanResult?.eligibleDisks.length === 0
                  ? 'No unused, unpartitioned non-OS disks found. Attach spare disks or press [R] to rescan.'
                  : ' '}
            </Text>
            <Text dimColor>
              [↑/↓] Move  [Space] Toggle  [A] All  [C] Clear  {totalPages > 1 ? '[←/→] Page  ' : ''}[R] Rescan  [Enter] Confirm  [B/Esc] Menu
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
};
