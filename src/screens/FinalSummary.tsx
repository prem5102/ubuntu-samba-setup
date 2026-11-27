import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ErrorScreen, type ErrorAction } from '../components/ErrorScreen.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useTerminalSize } from '../components/useTerminalSize.js';
import { VerificationManager } from '../modules/verification.js';
import type { InstallationState, VerificationCheckItem, VerificationReport } from '../types/index.js';

const DEFAULT_VERIFICATION_MANAGER = new VerificationManager();

export interface FinalSummaryProps {
  state: InstallationState;
  verificationManager?: VerificationManager;
  onReportGenerated: (report: VerificationReport) => void;
  onReturnToMenu: () => void;
  onExit: () => void;
}

type Phase = 'verifying' | 'report' | 'error';

const SECTIONS: Array<VerificationCheckItem['category'] | 'Summary'> = [
  'System',
  'Active Directory',
  'Storage',
  'Samba',
  'Summary',
];

export const FinalSummary: React.FC<FinalSummaryProps> = ({
  state,
  verificationManager = DEFAULT_VERIFICATION_MANAGER,
  onReportGenerated,
  onReturnToMenu,
  onExit,
}) => {
  const { pageHeight } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>('verifying');
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [sectionIdx, setSectionIdx] = useState(0);
  const [subPageIdx, setSubPageIdx] = useState(0);

  const stateRef = useRef(state);
  stateRef.current = state;
  const onReportGeneratedRef = useRef(onReportGenerated);
  onReportGeneratedRef.current = onReportGenerated;

  const runChecks = useCallback(async () => {
    setPhase('verifying');
    try {
      const res = await verificationManager.runFullVerification(stateRef.current);
      setReport(res);
      onReportGeneratedRef.current(res);
      setSectionIdx(0);
      setSubPageIdx(0);
      setPhase('report');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [verificationManager]);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  const currentSection = SECTIONS[sectionIdx] ?? 'System';
  const sectionChecks =
    report && currentSection !== 'Summary'
      ? report.checks.filter((c) => c.category === currentSection)
      : [];
  const rowsPerPage = Math.max(4, pageHeight - 12);
  const subTotalPages = Math.max(1, Math.ceil(sectionChecks.length / rowsPerPage));
  const safeSubPage = Math.min(subPageIdx, subTotalPages - 1);
  const visibleChecks = sectionChecks.slice(safeSubPage * rowsPerPage, (safeSubPage + 1) * rowsPerPage);

  useInput((input, key) => {
    if (phase !== 'report') return;
    if (key.leftArrow || (key.tab && key.shift)) {
      setSectionIdx((prev) => (prev - 1 + SECTIONS.length) % SECTIONS.length);
      setSubPageIdx(0);
      return;
    }
    if (key.rightArrow || key.tab) {
      setSectionIdx((prev) => (prev + 1) % SECTIONS.length);
      setSubPageIdx(0);
      return;
    }
    const num = Number.parseInt(input, 10);
    if (num >= 1 && num <= SECTIONS.length) {
      setSectionIdx(num - 1);
      setSubPageIdx(0);
      return;
    }
    if (key.pageUp || key.upArrow) {
      setSubPageIdx((p) => Math.max(0, p - 1));
      return;
    }
    if (key.pageDown || key.downArrow) {
      setSubPageIdx((p) => Math.min(subTotalPages - 1, p + 1));
      return;
    }
    if (input.toLowerCase() === 'r') {
      void runChecks();
    } else if (input.toLowerCase() === 'm' || key.escape || key.return) {
      onReturnToMenu();
    } else if (input.toLowerCase() === 'q') {
      onExit();
    }
  });

  const handleErrorAction = (action: ErrorAction): void => {
    if (action === 'retry') void runChecks();
    else if (action === 'back') onReturnToMenu();
    else onExit();
  };

  const passCount = report?.checks.filter((c) => c.passed).length ?? 0;
  const totalCount = report?.checks.length ?? 0;

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box flexDirection="column">
        <ScreenHeader
          title="Final System Verification & Summary"
          stageId="verification"
          badgeText={report ? `${passCount}/${totalCount} PASSED` : 'VERIFYING'}
          badgeColor={report ? (report.overallPassed ? 'green' : 'yellow') : 'cyan'}
        />

        {phase === 'verifying' && (
          <Box marginTop={1}>
            <ProgressBar percent={60} label="Verifying System, Active Directory, LVM/XFS/Mount, and Samba ACLs..." />
          </Box>
        )}

        {phase === 'report' && report && (
          <Box flexDirection="column">
            {/* Section Page Tabs */}
            <Box gap={1} marginTop={1} height={1}>
              {SECTIONS.map((sec, idx) => {
                const active = idx === sectionIdx;
                let badge = '';
                if (sec !== 'Summary') {
                  const items = report.checks.filter((c) => c.category === sec);
                  const ok = items.filter((c) => c.passed).length;
                  badge = ` (${ok}/${items.length})`;
                }
                return (
                  <Text
                    key={sec}
                    bold={active}
                    color={active ? 'black' : 'cyan'}
                    backgroundColor={active ? 'cyan' : undefined}
                  >
                    {' '}
                    [{idx + 1}] {sec}
                    {badge}{' '}
                  </Text>
                );
              })}
            </Box>

            <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1} marginTop={1}>
              <Box justifyContent="space-between" height={1}>
                <Text bold color={report.overallPassed ? 'green' : 'yellow'}>
                  Page: {currentSection} ({sectionIdx + 1}/{SECTIONS.length})
                </Text>
                {currentSection !== 'Summary' && subTotalPages > 1 && (
                  <Text color="cyan">
                    Subpage {safeSubPage + 1}/{subTotalPages}
                  </Text>
                )}
              </Box>

              {currentSection === 'Summary' ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold color={report.overallPassed ? 'green' : 'yellow'}>
                    {report.overallPassed
                      ? `✔ ALL ${totalCount} VERIFICATION CHECKS PASSED — Ubuntu File Server Ready`
                      : `⚠ ${totalCount - passCount} CHECK(S) NEED ATTENTION — Inspect section pages [1-4]`}
                  </Text>
                  <Text>Hostname:   {state.hostname?.fqdn ?? 'N/A'}</Text>
                  <Text>AD Domain:  {state.activeDirectory?.domain ?? 'N/A'} ({state.activeDirectory?.netbiosName ?? 'N/A'})</Text>
                  <Text>Mounts:     {(state.configuredMounts && state.configuredMounts.length > 0 ? state.configuredMounts : state.mount ? [state.mount] : []).map((m) => `${m.mountPoint} (${m.lvDevicePath})`).join(', ') || 'N/A'}</Text>
                  <Text>Shares:     {state.samba.shares.map((s) => `${s.name} -> ${s.sharePath}`).join(', ') || 'None'}</Text>
                  <Text dimColor>Sanitized report saved to logs/ without passwords, tickets, or credentials.</Text>
                </Box>
              ) : visibleChecks.length === 0 ? (
                <Text dimColor>No checks recorded for {currentSection}.</Text>
              ) : (
                visibleChecks.map((chk, idx) => (
                  <Box key={`${chk.name}-${idx}`} height={1}>
                    <Text bold color={chk.passed ? 'green' : 'red'}>
                      {chk.passed ? '✓ [PASS] ' : '✗ [FAIL] '}
                    </Text>
                    <Text bold>{chk.name.padEnd(28)} </Text>
                    <Text dimColor>{chk.detail}</Text>
                  </Box>
                ))
              )}
            </Box>
          </Box>
        )}

        {phase === 'error' && (
          <ErrorScreen title="Verification Error" message={errorMsg} onAction={handleErrorAction} />
        )}
      </Box>

      <Box height={1} paddingX={1}>
        <Text dimColor>[←/→/Tab/1-5] Switch Section Page  •  [R] Re-run  •  [Enter/M/Esc] Menu  •  [Q] Exit</Text>
      </Box>
    </Box>
  );
};
