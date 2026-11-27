import { systemCommandExecutor } from './commandExecutor.js';
import { logEvent } from './logger.js';
import type {
  CommandExecutor,
  PackageInstallProgress,
  PackageInstallResult,
  PackageStatusInfo,
  PrerequisiteCheckResult,
  RequiredPackageSpec,
} from '../types/index.js';

export const REQUIRED_PACKAGES: RequiredPackageSpec[] = [
  { name: 'samba', description: 'SMB/CIFS file, print, and login server', mandatory: true },
  { name: 'samba-common-bin', description: 'Samba common files used by server and client', mandatory: true },
  { name: 'samba-vfs-modules', description: 'Samba VFS plugins (acl_xattr, recycle trash)', mandatory: true },
  { name: 'winbind', description: 'Active Directory NSS/PAM/IDMAP daemon', mandatory: true },
  { name: 'libnss-winbind', description: 'Name Service Switch plugin for Winbind', mandatory: true },
  { name: 'libpam-winbind', description: 'Pluggable Authentication Module for Winbind', mandatory: true },
  { name: 'krb5-user', description: 'Kerberos V5 client utilities (kinit, klist)', mandatory: true },
  { name: 'realmd', description: 'AD / Kerberos realm discovery helper', mandatory: true },
  { name: 'adcli', description: 'Active Directory enrollment helper tools', mandatory: true },
  { name: 'lvm2', description: 'Linux Logical Volume Manager tools', mandatory: true },
  { name: 'xfsprogs', description: 'Utilities for managing XFS filesystems', mandatory: true },
  { name: 'acl', description: 'POSIX Access Control List utilities (setfacl/getfacl)', mandatory: true },
  { name: 'dnsutils', description: 'DNS lookup tools (dig, nslookup)', mandatory: true },
  { name: 'chrony', description: 'NTP time synchronization daemon for Kerberos', mandatory: true },
  { name: 'smbclient', description: 'Command-line SMB/CIFS client for testing', mandatory: true },
  { name: 'ldap-utils', description: 'OpenLDAP utilities for directory queries', mandatory: true },
  { name: 'tree', description: 'Recursive directory listing utility', mandatory: true },
  { name: 'telnet', description: 'TCP port connectivity and diagnostic client', mandatory: true },
  { name: 'plocate', description: 'Fast filesystem index and file locator', mandatory: true },
];

export class PackageManager {
  constructor(private readonly executor: CommandExecutor = systemCommandExecutor) {}

  async checkPrerequisites(): Promise<PrerequisiteCheckResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    const isRoot = await this.executor.isRoot();
    if (!isRoot) {
      errors.push('Root privileges are required to install APT packages. Run the application with sudo.');
    }

    const [hasAptGet, hasDpkgQuery, hasDpkg] = await Promise.all([
      this.executor.commandExists('apt-get'),
      this.executor.commandExists('dpkg-query'),
      this.executor.commandExists('dpkg'),
    ]);

    const aptAvailable = hasAptGet && hasDpkgQuery && hasDpkg;
    if (!aptAvailable) {
      errors.push('APT / dpkg utilities (apt-get, dpkg-query, dpkg) are not available on this system.');
    }

    let dpkgHealthy = true;
    if (aptAvailable) {
      const auditRes = await this.executor.run({ command: 'dpkg', args: ['--audit'] });
      if (auditRes.exitCode !== 0 || auditRes.stdout.trim().length > 0) {
        dpkgHealthy = false;
        warnings.push('dpkg reported interrupted package state; `dpkg --configure -a` may be needed.');
      }
    }

    // Check internet / APT mirror connectivity concurrently without relying on ICMP ping
    const connectivityHosts = [
      { host: 'archive.ubuntu.com', port: 80 },
      { host: 'security.ubuntu.com', port: 80 },
      { host: '1.1.1.1', port: 443 },
    ];
    const probeResults = await Promise.all(
      connectivityHosts.map((target) => this.executor.checkTcp(target.host, target.port, 1500)),
    );
    const hasInternet = probeResults.some(Boolean);
    if (!hasInternet) {
      warnings.push('Could not reach archive.ubuntu.com or 1.1.1.1 over TCP; offline APT mirrors may still work.');
    }

