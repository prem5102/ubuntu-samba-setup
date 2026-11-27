import { systemCommandExecutor } from './commandExecutor.js';
import { DiskDetector } from './diskDetection.js';
import { logEvent } from './logger.js';
import type { CommandExecutor, LvmExecutionResult, LvmPlan } from '../types/index.js';
import { lvmBaseNameSchema, safeDevicePathSchema, wipeConfirmationSchema } from '../validation/schemas.js';
import { validateInput } from '../validation/retry.js';

export function buildLvmPlan(baseName: string, selectedDisks: string[], totalBytes: number): LvmPlan {
  const clean = baseName.trim().toLowerCase();
  const vgName = `vg_${clean}`;
  const lvName = `lv_${clean}`;
  return {
    baseName: clean,
    vgName,
    lvName,
    lvDevicePath: `/dev/${vgName}/${lvName}`,
    selectedDisks: [...selectedDisks],
    totalBytes,
  };
}

export class LvmManager {
  constructor(
    private readonly executor: CommandExecutor = systemCommandExecutor,
    private readonly diskDetector: DiskDetector = new DiskDetector(systemCommandExecutor),
  ) {}

  async checkNameConflicts(plan: LvmPlan): Promise<string[]> {
    const conflicts: string[] = [];
    const vgCheck = await this.executor.run({
      command: 'vgs',
      args: ['--noheadings', '-o', 'vg_name'],
    });

    if (vgCheck.exitCode === 0) {
      const existingVgs = vgCheck.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (existingVgs.includes(plan.vgName)) {
        conflicts.push(`Volume Group "${plan.vgName}" already exists on this system.`);
      }
    }

    const lvCheck = await this.executor.run({
      command: 'lvs',
      args: ['--noheadings', '-o', 'lv_path'],
    });
    if (lvCheck.exitCode === 0) {
      const existingLvs = lvCheck.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (existingLvs.includes(plan.lvDevicePath)) {
        conflicts.push(`Logical Volume "${plan.lvDevicePath}" already exists on this system.`);
      }
    }

    return conflicts;
  }

