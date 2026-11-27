import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Confirmation } from '../components/Confirmation.js';
import { ErrorScreen, type ErrorAction } from '../components/ErrorScreen.js';
import { InputField } from '../components/InputField.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useTerminalSize } from '../components/useTerminalSize.js';
import { ActiveDirectoryManager } from '../modules/activeDirectory.js';
import type { ActiveDirectoryPersistedConfig, AdJoinResult } from '../types/index.js';
import { validateInput } from '../validation/retry.js';
import { activeDirectoryInputSchema } from '../validation/schemas.js';

const DEFAULT_AD_MANAGER = new ActiveDirectoryManager();

export interface ActiveDirectoryConfigProps {
  initialConfig?: ActiveDirectoryPersistedConfig;
  hostnameShort?: string;
  adManager?: ActiveDirectoryManager;
  onComplete: (persisted: ActiveDirectoryPersistedConfig) => void;
  onBack: () => void;
  onExit: () => void;
}

type Phase = 'form' | 'confirm' | 'joining' | 'done' | 'error';

const FIELD_ORDER = ['domain', 'netbiosName', 'dcIp', 'username', 'password'] as const;

export const ActiveDirectoryConfig: React.FC<ActiveDirectoryConfigProps> = ({
  initialConfig,
  hostnameShort,
  adManager = DEFAULT_AD_MANAGER,
  onComplete,
  onBack,
  onExit,
}) => {
  const { pageHeight } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>('form');
  const [focusIndex, setFocusIndex] = useState(0);

  const [domain, setDomain] = useState(initialConfig?.domain ?? '');
  const [netbiosName, setNetbiosName] = useState(initialConfig?.netbiosName ?? '');
  const [dcIp, setDcIp] = useState(initialConfig?.dcIp ?? '');
  const [username, setUsername] = useState(initialConfig?.username ?? '');
  // Password exists ONLY in volatile React state and is never logged or persisted
  const [password, setPassword] = useState('');

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [errorSummary, setErrorSummary] = useState<string | undefined>();
  const [joinResult, setJoinResult] = useState<AdJoinResult | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const handleDomainChange = (val: string): void => {
    setDomain(val);
    setFieldErrors((prev) => ({ ...prev, domain: '' }));
    setErrorSummary(undefined);
    if (!netbiosName && val.includes('.')) {
      const firstLabel = val.split('.')[0] ?? '';
      if (firstLabel.length > 0 && firstLabel.length <= 15) {
        setNetbiosName(firstLabel.toUpperCase());
      }
    }
  };

  const validateAndProceed = (): void => {
    const check = validateInput(activeDirectoryInputSchema, {
      domain,
      netbiosName,
      dcIp,
      username,
      password,
    });

    if (!check.success || !check.data) {
      setFieldErrors(check.fieldErrors);
      setErrorSummary(check.errorSummary ?? 'Please correct highlighted fields.');
      const firstBadIdx = FIELD_ORDER.findIndex((f) => Boolean(check.fieldErrors[f]));
      if (firstBadIdx >= 0) setFocusIndex(firstBadIdx);
      return;
    }

    setDomain(check.data.domain);
    setNetbiosName(check.data.netbiosName);
    setDcIp(check.data.dcIp);
    setUsername(check.data.username);
    setFieldErrors({});
    setErrorSummary(undefined);
    setPhase('confirm');
  };

  useInput((input, key) => {
    if (phase === 'form') {
      if (key.escape) {
        onBack();
        return;
      }
      if (key.upArrow || (key.tab && key.shift)) {
        setFocusIndex((prev) => (prev - 1 + FIELD_ORDER.length) % FIELD_ORDER.length);
        return;
      }
      if (key.downArrow || key.tab) {
        setFocusIndex((prev) => (prev + 1) % FIELD_ORDER.length);
        return;
      }
      if (key.ctrl && input.toLowerCase() === 'd') {
        validateAndProceed();
      }
    } else if (phase === 'done' && key.return && joinResult?.success) {
      const persisted: ActiveDirectoryPersistedConfig = {
        domain: domain.trim().toLowerCase(),
        netbiosName: netbiosName.trim().toUpperCase(),
        dcIp: dcIp.trim(),
        username: username.trim(),
        dnsConfigured: true,
        kerberosConfigured: true,
        sambaAdsConfigured: true,
        nssConfigured: true,
        pamConfigured: true,
        joined: true,
        verified: true,
      };
      setPassword('');
      onComplete(persisted);
    }
  });

  const handleFieldSubmit = (idx: number): void => {
    if (idx < FIELD_ORDER.length - 1) {
      setFocusIndex(idx + 1);
    } else {
      validateAndProceed();
    }
  };

  const executeJoin = async (): Promise<void> => {
    setPhase('joining');
    const result = await adManager.configureAndJoin(
      {
        domain,
        netbiosName,
        dcIp,
        username,
        password,
      },
      hostnameShort,
    );
    setJoinResult(result);
    if (result.success) {
      setPassword('');
      setPhase('done');
    } else {
      setErrorMsg(result.error ?? 'Active Directory join failed.');
      setPhase('error');
    }
  };

  const handleErrorAction = (action: ErrorAction): void => {
    if (action === 'retry') {
      setPhase('form');
    } else if (action === 'back') {
      setPassword('');
      onBack();
    } else {
      setPassword('');
      onExit();
    }
  };

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box flexDirection="column">
        <ScreenHeader
          title="Active Directory, DNS, Kerberos & Winbind"
          stageId="active_directory"
          subtitle="Passwords are masked and passed only in volatile memory; never logged or saved."
        />

        {phase === 'form' && (
          <Box flexDirection="column">
            <InputField
              label="AD DNS Domain"
              value={domain}
              onChange={handleDomainChange}
              onSubmit={() => handleFieldSubmit(0)}
              placeholder="e.g., project.local (NOT DC hostname)"
              error={fieldErrors['domain'] || undefined}
              focused={focusIndex === 0}
              suppressInlineError
              compact
            />
            <InputField
              label="Domain NetBIOS Name"
              value={netbiosName}
              onChange={(v) => {
                setNetbiosName(v.toUpperCase());
                setFieldErrors((prev) => ({ ...prev, netbiosName: '' }));
                setErrorSummary(undefined);
              }}
              onSubmit={() => handleFieldSubmit(1)}
              placeholder="e.g., PROJECT"
              error={fieldErrors['netbiosName'] || undefined}
              focused={focusIndex === 1}
              suppressInlineError
              compact
            />
            <InputField
              label="Domain Controller IP"
              value={dcIp}
              onChange={(v) => {
                setDcIp(v);
                setFieldErrors((prev) => ({ ...prev, dcIp: '' }));
                setErrorSummary(undefined);
              }}
              onSubmit={() => handleFieldSubmit(2)}
              placeholder="e.g., 192.168.161.137"
              error={fieldErrors['dcIp'] || undefined}
              focused={focusIndex === 2}
              suppressInlineError
              compact
            />
            <InputField
              label="Domain-Join Username"
              value={username}
              onChange={(v) => {
                setUsername(v);
                setFieldErrors((prev) => ({ ...prev, username: '' }));
                setErrorSummary(undefined);
              }}
              onSubmit={() => handleFieldSubmit(3)}
              placeholder="e.g., Administrator"
              error={fieldErrors['username'] || undefined}
              focused={focusIndex === 3}
              suppressInlineError
              compact
            />
            <InputField
              label="Password"
              value={password}
              mask="*"
              onChange={(v) => {
                setPassword(v);
                setFieldErrors((prev) => ({ ...prev, password: '' }));
                setErrorSummary(undefined);
              }}
              onSubmit={() => handleFieldSubmit(4)}
              placeholder="Enter AD password (masked)"
              error={fieldErrors['password'] || undefined}
              focused={focusIndex === 4}
              suppressInlineError
              compact
            />
          </Box>
        )}

        {phase === 'confirm' && (
          <Confirmation
            title="Configure DNS, Kerberos, Winbind & Join Active Directory"
            message={[
              `AD DNS Domain / Realm: ${domain} (${domain.toUpperCase()})`,
              `NetBIOS Workgroup:     ${netbiosName}`,
              `Domain Controller IP:  ${dcIp}`,
              `Domain-Join Account:   ${username}`,
              `Password:              ${'*'.repeat(Math.min(password.length, 12))} (volatile memory only)`,
              'Backups will be created for DNS, /etc/krb5.conf, /etc/samba/smb.conf, /etc/nsswitch.conf, and /etc/hosts.',
            ]}
            confirmLabel="Configure & Join AD"
            cancelLabel="Edit Settings"
            onConfirm={() => void executeJoin()}
            onCancel={() => setPhase('form')}
          />
        )}

        {phase === 'joining' && (
          <Box marginTop={1}>
            <ProgressBar
              percent={55}
              label="Configuring DNS, testing SRV records, authenticating Kerberos, configuring Samba/Winbind, and joining AD..."
            />
          </Box>
        )}

        {phase === 'done' && joinResult && (
          <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={2}>
            <Text bold color="green">
              ✔ Active Directory joined and verified!
            </Text>
            <Box flexDirection="column" marginY={1}>
              {joinResult.checks.slice(0, Math.max(4, pageHeight - 10)).map((chk, idx) => (
                <Text key={idx} color={chk.passed ? 'green' : 'red'}>
                  {chk.passed ? '✓' : '✗'} {chk.name}: {chk.detail}
                </Text>
              ))}
            </Box>
            <Text dimColor>Press [Enter] to proceed to Disk Detection.</Text>
          </Box>
        )}

        {phase === 'error' && (
          <ErrorScreen
            title="Active Directory Configuration / Join Failed"
            message={errorMsg}
            details={joinResult?.checks.map((c) => `${c.passed ? '[PASS]' : '[FAIL]'} ${c.name}: ${c.detail}`) ?? []}
            recoveryInstructions={[
              'Verify DC IP reachability on TCP/UDP 53 (DNS), 88 (Kerberos), 389 (LDAP), 445 (SMB).',
              'Ensure system clock skew with the Domain Controller is under 5 minutes (chrony).',
              'Verify the Domain-Join user has permission to create computer objects in the domain.',
            ]}
            onAction={handleErrorAction}
          />
        )}
      </Box>

      {/* Fixed 2-line validation/footer area prevents fields from jumping when errors toggle */}
      <Box flexDirection="column" height={2} paddingX={1}>
        {phase === 'form' && (
          <>
            <Text color={errorSummary ? 'red' : 'gray'}>
              {errorSummary ? `✖ ${errorSummary}` : 'Enter AD domain zone (e.g., project.local), NetBIOS name, DC IP, and join credentials.'}
            </Text>
            <Text dimColor>[↑/↓/Tab] Switch Field  •  [Enter] Next/Submit  •  [Ctrl+D] Validate Now  •  [Esc] Menu</Text>
          </>
        )}
      </Box>
    </Box>
  );
};
