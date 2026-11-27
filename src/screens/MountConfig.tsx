import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Confirmation } from '../components/Confirmation.js';
import { ErrorScreen, type ErrorAction } from '../components/ErrorScreen.js';
import { InputField } from '../components/InputField.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useTerminalSize } from '../components/useTerminalSize.js';
import { FilesystemManager } from '../modules/filesystem.js';
import { MountManager } from '../modules/mount.js';
import type { MountExecutionResult, XfsFormatResult } from '../types/index.js';
import { validateInput } from '../validation/retry.js';
import { mountPointSchema } from '../validation/schemas.js';

const DEFAULT_FILESYSTEM_MANAGER = new FilesystemManager();
const DEFAULT_MOUNT_MANAGER = new MountManager();

export interface MountConfigProps {
  lvDevicePath: string;
  initialMountPoint?: string;
  initialXfsFormatted?: boolean;
  initialUuid?: string;
  filesystemManager?: FilesystemManager;
  mountManager?: MountManager;
  onXfsReady: (uuid: string) => void;
  onComplete: (result: MountExecutionResult) => void;
  onBack: () => void;
  onExit: () => void;
}

type Phase =
  | 'inspecting_fs'
  | 'confirm_format'
  | 'formatting'
  | 'mount_input'
  | 'confirm_mount'
  | 'mounting'
  | 'done'
  | 'error';

