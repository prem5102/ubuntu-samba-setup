import path from 'node:path';
import type { BackupFileRecord, BackupManifest, FileSystemAdapter, StageId } from '../types/index.js';
import { systemFileSystem } from './commandExecutor.js';
import { logEvent, resolveAppPaths } from './logger.js';

export const CORE_SYSTEM_CONFIG_FILES = [
  '/etc/samba/smb.conf',
  '/etc/krb5.conf',
  '/etc/nsswitch.conf',
  '/etc/fstab',
  '/etc/hostname',
  '/etc/hosts',
] as const;

function makeTimestampSlug(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}-${String(now.getUTCMilliseconds()).padStart(3, '0')}`;
}

export class BackupManager {
  constructor(
    private readonly fs: FileSystemAdapter = systemFileSystem,
    private readonly backupsRoot: string = resolveAppPaths().backupsDir,
  ) {}

  async createBackupSession(stage: StageId, filePaths: string[]): Promise<BackupManifest> {
    const sessionId = `${makeTimestampSlug()}_${stage}`;
    const sessionDir = path.join(this.backupsRoot, sessionId);
    await this.fs.mkdir(sessionDir, 0o700);

    const uniquePaths = Array.from(new Set(filePaths));
    const records: BackupFileRecord[] = [];

    for (const originalPath of uniquePaths) {
      const normalized = path.posix.normalize(originalPath);
      const relativeRel = normalized.replace(/^\/+/, '');
      const backupDest = path.join(sessionDir, 'files', relativeRel);

      const exists = await this.fs.exists(normalized);
      if (!exists) {
        records.push({
          originalPath: normalized,
          backupPath: backupDest,
          existed: false,
          wasSymlink: false,
        });
        continue;
      }

      const wasSymlink = await this.fs.isSymlink(normalized);
      const mode = await this.fs.statMode(normalized);

      if (wasSymlink) {
        const symlinkTarget = await this.fs.readlink(normalized);
        let resolvedContent = '';
        try {
          resolvedContent = await this.fs.readText(normalized);
          await this.fs.writeText(backupDest, resolvedContent, 0o600);
        } catch {
          // Broken symlink still recorded via symlinkTarget
        }
        records.push({
          originalPath: normalized,
          backupPath: backupDest,
          existed: true,
          wasSymlink: true,
          symlinkTarget,
          mode: mode ?? undefined,
        });
      } else {
        await this.fs.copyFile(normalized, backupDest);
        records.push({
          originalPath: normalized,
          backupPath: backupDest,
          existed: true,
          wasSymlink: false,
          mode: mode ?? undefined,
        });
      }
    }

    const manifest: BackupManifest = {
      sessionId,
      stage,
      createdAt: new Date().toISOString(),
      files: records,
    };

    await this.fs.writeText(path.join(sessionDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 0o600);

    logEvent('info', 'backup', `Created backup session ${sessionId}`, {
      sessionId,
      stage,
      fileCount: records.length,
    });

    return manifest;
  }

  async restoreBackupSession(sessionId: string): Promise<{ restored: string[]; removed: string[]; errors: string[] }> {
    const manifestPath = path.join(this.backupsRoot, sessionId, 'manifest.json');
    const restored: string[] = [];
    const removed: string[] = [];
    const errors: string[] = [];

    if (!(await this.fs.exists(manifestPath))) {
      const msg = `Backup manifest not found for session ${sessionId}`;
      logEvent('error', 'backup', msg, { sessionId });
      return { restored, removed, errors: [msg] };
    }

    const manifest = JSON.parse(await this.fs.readText(manifestPath)) as BackupManifest;

    for (const record of manifest.files) {
      try {
        if (!record.existed) {
          if (await this.fs.exists(record.originalPath)) {
            await this.fs.unlink(record.originalPath);
            removed.push(record.originalPath);
          }
          continue;
        }

        if (record.wasSymlink) {
          // Do not replace managed symlinks like /etc/resolv.conf unless regular file was written over it
          if (await this.fs.exists(record.backupPath)) {
            const existsNow = await this.fs.exists(record.originalPath);
            const isStillSymlink = await this.fs.isSymlink(record.originalPath);
            if (!existsNow || !isStillSymlink) {
              await this.fs.copyFile(record.backupPath, record.originalPath);
              restored.push(record.originalPath);
            }
          }
          continue;
        }

        if (await this.fs.exists(record.backupPath)) {
          await this.fs.copyFile(record.backupPath, record.originalPath);
          if (record.mode !== undefined) {
            await this.fs.chmod(record.originalPath, record.mode);
          }
          restored.push(record.originalPath);
        }
      } catch (err) {
        errors.push(`${record.originalPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logEvent(errors.length > 0 ? 'warn' : 'info', 'backup', `Restored backup session ${sessionId}`, {
      sessionId,
      restored,
      removed,
      errors,
    });

    return { restored, removed, errors };
  }

  async listBackupSessions(): Promise<BackupManifest[]> {
    if (!(await this.fs.exists(this.backupsRoot))) return [];
    const entries = await this.fs.readdir(this.backupsRoot);
    const manifests: BackupManifest[] = [];

    for (const entry of entries.sort().reverse()) {
      const manifestPath = path.join(this.backupsRoot, entry, 'manifest.json');
      if (await this.fs.exists(manifestPath)) {
        try {
          const parsed = JSON.parse(await this.fs.readText(manifestPath)) as BackupManifest;
          manifests.push(parsed);
        } catch {
          // Ignore malformed entry
        }
      }
    }

    return manifests;
  }
}
