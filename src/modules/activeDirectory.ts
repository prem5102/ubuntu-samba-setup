import { BackupManager } from './backup.js';
import { systemCommandExecutor, systemFileSystem } from './commandExecutor.js';
import { DnsManager } from './dns.js';
import { buildUpdatedHostsContent } from './hostname.js';
import { logEvent } from './logger.js';
import type {
  ActiveDirectoryInput,
  AdJoinResult,
  CommandExecutor,
  DnsDiagnosticCheck,
  FileSystemAdapter,
} from '../types/index.js';
import { activeDirectoryInputSchema } from '../validation/schemas.js';
import { validateInput } from '../validation/retry.js';

export function buildKrb5Conf(domain: string): string {
  const lower = domain.toLowerCase();
  const realm = domain.toUpperCase();

  return [
    '# Managed by ubuntu-fileserver for Active Directory Kerberos integration',
    '[libdefaults]',
    `    default_realm = ${realm}`,
    '    dns_lookup_realm = false',
    '    dns_lookup_kdc = true',
    '    rdns = false',
    '    ticket_lifetime = 24h',
    '    renew_lifetime = 7d',
    '    forwardable = true',
    '',
    '[realms]',
    `    ${realm} = {`,
    `        default_domain = ${lower}`,
    '    }',
    '',
    '[domain_realm]',
    `    .${lower} = ${realm}`,
    `    ${lower} = ${realm}`,
    '',
  ].join('\n');
}

export function buildSambaGlobalSection(domain: string, netbiosName: string): string {
  const realm = domain.toUpperCase();
  const workgroup = netbiosName.toUpperCase();

  return [
    '# Managed by ubuntu-fileserver for Active Directory Samba Member Server',
    '[global]',
    `   workgroup = ${workgroup}`,
    '   security = ADS',
    `   realm = ${realm}`,
    '   server role = member server',
    '   winbind refresh tickets = Yes',
    '   winbind use default domain = Yes',
    '   winbind enum users = Yes',
    '   winbind enum groups = Yes',
    '   winbind offline logon = No',
    '   idmap config * : backend = tdb',
    '   idmap config * : range = 3000-7999',
    `   idmap config ${workgroup} : backend = rid`,
    `   idmap config ${workgroup} : range = 10000-999999`,
    '   template shell = /sbin/nologin',
    '   template homedir = /home/%D/%U',
    '   dedicated keytab file = /etc/krb5.keytab',
    '   kerberos method = secrets and keytab',
    '   vfs objects = acl_xattr',
    '   map acl inherit = Yes',
    '   acl_xattr:ignore system acls = No',
    '   store dos attributes = Yes',
    '   map to guest = Never',
    '   restrict anonymous = 2',
    '',
  ].join('\n');
}

export function updateNsswitchContent(existing: string): string {
  const lines = existing.split('\n');
  let sawPasswd = false;
  let sawGroup = false;

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('passwd:')) {
      sawPasswd = true;
      return ensureWinbindInNssLine(line, 'passwd');
    }
    if (trimmed.startsWith('group:')) {
      sawGroup = true;
      return ensureWinbindInNssLine(line, 'group');
    }
    return line;
  });

  if (!sawPasswd) updated.push('passwd:         files systemd winbind');
  if (!sawGroup) updated.push('group:          files systemd winbind');

  return `${updated.join('\n').replace(/\n+$/, '')}\n`;
}

function ensureWinbindInNssLine(line: string, key: 'passwd' | 'group'): string {
  const parts = line.split(':');
  const rawSources = parts.slice(1).join(':').trim().split(/\s+/).filter(Boolean);
  if (!rawSources.includes('winbind')) {
    rawSources.push('winbind');
  }
  const paddedKey = `${key}:`.padEnd(16, ' ');
  return `${paddedKey}${rawSources.join(' ')}`;
}

export function extractSambaShareSections(smbConf: string): string {
  const lines = smbConf.split('\n');
  const shareLines: string[] = [];
  let inNonGlobalSection = false;

  for (const line of lines) {
    const sectionMatch = line.trim().match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const sectionName = sectionMatch[1]!.trim().toLowerCase();
      inNonGlobalSection = sectionName !== 'global';
    }
    if (inNonGlobalSection) {
      shareLines.push(line);
    }
  }

  return shareLines.join('\n').trim();
}