    return {
      isRoot,
      hasInternet,
      aptAvailable,
      dpkgHealthy,
      errors,
      warnings,
    };
  }

  async getPackageStatuses(): Promise<PackageStatusInfo[]> {
    const names = REQUIRED_PACKAGES.map((p) => p.name);
    const installedMap = new Map<string, { installed: boolean; version?: string }>();

    const queryRes = await this.executor.run({
      command: 'dpkg-query',
      args: ['-W', '-f=${Package}\t${db:Status-Abbrev}\t${Version}\n', ...names],
    });

    const lines = queryRes.stdout.split('\n').filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const [pkgName, statusAbbrev, version] = line.split('\t');
      if (!pkgName) continue;
      const isInstalled = Boolean(statusAbbrev && statusAbbrev.startsWith('ii'));
      installedMap.set(pkgName.trim(), {
        installed: isInstalled,
        version: isInstalled ? version?.trim() : undefined,
      });
    }

    return REQUIRED_PACKAGES.map((spec) => {
      const status = installedMap.get(spec.name);
      return {
        name: spec.name,
        description: spec.description,
        mandatory: spec.mandatory,
        installed: status?.installed ?? false,
        version: status?.version,
      };
    });
  }

  async installMissingPackages(
    requestedPackages?: string[],
    onProgress?: (progress: PackageInstallProgress) => void,
  ): Promise<PackageInstallResult> {
    const emit = (progress: PackageInstallProgress): void => {
      onProgress?.(progress);
    };

    emit({
      phase: 'checking',
      completedCount: 0,
      totalCount: REQUIRED_PACKAGES.length,
      message: 'Checking root privileges, APT availability, and installed packages...',
    });

    const prereq = await this.checkPrerequisites();
    if (!prereq.isRoot || !prereq.aptAvailable) {
      const error = prereq.errors.join(' ');
      logEvent('error', 'packageManager', 'Package prerequisite check failed', { prereq });
      emit({
        phase: 'error',
        completedCount: 0,
        totalCount: REQUIRED_PACKAGES.length,
        message: error,
      });
      return {
        success: false,
        installed: [],
        skipped: [],
        failed: [],
        verified: [],
        error,
      };
    }

    const currentStatuses = await this.getPackageStatuses();
    const allowedSet = requestedPackages ? new Set(requestedPackages) : null;
    const skipped: string[] = [];
    const missing: string[] = [];

    for (const pkg of currentStatuses) {
      if (allowedSet && !allowedSet.has(pkg.name)) continue;
      if (pkg.installed) {
        skipped.push(pkg.name);
      } else {
        missing.push(pkg.name);
      }
    }

    if (missing.length === 0) {
      emit({
        phase: 'done',
        completedCount: currentStatuses.length,
        totalCount: currentStatuses.length,
        message: 'All required packages are already installed.',
      });
      return {
        success: true,
        installed: [],
        skipped,
        failed: [],
        verified: skipped,
      };
    }

    if (!prereq.hasInternet) {
      logEvent('warn', 'packageManager', 'Proceeding with apt-get update despite TCP internet probe warning');
    }

    emit({
      phase: 'apt_update',
      completedCount: 0,
      totalCount: missing.length,
      message: 'Running apt-get update...',
    });

    const aptEnv = {
      DEBIAN_FRONTEND: 'noninteractive',
      NEEDRESTART_MODE: 'a',
    };

    const updateRes = await this.executor.run({
      command: 'apt-get',
      args: ['update', '-qq'],
      env: aptEnv,
      timeoutMs: 180_000,
    });

    if (updateRes.exitCode !== 0) {
      const error = `apt-get update failed (exit ${updateRes.exitCode}): ${updateRes.stderr.trim() || updateRes.stdout.trim() || 'Network or APT repository unreachable.'}`;
      logEvent('error', 'packageManager', error);
      emit({
        phase: 'error',
        completedCount: 0,
        totalCount: missing.length,
        message: error,
      });
      return {
        success: false,
        installed: [],
        skipped,
        failed: missing.map((name) => ({ name, reason: 'apt-get update failed' })),
        verified: [],
        error,
      };
    }

    const installed: string[] = [];
    const failed: Array<{ name: string; reason: string }> = [];

    for (let idx = 0; idx < missing.length; idx += 1) {
      const pkgName = missing[idx]!;
      emit({
        phase: 'installing',
        currentPackage: pkgName,
        completedCount: idx,
        totalCount: missing.length,
        message: `Installing ${pkgName} (${idx + 1}/${missing.length})...`,
      });

      const installRes = await this.executor.run({
        command: 'apt-get',
        args: [
          'install',
          '-y',
          '-o',
          'Dpkg::Options::=--force-confdef',
          '-o',
          'Dpkg::Options::=--force-confold',
          pkgName,
        ],
        env: aptEnv,
        timeoutMs: 300_000,
      });

      if (installRes.exitCode === 0) {
        installed.push(pkgName);
      } else {
        const reason = installRes.stderr.trim() || installRes.stdout.trim() || `Exit code ${installRes.exitCode}`;
        failed.push({ name: pkgName, reason: reason.slice(0, 300) });
        logEvent('error', 'packageManager', `Failed to install package ${pkgName}`, {
          package: pkgName,
          exitCode: installRes.exitCode,
          reason,
        });
      }
    }

    emit({
      phase: 'verifying',
      completedCount: missing.length,
      totalCount: missing.length,
      message: 'Verifying installed packages via dpkg-query...',
    });

    const postStatuses = await this.getPackageStatuses();
    const postMap = new Map(postStatuses.map((p) => [p.name, p]));
    const verified: string[] = [];

    for (const pkgName of [...skipped, ...installed]) {
      const status = postMap.get(pkgName);
      if (status?.installed) {
        verified.push(pkgName);
      } else if (!failed.some((f) => f.name === pkgName)) {
        failed.push({ name: pkgName, reason: 'Package did not verify as installed in dpkg-query.' });
      }
    }

    const mandatoryMissing = postStatuses.filter((p) => p.mandatory && !p.installed);
    const success = failed.length === 0 && mandatoryMissing.length === 0;

    emit({
      phase: success ? 'done' : 'error',
      completedCount: missing.length,
      totalCount: missing.length,
      message: success
        ? `Verified ${verified.length} required packages.`
        : `Package installation completed with ${failed.length} failure(s).`,
    });

    logEvent(success ? 'info' : 'warn', 'packageManager', 'Package installation run completed', {
      installed,
      skipped,
      failed,
      verifiedCount: verified.length,
    });

    return {
      success,
      installed,
      skipped,
      failed,
      verified,
      error: success ? undefined : `Failed packages: ${failed.map((f) => f.name).join(', ')}`,
    };
  }
}
