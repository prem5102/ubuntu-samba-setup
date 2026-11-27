export type StageId =
  | 'packages'
  | 'hostname'
  | 'active_directory'
  | 'disk_selection'
  | 'lvm'
  | 'mount'
  | 'samba'
  | 'verification';

export type StageStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export type ScreenId =
  | 'main_menu'
  | 'package_menu'
  | 'package_preinstall'
  | 'hostname_config'
  | 'ad_config'
  | 'disk_selection'
  | 'lvm_config'
  | 'mount_config'
  | 'samba_config'
  | 'post_samba_next'
  | 'final_summary'
  | 'log_viewer';

export interface StageState {
  status: StageStatus;
  updatedAt: string;
  message?: string;
  error?: string;
}

export interface CommandOptions {
  command: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  cwd?: string;
  /** Positional indices in `args` whose values must be redacted in logs. */
  redactArgs?: number[];
  /** If true, stdout/stderr are not logged verbatim (e.g. ticket/keytab commands). */
  redactOutput?: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  command: string;
  args: string[];
  durationMs: number;
  errorMessage?: string;
}

export interface CommandExecutor {
  run(options: CommandOptions): Promise<CommandResult>;
  commandExists(binaryName: string): Promise<boolean>;
  isRoot(): Promise<boolean>;
  checkTcp(host: string, port: number, timeoutMs?: number): Promise<boolean>;
}

