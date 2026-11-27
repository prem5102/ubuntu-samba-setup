import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Confirmation } from '../components/Confirmation.js';
import { ErrorScreen, type ErrorAction } from '../components/ErrorScreen.js';
import { InputField } from '../components/InputField.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useTerminalSize } from '../components/useTerminalSize.js';
import { HostnameManager } from '../modules/hostname.js';
import type { HostnameApplyResult } from '../types/index.js';
import { validateInput } from '../validation/retry.js';
import { hostnameSchema } from '../validation/schemas.js';

const DEFAULT_HOSTNAME_MANAGER = new HostnameManager();

export interface HostnameConfigProps {
  initialHostname?: string;
  adDomain?: string;
  hostnameManager?: HostnameManager;
  onComplete: (hostname: string, fqdn: string) => void;
  onBack: () => void;
  onExit: () => void;
}

type Phase = 'input' | 'confirm' | 'applying' | 'done' | 'error';

export const HostnameConfig: React.FC<HostnameConfigProps> = ({
  initialHostname = '',
  adDomain,
  hostnameManager = DEFAULT_HOSTNAME_MANAGER,
  onComplete,
  onBack,
  onExit,
}) => {
  const { pageHeight } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>('input');
  const [currentSystem, setCurrentSystem] = useState<{ shortName: string; fqdn: string }>({ shortName: '', fqdn: '' });
  const [hostnameInput, setHostnameInput] = useState(initialHostname);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [applyResult, setApplyResult] = useState<HostnameApplyResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    void hostnameManager.getCurrentHostname().then((cur) => {
      setCurrentSystem(cur);
      if (!initialHostname && cur.shortName) {
        setHostnameInput(cur.shortName);
      }
    });
  }, [hostnameManager, initialHostname]);

  useInput((_input, key) => {
    if (phase === 'input' && key.escape) {
      onBack();
    } else if (phase === 'done' && (key.return || key.escape)) {
      if (applyResult?.success) {
        onComplete(applyResult.hostname, applyResult.fqdn);
      }
    }
  });

  const handleSubmit = (val: string): void => {
    const check = validateInput(hostnameSchema, val);
    if (!check.success || !check.data) {
      setFieldError(check.errorSummary ?? 'Invalid Linux hostname.');
      return;
    }
    setHostnameInput(check.data);
    setFieldError(undefined);
    setPhase('confirm');
  };

  const applyChanges = async (): Promise<void> => {
    setPhase('applying');
    const res = await hostnameManager.applyHostname({
      hostname: hostnameInput,
      domain: adDomain,
    });
    setApplyResult(res);
    if (res.success) {
      setPhase('done');
    } else {
      setErrorMsg(res.error ?? 'Failed to configure hostname.');
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

  const cleanPreview = hostnameInput.trim().toLowerCase() || 'fileserver01';
  const previewFqdn = adDomain ? `${cleanPreview}.${adDomain}` : cleanPreview;

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box flexDirection="column">
        <ScreenHeader
          title="Ubuntu Server Hostname Configuration"
          stageId="hostname"
          subtitle={`Current system: ${currentSystem.shortName || 'detecting...'} (${currentSystem.fqdn || 'n/a'})`}
        />

        {phase === 'input' && (
          <Box flexDirection="column" marginTop={1}>
            <InputField
              label="Server Hostname"
              value={hostnameInput}
              onChange={(v) => {
                setHostnameInput(v);
                setFieldError(undefined);
              }}
              onSubmit={handleSubmit}
              placeholder="e.g., fileserver01"
              error={fieldError}
              suppressInlineError
              compact
            />
            <Box borderStyle="single" borderColor="gray" paddingX={1} marginTop={1} height={3}>
              <Text>
                Preview: <Text color="cyan">{cleanPreview}</Text>
                {'  •  '}/etc/hosts: 127.0.1.1 {previewFqdn !== cleanPreview ? `${previewFqdn} ${cleanPreview}` : cleanPreview}
              </Text>
            </Box>
            <Box height={2} marginTop={1}>
              {fieldError ? (
                <Text color="red">✖ {fieldError}</Text>
              ) : (
                <Text dimColor>Lowercase letters (a-z), digits (0-9), and hyphens (-), 1-63 chars.</Text>
              )}
            </Box>
          </Box>
        )}

        {phase === 'confirm' && (
          <Confirmation
            title="Apply Hostname Configuration"
            message={[
              `System Hostname (/etc/hostname & hostnamectl): ${hostnameInput}`,
              `/etc/hosts entry: 127.0.1.1  ${previewFqdn !== hostnameInput ? `${previewFqdn} ${hostnameInput}` : hostnameInput}`,
              'Timestamped backups of /etc/hostname and /etc/hosts will be created first.',
            ]}
            confirmLabel="Apply Hostname"
            cancelLabel="Edit Hostname"
            onConfirm={() => void applyChanges()}
            onCancel={() => setPhase('input')}
          />
        )}

        {phase === 'applying' && (
          <Box marginTop={1}>
            <ProgressBar percent={65} label={`Configuring hostname "${hostnameInput}" and verifying resolution...`} />
          </Box>
        )}

        {phase === 'done' && applyResult && (
          <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={2} marginTop={1}>
            <Text bold color="green">
              ✔ Hostname configured and verified: {applyResult.verifiedHostname}
            </Text>
            <Text>FQDN mapping: {applyResult.fqdn}</Text>
            <Text dimColor>Backup session: {applyResult.backupSessionId}</Text>
            <Text dimColor>Press [Enter] to proceed to Active Directory Configuration.</Text>
          </Box>
        )}

        {phase === 'error' && (
          <ErrorScreen
            title="Hostname Configuration Failed"
            message={errorMsg}
            recoveryInstructions={[
              'Ensure you are running with root privileges (sudo).',
              'Choose Retry to adjust the hostname and re-apply without losing prior stages.',
            ]}
            onAction={handleErrorAction}
          />
        )}
      </Box>

      <Box height={1} paddingX={1}>
        <Text dimColor>[Enter] Review & Confirm  •  [Ctrl+U] Clear  •  [Esc] Main Menu</Text>
      </Box>
    </Box>
  );
};