  async createLvmStorage(plan: LvmPlan, wipeConfirmation: string): Promise<LvmExecutionResult> {
    const nameVal = validateInput(lvmBaseNameSchema, plan.baseName);
    if (!nameVal.success || !nameVal.data) {
      return {
        success: false,
        plan,
        pvCreated: [],
        vgCreated: false,
        lvCreated: false,
        error: nameVal.errorSummary ?? 'Invalid LVM name.',
      };
    }

    const wipeVal = validateInput(wipeConfirmationSchema, wipeConfirmation);
    if (!wipeVal.success) {
      return {
        success: false,
        plan,
        pvCreated: [],
        vgCreated: false,
        lvCreated: false,
        error: wipeVal.errorSummary ?? 'Exact confirmation "WIPE" is required.',
      };
    }

    if (plan.selectedDisks.length === 0) {
      return {
        success: false,
        plan,
        pvCreated: [],
        vgCreated: false,
        lvCreated: false,
        error: 'At least one eligible disk must be selected before creating LVM storage.',
      };
    }

    for (const devPath of plan.selectedDisks) {
      const devVal = validateInput(safeDevicePathSchema, devPath);
      if (!devVal.success) {
        return {
          success: false,
          plan,
          pvCreated: [],
          vgCreated: false,
          lvCreated: false,
          error: `Unsafe device path "${devPath}": ${devVal.errorSummary}`,
        };
      }
    }

    if (!(await this.executor.isRoot())) {
      return {
        success: false,
        plan,
        pvCreated: [],
        vgCreated: false,
        lvCreated: false,
        error: 'Root privileges are required to execute pvcreate, vgcreate, and lvcreate.',
      };
    }

    // Revalidate live disk eligibility immediately before destructive operations
    const liveScan = await this.diskDetector.detectDisks();
    const eligibleSet = new Set(liveScan.eligibleDisks.map((d) => d.path));
    const invalidNow = plan.selectedDisks.filter((d) => !eligibleSet.has(d));
    if (invalidNow.length > 0) {
      const reasons = invalidNow.map((devPath) => {
        const match = liveScan.disks.find((d) => d.path === devPath);
        return match
          ? `${devPath} (${match.exclusionReasons.join(', ')})`
          : `${devPath} (device no longer detected)`;
      });
      return {
        success: false,
        plan,
        pvCreated: [],
        vgCreated: false,
        lvCreated: false,
        error: `Pre-destructive disk revalidation failed: ${reasons.join('; ')}`,
        recoveryInstructions: [
          'Return to Disk Detection and verify which devices are available and unused.',
          'Do not force pvcreate on devices that have mounted filesystems or existing data.',
        ],
      };
    }

    const conflicts = await this.checkNameConflicts(plan);
    if (conflicts.length > 0) {
      return {
        success: false,
        plan,
        pvCreated: [],
        vgCreated: false,
        lvCreated: false,
        error: conflicts.join(' '),
        recoveryInstructions: ['Choose a different LVM base name that does not conflict with existing VGs/LVs.'],
      };
    }

    const pvCreated: string[] = [];
    let vgCreated = false;
    let lvCreated = false;

    try {
      // 1. Create Physical Volumes on every selected disk
      for (const disk of plan.selectedDisks) {
        const pvRes = await this.executor.run({
          command: 'pvcreate',
          args: [disk],
          timeoutMs: 60_000,
        });
        if (pvRes.exitCode !== 0) {
          throw new Error(`pvcreate failed on ${disk}: ${pvRes.stderr.trim() || pvRes.stdout.trim()}`);
        }
        pvCreated.push(disk);
      }

      // 2. Combine all selected disks into ONE Volume Group
      const vgRes = await this.executor.run({
        command: 'vgcreate',
        args: [plan.vgName, ...plan.selectedDisks],
        timeoutMs: 60_000,
      });
      if (vgRes.exitCode !== 0) {
        throw new Error(`vgcreate failed for ${plan.vgName}: ${vgRes.stderr.trim() || vgRes.stdout.trim()}`);
      }
      vgCreated = true;

      // 3. Create ONE Logical Volume consuming 100% of available VG space
      const lvRes = await this.executor.run({
        command: 'lvcreate',
        args: ['-y', '-l', '100%FREE', '-n', plan.lvName, plan.vgName],
        timeoutMs: 60_000,
      });
      if (lvRes.exitCode !== 0) {
        throw new Error(`lvcreate failed for ${plan.lvName}: ${lvRes.stderr.trim() || lvRes.stdout.trim()}`);
      }
      lvCreated = true;

      // 4. Verify VG and LV exist
      const verifyLv = await this.executor.run({
        command: 'lvs',
        args: ['--noheadings', '-o', 'lv_path,lv_size', plan.lvDevicePath],
      });
      if (verifyLv.exitCode !== 0 || !verifyLv.stdout.trim()) {
        throw new Error(`Verification via lvs failed for ${plan.lvDevicePath}.`);
      }

      logEvent('info', 'lvm', 'Created Physical Volumes, Volume Group, and Logical Volume', {
        plan,
        pvCreated,
      });

      return {
        success: true,
        plan,
        pvCreated,
        vgCreated,
        lvCreated,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('error', 'lvm', 'LVM creation failed', {
        plan,
        pvCreated,
        vgCreated,
        lvCreated,
        error: msg,
      });

      const recovery: string[] = [
        'Destructive LVM steps were halted and were NOT automatically retried.',
        `Inspect current LVM state with: sudo pvs && sudo vgs && sudo lvs`,
      ];
      if (vgCreated && !lvCreated) {
        recovery.push(`To clean up partial VG before retrying: sudo vgremove ${plan.vgName}`);
      }
      if (pvCreated.length > 0 && !vgCreated) {
        recovery.push(`To remove partial PV labels before retrying: sudo pvremove ${pvCreated.join(' ')}`);
      }

      return {
        success: false,
        plan,
        pvCreated,
        vgCreated,
        lvCreated,
        error: msg,
        recoveryInstructions: recovery,
      };
    }
  }
}
