import path from 'node:path';
import { systemCommandExecutor, systemFileSystem } from './commandExecutor.js';
import { logEvent } from './logger.js';
import type { CommandExecutor, FileSystemAdapter, SambaShareConfig } from '../types/index.js';

export function validateShareAclConsistency(share: SambaShareConfig): string[] {
  const errors: string[] = [];

  const normSharePath = path.posix.resolve(share.sharePath);
  const normBaseMount = path.posix.resolve(share.baseMountPoint);
  if (normSharePath !== normBaseMount && !normSharePath.startsWith(`${normBaseMount}/`)) {
    errors.push(`Share path "${share.sharePath}" must reside inside configured LVM mount point "${share.baseMountPoint}".`);
  }

  const roGroupIds = new Set(share.readOnlyGroups.map((g) => g.numericId));
  const rwGroupIds = new Set(share.readWriteGroups.map((g) => g.numericId));
  for (const g of share.readOnlyGroups) {
    if (rwGroupIds.has(g.numericId)) {
      errors.push(`Group "${g.normalized}" (GID ${g.numericId}) cannot be assigned to both Read-Only and Read/Write lists.`);
    }
  }

  const rwUserIds = new Set(share.readWriteUsers.map((u) => u.numericId));
  for (const u of share.readOnlyUsers) {
    if (rwUserIds.has(u.numericId)) {
      errors.push(`User "${u.normalized}" (UID ${u.numericId}) cannot be assigned to both Read-Only and Read/Write lists.`);
    }
  }

  if (share.accessMode === 'read_only' && (share.readWriteGroups.length > 0 || share.readWriteUsers.length > 0)) {
    errors.push('A Read-Only share cannot contain Read/Write groups or users.');
  }

  const totalPrincipals =
    share.readOnlyGroups.length +
    share.readWriteGroups.length +
    share.readOnlyUsers.length +
    share.readWriteUsers.length;
  if (totalPrincipals === 0) {
    errors.push('At least one validated AD group or user must be assigned to the share.');
  }

  // Ensure RO groups are not accidentally given RW via duplicate numeric IDs
  void roGroupIds;
  return errors;
}

export function buildAclEntries(share: SambaShareConfig, usePrimaryGroup: boolean): string[] {
  const entries: string[] = ['u::rwx', usePrimaryGroup ? 'g::rwx' : 'g::---', 'o::---', 'm::rwx'];

  const rwUsers = share.accessMode === 'read_write' ? share.readWriteUsers : [];
  const rwGroups = share.accessMode === 'read_write' ? share.readWriteGroups : [];

  for (const u of rwUsers) {
    entries.push(`u:${u.numericId}:rwx`);
  }
  for (const g of rwGroups) {
    entries.push(`g:${g.numericId}:rwx`);
  }
  for (const u of share.readOnlyUsers) {
    entries.push(`u:${u.numericId}:r-x`);
  }
  for (const g of share.readOnlyGroups) {
    entries.push(`g:${g.numericId}:r-x`);
  }

  const defaultEntries = entries.map((entry) => `d:${entry}`);
  return [...entries, ...defaultEntries];
}

export class PermissionsManager {
  constructor(
    private readonly executor: CommandExecutor = systemCommandExecutor,
    private readonly fs: FileSystemAdapter = systemFileSystem,
  ) {}

  async applySharePermissions(share: SambaShareConfig): Promise<{ success: boolean; getfaclOutput: string; error?: string }> {
    const consistencyErrors = validateShareAclConsistency(share);
    if (consistencyErrors.length > 0) {
      return {
        success: false,
        getfaclOutput: '',
        error: consistencyErrors.join(' '),
      };
    }

    if (!(await this.executor.isRoot())) {
      return {
        success: false,
        getfaclOutput: '',
        error: 'Root privileges are required to set ownership and POSIX ACLs.',
      };
    }

    try {
      await this.fs.mkdir(share.sharePath, 0o770);

      // Use primary RW group as owning group for setgid inheritance when present; otherwise root (0)
      const primaryRwGroup = share.accessMode === 'read_write' ? share.readWriteGroups[0] : undefined;
      const owningGroup = primaryRwGroup ? String(primaryRwGroup.numericId) : '0';

      const chownRes = await this.executor.run({
        command: 'chown',
        args: ['-R', `0:${owningGroup}`, share.sharePath],
      });
      if (chownRes.exitCode !== 0) {
        throw new Error(`chown failed on ${share.sharePath}: ${chownRes.stderr.trim()}`);
      }

      // Set setgid bit (2770) on directory and ensure no world access
      const chmodRes = await this.executor.run({
        command: 'chmod',
        args: ['2770', share.sharePath],
      });
      if (chmodRes.exitCode !== 0) {
        throw new Error(`chmod 2770 failed on ${share.sharePath}: ${chmodRes.stderr.trim()}`);
      }

      // Remove stale ACL entries before applying exact policy so RO users cannot inherit old write entries
      const clearAclRes = await this.executor.run({
        command: 'setfacl',
        args: ['-R', '-b', share.sharePath],
      });
      if (clearAclRes.exitCode !== 0) {
        throw new Error(`setfacl -b failed on ${share.sharePath}: ${clearAclRes.stderr.trim()}`);
      }

      const aclEntries = buildAclEntries(share, Boolean(primaryRwGroup));
      const setAclRes = await this.executor.run({
        command: 'setfacl',
        args: ['-R', '-m', aclEntries.join(','), share.sharePath],
      });
      if (setAclRes.exitCode !== 0) {
        throw new Error(`setfacl -m failed on ${share.sharePath}: ${setAclRes.stderr.trim()}`);
      }

      const getAclRes = await this.executor.run({
        command: 'getfacl',
        args: ['-p', share.sharePath],
      });
      if (getAclRes.exitCode !== 0) {
        throw new Error(`getfacl verification failed on ${share.sharePath}: ${getAclRes.stderr.trim()}`);
      }

      logEvent('info', 'permissions', `Applied and verified POSIX ACLs for share ${share.name}`, {
        shareName: share.name,
        sharePath: share.sharePath,
        owningGroup,
        aclCount: aclEntries.length,
      });

      return {
        success: true,
        getfaclOutput: getAclRes.stdout.trim(),
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logEvent('error', 'permissions', `Failed applying POSIX ACLs for share ${share.name}`, {
        sharePath: share.sharePath,
        error,
      });
      return {
        success: false,
        getfaclOutput: '',
        error,
      };
    }
  }
}
