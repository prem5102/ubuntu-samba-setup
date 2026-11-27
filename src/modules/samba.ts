import path from 'node:path';
import { buildSambaGlobalSection } from './activeDirectory.js';
import { BackupManager } from './backup.js';
import { systemCommandExecutor, systemFileSystem } from './commandExecutor.js';
import { logEvent } from './logger.js';
import { PermissionsManager, validateShareAclConsistency } from './permissions.js';
import type {
  ActiveDirectoryPersistedConfig,
  CommandExecutor,
  FileSystemAdapter,
  SambaApplyResult,
  SambaShareConfig,
} from '../types/index.js';
import { sambaDescriptionSchema, sambaShareNameSchema } from '../validation/schemas.js';
import { validateInput } from '../validation/retry.js';

function quotePrincipal(name: string, isGroup: boolean): string {
  const prefix = isGroup ? '@' : '';
  return `"${prefix}${name}"`;
}

export function buildSambaShareStanza(share: SambaShareConfig): string {
  const validList: string[] = [
    ...share.readWriteGroups.map((g) => quotePrincipal(g.normalized, true)),
    ...share.readOnlyGroups.map((g) => quotePrincipal(g.normalized, true)),
    ...share.readWriteUsers.map((u) => quotePrincipal(u.normalized, false)),
    ...share.readOnlyUsers.map((u) => quotePrincipal(u.normalized, false)),
  ];

  const readList: string[] = [
    ...share.readOnlyGroups.map((g) => quotePrincipal(g.normalized, true)),
    ...share.readOnlyUsers.map((u) => quotePrincipal(u.normalized, false)),
  ];

  const writeList: string[] =
    share.accessMode === 'read_write'
      ? [
          ...share.readWriteGroups.map((g) => quotePrincipal(g.normalized, true)),
          ...share.readWriteUsers.map((u) => quotePrincipal(u.normalized, false)),
        ]
      : [];

  const lines: string[] = [
    `[${share.name}]`,
    `   comment = ${share.description}`,
    `   path = ${share.sharePath}`,
    '   browseable = yes',
    '   guest ok = no',
    '   read only = yes',
    `   valid users = ${validList.join(', ')}`,
  ];

  if (readList.length > 0) {
    lines.push(`   read list = ${readList.join(', ')}`);
  }
  if (writeList.length > 0) {
    lines.push(`   write list = ${writeList.join(', ')}`);
  }

  lines.push(
    '   create mask = 0660',
    '   directory mask = 2770',
    '   force create mode = 0660',
    '   force directory mode = 2770',
    '   inherit acls = yes',
    '   inherit permissions = yes',
    '',
  );

  return lines.join('\n');
}

export function extractGlobalSection(smbConf: string): string {
  const lines = smbConf.split('\n');
  const out: string[] = [];
  let inGlobal = false;
  let sawGlobal = false;

  for (const line of lines) {
    const secMatch = line.trim().match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      const name = secMatch[1]!.trim().toLowerCase();
      if (name === 'global') {
        inGlobal = true;
        sawGlobal = true;
        out.push(line);
        continue;
      } else {
        inGlobal = false;
      }
    } else if (!sawGlobal || inGlobal) {
      out.push(line);
    }
  }

  return out.join('\n').trim();
}

export class SambaManager {
  constructor(
    private readonly executor: CommandExecutor = systemCommandExecutor,
    private readonly fs: FileSystemAdapter = systemFileSystem,
    private readonly permissionsManager: PermissionsManager = new PermissionsManager(systemCommandExecutor, systemFileSystem),
    private readonly backupManager: BackupManager = new BackupManager(systemFileSystem),
  ) {}

  validateShareConfig(
    share: SambaShareConfig,
    configuredMountPoints: string[],
    existingShares: SambaShareConfig[],
  ): string[] {
    const errors: string[] = [];

    const nameVal = validateInput(sambaShareNameSchema, share.name);
    if (!nameVal.success) {
      errors.push(nameVal.errorSummary ?? 'Invalid share name.');
    }

    const descVal = validateInput(sambaDescriptionSchema, share.description);
    if (!descVal.success) {
      errors.push(descVal.errorSummary ?? 'Invalid share description.');
    }

    const dup = existingShares.find((s) => s.name.toLowerCase() === share.name.trim().toLowerCase());
    if (dup) {
      errors.push(`A share named "${share.name}" already exists (Samba share names are case-insensitive).`);
    }

    const normalizedMountPoints = configuredMountPoints.map((m) => path.posix.resolve(m));
    const normBaseMount = path.posix.resolve(share.baseMountPoint);
    if (!normalizedMountPoints.includes(normBaseMount)) {
      errors.push(`Mount point "${share.baseMountPoint}" is not a configured LVM mount point.`);
    }

    errors.push(...validateShareAclConsistency(share));
    return errors;
  }