export function updateChronyWithDc(existing: string, dcIp: string): string {
  const lines = existing.split('\n');
  const dcLine = `server ${dcIp} iburst prefer`;
  if (lines.some((l) => l.trim().startsWith(`server ${dcIp}`))) {
    return existing;
  }
  const filtered = lines.filter((l) => !l.includes('# Managed AD DC NTP'));
  filtered.unshift('# Managed AD DC NTP', dcLine);
  return `${filtered.join('\n').replace(/\n+$/, '')}\n`;
}

export class ActiveDirectoryManager {
  constructor(
    private readonly executor: CommandExecutor = systemCommandExecutor,
    private readonly fs: FileSystemAdapter = systemFileSystem,
    private readonly dnsManager: DnsManager = new DnsManager(systemCommandExecutor, systemFileSystem),
    private readonly backupManager: BackupManager = new BackupManager(systemFileSystem),
  ) {}

  async configureAndJoin(input: ActiveDirectoryInput, hostnameShort?: string): Promise<AdJoinResult> {
    const validation = validateInput(activeDirectoryInputSchema, input);
    if (!validation.success || !validation.data) {
      return {
        success: false,
        checks: [],
        sampleUsers: [],
        sampleGroups: [],
        error: validation.errorSummary ?? 'Invalid Active Directory configuration input.',
      };
    }

    const { domain, netbiosName, dcIp, username, password } = validation.data;
    const realm = domain.toUpperCase();

    if (!(await this.executor.isRoot())) {
      return {
        success: false,
        checks: [],
        sampleUsers: [],
        sampleGroups: [],
        error: 'Root privileges are required to configure Kerberos, Samba, Winbind, and join Active Directory.',
      };
    }

    const checks: DnsDiagnosticCheck[] = [];

    // Step 1: Configure & verify DNS
    const dnsResult = await this.dnsManager.configureAdDns(domain, dcIp);
    checks.push(...dnsResult.checks);
    if (!dnsResult.success) {
      return {
        success: false,
        backupSessionId: dnsResult.backupSessionId,
        checks,
        sampleUsers: [],
        sampleGroups: [],
        error: dnsResult.error ?? 'DNS verification failed before Active Directory join.',
      };
    }

    // Step 2: Backup AD-related configs
    const backup = await this.backupManager.createBackupSession('active_directory', [
      '/etc/krb5.conf',
      '/etc/samba/smb.conf',
      '/etc/nsswitch.conf',
      '/etc/hosts',
      '/etc/chrony/chrony.conf',
    ]);

    try {
      // Step 3: Ensure /etc/hosts has FQDN mapping
      const shortRes = hostnameShort
        ? hostnameShort
        : (await this.executor.run({ command: 'hostname', args: ['-s'] })).stdout.trim();
      if (shortRes) {
        const existingHosts = (await this.fs.exists('/etc/hosts')) ? await this.fs.readText('/etc/hosts') : '127.0.0.1\tlocalhost\n';
        await this.fs.writeText('/etc/hosts', buildUpdatedHostsContent(existingHosts, shortRes, `${shortRes}.${domain}`), 0o644);
      }

      // Step 4: Configure NTP (chrony) against DC for Kerberos time sync
      if (await this.fs.exists('/etc/chrony/chrony.conf')) {
        const chronyText = await this.fs.readText('/etc/chrony/chrony.conf');
        await this.fs.writeText('/etc/chrony/chrony.conf', updateChronyWithDc(chronyText, dcIp), 0o644);
        await this.executor.run({ command: 'systemctl', args: ['restart', 'chrony'] });
        await this.executor.run({ command: 'chronyc', args: ['makestep'] });
      }

      // Step 5: Configure /etc/krb5.conf and test authentication with kinit (password via stdin only!)
      await this.fs.writeText('/etc/krb5.conf', buildKrb5Conf(domain), 0o644);

      const krbUser = username.includes('@') ? username : `${username.includes('\\') ? username.split('\\')[1] : username}@${realm}`;
      const kinitRes = await this.executor.run({
        command: 'kinit',
        args: [krbUser],
        stdin: `${password}\n`,
        redactOutput: true,
        timeoutMs: 30_000,
      });

      const kinitPassed = kinitRes.exitCode === 0;
      checks.push({
        name: 'Kerberos Authentication (kinit)',
        passed: kinitPassed,
        detail: kinitPassed
          ? `Authenticated Kerberos principal ${krbUser}`
          : `kinit failed (exit ${kinitRes.exitCode}): ${kinitRes.stderr.trim() || 'Check credentials, DNS, and clock skew.'}`,
      });

      if (!kinitPassed) {
        throw new Error(`Kerberos authentication failed: ${kinitRes.stderr.trim() || 'Invalid credentials or KDC unreachable'}`);
      }

      // Step 6: Configure /etc/samba/smb.conf (preserving existing shares if any)
      const existingSmb = (await this.fs.exists('/etc/samba/smb.conf')) ? await this.fs.readText('/etc/samba/smb.conf') : '';
      const existingShares = extractSambaShareSections(existingSmb);
      const smbContent = existingShares
        ? `${buildSambaGlobalSection(domain, netbiosName)}\n${existingShares}\n`
        : buildSambaGlobalSection(domain, netbiosName);
      await this.fs.writeText('/etc/samba/smb.conf', smbContent, 0o644);

      // Step 7: Configure /etc/nsswitch.conf & PAM
      const existingNss = (await this.fs.exists('/etc/nsswitch.conf'))
        ? await this.fs.readText('/etc/nsswitch.conf')
        : 'passwd:         files systemd\ngroup:          files systemd\nshadow:         files systemd\n';
      await this.fs.writeText('/etc/nsswitch.conf', updateNsswitchContent(existingNss), 0o644);

      if (await this.executor.commandExists('pam-auth-update')) {
        await this.executor.run({
          command: 'pam-auth-update',
          args: ['--package', '--enable', 'winbind'],
          env: { DEBIAN_FRONTEND: 'noninteractive' },
        });
      }

      // Validate smb.conf before joining
      const testparmPre = await this.executor.run({ command: 'testparm', args: ['-s'] });
      if (testparmPre.exitCode !== 0) {
        throw new Error(`smb.conf validation failed before join: ${testparmPre.stderr.trim()}`);
      }

      // Step 8: Join AD domain using Kerberos ticket first, then fallback to stdin password if needed
      let joinRes = await this.executor.run({
        command: 'net',
        args: ['ads', 'join', '-k'],
        timeoutMs: 60_000,
      });

      if (joinRes.exitCode !== 0) {
        const plainUser = username.includes('@') ? username.split('@')[0]! : username.includes('\\') ? username.split('\\')[1]! : username;
        joinRes = await this.executor.run({
          command: 'net',
          args: ['ads', 'join', '-U', plainUser],
          stdin: `${password}\n`,
          redactOutput: true,
          timeoutMs: 60_000,
        });
      }

      // Destroy ephemeral admin TGT right after join attempt
      await this.executor.run({ command: 'kdestroy', args: [] });

      if (joinRes.exitCode !== 0) {
        throw new Error(`Domain join failed (net ads join): ${joinRes.stderr.trim() || joinRes.stdout.trim()}`);
      }

      checks.push({
        name: 'Domain Join (net ads join)',
        passed: true,
        detail: `Joined domain ${realm} (${netbiosName})`,
      });

      // Step 9: Start/enable winbind and smbd
      await this.executor.run({ command: 'systemctl', args: ['enable', '--now', 'winbind'] });
      await this.executor.run({ command: 'systemctl', args: ['restart', 'winbind'] });
      await this.executor.run({ command: 'systemctl', args: ['enable', '--now', 'smbd'] });
      await this.executor.run({ command: 'systemctl', args: ['restart', 'smbd'] });

      // Step 10: Mandatory verification suite
      const testjoinRes = await this.executor.run({ command: 'net', args: ['ads', 'testjoin'] });
      const testjoinOk = testjoinRes.exitCode === 0;
      checks.push({
        name: 'net ads testjoin',
        passed: testjoinOk,
        detail: testjoinOk ? testjoinRes.stdout.trim() || 'Join is OK' : testjoinRes.stderr.trim() || 'Join check failed',
      });

      const wbTrustRes = await this.executor.run({ command: 'wbinfo', args: ['-t'] });
      const wbTrustOk = wbTrustRes.exitCode === 0;
      checks.push({
        name: 'wbinfo -t (Trust Secret)',
        passed: wbTrustOk,
        detail: wbTrustOk ? wbTrustRes.stdout.trim() || 'Trust secret succeeded' : wbTrustRes.stderr.trim(),
      });

      const wbUsersRes = await this.executor.run({ command: 'wbinfo', args: ['-u'] });
      const sampleUsers = wbUsersRes.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 10);
      const wbUsersOk = wbUsersRes.exitCode === 0 && sampleUsers.length > 0;
      checks.push({
        name: 'wbinfo -u (AD Users)',
        passed: wbUsersOk,
        detail: wbUsersOk ? `Found ${sampleUsers.length}+ AD users (e.g. ${sampleUsers[0]})` : 'No AD users returned by wbinfo -u',
      });

      const wbGroupsRes = await this.executor.run({ command: 'wbinfo', args: ['-g'] });
      const sampleGroups = wbGroupsRes.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 10);
      const wbGroupsOk = wbGroupsRes.exitCode === 0 && sampleGroups.length > 0;
      checks.push({
        name: 'wbinfo -g (AD Groups)',
        passed: wbGroupsOk,
        detail: wbGroupsOk ? `Found ${sampleGroups.length}+ AD groups (e.g. ${sampleGroups[0]})` : 'No AD groups returned by wbinfo -g',
      });

