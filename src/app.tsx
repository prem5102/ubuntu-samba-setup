import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { MainMenu, type MainMenuChoice } from './components/MainMenu.js';
import { ProgressBar } from './components/ProgressBar.js';
import { useTerminalSize } from './components/useTerminalSize.js';
import { systemCommandExecutor } from './modules/commandExecutor.js';
import { logEvent } from './modules/logger.js';
import type { PackageManager } from './modules/packageManager.js';
import { ActiveDirectoryConfig } from './screens/ActiveDirectoryConfig.js';
import { DiskSelection } from './screens/DiskSelection.js';
import { FinalSummary } from './screens/FinalSummary.js';
import { HostnameConfig } from './screens/HostnameConfig.js';
import { LogViewer } from './screens/LogViewer.js';
import { LVMConfig } from './screens/LVMConfig.js';
import { MountConfig } from './screens/MountConfig.js';
import { PackageMenu } from './screens/PackageMenu.js';
import { PackagePreinstall } from './screens/PackagePreinstall.js';
import { PostSambaNext } from './screens/PostSambaNext.js';
import { SambaConfig } from './screens/SambaConfig.js';
import {
  getNextIncompleteStage,
  hasResumableProgress,
  resetStateFromStage,
  revalidateStateAgainstSystem,
  updateStageStatus,
} from './state/installationState.js';
import {
  createInitialInstallationState,
  loadInstallationState,
  saveInstallationState,
} from './state/persistence.js';
import type {
  ActiveDirectoryPersistedConfig,
  ConfiguredMountEntry,
  InstallationState,
  LvmExecutionResult,
  MountExecutionResult,
  SambaApplyResult,
  SambaShareConfig,
  ScreenId,
  StageId,
  VerificationReport,
} from './types/index.js';

function stageToScreen(stage: StageId): ScreenId {
  switch (stage) {
    case 'packages':
      return 'package_menu';
    case 'hostname':
      return 'hostname_config';
    case 'active_directory':
      return 'ad_config';
    case 'disk_selection':
      return 'disk_selection';
    case 'lvm':
      return 'lvm_config';
    case 'mount':
      return 'mount_config';
    case 'samba':
      return 'samba_config';
    case 'verification':
      return 'final_summary';
  }
}

function getConfiguredMountsList(state: InstallationState): ConfiguredMountEntry[] {
  const map = new Map<string, ConfiguredMountEntry>();
  for (const m of state.configuredMounts ?? []) {
    if (m.mounted && m.mountPoint) {
      map.set(m.mountPoint, m);
    }
  }
  if (state.mount?.mounted && state.mount.mountPoint) {
    map.set(state.mount.mountPoint, state.mount);
  }
  return Array.from(map.values());
}

class TuiErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset: () => void },
  { hasError: boolean; errorMsg: string }
