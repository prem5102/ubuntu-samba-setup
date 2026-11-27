import path from 'node:path';
import { BackupManager } from './backup.js';
import { systemCommandExecutor, systemFileSystem } from './commandExecutor.js';
import { logEvent } from './logger.js';
import type { CommandExecutor, DnsConfigResult, DnsDiagnosticCheck, FileSystemAdapter } from '../types/index.js';
import { adDomainSchema, dcIpAddressSchema } from '../validation/schemas.js';
import { validateInput } from '../validation/retry.js';

export type DnsBackend = 'netplan-resolved' | 'systemd-resolved' | 'networkmanager' | 'resolv-conf';

export class DnsManager {
  constructor(
    private readonly executor: CommandExecutor = systemCommandExecutor,
    private readonly fs: FileSystemAdapter = systemFileSystem,
    private readonly backupManager: BackupManager = new BackupManager(systemFileSystem),
  ) {}

  async detectNetworkFilesToBackup(): Promise<string[]> {
    const files: string[] = ['/etc/resolv.conf', '/etc/systemd/resolved.conf', '/etc/systemd/resolved.conf.d/99-ubuntu-fileserver-ad.conf'];
    if (await this.fs.isDirectory('/etc/netplan')) {
      const entries = await this.fs.readdir('/etc/netplan');
      for (const entry of entries) {
        if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
          files.push(path.posix.join('/etc/netplan', entry));
        }
      }
    }
    return files;
  }

  async detectBackend(): Promise<DnsBackend> {
    const resolvedActive = await this.executor.run({ command: 'systemctl', args: ['is-active', 'systemd-resolved'] });
    const nmActive = await this.executor.run({ command: 'systemctl', args: ['is-active', 'NetworkManager'] });

    if (resolvedActive.exitCode === 0 && resolvedActive.stdout.trim() === 'active') {
      if (await this.fs.isDirectory('/etc/netplan')) {
        return 'netplan-resolved';
      }
      return 'systemd-resolved';
    }
    if (nmActive.exitCode === 0 && nmActive.stdout.trim() === 'active') {
      return 'networkmanager';
    }
    return 'resolv-conf';
  }

  async configureAdDns(domainInput: string, dcIpInput: string): Promise<DnsConfigResult> {
    const domVal = validateInput(adDomainSchema, domainInput);
    if (!domVal.success || !domVal.data) {
      return {
        success: false,
        backend: 'resolv-conf',
        checks: [],
        error: domVal.errorSummary ?? 'Invalid AD domain.',
      };
    }

    const ipVal = validateInput(dcIpAddressSchema, dcIpInput);
    if (!ipVal.success || !ipVal.data) {
      return {
        success: false,
        backend: 'resolv-conf',
        checks: [],
        error: ipVal.errorSummary ?? 'Invalid Domain Controller IP.',
      };
    }

    const domain = domVal.data;
    const dcIp = ipVal.data;

    if (!(await this.executor.isRoot())) {
      return {
        success: false,
        backend: 'resolv-conf',
        checks: [],
        error: 'Root privileges are required to configure system DNS.',
      };
    }

    const backend = await this.detectBackend();
    const filesToBackup = await this.detectNetworkFilesToBackup();
    const backup = await this.backupManager.createBackupSession('active_directory', filesToBackup);

    try {
      if (backend === 'netplan-resolved' || backend === 'systemd-resolved') {
        const isDotLocal = domain === 'local' || domain.endsWith('.local');
        const resolvedDomains = isDotLocal ? `~${domain} ~local ${domain}` : `~${domain} ${domain}`;
        const dropInLines = [
          '# Managed by ubuntu-fileserver for Active Directory DNS resolution',
          '[Resolve]',
          `DNS=${dcIp}`,
          `Domains=${resolvedDomains}`,
          ...(isDotLocal ? ['MulticastDNS=no'] : []),
          'DNSStubListener=yes',
          '',
        ];

        await this.fs.writeText('/etc/systemd/resolved.conf.d/99-ubuntu-fileserver-ad.conf', dropInLines.join('\n'), 0o644);

        const restartRes = await this.executor.run({
          command: 'systemctl',
          args: ['restart', 'systemd-resolved'],
        });
        if (restartRes.exitCode !== 0) {
          throw new Error(`Failed to restart systemd-resolved: ${restartRes.stderr.trim()}`);
        }

        // Also apply per-interface DNS override dynamically via resolvectl if available
        if (await this.executor.commandExists('resolvectl')) {
          const linkRes = await this.executor.run({ command: 'ip', args: ['-o', '-4', 'route', 'show', 'to', 'default'] });
          const match = linkRes.stdout.match(/\bdev\s+(\S+)/);
          const iface = match?.[1];
          if (iface) {
            await this.executor.run({ command: 'resolvectl', args: ['dns', iface, dcIp] });
            await this.executor.run({
              command: 'resolvectl',
              args: ['domain', iface, `~${domain}`, ...(isDotLocal ? ['~local'] : []), domain],
            });
          }
          await this.executor.run({ command: 'resolvectl', args: ['flush-caches'] });
        }
      } else if (backend === 'networkmanager') {
        const nmConf = [
          '# Managed by ubuntu-fileserver for Active Directory DNS',
          '[main]',
          'dns=default',
          '',
          '[global-dns-domain-*]',
          `servers=${dcIp}`,
          '',
        ].join('\n');
        await this.fs.writeText('/etc/NetworkManager/conf.d/99-ubuntu-fileserver-ad.conf', nmConf, 0o644);
        await this.executor.run({ command: 'systemctl', args: ['reload', 'NetworkManager'] });
      } else {
        const resolvContent = [
          '# Managed by ubuntu-fileserver for Active Directory DNS',
          `search ${domain}`,
          `nameserver ${dcIp}`,
          '',
        ].join('\n');
        await this.fs.writeText('/etc/resolv.conf', resolvContent, 0o644);
      }

      const checks = await this.verifyAdDnsAndConnectivity(domain, dcIp);
      const failedChecks = checks.filter((c) => !c.passed);

      if (failedChecks.length > 0) {
        const error = `DNS/connectivity verification failed: ${failedChecks.map((c) => `${c.name} (${c.detail})`).join('; ')}`;
        logEvent('warn', 'dns', error, { domain, dcIp, backend, checks });
        return {
          success: false,
          backend,
          backupSessionId: backup.sessionId,
          checks,
          error,
        };
      }

      logEvent('info', 'dns', 'AD DNS configuration and diagnostics passed', {
        domain,
        dcIp,
        backend,
        backupSessionId: backup.sessionId,
      });

      return {
        success: true,
        backend,
        backupSessionId: backup.sessionId,
        checks,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logEvent('error', 'dns', 'DNS configuration failed; restoring backup', {
        error: errorMsg,
        backupSessionId: backup.sessionId,
      });
      await this.backupManager.restoreBackupSession(backup.sessionId);
      return {
        success: false,
        backend,
        backupSessionId: backup.sessionId,
        checks: [],
        error: errorMsg,
      };
    }
  }

  async verifyAdDnsAndConnectivity(domain: string, dcIp: string): Promise<DnsDiagnosticCheck[]> {
    const checks: DnsDiagnosticCheck[] = [];

    // 1. Network connectivity to AD ports (Kerberos 88, LDAP 389, SMB 445)
    const [port88, port389, port445] = await Promise.all([
      this.executor.checkTcp(dcIp, 88, 4000),
      this.executor.checkTcp(dcIp, 389, 4000),
      this.executor.checkTcp(dcIp, 445, 4000),
    ]);

    checks.push({
      name: 'DC Network Connectivity',
      passed: port88 && port389 && port445,
      detail: `Kerberos(88)=${port88 ? 'OK' : 'FAIL'}, LDAP(389)=${port389 ? 'OK' : 'FAIL'}, SMB(445)=${port445 ? 'OK' : 'FAIL'} at ${dcIp}`,
    });

    // 2. AD Domain A record resolution
    const domainARes = await this.executor.run({
      command: 'dig',
      args: ['+short', '+time=3', '+tries=2', domain, 'A'],
    });
    const domainIps = domainARes.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith(';'));
    checks.push({
      name: 'AD Domain DNS Resolution',
      passed: domainARes.exitCode === 0 && domainIps.length > 0,
      detail: domainIps.length > 0 ? `${domain} -> ${domainIps.join(', ')}` : `No A record returned for ${domain}`,
    });

    // 3. Domain Controller DNS / direct query check
    const dcQueryRes = await this.executor.run({
      command: 'dig',
      args: [`@${dcIp}`, '+short', '+time=3', '+tries=2', domain, 'A'],
    });
    const dcQueryIps = dcQueryRes.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith(';'));
    checks.push({
      name: 'Domain Controller DNS Query',
      passed: dcQueryRes.exitCode === 0 && dcQueryIps.length > 0,
      detail: dcQueryIps.length > 0 ? `DC ${dcIp} resolved ${domain} -> ${dcQueryIps.join(', ')}` : `DC ${dcIp} failed DNS query for ${domain}`,
    });

    // 4. Kerberos SRV record
    const krbSrvRes = await this.executor.run({
      command: 'dig',
      args: ['+short', '+time=3', '+tries=2', `_kerberos._tcp.${domain}`, 'SRV'],
    });
    const krbSrvLines = krbSrvRes.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith(';'));
    checks.push({
      name: 'Kerberos SRV Record',
      passed: krbSrvRes.exitCode === 0 && krbSrvLines.length > 0,
      detail: krbSrvLines.length > 0 ? krbSrvLines[0]! : `Missing _kerberos._tcp.${domain} SRV record`,
    });

    // 5. LDAP SRV record
    const ldapSrvRes = await this.executor.run({
      command: 'dig',
      args: ['+short', '+time=3', '+tries=2', `_ldap._tcp.${domain}`, 'SRV'],
    });
    const ldapSrvLines = ldapSrvRes.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith(';'));

    let ldapDetail = ldapSrvLines.length > 0 ? ldapSrvLines[0]! : `Missing _ldap._tcp.${domain} SRV record`;
    if (ldapSrvLines.length === 0 && domain.split('.').length >= 3) {
      const parentDomain = domain.split('.').slice(1).join('.');
      const parentCheck = await this.executor.run({
        command: 'dig',
        args: [`@${dcIp}`, '+short', '+time=2', '+tries=1', `_ldap._tcp.${parentDomain}`, 'SRV'],
      });
      if (parentCheck.exitCode === 0 && parentCheck.stdout.trim().length > 0) {
        ldapDetail = `No SRV for "${domain}", but DC ${dcIp} has _ldap._tcp.${parentDomain} — enter "${parentDomain}" as AD DNS Domain instead of the DC hostname.`;
      }
    }

    checks.push({
      name: 'LDAP SRV Record',
      passed: ldapSrvRes.exitCode === 0 && ldapSrvLines.length > 0,
      detail: ldapDetail,
    });

    return checks;
  }
}
