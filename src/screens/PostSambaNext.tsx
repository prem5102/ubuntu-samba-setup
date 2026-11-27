import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useTerminalSize } from '../components/useTerminalSize.js';
import { DiskDetector, formatBytes } from '../modules/diskDetection.js';
import type { BlockDeviceInfo, ConfiguredMountEntry, SambaShareConfig } from '../types/index.js';

const DEFAULT_DISK_DETECTOR = new DiskDetector();

export interface PostSambaNextProps {
  configuredMounts: ConfiguredMountEntry[];
  shares: SambaShareConfig[];
  diskDetector?: DiskDetector;
  onConfigureAnotherDisk: () => void;
  onFinishVerification: () => void;
  onReturnToMenu: () => void;
  onExit: () => void;
}

type ChoiceId = 'another_disk' | 'finish_verify' | 'exit_setup';

const OPTIONS: Array<{ id: ChoiceId; label: string; hint: string }> = [
  {
    id: 'another_disk',
    label: '1. Configure another disk for Samba',
    hint: 'Detect unused disks → LVM → XFS/Mount → Add new Samba share(s)',
  },
  {
    id: 'finish_verify',
    label: '2. Finish & Run Final Verification',
    hint: 'Verify System, Active Directory, Storage mounts, and Samba ACLs',
  },
  {
    id: 'exit_setup',
    label: '3. Save & Exit Setup',
    hint: 'Persist configuration state and close application',
  },
];

export const PostSambaNext: React.FC<PostSambaNextProps> = ({
  configuredMounts,
  shares,
  diskDetector = DEFAULT_DISK_DETECTOR,
  onConfigureAnotherDisk,
  onFinishVerification,
  onReturnToMenu,
  onExit,
}) => {
  const { pageHeight } = useTerminalSize();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [availableDisks, setAvailableDisks] = useState<BlockDeviceInfo[] | null>(null);

  useEffect(() => {
    let active = true;
    void diskDetector
      .detectDisks()
      .then((res) => {
        if (active) setAvailableDisks(res.eligibleDisks);
      })
      .catch(() => {
        if (active) setAvailableDisks([]);
      });
    return () => {
      active = false;
    };
  }, [diskDetector]);

  const triggerChoice = (choice: ChoiceId): void => {
    if (choice === 'another_disk') onConfigureAnotherDisk();
    else if (choice === 'finish_verify') onFinishVerification();
    else onExit();
  };

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setSelectedIndex((prev) => (prev - 1 + OPTIONS.length) % OPTIONS.length);
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex((prev) => (prev + 1) % OPTIONS.length);
      return;
    }
    if (key.return) {
      const opt = OPTIONS[selectedIndex];
      if (opt) triggerChoice(opt.id);
      return;
    }
    if (input === '1' || input.toLowerCase() === 'c') {
      onConfigureAnotherDisk();
      return;
    }
    if (input === '2' || input.toLowerCase() === 'f') {
      onFinishVerification();
      return;
    }
    if (input === '3' || input.toLowerCase() === 'q') {
      onExit();
      return;
    }
    if (input.toLowerCase() === 'm' || key.escape) {
      onReturnToMenu();
    }
  });

  const activeOption = OPTIONS[selectedIndex] ?? OPTIONS[0]!;

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box flexDirection="column">
        <ScreenHeader
          title="Samba Configuration Saved — Next Action"
          badgeText={`${shares.length} share${shares.length === 1 ? '' : 's'} active`}
          badgeColor="green"
        />

        <Box flexDirection="column" borderStyle="single" borderColor="green" paddingX={1} height={6}>
          <Text bold color="green">
            ✔ Samba share(s) and POSIX ACLs applied successfully.
          </Text>
          <Text>
            Configured Mounts ({configuredMounts.length}): {configuredMounts.map((m) => m.mountPoint).join(', ') || 'None'}
          </Text>
          <Text>
            Active Shares ({shares.length}): {shares.map((s) => `[${s.name}]`).join(', ') || 'None'}
          </Text>
          <Text color={availableDisks && availableDisks.length > 0 ? 'cyan' : 'yellow'}>
            {availableDisks === null
              ? '○ Checking for remaining unused disks...'
              : availableDisks.length > 0
                ? `● ${availableDisks.length} unused disk(s) available: ${availableDisks.map((d) => `${d.path} (${formatBytes(d.sizeBytes)})`).join(', ')}`
                : '○ No additional unused disks detected right now.'}
          </Text>
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor="white" paddingX={2} marginTop={1}>
          <Text bold color="yellow">
            Would you like to configure another disk for Samba?
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {OPTIONS.map((opt, idx) => {
              const active = idx === selectedIndex;
              return (
                <Box key={opt.id} height={1}>
                  <Text bold={active} color={active ? 'black' : 'white'} backgroundColor={active ? 'cyan' : undefined}>
                    {active ? ' ▸ ' : '   '}
                    {opt.label.padEnd(42)}
                  </Text>
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1} height={1}>
            <Text dimColor>{activeOption.hint}</Text>
          </Box>
        </Box>
      </Box>

      <Box height={1} paddingX={1}>
        <Text dimColor>[↑/↓] Move  •  [1/C] Another Disk  •  [2/F] Final Verify  •  [M/Esc] Main Menu  •  [3/Q] Exit</Text>
      </Box>
    </Box>
  );
};