> {
  constructor(props: { children: React.ReactNode; onReset: () => void }) {
    super(props);
    this.state = { hasError: false, errorMsg: '' };
  }

  static getDerivedStateFromError(error: Error): { hasError: boolean; errorMsg: string } {
    return { hasError: true, errorMsg: error.message };
  }

  override componentDidCatch(error: Error): void {
    logEvent('error', 'tui', 'Caught unexpected UI render exception', { error: error.message });
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
          <Text bold color="red">
            Recoverable UI Error: {this.state.errorMsg}
          </Text>
          <Text>Press Ctrl+C to exit safely; your progress is preserved on disk.</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}

export interface AppProps {
  initialStateOverride?: InstallationState;
  packageManagerOverride?: PackageManager;
}

export const App: React.FC<AppProps> = ({ initialStateOverride, packageManagerOverride }) => {
  const { exit } = useApp();
  const { columns, pageHeight } = useTerminalSize();
  const [screen, setScreen] = useState<ScreenId>('main_menu');
  const [packageMode, setPackageMode] = useState<'check_only' | 'auto_install'>('check_only');
  const [state, setState] = useState<InstallationState>(() => initialStateOverride ?? createInitialInstallationState());
  const stateRef = useRef(state);
  stateRef.current = state;
  const [loaded, setLoaded] = useState<boolean>(Boolean(initialStateOverride));
  const [isRoot, setIsRoot] = useState<boolean>(false);
  const [statusNotice, setStatusNotice] = useState<string | undefined>();
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    const init = async (): Promise<void> => {
      const [rootOk, persisted] = await Promise.all([
        systemCommandExecutor.isRoot(),
        initialStateOverride ? Promise.resolve(null) : loadInstallationState(),
      ]);
      setIsRoot(rootOk);
      if (persisted) {
        setState(persisted);
      }
      setLoaded(true);
      logEvent('info', 'app', 'Application initialized', { isRoot: rootOk });
    };
    void init();
  }, [initialStateOverride]);

  const commitState = useCallback((updater: (prev: InstallationState) => InstallationState) => {
    setState((prev) => {
      const next = updater(prev);
      stateRef.current = next;
      void saveInstallationState(next);
      return next;
    });
  }, []);

  const handleExit = useCallback(async () => {
    await saveInstallationState(stateRef.current);
    logEvent('info', 'app', 'Application exiting cleanly');
    exit();
  }, [exit]);

  // Graceful Ctrl+C save & exit
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      void handleExit();
    }
  });

  const handleMenuSelect = async (choice: MainMenuChoice): Promise<void> => {
    setStatusNotice(undefined);

    if (choice === 'start_complete') {
      setPackageMode('auto_install');
      await commitState((prev) => ({
        ...prev,
        workflowActive: true,
        currentStage: 'packages',
        stages: {
          ...prev.stages,
          packages:
            prev.stages.packages.status === 'completed'
              ? prev.stages.packages
              : { status: 'in_progress', updatedAt: new Date().toISOString() },
        },
      }));
      setScreen('package_menu');
      return;
    }

    if (choice === 'preinstall_packages') {
      setScreen('package_preinstall');
      return;
    }

    if (choice === 'check_packages') {
      setPackageMode('check_only');
      setScreen('package_menu');
      return;
    }

    if (choice === 'resume') {
      if (!hasResumableProgress(state)) {
        setStatusNotice('No saved incomplete configuration found. Starting complete configuration from Stage 1.');
        setPackageMode('auto_install');
        setScreen('package_menu');
        return;
      }

      setResuming(true);
      const reval = await revalidateStateAgainstSystem(state);
      setResuming(false);
      await commitState(() => ({ ...reval.state, workflowActive: true }));

      if (reval.adjustments.length > 0) {
        setStatusNotice(`Revalidated state: ${reval.adjustments.join(' ')}`);
      }

      const target = reval.resumeStage ?? getNextIncompleteStage(reval.state);
      if (target === 'packages') setPackageMode('auto_install');
      setScreen(stageToScreen(target));
      return;
    }

    if (choice === 'view_logs') {
      setScreen('log_viewer');
      return;
    }

    if (choice === 'exit') {
      await handleExit();
    }
  };

  if (!loaded || resuming) {
    return (
      <Box flexDirection="column" padding={1}>
        <ProgressBar
          percent={50}
          label={resuming ? 'Revalidating live system state before resuming...' : 'Loading persisted configuration state...'}
        />
      </Box>
    );
  }

  const configuredMounts = getConfiguredMountsList(state);
  const configuredMountPoints = configuredMounts.map((m) => m.mountPoint);

  return (
    <TuiErrorBoundary onReset={() => setScreen('main_menu')}>
      <Box flexDirection="column" width={columns} height={pageHeight}>
        {statusNotice && (
          <Box marginX={1} borderStyle="single" borderColor="yellow" paddingX={1} height={3}>
            <Text color="yellow">ℹ {statusNotice}</Text>
          </Box>
        )}

        {screen === 'main_menu' && (
          <MainMenu state={state} isRoot={isRoot} onSelect={(c) => void handleMenuSelect(c)} />
        )}

        {screen === 'package_menu' && (
          <PackageMenu
            mode={packageMode}
            packageManager={packageManagerOverride}
            onCompleteAutoInstall={(installed, missing) => {
              commitState((prev) => {
                const updated: InstallationState = {
                  ...prev,
                  packages: {
                    checkedAt: new Date().toISOString(),
                    allMandatoryInstalled: missing.length === 0,
                    installedPackages: installed,
                    missingPackages: missing,
                  },
                };
                return updateStageStatus(updated, 'packages', 'completed', 'All mandatory packages installed and verified.');
              });
              setScreen('hostname_config');
            }}
            onSwitchToPreinstall={() => setScreen('package_preinstall')}
            onBack={() => setScreen('main_menu')}
            onExit={() => void handleExit()}
          />
        )}

        {screen === 'package_preinstall' && (
          <PackagePreinstall
            packageManager={packageManagerOverride}
            onPackagesUpdated={(installed, missing) => {
              commitState((prev) => {
                const updated: InstallationState = {
                  ...prev,
                  packages: {
                    checkedAt: new Date().toISOString(),
                    allMandatoryInstalled: missing.length === 0,
                    installedPackages: installed,
                    missingPackages: missing,
                  },
                };
                return missing.length === 0
                  ? updateStageStatus(updated, 'packages', 'completed', 'Preinstalled and verified.')
                  : updated;
              });
            }}
            onBack={() => setScreen('main_menu')}
            onExit={() => void handleExit()}
          />
        )}

        {screen === 'hostname_config' && (
          <HostnameConfig
            initialHostname={state.hostname?.hostname}
            adDomain={state.activeDirectory?.domain}
            onComplete={(hostname, fqdn) => {
              void commitState((prev) =>
                updateStageStatus(
                  {
                    ...prev,
                    hostname: { hostname, fqdn, configured: true },
                  },
                  'hostname',
                  'completed',
                  `Configured ${hostname}`,
                ),
              );
              setScreen('ad_config');
            }}
            onBack={() => setScreen('main_menu')}
            onExit={() => void handleExit()}
          />
        )}

        {screen === 'ad_config' && (
          <ActiveDirectoryConfig
            initialConfig={state.activeDirectory}
            hostnameShort={state.hostname?.hostname}
            onComplete={(persisted: ActiveDirectoryPersistedConfig) => {
              void commitState((prev) =>
                updateStageStatus(
                  {
                    ...prev,
                    activeDirectory: persisted,
                  },
                  'active_directory',
                  'completed',
                  `Joined ${persisted.domain}`,
                ),
              );
              setScreen('disk_selection');
            }}
            onBack={() => setScreen('main_menu')}
            onExit={() => void handleExit()}
          />
        )}

        {screen === 'disk_selection' && (
          <DiskSelection
            key={`disk-${configuredMounts.length}`}
            initialSelected={state.disks.selectedDevices}
            onComplete={(selectedDevices, totalBytes) => {
              commitState((prev) => {
                const sameDisks =
                  prev.lvm &&
                  prev.lvm.pvCreated.length === selectedDevices.length &&
                  prev.lvm.pvCreated.every((d, idx) => d === selectedDevices[idx]);
                const base = sameDisks
                  ? prev
                  : resetStateFromStage(
                      {
                        ...prev,
                        lvm: undefined,
                        mount: undefined,
                      },
                      'lvm',
                    );
                return updateStageStatus(
                  {
                    ...base,
                    disks: { selectedDevices, totalBytes, confirmed: true },
                  },
                  'disk_selection',
                  'completed',
                  `Selected ${selectedDevices.length} disk(s)`,
                );
              });
              setScreen('lvm_config');
            }}
            onBack={() => setScreen('main_menu')}
            onExit={() => void handleExit()}
          />
        )}

        {screen === 'lvm_config' && (
          <LVMConfig
            key={`lvm-${state.disks.selectedDevices.join(',')}`}
            selectedDisks={state.disks.selectedDevices}
            totalBytes={state.disks.totalBytes}
            initialBaseName={state.lvm?.baseName}
            onComplete={(res: LvmExecutionResult) => {
              commitState((prev) => {
                const isNewLv = prev.mount?.lvDevicePath !== res.plan.lvDevicePath;
                const base = isNewLv
                  ? resetStateFromStage(
                      {
                        ...prev,
                        mount: undefined,
                      },
                      'mount',
                    )
                  : prev;
                return updateStageStatus(
                  {
                    ...base,
                    lvm: {
                      baseName: res.plan.baseName,
                      vgName: res.plan.vgName,
                      lvName: res.plan.lvName,
                      lvDevicePath: res.plan.lvDevicePath,
                      pvCreated: res.pvCreated,
                      vgCreated: res.vgCreated,
                      lvCreated: res.lvCreated,
                      wipeConfirmed: true,
                    },
                  },
                  'lvm',
                  'completed',
                  `Created ${res.plan.lvDevicePath}`,
                );
              });
              setScreen('mount_config');
            }}
            onBack={() => setScreen('main_menu')}
            onExit={() => void handleExit()}
          />
        )}

        {screen === 'mount_config' && (
          <MountConfig
            key={state.lvm?.lvDevicePath ?? state.mount?.lvDevicePath ?? 'mount'}
            lvDevicePath={state.lvm?.lvDevicePath ?? state.mount?.lvDevicePath ?? ''}
            initialMountPoint={
              state.mount?.lvDevicePath === state.lvm?.lvDevicePath && state.mount?.mountPoint
                ? state.mount.mountPoint
                : state.lvm?.baseName
                  ? `/data/${state.lvm.baseName}`
                  : '/data/fileserver'
            }
            initialXfsFormatted={false}
            initialUuid={undefined}
            onXfsReady={(uuid) => {
              void commitState((prev) => ({
                ...prev,
                mount: {
                  lvDevicePath: prev.lvm?.lvDevicePath ?? prev.mount?.lvDevicePath ?? '',
                  xfsFormatted: true,
                  uuid,
                  mountPoint: prev.mount?.mountPoint ?? '',
                  fstabUpdated: prev.mount?.fstabUpdated ?? false,
                  mounted: prev.mount?.mounted ?? false,
                },
              }));
            }}
            onComplete={(res: MountExecutionResult) => {
              commitState((prev) => {
                const newMountEntry: ConfiguredMountEntry = {
                  lvDevicePath: res.lvDevicePath,
                  vgName: prev.lvm?.vgName,
                  lvName: prev.lvm?.lvName,
                  xfsFormatted: true,
                  uuid: res.uuid,
                  mountPoint: res.mountPoint,
                  fstabUpdated: true,
                  mounted: true,
                };
                const existingMounts = getConfiguredMountsList(prev).filter(
                  (m) => m.mountPoint !== newMountEntry.mountPoint,
                );
                return updateStageStatus(
                  {
                    ...prev,
                    mount: newMountEntry,
                    configuredMounts: [...existingMounts, newMountEntry],
                  },
                  'mount',
                  'completed',
                  `Mounted ${res.mountPoint} (UUID=${res.uuid})`,
                );
              });
              setScreen('samba_config');
            }}
            onBack={() => setScreen('main_menu')}
            onExit={() => void handleExit()}
          />
        )}

        {screen === 'samba_config' && (
          <SambaConfig
            configuredMountPoints={configuredMountPoints}
            preferredMountPoint={state.mount?.mountPoint}
            existingShares={state.samba.shares}
            adConfig={state.activeDirectory}
            onComplete={(shares: SambaShareConfig[], applyRes: SambaApplyResult) => {
              commitState((prev) =>
                updateStageStatus(
                  {
                    ...prev,
                    samba: {
                      shares,
                      testparmPassed: applyRes.testparmPassed,
                      servicesReloaded: applyRes.servicesReloaded,
                    },
                  },
                  'samba',
                  'completed',
                  `Configured ${shares.length} share(s)`,
                ),
              );
              setScreen('post_samba_next');
            }}
            onBack={() => setScreen('main_menu')}
            onExit={() => void handleExit()}
          />
        )}

        {screen === 'post_samba_next' && (
          <PostSambaNext
            configuredMounts={configuredMounts}
            shares={state.samba.shares}
            onConfigureAnotherDisk={() => {
              commitState((prev) => {
                const reset = resetStateFromStage(
                  {
                    ...prev,
                    disks: { selectedDevices: [], totalBytes: 0, confirmed: false },
                    lvm: undefined,
                    mount: undefined,
                  },
                  'disk_selection',
                );
                return updateStageStatus(reset, 'disk_selection', 'in_progress', 'Select another disk for Samba');
              });
              setScreen('disk_selection');
            }}
            onFinishVerification={() => setScreen('final_summary')}
            onReturnToMenu={() => setScreen('main_menu')}
            onExit={() => void handleExit()}
          />
        )}

        {screen === 'final_summary' && (
          <FinalSummary
            state={state}
            onReportGenerated={(report: VerificationReport) => {
              void commitState((prev) =>
                updateStageStatus(
                  {
                    ...prev,
                    verification: report,
                  },
                  'verification',
                  report.overallPassed ? 'completed' : 'failed',
                  report.overallPassed ? 'All checks passed' : 'Some verification checks require attention',
                ),
              );
            }}
            onReturnToMenu={() => setScreen('main_menu')}
            onExit={() => void handleExit()}
          />
        )}

        {screen === 'log_viewer' && <LogViewer onBack={() => setScreen('main_menu')} />}
      </Box>
    </TuiErrorBoundary>
  );
};
