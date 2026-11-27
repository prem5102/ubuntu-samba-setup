import React from 'react';
import { Box, Text } from 'ink';
import { STAGE_LABELS, STAGE_ORDER } from '../state/persistence.js';
import type { StageId } from '../types/index.js';

export interface ScreenHeaderProps {
  title: string;
  stageId?: StageId;
  subtitle?: string;
  badgeText?: string;
  badgeColor?: 'cyan' | 'green' | 'yellow' | 'red';
}

export const ScreenHeader: React.FC<ScreenHeaderProps> = ({
  title,
  stageId,
  subtitle,
  badgeText,
  badgeColor = 'cyan',
}) => {
  const stepIndex = stageId ? STAGE_ORDER.indexOf(stageId) : -1;
  const totalSteps = STAGE_ORDER.length;
  const filled = stepIndex >= 0 ? stepIndex + 1 : 0;
  const progressBar =
    stepIndex >= 0 ? `${'▰'.repeat(filled)}${'▱'.repeat(Math.max(0, totalSteps - filled))}` : '';
  const hasSubtitle = Boolean(subtitle || (stageId && title !== STAGE_LABELS[stageId]));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} height={hasSubtitle ? 4 : 3}>
      <Box justifyContent="space-between" height={1}>
        <Text bold color="cyan">
          {stageId ? `Stage ${stepIndex + 1}/${totalSteps}: ${STAGE_LABELS[stageId]}` : title}
        </Text>
        <Box gap={2}>
          {progressBar && <Text color="cyan">{progressBar}</Text>}
          {badgeText && (
            <Text bold color={badgeColor}>
              [{badgeText}]
            </Text>
          )}
        </Box>
      </Box>
      {hasSubtitle && <Text dimColor>{subtitle ?? title}</Text>}
    </Box>
  );
};
