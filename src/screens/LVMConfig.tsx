import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Confirmation } from '../components/Confirmation.js';
import { ErrorScreen, type ErrorAction } from '../components/ErrorScreen.js';
import { InputField } from '../components/InputField.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useTerminalSize } from '../components/useTerminalSize.js';
import { formatBytes } from '../modules/diskDetection.js';
import { buildLvmPlan, LvmManager } from '../modules/lvm.js';
import type { LvmExecutionResult, LvmPlan } from '../types/index.js';
import { validateInput } from '../validation/retry.js';
import { lvmBaseNameSchema } from '../validation/schemas.js';

const DEFAULT_LVM_MANAGER = new LvmManager();

export interface LVMConfigProps {
  selectedDisks: string[];
  totalBytes: number;
  initialBaseName?: string;
  lvmManager?: LvmManager;
  onComplete: (result: LvmExecutionResult) => void;
  onBack: () => void;
  onExit: () => void;
}

type Phase = 'input' | 'checking' | 'confirm_wipe' | 'creating' | 'done' | 'error';

export const LVMConfig: React.FC<LVMConfigProps> = ({
  selectedDisks,
  totalBytes,
  initialBaseName = 'fileserver',
  lvmManager = DEFAULT_LVM_MANAGER,
  onComplete,
  onBack,
  onExit,
}) => {
  const { pageHeight } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>('input');
  const [baseName, setBaseName] = useState(initialBaseName);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [plan, setPlan] = useState<LvmPlan | null>(null);
  const [execResult, setExecResult] = useState<LvmExecutionResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [recoverySteps, setRecoverySteps] = useState<string[]>([]);

  useInput((_input, key) => {
    if (phase === 'input' && key.escape) {
      onBack();
    } else if (phase === 'done' && (key.return || key.escape) && execResult?.success) {
      onComplete(execResult);
    }
  });

  const handleSubmit = async (rawValue: string): Promise<void> => {
    const check = validateInput(lvmBaseNameSchema, rawValue);
    if (!check.success || !check.data) {
      setFieldError(check.errorSummary ?? 'Invalid LVM name.');
      return;
    }

    if (selectedDisks.length === 0) {
      setFieldError('No disks are selected. Return to Disk Detection first.');
      return;
    }

    const candidatePlan = buildLvmPlan(check.data, selectedDisks, totalBytes);
    setBaseName(check.data);
    setFieldError(undefined);
    setPhase('checking');

    try {
      const conflicts = await lvmManager.checkNameConflicts(candidatePlan);
      if (conflicts.length > 0) {
        setFieldError(conflicts.join(' '));
        setPhase('input');
        return;
      }
      setPlan(candidatePlan);
      setPhase('confirm_wipe');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  const executeLvmCreation = async (): Promise<void> => {
    if (!plan) return;
    setPhase('creating');
    const res = await lvmManager.createLvmStorage(plan, 'WIPE');
    setExecResult(res);
    if (res.success) {
      setPhase('done');
    } else {
      setErrorMsg(res.error ?? 'LVM creation failed.');
      setRecoverySteps(res.recoveryInstructions ?? []);
      setPhase('error');
    }
  };

  const handleErrorAction = (action: ErrorAction): void => {
    if (action === 'retry') {
      setPhase('input');
    } else if (action === 'back') {
      onBack();
    } else {
      onExit();
    }
  };

  const previewClean = baseName.trim().toLowerCase() || 'fileserver';

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box flexDirection="column">
        <ScreenHeader
          title="LVM Volume Group & Logical Volume"
          stageId="lvm"
          subtitle={`Disks (${selectedDisks.length}): ${selectedDisks.join(', ') || 'None'} • ${formatBytes(totalBytes)}`}
        />

        {phase === 'input' && (
          <Box flexDirection="column" marginTop={1}>
            <InputField
              label="LVM Base Name"
              value={baseName}
              onChange={(v) => {
                setBaseName(v);
                setFieldError(undefined);
              }}
              onSubmit={(v) => void handleSubmit(v)}
              placeholder="e.g., fileserver"
              error={fieldError}
              suppressInlineError
              compact
            />

            <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={2} marginTop={1} height={5}>
              <Text bold color="cyan">
                Generated LVM Identifiers Preview
              </Text>
              <Text>
                Volume Group: <Text bold>vg_{previewClean}</Text>   •   Logical Volume: <Text bold>lv_{previewClean}</Text> (100%FREE)
              </Text>
              <Text>
                Block Device: <Text bold color="green">/dev/vg_{previewClean}/lv_{previewClean}</Text>
              </Text>
            </Box>

            <Box height={2} marginTop={1}>
              {fieldError ? (
                <Text color="red">✖ {fieldError}</Text>
              ) : (
                <Text dimColor>Enter one base name only (without vg_ or lv_ prefixes).</Text>
              )}
            </Box>
          </Box>
        )}

        {phase === 'checking' && (
          <Box marginTop={1}>
            <ProgressBar percent={40} label="Checking existing VGs/LVs for naming conflicts..." />
          </Box>
        )}

        {phase === 'confirm_wipe' && plan && (
          <Confirmation
            title="Erase Selected Disks & Create LVM Storage"
            danger
            requiredKeyword="WIPE"
            message={[
              `WARNING: ALL EXISTING DATA ON THESE DISKS WILL BE PERMANENTLY DESTROYED:`,
              `  Disks: ${plan.selectedDisks.join(', ')} (${formatBytes(plan.totalBytes)})`,
              `  VG / LV: ${plan.vgName} / ${plan.lvName} (100%FREE) -> ${plan.lvDevicePath}`,
              'Devices are revalidated immediately before pvcreate/vgcreate/lvcreate.',
            ]}
            onConfirm={() => void executeLvmCreation()}
            onCancel={() => setPhase('input')}
          />
        )}

        {phase === 'creating' && (
          <Box marginTop={1}>
            <ProgressBar
              percent={65}
              color="yellow"
              label={`Revalidating disks and running pvcreate, vgcreate ${plan?.vgName}, lvcreate -l 100%FREE...`}
            />
          </Box>
        )}

        {phase === 'done' && execResult && (
          <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={2} marginTop={1}>
            <Text bold color="green">
              ✔ LVM Storage Created Successfully!
            </Text>
            <Text>Physical Volumes: {execResult.pvCreated.join(', ')}</Text>
            <Text>Volume Group: {execResult.plan.vgName}</Text>
            <Text>Logical Volume: {execResult.plan.lvDevicePath}</Text>
            <Text dimColor>Press [Enter] to proceed to XFS Formatting & Mount Configuration.</Text>
          </Box>
        )}

        {phase === 'error' && (
          <ErrorScreen
            title="LVM Creation Halted"
            message={errorMsg}
            recoveryInstructions={recoverySteps}
            onAction={handleErrorAction}
          />
        )}
      </Box>

      <Box height={1} paddingX={1}>
        <Text dimColor>[Enter] Continue to WIPE Confirmation  •  [Ctrl+U] Clear  •  [Esc] Menu</Text>
      </Box>
    </Box>
  );
};