export const MountConfig: React.FC<MountConfigProps> = ({
  lvDevicePath,
  initialMountPoint = '/data/fileserver',
  filesystemManager = DEFAULT_FILESYSTEM_MANAGER,
  mountManager = DEFAULT_MOUNT_MANAGER,
  onXfsReady,
  onComplete,
  onBack,
  onExit,
}) => {
  const { pageHeight } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>('inspecting_fs');
  const [uuid, setUuid] = useState('');
  const [mountPoint, setMountPoint] = useState(initialMountPoint);
  const [mountError, setMountError] = useState<string | undefined>();
  const [mountResult, setMountResult] = useState<MountExecutionResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [recoverySteps, setRecoverySteps] = useState<string[]>([]);

  const onXfsReadyRef = useRef(onXfsReady);
  onXfsReadyRef.current = onXfsReady;

  const inspectFs = useCallback(async () => {
    setPhase('inspecting_fs');
    try {
      const info = await filesystemManager.inspectDeviceFilesystem(lvDevicePath);
      if (info.fstype === 'xfs' && info.uuid) {
        setUuid(info.uuid);
        onXfsReadyRef.current(info.uuid);
        setPhase('mount_input');
      } else if (info.fstype && info.fstype !== 'xfs') {
        setUuid('');
        setErrorMsg(
          `Existing "${info.fstype}" filesystem detected on ${lvDevicePath}. Refusing to overwrite existing filesystem.`,
        );
        setRecoverySteps([
          `Inspect the device with: sudo blkid -p ${lvDevicePath}`,
          'Do not format disks containing existing data.',
        ]);
        setPhase('error');
      } else {
        setUuid('');
        setPhase('confirm_format');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [filesystemManager, lvDevicePath]);

  useEffect(() => {
    void inspectFs();
  }, [inspectFs]);

  useInput((_input, key) => {
    if (phase === 'mount_input' && key.escape) {
      onBack();
    } else if (phase === 'done' && (key.return || key.escape) && mountResult?.success) {
      onComplete(mountResult);
    }
  });

  const handleFormatXfs = async (): Promise<void> => {
    setPhase('formatting');
    const res: XfsFormatResult = await filesystemManager.formatLvWithXfs(lvDevicePath);
    if (res.success && res.uuid) {
      setUuid(res.uuid);
      onXfsReady(res.uuid);
      setPhase('mount_input');
    } else {
      setErrorMsg(res.error ?? 'XFS formatting failed.');
      setRecoverySteps(res.recoveryInstructions ?? []);
      setPhase('error');
    }
  };

  const handleMountSubmit = async (rawPath: string): Promise<void> => {
    const schemaCheck = validateInput(mountPointSchema, rawPath);
    if (!schemaCheck.success || !schemaCheck.data) {
      setMountError(schemaCheck.errorSummary ?? 'Invalid mount point.');
      return;
    }

    const pre = await mountManager.validateMountPointPreconditions(schemaCheck.data);
    if (!pre.valid || !pre.normalizedPath) {
      setMountError(pre.error ?? 'Mount point precondition failed.');
      return;
    }

    setMountPoint(pre.normalizedPath);
    setMountError(undefined);
    setPhase('confirm_mount');
  };

  const executeMount = async (): Promise<void> => {
    setPhase('mounting');
    const res = await mountManager.configureAndMount(lvDevicePath, mountPoint);
    setMountResult(res);
    if (res.success) {
      setPhase('done');
    } else {
      setErrorMsg(res.error ?? 'Mount operation failed.');
      setRecoverySteps(res.recoveryInstructions ?? []);
      setPhase('error');
    }
  };

  const handleErrorAction = (action: ErrorAction): void => {
    if (action === 'retry') {
      setUuid('');
      void inspectFs();
    } else if (action === 'back') {
      onBack();
    } else {
      onExit();
    }
  };

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box flexDirection="column">
        <ScreenHeader
          title="XFS Filesystem & Persistent UUID Mount"
          stageId="mount"
          subtitle={`Logical Volume: ${lvDevicePath}${uuid ? `  •  XFS UUID: ${uuid}` : ''}`}
          badgeText={uuid ? 'XFS READY' : 'INSPECTING'}
          badgeColor={uuid ? 'green' : 'cyan'}
        />

        {phase === 'inspecting_fs' && (
          <Box marginTop={1}>
            <ProgressBar percent={25} label={`Inspecting filesystem signature on ${lvDevicePath}...`} />
          </Box>
        )}

        {phase === 'confirm_format' && (
          <Confirmation
            title="Format Logical Volume with XFS"
            message={[
              `Target Logical Volume: ${lvDevicePath}`,
              'No existing filesystem signature was detected on this volume.',
              'mkfs.xfs will create an XFS filesystem and verify its UUID before mounting.',
            ]}
            confirmLabel="Format with XFS"
            cancelLabel="Back"
            onConfirm={() => void handleFormatXfs()}
            onCancel={onBack}
          />
        )}

        {phase === 'formatting' && (
          <Box marginTop={1}>
            <ProgressBar percent={60} label={`Running mkfs.xfs on ${lvDevicePath} and verifying UUID...`} />
          </Box>
        )}

        {phase === 'mount_input' && (
          <Box flexDirection="column" marginTop={1}>
            <Box marginBottom={1}>
              <Text color="green">✓ XFS filesystem verified (UUID: {uuid})</Text>
            </Box>
            <InputField
              label="Mount Point Path"
              value={mountPoint}
              onChange={(v) => {
                setMountPoint(v);
                setMountError(undefined);
              }}
              onSubmit={(v) => void handleMountSubmit(v)}
              placeholder="e.g., /data/fileserver"
              error={mountError}
              suppressInlineError
              compact
            />
            <Box height={2} marginTop={1}>
              {mountError ? (
                <Text color="red">✖ {mountError}</Text>
              ) : (
                <Text dimColor>Absolute path to a new or empty directory outside OS paths.</Text>
              )}
            </Box>
          </Box>
        )}

        {phase === 'confirm_mount' && (
          <Confirmation
            title="Update /etc/fstab and Mount XFS Volume"
            message={[
              `Mount Point:   ${mountPoint}`,
              `Device:        ${lvDevicePath}`,
              `fstab Entry:   UUID=${uuid}  ${mountPoint}  xfs  defaults  0  2`,
              '/etc/fstab will be backed up before changes, then verified via findmnt and df -h.',
            ]}
            confirmLabel="Mount & Persist"
            cancelLabel="Change Mount Point"
            onConfirm={() => void executeMount()}
            onCancel={() => setPhase('mount_input')}
          />
        )}

        {phase === 'mounting' && (
          <Box marginTop={1}>
            <ProgressBar percent={80} label={`Backing up /etc/fstab, mounting ${mountPoint}, and verifying...`} />
          </Box>
        )}

        {phase === 'done' && mountResult && (
          <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={2} marginTop={1}>
            <Text bold color="green">
              ✔ XFS Volume Mounted and Persisted via UUID!
            </Text>
            <Text>Mount Point: {mountResult.mountPoint}</Text>
            <Text>UUID Entry: {mountResult.fstabEntry}</Text>
            {mountResult.dfOutput && (
              <Box marginTop={1}>
                <Text dimColor>{mountResult.dfOutput}</Text>
              </Box>
            )}
            <Text dimColor>Press [Enter] to proceed to Samba Share & ACL Configuration.</Text>
          </Box>
        )}

        {phase === 'error' && (
          <ErrorScreen
            title="XFS / Mount Configuration Failed"
            message={errorMsg}
            recoveryInstructions={recoverySteps}
            onAction={handleErrorAction}
          />
        )}
      </Box>

      <Box height={1} paddingX={1}>
        <Text dimColor>[Enter] Validate & Preview fstab  •  [Ctrl+U] Clear  •  [Esc] Menu</Text>
      </Box>
    </Box>
  );
};