      // Verify NSS resolution using an enumerated AD user/group or general getent
      const targetUser = sampleUsers[0];
      const nssUserRes = targetUser
        ? await this.executor.run({ command: 'getent', args: ['passwd', targetUser] })
        : await this.executor.run({ command: 'getent', args: ['passwd'] });
      const targetGroup = sampleGroups[0];
      const nssGroupRes = targetGroup
        ? await this.executor.run({ command: 'getent', args: ['group', targetGroup] })
        : await this.executor.run({ command: 'getent', args: ['group'] });

      const nssOk = nssUserRes.exitCode === 0 && nssUserRes.stdout.trim().length > 0 && nssGroupRes.exitCode === 0 && nssGroupRes.stdout.trim().length > 0;
      checks.push({
        name: 'NSS Identity Resolution (getent)',
        passed: nssOk,
        detail: nssOk
          ? `Resolved AD identity via NSS (${targetUser ?? 'passwd'}, ${targetGroup ?? 'group'})`
          : 'Failed to resolve AD user/group via NSS getent',
      });

      const allPassed = checks.every((c) => c.passed);
      if (!allPassed) {
        const failedNames = checks.filter((c) => !c.passed).map((c) => c.name);
        throw new Error(`AD verification checks failed: ${failedNames.join(', ')}`);
      }

      logEvent('info', 'activeDirectory', 'Successfully configured and verified Active Directory membership', {
        domain,
        netbiosName,
        dcIp,
        username,
        backupSessionId: backup.sessionId,
      });

      return {
        success: true,
        backupSessionId: backup.sessionId,
        checks,
        sampleUsers,
        sampleGroups,
      };
    } catch (err) {
      // Ensure ephemeral TGT is cleaned up even on error
      await this.executor.run({ command: 'kdestroy', args: [] }).catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('error', 'activeDirectory', 'Active Directory configuration failed', {
        domain,
        netbiosName,
        dcIp,
        error: msg,
        backupSessionId: backup.sessionId,
      });
      return {
        success: false,
        backupSessionId: backup.sessionId,
        checks,
        sampleUsers: [],
        sampleGroups: [],
        error: msg,
      };
    }
  }
}
