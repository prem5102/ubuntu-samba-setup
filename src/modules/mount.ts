import { BackupManager } from './backup.js';
import { systemCommandExecutor, systemFileSystem } from './commandExecutor.js';
import { FilesystemManager } from './filesystem.js';
import { logEvent } from './logger.js';
import type { CommandExecutor, FileSystemAdapter, MountExecutionResult } from '../types/index.js';
import { mountPointSchema, safeDevicePathSchema } from '../validation/schemas.js';
import { validateInput } from '../validation/retry.js';

export function buildUpdatedFstabContent(existingFstab: string, uuid: string, mountPoint: string): { content: string; entry: string } {
  const entry = `UUID=${uuid}\t${mountPoint}\txfs\tdefaults\t0\t2`;
  const lines = existingFstab.split('\n');
  let replaced = false;

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const cols = trimmed.split(/\s+/);
    const colSpec = cols[0] ?? '';
    const colMount = cols[1] ?? '';
    if (colSpec === `UUID=${uuid}` || colMount === mountPoint) {
      replaced = true;
      return entry;
    }
    return line;
  });

  if (!replaced) {
    updated.push('# Added by ubuntu-fileserver for LVM XFS share storage');
    updated.push(entry);
  }

  return {
    content: `${updated.join('\n').replace(/\n+$/, '')}\n`,
    entry,
  };
}

export class MountManager {
  constructor(
    private readonly executor: CommandExecutor = systemCommandExecutor,
    private readonly fs: FileSystemAdapter = systemFileSystem,
    private readonly filesystemManager: FilesystemManager = new FilesystemManager(systemCommandExecutor),
    private readonly backupManager: BackupManager = new BackupManager(systemFileSystem),
  ) {}

  async validateMountPointPreconditions(mountPointInput: string): Promise<{ valid: boolean; normalizedPath?: string; error?: string }> {
    const val = validateInput(mountPointSchema, mountPointInput);
    if (!val.success || !val.data) {
      return { valid: false, error: val.errorSummary ?? 'Invalid mount point.' };
    }
    const mountPoint = val.data;

    // Ensure no conflicting active mount at this target
    const findmntRes = await this.executor.run({
      command: 'findmnt',
      args: ['--noheadings', '--mountpoint', mountPoint],
    });
    if (findmntRes.exitCode === 0 && findmntRes.stdout.trim().length > 0) {
      return {
        valid: false,
        error: `Mount point "${mountPoint}" already has an active mount (${findmntRes.stdout.trim()}).`,
      };
    }

    // Check existing path state
    if (await this.fs.exists(mountPoint)) {
      if (await this.fs.isSymlink(mountPoint)) {
        return {
          valid: false,
          error: `Path "${mountPoint}" is a symbolic link, not a directory.`,
        };
      }
      if (!(await this.fs.isDirectory(mountPoint))) {
        return {
          valid: false,
          error: `Path "${mountPoint}" already exists and is not a directory.`,
        };
      }
      const entries = await this.fs.readdir(mountPoint);
      if (entries.length > 0) {
        return {
          valid: false,
          error: `Directory "${mountPoint}" is not empty (${entries.length} item(s) found). Choose an empty directory or new mount point so existing files are not shadowed.`,
        };
      }
    }

    // Check if /etc/fstab already defines a conflicting device on this mount point
    if (await this.fs.exists('/etc/fstab')) {
      const fstab = await this.fs.readText('/etc/fstab');
      for (const line of fstab.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const cols = trimmed.split(/\s+/);
        if (cols[1] === mountPoint) {
          return {
            valid: false,
            error: `/etc/fstab already contains an entry for mount point "${mountPoint}" (${cols[0]}).`,
          };
        }
      }
    }

    return { valid: true, normalizedPath: mountPoint };
  }

