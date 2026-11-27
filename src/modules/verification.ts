import path from 'node:path';
import { systemCommandExecutor, systemFileSystem } from './commandExecutor.js';
import { logEvent, resolveAppPaths } from './logger.js';
import { PackageManager } from './packageManager.js';
import type {
  CommandExecutor,
  FileSystemAdapter,
  InstallationState,
  VerificationCheckItem,
  VerificationReport,
} from '../types/index.js';

export class VerificationManager {
  constructor(
    private readonly executor: CommandExecutor = systemCommandExecutor,
    private readonly fs: FileSystemAdapter = systemFileSystem,
    private readonly packageManager: PackageManager = new PackageManager(systemCommandExecutor),
  ) {}

  async runFullVerification(state: InstallationState): Promise<VerificationReport> {
    const checks: VerificationCheckItem[] = [];

    // --- SYSTEM ---
    const hostRes = await this.executor.run({ command: 'hostname', args: ['-f'] });
    const actualHost = hostRes.stdout.trim();
    checks.push({
      category: 'System',
      name: 'Hostname',
      passed: hostRes.exitCode === 0 && actualHost.length > 0,
      detail: actualHost || hostRes.stderr.trim() || 'Unable to read hostname',
    });

    if (state.activeDirectory?.domain && state.activeDirectory?.dcIp) {
      const digRes = await this.executor.run({
        command: 'dig',
        args: ['+short', '+time=3', state.activeDirectory.domain, 'A'],
      });
      const tcpOk = await this.executor.checkTcp(state.activeDirectory.dcIp, 389, 3000);
      checks.push({
        category: 'System',
        name: 'DNS Resolution',
        passed: digRes.exitCode === 0 && digRes.stdout.trim().length > 0,
        detail: digRes.stdout.trim().split('\n')[0] || 'DNS query returned no A record',
      });
      checks.push({
        category: 'System',
        name: 'Network Connectivity (DC)',
        passed: tcpOk,
        detail: tcpOk ? `TCP 389 reachable at ${state.activeDirectory.dcIp}` : `Unable to reach ${state.activeDirectory.dcIp}:389`,
      });
    }

    const pkgStatuses = await this.packageManager.getPackageStatuses();
    const missingPkgs = pkgStatuses.filter((p) => p.mandatory && !p.installed).map((p) => p.name);
    checks.push({
      category: 'System',
      name: 'Required Packages',
      passed: missingPkgs.length === 0,
      detail: missingPkgs.length === 0 ? `All ${pkgStatuses.length} mandatory packages installed` : `Missing: ${missingPkgs.join(', ')}`,
    });

    // --- ACTIVE DIRECTORY ---
    const testjoinRes = await this.executor.run({ command: 'net', args: ['ads', 'testjoin'] });
    checks.push({
      category: 'Active Directory',
      name: 'Domain Membership',
      passed: testjoinRes.exitCode === 0,
      detail: testjoinRes.stdout.trim() || testjoinRes.stderr.trim() || 'Not joined',
    });

    const krbExists = await this.fs.exists('/etc/krb5.conf');
    const krbContent = krbExists ? await this.fs.readText('/etc/krb5.conf') : '';
    const expectedRealm = state.activeDirectory?.domain?.toUpperCase() ?? '';
    checks.push({
      category: 'Active Directory',
      name: 'Kerberos Configuration',
      passed: krbExists && (expectedRealm === '' || krbContent.includes(expectedRealm)),
      detail: krbExists ? `/etc/krb5.conf configured${expectedRealm ? ` for ${expectedRealm}` : ''}` : '/etc/krb5.conf missing',
    });

    const wbTrust = await this.executor.run({ command: 'wbinfo', args: ['-t'] });
    checks.push({
      category: 'Active Directory',
      name: 'Winbind Trust Secret',
      passed: wbTrust.exitCode === 0,
      detail: wbTrust.stdout.trim() || wbTrust.stderr.trim() || 'wbinfo -t failed',
    });

    const wbUsers = await this.executor.run({ command: 'wbinfo', args: ['-u'] });
    const userCount = wbUsers.stdout.split('\n').filter((l) => l.trim().length > 0).length;
    checks.push({
      category: 'Active Directory',
      name: 'AD Users Enumeration',
      passed: wbUsers.exitCode === 0 && userCount > 0,
      detail: wbUsers.exitCode === 0 ? `${userCount} AD user(s) visible via Winbind` : wbUsers.stderr.trim(),
    });

    const wbGroups = await this.executor.run({ command: 'wbinfo', args: ['-g'] });
    const groupCount = wbGroups.stdout.split('\n').filter((l) => l.trim().length > 0).length;
    checks.push({
      category: 'Active Directory',
      name: 'AD Groups Enumeration',
      passed: wbGroups.exitCode === 0 && groupCount > 0,
      detail: wbGroups.exitCode === 0 ? `${groupCount} AD group(s) visible via Winbind` : wbGroups.stderr.trim(),
    });

    // --- STORAGE ---
    const pvsRes = await this.executor.run({ command: 'pvs', args: ['--noheadings', '-o', 'pv_name,vg_name'] });
    checks.push({
      category: 'Storage',
      name: 'Physical Volumes',
      passed: pvsRes.exitCode === 0 && pvsRes.stdout.trim().length > 0,
      detail: pvsRes.stdout.trim().replace(/\s+/g, ' ') || 'No PVs detected',
    });

    const vgName = state.lvm?.vgName;
    const vgsRes = await this.executor.run({ command: 'vgs', args: ['--noheadings', '-o', 'vg_name,vg_size', ...(vgName ? [vgName] : [])] });
    checks.push({
      category: 'Storage',
      name: 'Volume Group',
      passed: vgsRes.exitCode === 0 && vgsRes.stdout.trim().length > 0,
      detail: vgsRes.stdout.trim().replace(/\s+/g, ' ') || 'VG not found',
    });

    const lvPath = state.lvm?.lvDevicePath ?? state.mount?.lvDevicePath;
    const lvsRes = await this.executor.run({ command: 'lvs', args: ['--noheadings', '-o', 'lv_path,lv_size', ...(lvPath ? [lvPath] : [])] });
    checks.push({
      category: 'Storage',
      name: 'Logical Volume',
      passed: lvsRes.exitCode === 0 && lvsRes.stdout.trim().length > 0,
      detail: lvsRes.stdout.trim().replace(/\s+/g, ' ') || 'LV not found',
    });

    const mountsToVerify =
      state.configuredMounts && state.configuredMounts.length > 0
        ? state.configuredMounts
        : state.mount
          ? [state.mount]
          : [];

    for (const mnt of mountsToVerify) {
      const mntLvPath = mnt.lvDevicePath;
      if (mntLvPath) {
        const fstypeRes = await this.executor.run({ command: 'blkid', args: ['-s', 'TYPE', '-o', 'value', mntLvPath] });
        const uuidRes = await this.executor.run({ command: 'blkid', args: ['-s', 'UUID', '-o', 'value', mntLvPath] });
        const fstype = fstypeRes.stdout.trim();
        const uuid = uuidRes.stdout.trim();
        checks.push({
          category: 'Storage',
          name: `XFS & UUID (${mnt.mountPoint})`,
          passed: fstype === 'xfs' && uuid.length > 0,
          detail: `lv=${mntLvPath}, type=${fstype || 'none'}, uuid=${uuid || 'none'}`,
        });
      }

      if (mnt.mountPoint) {
        const findmntRes = await this.executor.run({ command: 'findmnt', args: ['--noheadings', '--target', mnt.mountPoint] });
        checks.push({
          category: 'Storage',
          name: `Mount Point (${mnt.mountPoint})`,
          passed: findmntRes.exitCode === 0 && findmntRes.stdout.trim().length > 0,
          detail: findmntRes.stdout.trim().replace(/\s+/g, ' ') || `${mnt.mountPoint} not mounted`,
        });

        const fstabExists = await this.fs.exists('/etc/fstab');
        const fstabText = fstabExists ? await this.fs.readText('/etc/fstab') : '';
        const hasUuidEntry = Boolean(mnt.uuid && fstabText.includes(`UUID=${mnt.uuid}`) && fstabText.includes(mnt.mountPoint));
        checks.push({
          category: 'Storage',
          name: `/etc/fstab UUID (${mnt.mountPoint})`,
          passed: hasUuidEntry,
          detail: hasUuidEntry ? `UUID=${mnt.uuid} -> ${mnt.mountPoint}` : `Missing UUID entry for ${mnt.mountPoint} in /etc/fstab`,
        });
      }
    }

    // --- SAMBA ---
    const testparmRes = await this.executor.run({ command: 'testparm', args: ['-s'] });
    checks.push({
      category: 'Samba',
      name: 'Samba Configuration (testparm)',
      passed: testparmRes.exitCode === 0,
      detail: testparmRes.exitCode === 0 ? 'smb.conf syntax and parameters valid' : testparmRes.stderr.trim(),
    });

    const smbdActive = await this.executor.run({ command: 'systemctl', args: ['is-active', 'smbd'] });
    const winbindActive = await this.executor.run({ command: 'systemctl', args: ['is-active', 'winbind'] });
    checks.push({
      category: 'Samba',
      name: 'Samba Services',
      passed: smbdActive.exitCode === 0 && winbindActive.exitCode === 0,
      detail: `smbd=${smbdActive.stdout.trim() || 'inactive'}, winbind=${winbindActive.stdout.trim() || 'inactive'}`,
    });

    for (const share of state.samba.shares) {
      const dirOk = await this.fs.isDirectory(share.sharePath);
      const aclRes = await this.executor.run({ command: 'getfacl', args: ['-p', share.sharePath] });
      const hasOtherNone = aclRes.stdout.includes('other::---');
      const trashLabel = (share.trashEnabled ?? true) && share.accessMode === 'read_write' ? 'trash=on' : 'trash=off';
      checks.push({
        category: 'Samba',
        name: `Share [${share.name}] Path & ACLs`,
        passed: dirOk && aclRes.exitCode === 0 && hasOtherNone,
        detail: dirOk ? `${share.sharePath} (${share.accessMode}, ${trashLabel}, other::---=${hasOtherNone})` : `Directory missing: ${share.sharePath}`,
      });
    }

    const overallPassed = checks.every((c) => c.passed);
    const generatedAt = new Date().toISOString();
    const summaryText = this.formatReportText(state, checks, generatedAt, overallPassed);

    const report: VerificationReport = {
      generatedAt,
      overallPassed,
      checks,
      summaryText,
    };

    try {
      const reportPath = path.join(resolveAppPaths().logsDir, `final-report-${generatedAt.replace(/[:.]/g, '-')}.txt`);
      await this.fs.writeText(reportPath, summaryText, 0o600);
    } catch {
      // Non-fatal if report copy write fails
    }

    logEvent(overallPassed ? 'info' : 'warn', 'verification', 'Completed final system verification', {
      overallPassed,
      totalChecks: checks.length,
      failedChecks: checks.filter((c) => !c.passed).map((c) => c.name),
    });

    return report;
  }