  async applySharesAndReload(
    shares: SambaShareConfig[],
    configuredMountPoints: string[],
    adConfig?: ActiveDirectoryPersistedConfig,
  ): Promise<SambaApplyResult> {
    if (shares.length === 0) {
      return {
        success: false,
        testparmPassed: false,
        testparmOutput: '',
        servicesReloaded: false,
        aclOutputs: [],
        error: 'At least one Samba share must be configured.',
      };
    }

    // Validate all shares & paths before modifying any file
    const seenNames = new Set<string>();
    for (const share of shares) {
      const lower = share.name.toLowerCase();
      if (seenNames.has(lower)) {
        return {
          success: false,
          testparmPassed: false,
          testparmOutput: '',
          servicesReloaded: false,
          aclOutputs: [],
          error: `Duplicate share name detected: "${share.name}".`,
        };
      }
      seenNames.add(lower);

      const errs = this.validateShareConfig(share, configuredMountPoints, []);
      if (errs.length > 0) {
        return {
          success: false,
          testparmPassed: false,
          testparmOutput: '',
          servicesReloaded: false,
          aclOutputs: [],
          error: errs.join(' '),
        };
      }
    }

    if (!(await this.executor.isRoot())) {
      return {
        success: false,
        testparmPassed: false,
        testparmOutput: '',
        servicesReloaded: false,
        aclOutputs: [],
        error: 'Root privileges are required to update /etc/samba/smb.conf, apply ACLs, and reload Samba.',
      };
    }

    const backup = await this.backupManager.createBackupSession('samba', ['/etc/samba/smb.conf']);
    const aclOutputs: Array<{ shareName: string; sharePath: string; getfaclOutput: string }> = [];

    try {
      // 1. Apply POSIX ACLs and ownership on every share path
      for (const share of shares) {
        const permRes = await this.permissionsManager.applySharePermissions(share);
        if (!permRes.success) {
          throw new Error(permRes.error ?? `Failed to apply ACL permissions for ${share.name}`);
        }
        aclOutputs.push({
          shareName: share.name,
          sharePath: share.sharePath,
          getfaclOutput: permRes.getfaclOutput,
        });
      }

      // 2. Build /etc/samba/smb.conf preserving [global]
      let globalSection = '';
      if (await this.fs.exists('/etc/samba/smb.conf')) {
        const existing = await this.fs.readText('/etc/samba/smb.conf');
        globalSection = extractGlobalSection(existing);
      }
      if (!globalSection && adConfig) {
        globalSection = buildSambaGlobalSection(adConfig.domain, adConfig.netbiosName).trim();
      }
      if (!globalSection) {
        throw new Error('/etc/samba/smb.conf is missing [global] Active Directory configuration.');
      }

      const shareBlocks = shares.map((share) => buildSambaShareStanza(share)).join('\n');
      const fullConfig = `${globalSection}\n\n${shareBlocks}`;
      await this.fs.writeText('/etc/samba/smb.conf', fullConfig, 0o644);

      // 3. Validate with testparm BEFORE reloading or restarting Samba
      const testparmRes = await this.executor.run({
        command: 'testparm',
        args: ['-s'],
      });

      if (testparmRes.exitCode !== 0) {
        await this.backupManager.restoreBackupSession(backup.sessionId);
        return {
          success: false,
          backupSessionId: backup.sessionId,
          testparmPassed: false,
          testparmOutput: testparmRes.stderr.trim() || testparmRes.stdout.trim(),
          servicesReloaded: false,
          aclOutputs,
          error: `testparm validation failed; /etc/samba/smb.conf was restored from backup.`,
          recoveryInstructions: [
            'Review the testparm output for syntax or parameter errors.',
            'Samba service was NOT reloaded to prevent downtime.',
          ],
        };
      }

      // 4. Reload / restart Samba services only after testparm passes
      const reloadRes = await this.executor.run({
        command: 'systemctl',
        args: ['reload', 'smbd'],
      });
      if (reloadRes.exitCode !== 0) {
        const restartRes = await this.executor.run({
          command: 'systemctl',
          args: ['restart', 'smbd', 'winbind'],
        });
        if (restartRes.exitCode !== 0) {
          throw new Error(`Failed to reload/restart smbd: ${restartRes.stderr.trim()}`);
        }
      }

      logEvent('info', 'samba', 'Validated smb.conf with testparm and reloaded Samba services', {
        shareNames: shares.map((s) => s.name),
        backupSessionId: backup.sessionId,
      });

      return {
        success: true,
        backupSessionId: backup.sessionId,
        testparmPassed: true,
        testparmOutput: testparmRes.stdout.trim(),
        servicesReloaded: true,
        aclOutputs,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logEvent('error', 'samba', 'Failed applying Samba shares; restoring smb.conf backup', {
        error,
        backupSessionId: backup.sessionId,
      });
      await this.backupManager.restoreBackupSession(backup.sessionId);
      return {
        success: false,
        backupSessionId: backup.sessionId,
        testparmPassed: false,
        testparmOutput: '',
        servicesReloaded: false,
        aclOutputs,
        error,
        recoveryInstructions: [
          '/etc/samba/smb.conf was restored to its previous state.',
          'Check `sudo testparm -s` and `sudo systemctl status smbd winbind` before retrying.',
        ],
      };
    }
  }
}
