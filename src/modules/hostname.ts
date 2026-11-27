import { BackupManager } from './backup.js';
import { systemCommandExecutor, systemFileSystem } from './commandExecutor.js';
import { logEvent } from './logger.js';
import type { CommandExecutor, FileSystemAdapter, HostnameApplyResult, HostnameConfigInput } from '../types/index.js';
import { adDomainSchema, hostnameSchema } from '../validation/schemas.js';
import { validateInput } from '../validation/retry.js';

export function buildUpdatedHostsContent(existingContent: string, shortHostname: string, fqdn: string): string {
  const lines = existingContent.split('\n');
  const hostTokens = fqdn !== shortHostname ? `${fqdn} ${shortHostname}` : shortHostname;
  const targetLine = `127.0.1.1\t${hostTokens}`;

  let hasLocalhost = false;
  let replaced127011 = false;

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (/^127\.0\.0\.1\s+/.test(trimmed)) {
      hasLocalhost = true;
    }
    if (/^127\.0\.1\.1\s+/.test(trimmed)) {
      replaced127011 = true;
      return targetLine;
    }
    return line;
  });

  if (!hasLocalhost) {
    updatedLines.unshift('127.0.0.1\tlocalhost');
  }
  if (!replaced127011) {
    // Insert right after 127.0.0.1 line if present, else at top
    const idx = updatedLines.findIndex((l) => /^127\.0\.0\.1\s+/.test(l.trim()));
    if (idx >= 0) {
      updatedLines.splice(idx + 1, 0, targetLine);
    } else {
      updatedLines.unshift(targetLine);
    }
  }

  return `${updatedLines.join('\n').replace(/\n+$/, '')}\n`;
}

export class HostnameManager {
  constructor(
    private readonly executor: CommandExecutor = systemCommandExecutor,
    private readonly fs: FileSystemAdapter = systemFileSystem,
    private readonly backupManager: BackupManager = new BackupManager(systemFileSystem),
  ) {}

  async getCurrentHostname(): Promise<{ shortName: string; fqdn: string }> {
    const shortRes = await this.executor.run({ command: 'hostname', args: ['-s'] });
    const fqdnRes = await this.executor.run({ command: 'hostname', args: ['-f'] });
    return {
      shortName: shortRes.exitCode === 0 ? shortRes.stdout.trim() : '',
      fqdn: fqdnRes.exitCode === 0 ? fqdnRes.stdout.trim() : shortRes.stdout.trim(),
    };
  }

  async applyHostname(input: HostnameConfigInput): Promise<HostnameApplyResult> {
    const hostValidation = validateInput(hostnameSchema, input.hostname);
    if (!hostValidation.success || !hostValidation.data) {
      return {
        success: false,
        hostname: input.hostname,
        fqdn: input.hostname,
        error: hostValidation.errorSummary ?? 'Invalid hostname.',
      };
    }

    let cleanDomain: string | undefined;
    if (input.domain && input.domain.trim().length > 0) {
      const domValidation = validateInput(adDomainSchema, input.domain);
      if (!domValidation.success || !domValidation.data) {
        return {
          success: false,
          hostname: hostValidation.data,
          fqdn: hostValidation.data,
          error: domValidation.errorSummary ?? 'Invalid domain.',
        };
      }
      cleanDomain = domValidation.data;
    }

    const shortHostname = hostValidation.data;
    const fqdn = cleanDomain ? `${shortHostname}.${cleanDomain}` : shortHostname;

    const isRoot = await this.executor.isRoot();
    if (!isRoot) {
      return {
        success: false,
        hostname: shortHostname,
        fqdn,
        error: 'Root privileges are required to modify system hostname and /etc/hosts.',
      };
    }

    const backup = await this.backupManager.createBackupSession('hostname', ['/etc/hostname', '/etc/hosts']);

    try {
      await this.fs.writeText('/etc/hostname', `${shortHostname}\n`, 0o644);

      const existingHosts = (await this.fs.exists('/etc/hosts')) ? await this.fs.readText('/etc/hosts') : '127.0.0.1\tlocalhost\n';
      const updatedHosts = buildUpdatedHostsContent(existingHosts, shortHostname, fqdn);
      await this.fs.writeText('/etc/hosts', updatedHosts, 0o644);

      const hasHostnamectl = await this.executor.commandExists('hostnamectl');
      if (hasHostnamectl) {
        const ctlRes = await this.executor.run({
          command: 'hostnamectl',
          args: ['set-hostname', shortHostname],
        });
        if (ctlRes.exitCode !== 0) {
          throw new Error(`hostnamectl failed: ${ctlRes.stderr.trim() || ctlRes.stdout.trim()}`);
        }
      } else {
        const cmdRes = await this.executor.run({
          command: 'hostname',
          args: [shortHostname],
        });
        if (cmdRes.exitCode !== 0) {
          throw new Error(`hostname command failed: ${cmdRes.stderr.trim()}`);
        }
      }

      // Verify hostname and resolution
      const verifyShort = await this.executor.run({ command: 'hostname', args: ['-s'] });
      const verifiedName = verifyShort.stdout.trim().toLowerCase();
      if (verifyShort.exitCode !== 0 || verifiedName !== shortHostname) {
        throw new Error(`Hostname verification mismatch: expected "${shortHostname}", got "${verifiedName}".`);
      }

      const resolveRes = await this.executor.run({ command: 'getent', args: ['hosts', shortHostname] });
      if (resolveRes.exitCode !== 0 || !resolveRes.stdout.trim()) {
        throw new Error(`Hostname "${shortHostname}" could not be resolved via /etc/hosts (getent hosts failed).`);
      }

      logEvent('info', 'hostname', 'Configured and verified system hostname', {
        hostname: shortHostname,
        fqdn,
        backupSessionId: backup.sessionId,
      });

      return {
        success: true,
        hostname: shortHostname,
        fqdn,
        backupSessionId: backup.sessionId,
        verifiedHostname: verifiedName,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logEvent('error', 'hostname', 'Hostname configuration failed; restoring backup', {
        error: errorMsg,
        backupSessionId: backup.sessionId,
      });
      await this.backupManager.restoreBackupSession(backup.sessionId);
      return {
        success: false,
        hostname: shortHostname,
        fqdn,
        backupSessionId: backup.sessionId,
        error: `${errorMsg}. Previous /etc/hostname and /etc/hosts were restored.`,
      };
    }
  }
}