  private formatReportText(
    state: InstallationState,
    checks: VerificationCheckItem[],
    generatedAt: string,
    overallPassed: boolean,
  ): string {
    const lines: string[] = [
      '====================================================================',
      'Ubuntu Server 24.04 File Server (AD + LVM + XFS + Samba) Report',
      `Generated: ${generatedAt}`,
      `Overall Status: ${overallPassed ? 'PASSED' : 'ATTENTION REQUIRED'}`,
      '====================================================================',
      '',
      'Configuration Summary (Sensitive credentials omitted):',
      `  Hostname:       ${state.hostname?.fqdn ?? state.hostname?.hostname ?? 'Not configured'}`,
      `  AD Domain:      ${state.activeDirectory?.domain ?? 'Not configured'}`,
      `  NetBIOS:        ${state.activeDirectory?.netbiosName ?? 'Not configured'}`,
      `  DC IP:          ${state.activeDirectory?.dcIp ?? 'Not configured'}`,
      `  LVM VG / LV:    ${state.lvm ? `${state.lvm.vgName} / ${state.lvm.lvName} (${state.lvm.lvDevicePath})` : 'Not configured'}`,
      `  Mount Point:    ${state.mount ? `${state.mount.mountPoint} (UUID=${state.mount.uuid})` : 'Not configured'}`,
      `  Samba Shares:   ${state.samba.shares.length}`,
      '',
      'Verification Checks:',
    ];

    for (const item of checks) {
      const badge = item.passed ? '[PASS]' : '[FAIL]';
      lines.push(`  ${badge} [${item.category}] ${item.name}: ${item.detail}`);
    }

    return `${lines.join('\n')}\n`;
  }
}
