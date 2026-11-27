import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ErrorScreen, type ErrorAction } from '../components/ErrorScreen.js';
import { ProgressBar } from '../components/ProgressBar.js';
import { ScreenHeader } from '../components/ScreenHeader.js';
import { useTerminalSize } from '../components/useTerminalSize.js';
import { PackageManager } from '../modules/packageManager.js';
import type {
  PackageInstallProgress,
  PackageInstallResult,
  PackageStatusInfo,
  PrerequisiteCheckResult,
} from '../types/index.js';

const DEFAULT_PACKAGE_MANAGER = new PackageManager();

export interface PackageMenuProps {
  mode: 'check_only' | 'auto_install';
  packageManager?: PackageManager;
  onCompleteAutoInstall?: (installed: string[], missing: string[]) => void;
  onSwitchToPreinstall?: () => void;
  onBack: () => void;
  onExit: () => void;
}

type Phase = 'loading' | 'ready' | 'installing' | 'done' | 'error';

export const PackageMenu: React.FC<PackageMenuProps> = ({
  mode,
  packageManager = DEFAULT_PACKAGE_MANAGER,
  onCompleteAutoInstall,
  onSwitchToPreinstall,
  onBack,
  onExit,
}) => {
  const { columns, pageHeight } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>('loading');
  const [statuses, setStatuses] = useState<PackageStatusInfo[]>([]);
  const [prereq, setPrereq] = useState<PrerequisiteCheckResult | null>(null);
  const [progress, setProgress] = useState<PackageInstallProgress | null>(null);
  const [installResult, setInstallResult] = useState<PackageInstallResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [pageIdx, setPageIdx] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStatuses = useCallback(async () => {
    setPhase('loading');
    try {
      const [pkgs, pre] = await Promise.all([
        packageManager.getPackageStatuses(),
        packageManager.checkPrerequisites(),
      ]);
      if (!mountedRef.current) return;
      setStatuses(pkgs);
      setPrereq(pre);
      setPageIdx(0);
      const missing = pkgs.filter((p) => !p.installed);
      if (mode === 'auto_install' && missing.length === 0) {
        setPhase('done');
      } else {
        setPhase('ready');
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [mode, packageManager]);

  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses]);

  const runAutoInstall = useCallback(async () => {
    setPhase('installing');
    const result = await packageManager.installMissingPackages(undefined, (prog) => {
      if (mountedRef.current) setProgress(prog);
    });
    if (!mountedRef.current) return;
    setInstallResult(result);
    const refreshed = await packageManager.getPackageStatuses();
    if (!mountedRef.current) return;
    setStatuses(refreshed);
    if (result.success) {
      setPhase('done');
    } else {
      setErrorMsg(result.error ?? 'Failed to install all mandatory packages.');
      setPhase('error');
    }
  }, [packageManager]);

  const twoCol = columns < 100 || pageHeight < 28;
  const rows = useMemoRows(statuses, twoCol);
  const rowsPerPage = Math.max(4, pageHeight - 11);
  const totalPages = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  const safePage = Math.min(pageIdx, totalPages - 1);
  const visibleRows = rows.slice(safePage * rowsPerPage, (safePage + 1) * rowsPerPage);

  useInput((input, key) => {
    if (phase === 'loading') {
      if (key.escape || input.toLowerCase() === 'b') {
        onBack();
      }
      return;
    }

    if (phase === 'installing' || phase === 'error') {
      return;
    }

    if (key.escape || input.toLowerCase() === 'b') {
      onBack();
      return;
    }
    if (input.toLowerCase() === 'r') {
      void loadStatuses();
      return;
    }
    if ((key.leftArrow || key.pageUp) && totalPages > 1) {
      setPageIdx((p) => Math.max(0, p - 1));
      return;
    }
    if ((key.rightArrow || key.pageDown) && totalPages > 1) {
      setPageIdx((p) => Math.min(totalPages - 1, p + 1));
      return;
    }
    if (mode === 'check_only' && input.toLowerCase() === 'i' && onSwitchToPreinstall) {
      onSwitchToPreinstall();
      return;
    }
    if (key.return) {
      if (mode === 'auto_install') {
        if (phase === 'ready') {
          void runAutoInstall();
        } else if (phase === 'done') {
          const installed = statuses.filter((s) => s.installed).map((s) => s.name);
          const missing = statuses.filter((s) => !s.installed).map((s) => s.name);
          onCompleteAutoInstall?.(installed, missing);
        }
      } else if (phase === 'ready') {
        onBack();
      }
    }
  });

  const handleErrorAction = (action: ErrorAction): void => {
    if (action === 'retry') {
      if (mode === 'auto_install') void runAutoInstall();
      else void loadStatuses();
    } else if (action === 'back') {
      onBack();
    } else {
      onExit();
    }
  };

  const missingPkgs = statuses.filter((p) => !p.installed);
  const installedCount = statuses.length - missingPkgs.length;

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box flexDirection="column">
        <ScreenHeader
          title={mode === 'check_only' ? 'Package Status Inspection (Read-Only)' : 'Automatic Required Package Verification'}
          stageId={mode === 'auto_install' ? 'packages' : undefined}
          badgeText={statuses.length > 0 ? `${installedCount}/${statuses.length}` : 'SCANNING'}
          badgeColor={missingPkgs.length === 0 && statuses.length > 0 ? 'green' : 'yellow'}
        />

        {prereq && (
          <Box justifyContent="space-between" paddingX={1} height={1}>
            <Text>
              <Text color={prereq.isRoot ? 'green' : 'red'}>● Root: {prereq.isRoot ? 'YES' : 'NO'}</Text>
              {'   '}
              <Text color={prereq.aptAvailable ? 'green' : 'red'}>● APT: {prereq.aptAvailable ? 'READY' : 'MISSING'}</Text>
              {'   '}
              <Text color={prereq.hasInternet ? 'green' : 'yellow'}>
                ● Network: {prereq.hasInternet ? 'REACHABLE' : 'UNCONFIRMED'}
              </Text>
            </Text>
            {totalPages > 1 && (
              <Text color="cyan">
                Page {safePage + 1}/{totalPages}
              </Text>
            )}
          </Box>
        )}

        {phase === 'loading' && (
          <Box marginTop={1}>
            <ProgressBar percent={30} label="Querying dpkg-query for required packages..." />
          </Box>
        )}

        {phase === 'installing' && progress && (
          <Box marginTop={1}>
            <ProgressBar
              percent={progress.totalCount > 0 ? (progress.completedCount / progress.totalCount) * 100 : 10}
              label={progress.message}
            />
          </Box>
        )}

        {(phase === 'ready' || phase === 'done') && statuses.length > 0 && (
          <Box flexDirection="column" borderStyle="single" borderColor="blue" paddingX={1}>
            {twoCol ? (
              <>
                <Text bold underline>
                  {'Package'.padEnd(19)} {'Status'.padEnd(11)} | {'Package'.padEnd(19)} Status
                </Text>
                {visibleRows.map((row) => (
                  <Box key={row.left.name} height={1}>
                    <Text>{row.left.name.padEnd(19)} </Text>
                    <Text bold color={row.left.installed ? 'green' : 'yellow'}>
                      {(row.left.installed ? 'INSTALLED' : 'MISSING').padEnd(11)}
                    </Text>
                    <Text dimColor> | </Text>
                    {row.right && (
                      <>
                        <Text>{row.right.name.padEnd(19)} </Text>
                        <Text bold color={row.right.installed ? 'green' : 'yellow'}>
                          {row.right.installed ? 'INSTALLED' : 'MISSING'}
                        </Text>
                      </>
                    )}
                  </Box>
                ))}
              </>
            ) : (
              <>
                <Text bold underline>
                  {'Package'.padEnd(20)} {'Status'.padEnd(12)} {'Version'.padEnd(24)} Purpose
                </Text>
                {visibleRows.map((row) => (
                  <Box key={row.left.name} height={1}>
                    <Text>{row.left.name.padEnd(20)} </Text>
                    <Text bold color={row.left.installed ? 'green' : 'yellow'}>
                      {(row.left.installed ? 'INSTALLED' : 'MISSING').padEnd(12)}
                    </Text>
                    <Text dimColor> {(row.left.version ?? '-').slice(0, 22).padEnd(24)}</Text>
                    <Text dimColor>{row.left.description}</Text>
                  </Box>
                ))}
              </>
            )}
          </Box>
        )}

        {phase === 'error' && (
          <ErrorScreen
            title="Package Operation Failed"
            message={errorMsg}
            details={installResult?.failed.map((f) => `${f.name}: ${f.reason}`) ?? prereq?.errors ?? []}
            recoveryInstructions={[
              'Ensure the server has network/APT repository connectivity and run as root (sudo).',
              'If dpkg was interrupted previously, run `sudo dpkg --configure -a` and select Retry.',
            ]}
            onAction={handleErrorAction}
          />
        )}
      </Box>

      <Box flexDirection="column" height={3} paddingX={1}>
        {phase === 'done' && (
          <Text bold color="green">
            ✔ All {statuses.length} mandatory packages are installed and verified. Press [Enter] to continue or [B/Esc] for Menu.
          </Text>
        )}
        {phase === 'ready' && mode === 'auto_install' && missingPkgs.length > 0 && (
          <>
            <Text bold color="yellow">
              {missingPkgs.length} missing: {missingPkgs.map((p) => p.name).join(', ').slice(0, columns - 16)}
            </Text>
            <Text dimColor>[Enter] Install Missing  •  [R] Refresh  •  {totalPages > 1 ? '[←/→] Page  •  ' : ''}[B/Esc] Menu</Text>
          </>
        )}
        {phase === 'ready' && mode === 'check_only' && (
          <Text dimColor>
            [R] Refresh  •  [I] Preinstall Missing  •  {totalPages > 1 ? '[←/→] Page  •  ' : ''}[B/Esc/Enter] Return to Main Menu
          </Text>
        )}
        {phase === 'loading' && <Text dimColor>[B/Esc] Return to Main Menu</Text>}
      </Box>
    </Box>
  );
};

function useMemoRows(
  statuses: PackageStatusInfo[],
  twoCol: boolean,
): Array<{ left: PackageStatusInfo; right?: PackageStatusInfo }> {
  if (!twoCol) {
    return statuses.map((left) => ({ left }));
  }
  const half = Math.ceil(statuses.length / 2);
  const rows: Array<{ left: PackageStatusInfo; right?: PackageStatusInfo }> = [];
  for (let i = 0; i < half; i += 1) {
    rows.push({ left: statuses[i]!, right: statuses[i + half] });
  }
  return rows;
}