  async configureAndMount(lvDevicePath: string, mountPointInput: string): Promise<MountExecutionResult> {
    const devVal = validateInput(safeDevicePathSchema, lvDevicePath);
    if (!devVal.success) {
      return {
        success: false,
        mountPoint: mountPointInput,
        lvDevicePath,
        uuid: '',
        fstabEntry: '',
        findmntVerified: false,
        error: devVal.errorSummary ?? 'Invalid device path.',
      };
    }

    const pre = await this.validateMountPointPreconditions(mountPointInput);
    if (!pre.valid || !pre.normalizedPath) {
      return {
        success: false,
        mountPoint: mountPointInput,
        lvDevicePath,
        uuid: '',
        fstabEntry: '',
        findmntVerified: false,
        error: pre.error ?? 'Mount point validation failed.',
      };
    }

    const mountPoint = pre.normalizedPath;

    if (!(await this.executor.isRoot())) {
      return {
        success: false,
        mountPoint,
        lvDevicePath,
        uuid: '',
        fstabEntry: '',
        findmntVerified: false,
        error: 'Root privileges are required to update /etc/fstab and mount filesystems.',
      };
    }

    const fsInfo = await this.filesystemManager.inspectDeviceFilesystem(lvDevicePath);
    if (fsInfo.fstype !== 'xfs' || !fsInfo.uuid) {
      return {
        success: false,
        mountPoint,
        lvDevicePath,
        uuid: fsInfo.uuid ?? '',
        fstabEntry: '',
        findmntVerified: false,
        error: `Expected an XFS filesystem with a valid UUID on ${lvDevicePath}, found type="${fsInfo.fstype ?? 'none'}" uuid="${fsInfo.uuid ?? 'none'}".`,
        recoveryInstructions: [`Inspect filesystem metadata with: sudo blkid ${lvDevicePath}`],
      };
    }

    const backup = await this.backupManager.createBackupSession('mount', ['/etc/fstab']);

    try {
      await this.fs.mkdir(mountPoint, 0o755);

      const existingFstab = (await this.fs.exists('/etc/fstab')) ? await this.fs.readText('/etc/fstab') : '';
      const { content: newFstab, entry: fstabEntry } = buildUpdatedFstabContent(existingFstab, fsInfo.uuid, mountPoint);
      await this.fs.writeText('/etc/fstab', newFstab, 0o644);

      // Inform systemd about updated fstab
      await this.executor.run({ command: 'systemctl', args: ['daemon-reload'] });

      const mountRes = await this.executor.run({
        command: 'mount',
        args: [mountPoint],
        timeoutMs: 30_000,
      });
      if (mountRes.exitCode !== 0) {
        throw new Error(`mount ${mountPoint} failed: ${mountRes.stderr.trim() || mountRes.stdout.trim()}`);
      }

      const findmntRes = await this.executor.run({
        command: 'findmnt',
        args: ['--noheadings', '--target', mountPoint],
      });
      if (findmntRes.exitCode !== 0 || !findmntRes.stdout.trim()) {
        throw new Error(`findmnt verification failed for ${mountPoint}`);
      }

      const dfRes = await this.executor.run({
        command: 'df',
        args: ['-h', mountPoint],
      });

      logEvent('info', 'mount', 'Configured UUID fstab entry and mounted XFS filesystem', {
        mountPoint,
        lvDevicePath,
        uuid: fsInfo.uuid,
        backupSessionId: backup.sessionId,
      });

      return {
        success: true,
        mountPoint,
        lvDevicePath,
        uuid: fsInfo.uuid,
        fstabEntry,
        backupSessionId: backup.sessionId,
        findmntVerified: true,
        dfOutput: dfRes.stdout.trim(),
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logEvent('error', 'mount', 'Mount failed; restoring /etc/fstab backup', {
        mountPoint,
        lvDevicePath,
        error,
        backupSessionId: backup.sessionId,
      });
      await this.backupManager.restoreBackupSession(backup.sessionId);
      return {
        success: false,
        mountPoint,
        lvDevicePath,
        uuid: fsInfo.uuid,
        fstabEntry: '',
        backupSessionId: backup.sessionId,
        findmntVerified: false,
        error: `${error}. /etc/fstab has been restored from backup.`,
        recoveryInstructions: [
          `Verify UUID with: sudo blkid ${lvDevicePath}`,
          `Verify fstab syntax with: sudo findmnt --verify --verbose`,
          'You may retry mounting with the same or a different mount point.',
        ],
      };
    }
  }
}