export interface FileSystemAdapter {
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  isSymlink(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string, mode?: number): Promise<void>;
  mkdir(path: string, mode?: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  copyFile(src: string, dest: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readlink(path: string): Promise<string>;
  statMode(path: string): Promise<number | null>;
  chmod(path: string, mode: number): Promise<void>;
}

export interface RequiredPackageSpec {
  name: string;
  description: string;
  mandatory: boolean;
}

export interface PackageStatusInfo {
  name: string;
  description: string;
  mandatory: boolean;
  installed: boolean;
  version?: string;
}

export interface PrerequisiteCheckResult {
  isRoot: boolean;
  hasInternet: boolean;
  aptAvailable: boolean;
  dpkgHealthy: boolean;
  errors: string[];
  warnings: string[];
}

export interface PackageInstallProgress {
  phase: 'checking' | 'apt_update' | 'installing' | 'verifying' | 'done' | 'error';
  currentPackage?: string;
  completedCount: number;
  totalCount: number;
  message: string;
}

export interface PackageInstallResult {
  success: boolean;
  installed: string[];
  skipped: string[];
  failed: Array<{ name: string; reason: string }>;
  verified: string[];
  error?: string;
}

export interface HostnameConfigInput {
  hostname: string;
  domain?: string;
}

export interface HostnameApplyResult {
  success: boolean;
  hostname: string;
  fqdn: string;
  backupSessionId?: string;
  verifiedHostname?: string;
  error?: string;
}

export interface ActiveDirectoryInput {
  domain: string;
  netbiosName: string;
  dcIp: string;
  username: string;
  /** Ephemeral password used only in-memory for kinit/join; never persisted or logged. */
  password: string;
}

export interface ActiveDirectoryPersistedConfig {
  domain: string;
  netbiosName: string;
  dcIp: string;
  username: string;
  dnsConfigured: boolean;
  kerberosConfigured: boolean;
  sambaAdsConfigured: boolean;
  nssConfigured: boolean;
  pamConfigured: boolean;
  joined: boolean;
  verified: boolean;
}

export interface DnsDiagnosticCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface DnsConfigResult {
  success: boolean;
  backend: 'netplan-resolved' | 'systemd-resolved' | 'networkmanager' | 'resolv-conf';
  backupSessionId?: string;
  checks: DnsDiagnosticCheck[];
  error?: string;
}

export interface AdJoinResult {
  success: boolean;
  backupSessionId?: string;
  checks: DnsDiagnosticCheck[];
  sampleUsers: string[];
  sampleGroups: string[];
  error?: string;
}

export interface BlockDeviceChild {
  name: string;
  path: string;
  type: string;
  sizeBytes: number;
  fstype: string | null;
  mountpoint: string | null;
  uuid: string | null;
}

export interface BlockDeviceInfo {
  name: string;
  path: string;
  type: string;
  model: string;
  serial: string;
  sizeBytes: number;
  sizeFormatted: string;
  readOnly: boolean;
  removable: boolean;
  fstype: string | null;
  mountpoint: string | null;
  pttype: string | null;
  isOsDisk: boolean;
  isLvmMember: boolean;
  isRaidMember: boolean;
  inUseByOtherStorage: boolean;
  hasPartitions: boolean;
  hasFilesystem: boolean;
  children: BlockDeviceChild[];
  eligible: boolean;
  exclusionReasons: string[];
}

export interface DiskDetectionResult {
  disks: BlockDeviceInfo[];
  eligibleDisks: BlockDeviceInfo[];
  excludedDisks: BlockDeviceInfo[];
  warnings: string[];
}

export interface LvmPlan {
  baseName: string;
  vgName: string;
  lvName: string;
  lvDevicePath: string;
  selectedDisks: string[];
  totalBytes: number;
}

export interface LvmExecutionResult {
  success: boolean;
  plan: LvmPlan;
  pvCreated: string[];
  vgCreated: boolean;
  lvCreated: boolean;
  error?: string;
  recoveryInstructions?: string[];
}

export interface XfsFormatResult {
  success: boolean;
  lvDevicePath: string;
  uuid?: string;
  alreadyFormatted?: boolean;
  existingFstype?: string;
  error?: string;
  recoveryInstructions?: string[];
}

export interface MountExecutionResult {
  success: boolean;
  mountPoint: string;
  lvDevicePath: string;
  uuid: string;
  fstabEntry: string;
  backupSessionId?: string;
  findmntVerified: boolean;
  dfOutput?: string;
  error?: string;
  recoveryInstructions?: string[];
}

export type AdIdentityKind = 'user' | 'group';

export interface ResolvedAdIdentity {
  input: string;
  normalized: string;
  kind: AdIdentityKind;
  sid: string;
  numericId: number;
}

export type ShareAccessMode = 'read_only' | 'read_write';

export interface SambaShareConfig {
  name: string;
  description: string;
  baseMountPoint: string;
  sharePath: string;
  accessMode: ShareAccessMode;
  trashEnabled?: boolean;
  readOnlyGroups: ResolvedAdIdentity[];
  readWriteGroups: ResolvedAdIdentity[];
  readOnlyUsers: ResolvedAdIdentity[];
  readWriteUsers: ResolvedAdIdentity[];
  createdAt: string;
}

export interface SambaApplyResult {
  success: boolean;
  backupSessionId?: string;
  testparmPassed: boolean;
  testparmOutput: string;
  servicesReloaded: boolean;
  aclOutputs: Array<{ shareName: string; sharePath: string; getfaclOutput: string }>;
  error?: string;
  recoveryInstructions?: string[];
}

export interface BackupFileRecord {
  originalPath: string;
  backupPath: string;
  existed: boolean;
  wasSymlink: boolean;
  symlinkTarget?: string;
  mode?: number;
}

export interface BackupManifest {
  sessionId: string;
  stage: StageId;
  createdAt: string;
  files: BackupFileRecord[];
}

export interface VerificationCheckItem {
  category: 'System' | 'Active Directory' | 'Storage' | 'Samba';
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationReport {
  generatedAt: string;
  overallPassed: boolean;
  checks: VerificationCheckItem[];
  summaryText: string;
}

export interface ConfiguredMountEntry {
  lvDevicePath: string;
  vgName?: string;
  lvName?: string;
  xfsFormatted: boolean;
  uuid: string;
  mountPoint: string;
  fstabUpdated: boolean;
  mounted: boolean;
}

export interface InstallationState {
  version: number;
  createdAt: string;
  updatedAt: string;
  currentStage: StageId;
  workflowActive: boolean;
  stages: Record<StageId, StageState>;
  packages: {
    checkedAt?: string;
    allMandatoryInstalled: boolean;
    installedPackages: string[];
    missingPackages: string[];
  };
  hostname?: {
    hostname: string;
    fqdn: string;
    configured: boolean;
  };
  activeDirectory?: ActiveDirectoryPersistedConfig;
  disks: {
    selectedDevices: string[];
    totalBytes: number;
    confirmed: boolean;
  };
  lvm?: {
    baseName: string;
    vgName: string;
    lvName: string;
    lvDevicePath: string;
    pvCreated: string[];
    vgCreated: boolean;
    lvCreated: boolean;
    wipeConfirmed: boolean;
  };
  mount?: ConfiguredMountEntry;
  configuredMounts?: ConfiguredMountEntry[];
  samba: {
    shares: SambaShareConfig[];
    testparmPassed: boolean;
    servicesReloaded: boolean;
  };
  verification?: VerificationReport;
}

export interface LogEntry {
  level: string;
  time: string;
  msg: string;
  module?: string;
  details?: Record<string, unknown>;
}
