import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { StageSidebar } from './StageSidebar.js';
import { useTerminalSize } from './useTerminalSize.js';
import { REQUIRED_PACKAGES } from '../modules/packageManager.js';
import { getNextIncompleteStage, hasResumableProgress } from '../state/installationState.js';
import { STAGE_LABELS } from '../state/persistence.js';
import type { InstallationState } from '../types/index.js';

export type MainMenuChoice =
  | 'start_complete'
  | 'preinstall_packages'
  | 'check_packages'
  | 'resume'
  | 'view_logs'
  | 'exit';

export interface MainMenuProps {
  state: InstallationState;
  isRoot: boolean;
  onSelect: (choice: MainMenuChoice) => void;
}

const MENU_ITEMS: Array<{ id: MainMenuChoice; label: string; description: string }> = [
  {
    id: 'start_complete',
    label: '1. Start complete server configuration',
    description: 'Guided setup: Packages → Hostname → AD → Disks → LVM → XFS/Mount → Samba → Verify',
  },
  {
    id: 'preinstall_packages',
    label: '2. Preinstall required packages',
    description: 'Inspect, confirm, and install required Ubuntu AD/Samba/LVM/XFS dependencies',
  },
  {
    id: 'check_packages',
    label: '3. Check installed package status',
    description: `Read-only check of all ${REQUIRED_PACKAGES.length} mandatory packages via dpkg-query`,
  },
  {
    id: 'resume',
    label: '4. Resume previous configuration',
    description: 'Revalidate live system state and continue from the last incomplete stage',
  },
  {
    id: 'view_logs',
    label: '5. View installation logs',
    description: 'Inspect structured operation logs (secrets and passwords redacted)',
  },
  {
    id: 'exit',
    label: '6. Exit',
    description: 'Save progress state and close the application safely',
  },
];

export const MainMenu: React.FC<MainMenuProps> = ({ state, isRoot, onSelect }) => {
  const { columns, pageHeight } = useTerminalSize();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const resumable = hasResumableProgress(state);
  const nextStage = getNextIncompleteStage(state);
  const wideLayout = columns >= 104 && pageHeight >= 20;
  const activeItem = MENU_ITEMS[selectedIndex] ?? MENU_ITEMS[0]!;

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      setSelectedIndex((prev) => (prev - 1 + MENU_ITEMS.length) % MENU_ITEMS.length);
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex((prev) => (prev + 1) % MENU_ITEMS.length);
      return;
    }
    if (key.return) {
      const item = MENU_ITEMS[selectedIndex];
      if (item) onSelect(item.id);
      return;
    }
    const num = Number.parseInt(input, 10);
    if (num >= 1 && num <= MENU_ITEMS.length) {
      const item = MENU_ITEMS[num - 1];
      if (item) {
        setSelectedIndex(num - 1);
        onSelect(item.id);
      }
      return;
    }
    if (input.toLowerCase() === 'q') {
      onSelect('exit');
    }
  });

  // Fixed-height menu rows + fixed 2-line description area prevents vertical shifting when navigating
  const menuBox = (
    <Box flexDirection="column" borderStyle="round" borderColor="white" paddingX={2} flexGrow={1}>
      <Box justifyContent="space-between">
        <Text bold color="yellow">
          Main Menu
        </Text>
        {resumable ? (
          <Text color="green">Next: {STAGE_LABELS[nextStage]}</Text>
        ) : (
          <Text dimColor>Ready</Text>
        )}
      </Box>

      <Box height={1}>
        {!isRoot ? (
          <Text color="yellow">⚠ Non-root mode: run `sudo ./ubuntu-fileserver` for system changes.</Text>
        ) : (
          <Text color="green">● Root privileges verified — full setup enabled.</Text>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {MENU_ITEMS.map((item, idx) => {
          const active = idx === selectedIndex;
          return (
            <Box key={item.id} height={1}>
              <Text bold={active} color={active ? 'black' : 'white'} backgroundColor={active ? 'cyan' : undefined}>
                {active ? ' ▸ ' : '   '}
                {item.label.padEnd(40)}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1} height={4}>
        <Text bold color="cyan">
          Selected Action:
        </Text>
        <Text dimColor>{activeItem.description}</Text>
      </Box>
    </Box>
  );

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box borderStyle="round" borderColor="cyan" paddingX={2} justifyContent="space-between" height={3}>
        <Text bold color="cyan">
          Ubuntu Server 24.04 • Samba + Active Directory + LVM
        </Text>
        <Text color={isRoot ? 'green' : 'yellow'} bold>
          {isRoot ? '● ROOT' : '○ NON-ROOT'}
        </Text>
      </Box>

      {wideLayout ? (
        <Box flexDirection="row" gap={1} flexGrow={1}>
          <Box flexDirection="column" width="52%">
            {menuBox}
          </Box>
          <Box flexDirection="column" width="48%">
            <StageSidebar state={state} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1}>
          <StageSidebar state={state} compact />
          {menuBox}
        </Box>
      )}

      <Box justifyContent="space-between" height={1} paddingX={1}>
        <Text dimColor>[↑/↓] Move  [Enter / 1-6] Select  [Q] Exit</Text>
        {resumable ? <Text color="green">[4] Resume Available</Text> : <Text dimColor>v1.0.0</Text>}
      </Box>
    </Box>
  );
};
