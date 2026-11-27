import React from 'react';
import { Box, Text } from 'ink';
import { STAGE_LABELS, STAGE_ORDER } from '../state/persistence.js';
import type { InstallationState, StageStatus } from '../types/index.js';

export interface StageSidebarProps {
  state: InstallationState;
  compact?: boolean;
}

function statusBadge(status: StageStatus): { icon: string; text: string; color: 'green' | 'cyan' | 'yellow' | 'red' | 'gray' } {
  switch (status) {
    case 'completed':
      return { icon: '✓', text: 'COMPLETED', color: 'green' };
    case 'in_progress':
      return { icon: '▸', text: 'IN PROGRESS', color: 'cyan' };
    case 'failed':
      return { icon: '✗', text: 'FAILED', color: 'red' };
    case 'skipped':
      return { icon: '–', text: 'SKIPPED', color: 'yellow' };
    default:
      return { icon: '○', text: 'PENDING', color: 'gray' };
  }
}

export const StageSidebar: React.FC<StageSidebarProps> = ({ state, compact = false }) => {
  const completedCount = STAGE_ORDER.filter((id) => state.stages[id].status === 'completed').length;
  const pct = Math.round((completedCount / STAGE_ORDER.length) * 100);
  const meterFilled = Math.round((completedCount / STAGE_ORDER.length) * 16);
  const meter = `${'█'.repeat(meterFilled)}${'░'.repeat(16 - meterFilled)}`;

  if (compact) {
    const half = Math.ceil(STAGE_ORDER.length / 2);
    return (
      <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1} height={7}>
        <Box justifyContent="space-between">
          <Text bold color="cyan">
            Ubuntu File Server Configuration
          </Text>
          <Text color="cyan">
            [{meter}] {completedCount}/{STAGE_ORDER.length}
          </Text>
        </Box>
        {Array.from({ length: half }).map((_, i) => {
          const leftId = STAGE_ORDER[i]!;
          const rightId = STAGE_ORDER[i + half];
          const leftBadge = statusBadge(state.stages[leftId].status);
          const rightBadge = rightId ? statusBadge(state.stages[rightId].status) : null;
          return (
            <Box key={leftId} justifyContent="space-between" height={1}>
              <Box width="50%">
                <Text color={leftBadge.color} bold>
                  {leftBadge.icon}{' '}
                </Text>
                <Text dimColor={state.stages[leftId].status === 'pending'}>
                  {`[${i + 1}] ${STAGE_LABELS[leftId]}`.slice(0, 22).padEnd(23)}{' '}
                </Text>
                <Text bold color={leftBadge.color}>
                  {leftBadge.text}
                </Text>
              </Box>
              {rightId && rightBadge && (
                <Box width="50%">
                  <Text color={rightBadge.color} bold>
                    {rightBadge.icon}{' '}
                  </Text>
                  <Text dimColor={state.stages[rightId].status === 'pending'}>
                    {`[${i + 1 + half}] ${STAGE_LABELS[rightId]}`.slice(0, 22).padEnd(23)}{' '}
                  </Text>
                  <Text bold color={rightBadge.color}>
                    {rightBadge.text}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} flexGrow={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Ubuntu File Server Configuration
        </Text>
        <Text color="green" bold>
          {pct}%
        </Text>
      </Box>
      <Text color="cyan">
        [{meter}] {completedCount}/{STAGE_ORDER.length} stages
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {STAGE_ORDER.map((stageId, idx) => {
          const st = state.stages[stageId];
          const badge = statusBadge(st.status);
          const isCurrent = state.currentStage === stageId;
          const label = `[${idx + 1}] ${STAGE_LABELS[stageId]}`.slice(0, 32).padEnd(33, ' ');
          return (
            <Box key={stageId} justifyContent="space-between" height={1}>
              <Text bold={isCurrent} color={isCurrent ? 'white' : undefined}>
                <Text color={badge.color}>{badge.icon} </Text>
                {label}
              </Text>
              <Text bold color={badge.color}>
                {badge.text}
              </Text>
            </Box>
          );
        })}
      </Box>

      {(state.hostname?.hostname || state.activeDirectory?.domain || state.lvm?.lvDevicePath || state.mount?.mountPoint) && (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
          <Text bold dimColor>
            Active Config
          </Text>
          {state.hostname?.hostname && <Text dimColor>Host: {state.hostname.fqdn}</Text>}
          {state.activeDirectory?.domain && (
            <Text dimColor>AD: {state.activeDirectory.domain} ({state.activeDirectory.netbiosName})</Text>
          )}
          {state.lvm?.lvDevicePath && <Text dimColor>LV: {state.lvm.lvDevicePath}</Text>}
          {state.mount?.mountPoint && <Text dimColor>Mount: {state.mount.mountPoint}</Text>}
          {state.samba.shares.length > 0 && <Text dimColor>Shares: {state.samba.shares.map((s) => s.name).join(', ')}</Text>}
        </Box>
      )}
    </Box>
  );
};
