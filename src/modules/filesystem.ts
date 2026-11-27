import { systemCommandExecutor } from './commandExecutor.js';
import { logEvent } from './logger.js';
import type { CommandExecutor, XfsFormatResult } from '../types/index.js';
import { safeDevicePathSchema } from '../validation/schemas.js';
import { validateInput } from '../validation/retry.js';

export class FilesystemManager {
  constructor(private readonly executor: CommandExecutor = systemCommandExecutor) {}

  async inspectDeviceFilesystem(devicePath: string): Promise<{ fstype?: string; uuid?: string }> {
    // Use -p (--probe) to bypass blkid cache and read the live superblock directly from the block device.
    const typeRes = await this.executor.run({
      command: 'blkid',
      args: ['-p', '-s', 'TYPE', '-o', 'value', devicePath],
    });
    const uuidRes = await this.executor.run({
      command: 'blkid',
      args: ['-p', '-s', 'UUID', '-o', 'value', devicePath],
    });

    const fstype = typeRes.exitCode === 0 ? typeRes.stdout.trim() : '';
    const uuid = uuidRes.exitCode === 0 ? uuidRes.stdout.trim() : '';

    return {
      fstype: fstype.length > 0 ? fstype : undefined,
      uuid: uuid.length > 0 ? uuid : undefined,
    };
  }

  async formatLvWithXfs(lvDevicePath: string): Promise<XfsFormatResult> {
    const pathVal = validateInput(safeDevicePathSchema, lvDevicePath);
    if (!pathVal.success || !pathVal.data) {
      return {
        success: false,
        lvDevicePath,
        error: pathVal.errorSummary ?? 'Invalid logical volume device path.',
      };
    }

    if (!(await this.executor.isRoot())) {
      return {
        success: false,
        lvDevicePath,
        error: 'Root privileges are required to format a logical volume with XFS.',
      };
    }

    // Verify LV exists
    const lvCheck = await this.executor.run({
      command: 'lvs',
      args: ['--noheadings', '-o', 'lv_path', lvDevicePath],
    });
    if (lvCheck.exitCode !== 0 || !lvCheck.stdout.trim()) {
      return {
        success: false,
        lvDevicePath,
        error: `Logical volume "${lvDevicePath}" does not exist or is inactive.`,
        recoveryInstructions: [
          `Check active logical volumes with: sudo lvs -a`,
          `Activate volume group if needed: sudo vgchange -ay`,
        ],
      };
    }

    // Refuse to format any existing filesystem
    const existing = await this.inspectDeviceFilesystem(lvDevicePath);
    if (existing.fstype) {
      logEvent('warn', 'filesystem', 'Refused to format LV because existing filesystem was detected', {
        lvDevicePath,
        existingFstype: existing.fstype,
        uuid: existing.uuid,
      });
      return {
        success: false,
        lvDevicePath,
        uuid: existing.uuid,
        alreadyFormatted: true,
        existingFstype: existing.fstype,
        error: `Refusing to format ${lvDevicePath}: an existing "${existing.fstype}" filesystem (UUID: ${existing.uuid ?? 'unknown'}) was detected.`,
        recoveryInstructions: [
          'If this is your previously formatted XFS volume, you can proceed to mounting without formatting.',
          'If you intentionally want to wipe it manually, inspect data first and use mkfs.xfs outside this wizard.',
        ],
      };
    }

    const mkfsRes = await this.executor.run({
      command: 'mkfs.xfs',
      args: [lvDevicePath],
      timeoutMs: 180_000,
    });

    if (mkfsRes.exitCode !== 0) {
      const error = `mkfs.xfs failed on ${lvDevicePath}: ${mkfsRes.stderr.trim() || mkfsRes.stdout.trim()}`;
      logEvent('error', 'filesystem', error, { lvDevicePath });
      return {
        success: false,
        lvDevicePath,
        error,
        recoveryInstructions: [
          `Inspect device signatures with: sudo blkid ${lvDevicePath}`,
          `Verify xfsprogs is installed: dpkg -s xfsprogs`,
          `Check kernel messages for storage errors: sudo dmesg | tail -n 30`,
        ],
      };
    }

    // Verify XFS creation and retrieve UUID
    const verified = await this.inspectDeviceFilesystem(lvDevicePath);
    if (verified.fstype !== 'xfs' || !verified.uuid) {
      const error = `XFS verification failed after mkfs.xfs (detected type="${verified.fstype ?? 'none'}", uuid="${verified.uuid ?? 'none'}").`;
      logEvent('error', 'filesystem', error, { lvDevicePath, verified });
      return {
        success: false,
        lvDevicePath,
        error,
        recoveryInstructions: [`Run sudo blkid ${lvDevicePath} and sudo xfs_info ${lvDevicePath} to inspect the filesystem.`],
      };
    }

    logEvent('info', 'filesystem', 'Created and verified XFS filesystem', {
      lvDevicePath,
      uuid: verified.uuid,
    });

    return {
      success: true,
      lvDevicePath,
      uuid: verified.uuid,
      alreadyFormatted: false,
    };
  }
}
