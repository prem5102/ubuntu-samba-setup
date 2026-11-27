import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Confirmation } from '../components/Confirmation.js';
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

export interface PackagePreinstallProps {
  packageManager?: PackageManager;
  onPackagesUpdated: (installed: string[], missing: string[]) => void;
  onBack: () => void;
  onExit: () => void;
}

type Phase = 'loading' | 'review' | 'confirm' | 'installing' | 'success' | 'error';

export const PackagePreinstall: React.FC<PackagePreinstallProps> = ({
  packageManager = DEFAULT_PACKAGE_MANAGER,
  onPackagesUpdated,
  onBack,
  onExit,
}) => {
  const { columns, pageHeight } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>('loading');
  const [statuses, setStatuses] = useState<PackageStatusInfo[]>([]);
  const [prereq, setPrereq] = useState<PrerequisiteCheckResult | null>(null);
  const [progress, setProgress] = useState<PackageInstallProgress | null>(null);
  const [result, setResult] = useState<PackageInstallResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [pageIdx, setPageIdx] = useState(0);

  const onPackagesUpdatedRef = useRef(onPackagesUpdated);
  onPackagesUpdatedRef.current = onPackagesUpdated;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const scan = useCallback(async () => {
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
      onPackagesUpdatedRef.current(
        pkgs.filter((p) => p.installed).map((p) => p.name),
        pkgs.filter((p) => !p.installed).map((p) => p.name),
      );
      setPhase('review');
    } catch (err) {
      if (!mountedRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }, [packageManager]);

  useEffect(() => {
    void scan();
  }, [scan]);

  const startInstall = useCallback(async () => {
    setPhase('installing');
    const res = await packageManager.installMissingPackages(undefined, (p) => {
      if (mountedRef.current) setProgress(p);
    });
    if (!mountedRef.current) return;
    setResult(res);
    const refreshed = await packageManager.getPackageStatuses();
    if (!mountedRef.current) return;
    setStatuses(refreshed);
    onPackagesUpdatedRef.current(
      refreshed.filter((p) => p.installed).map((p) => p.name),
      refreshed.filter((p) => !p.installed).map((p) => p.name),
    );
    if (res.success) {
      setPhase('success');
    } else {
      setErrorMsg(res.error ?? 'Some packages failed to install.');
      setPhase('error');
    }
  }, [packageManager]);

  const twoCol = columns < 100 || pageHeight < 28;
  const half = Math.ceil(statuses.length / 2);
  const tableRows: Array<{ left: PackageStatusInfo; right?: PackageStatusInfo }> = twoCol
    ? Array.from({ length: half }, (_, i) => ({ left: statuses[i]!, right: statuses[i + half] }))
    : statuses.map((left) => ({ left }));
  const rowsPerPage = Math.max(4, pageHeight - 11);
  const totalPages = Math.max(1, Math.ceil(tableRows.length / rowsPerPage));
  const safePage = Math.min(pageIdx, totalPages - 1);
  const visibleRows = tableRows.slice(safePage * rowsPerPage, (safePage + 1) * rowsPerPage);

  useInput((input, key) => {
    if (phase === 'loading') {
      if (key.escape || input.toLowerCase() === 'b') {
        onBack();
      }
      return;
    }

    if (phase === 'review') {
      if (key.escape || input.toLowerCase() === 'b') {
        onBack();
        return;
      }
      if (input.toLowerCase() === 'r') {
        void scan();
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
      if (key.return || input.toLowerCase() === 'i') {
        const missing = statuses.filter((p) => !p.installed);
        if (missing.length === 0) {
          onBack();
        } else {
          setPhase('confirm');
        }
      }
    } else if (phase === 'success') {
      if (key.return || key.escape || input.toLowerCase() === 'b') {
        onBack();
      }
    }
  });

  const handleErrorAction = (action: ErrorAction): void => {
    if (action === 'retry') {
      void startInstall();
    } else if (action === 'back') {
      onBack();
    } else {
      onExit();
    }
  };

  const missingPkgs = statuses.filter((p) => !p.installed);
  const installedPkgs = statuses.filter((p) => p.installed);

  return (
    <Box flexDirection="column" paddingX={1} height={pageHeight} justifyContent="space-between">
      <Box flexDirection="column">
        <ScreenHeader
          title="Mode B: Preinstall Required Packages"
          badgeText={statuses.length > 0 ? `${installedPkgs.length}/${statuses.length} installed` : 'CHECKING'}
          badgeColor={missingPkgs.length === 0 && statuses.length > 0 ? 'green' : 'yellow'}
        />

        {prereq && (
          <Box justifyContent="space-between" paddingX={1} height={1}>
            <Text>
              <Text color={prereq.isRoot ? 'green' : 'red'}>● Root: {prereq.isRoot ? 'OK' : 'MISSING (sudo required)'}</Text>
              {'  '}
              <Text color={prereq.aptAvailable ? 'green' : 'red'}>● APT: {prereq.aptAvailable ? 'OK' : 'MISSING'}</Text>
              {'  '}
              <Text color={prereq.hasInternet ? 'green' : 'yellow'}>
                ● Network: {prereq.hasInternet ? 'REACHABLE' : 'CHECK MIRROR'}
              </Text>
            </Text>
            {totalPages > 1 && phase === 'review' && (
              <Text color="cyan">
                Page {safePage + 1}/{totalPages}
              </Text>
            )}
          </Box>
        )}

        {phase === 'loading' && (
          <Box marginTop={1}>
            <ProgressBar percent={25} label="Checking installed packages and APT availability..." />
          </Box>
        )}

        {phase === 'review' && statuses.length > 0 && (
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
                  {'Package'.padEnd(20)} {'Status'.padEnd(11)} Description
                </Text>
                {visibleRows.map((row) => (
                  <Box key={row.left.name} height={1}>
                    <Text>{row.left.name.padEnd(20)} </Text>
                    <Text bold color={row.left.installed ? 'green' : 'yellow'}>
                      {(row.left.installed ? 'INSTALLED' : 'MISSING').padEnd(11)}
                    </Text>
                    <Text dimColor> {row.left.description}</Text>
                  </Box>
                ))}
              </>
            )}
          </Box>
        )}

        {phase === 'confirm' && (
          <Confirmation
            title="Install Missing Required Packages"
            message={[
              `Already installed (will skip): ${installedPkgs.length} package(s)`,
              `Missing to install via apt-get (${missingPkgs.length}): ${missingPkgs.map((p) => p.name).join(', ')}`,
              !prereq?.isRoot
                ? 'Warning: Not running as root — installation will fail unless restarted with sudo.'
                : 'Packages will be installed non-interactively and verified via dpkg-query.',
            ]}
            confirmLabel="Install Missing Packages"
            cancelLabel="Back"
            onConfirm={() => void startInstall()}
            onCancel={() => setPhase('review')}
          />
        )}

        {phase === 'installing' && progress && (
          <Box flexDirection="column" marginTop={1}>
            <ProgressBar
              percent={progress.totalCount > 0 ? (progress.completedCount / progress.totalCount) * 100 : 10}
              label={progress.message}
            />
          </Box>
        )}

        {phase === 'success' && result && (
          <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={2} marginTop={1}>
            <Text bold color="green">
              ✔ Package preinstallation complete and verified!
            </Text>
            <Text>
              Installed: {result.installed.length} • Skipped (already installed): {result.skipped.length} • Verified: {result.verified.length}
            </Text>
            <Text dimColor>Press Enter or Esc to return to the Main Menu.</Text>
          </Box>
        )}

        {phase === 'error' && (
          <ErrorScreen
            title="Package Preinstallation Error"
            message={errorMsg}
            details={result?.failed.map((f) => `${f.name}: ${f.reason}`) ?? prereq?.errors ?? []}
            recoveryInstructions={[
              'Ensure this program is started with root privileges (`sudo ./ubuntu-fileserver`).',
              'Verify `/etc/apt/sources.list` or `/etc/apt/sources.list.d/` and network connectivity.',
              'Select Retry to re-attempt installation of missing packages without losing progress.',
            ]}
            onAction={handleErrorAction}
          />
        )}
      </Box>

      <Box flexDirection="column" height={2} paddingX={1}>
        {phase === 'review' && missingPkgs.length === 0 && (
          <Text bold color="green">
            ✔ All {statuses.length} required packages are already installed. Press Enter or Esc to return to Main Menu.
          </Text>
        )}
        {phase === 'review' && missingPkgs.length > 0 && (
          <>
            <Text color="yellow">
              Missing ({missingPkgs.length}): {missingPkgs.map((p) => p.name).join(', ').slice(0, columns - 18)}
            </Text>
            <Text dimColor>
              Press [Enter] or [I] to install missing packages • {totalPages > 1 ? '[←/→] Page • ' : ''}[R] Refresh • [B/Esc] Main Menu
            </Text>
          </>
        )}
        {phase === 'loading' && <Text dimColor>[B/Esc] Main Menu</Text>}
      </Box>
    </Box>
  );
};
