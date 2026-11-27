import { systemCommandExecutor } from './commandExecutor.js';
import { logEvent } from './logger.js';
import type { BlockDeviceChild, BlockDeviceInfo, CommandExecutor, DiskDetectionResult } from '../types/index.js';

interface RawLsblkDevice {
  name?: string;
  kname?: string;
  path?: string;
  type?: string;
  size?: number | string | null;
  model?: string | null;
  serial?: string | null;
  ro?: boolean | number | string | null;
  rm?: boolean | number | string | null;
  mountpoint?: string | null;
  mountpoints?: Array<string | null>;
  fstype?: string | null;
  uuid?: string | null;
  pttype?: string | null;
  pkname?: string | null;
  children?: RawLsblkDevice[];
}

interface RawLsblkOutput {
  blockdevices?: RawLsblkDevice[];
}

interface RawFindmntNode {
  target?: string;
  source?: string;
  fstype?: string;
  children?: RawFindmntNode[];
}

interface RawFindmntOutput {
  filesystems?: RawFindmntNode[];
}

const OTHER_STORAGE_FSTYPES = new Set([
  'zfs_member',
  'crypto_luks',
  'btrfs',
  'ceph_bluestore',
  'multipath_member',
  'dm_snapshot_cow',
]);

const RAID_FSTYPES = new Set(['linux_raid_member', 'isw_raid_member', 'ddf_raid_member', 'promise_fasttrack_raid_member']);

const OS_MOUNT_PREFIXES = new Set(['/', '/boot', '/boot/efi', '/var', '/usr', '/home', '/opt', '[SWAP]']);

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(val >= 10 || idx === 0 ? 1 : 2)} ${units[idx]}`;
}

function toBool(val: boolean | number | string | null | undefined): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') return val === '1' || val.toLowerCase() === 'true';
  return false;
}

function toBytes(val: number | string | null | undefined): number {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (typeof val === 'string') {
    const parsed = Number.parseInt(val, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function firstMountpoint(dev: RawLsblkDevice): string | null {
  if (dev.mountpoint && dev.mountpoint.trim().length > 0) return dev.mountpoint;
  if (Array.isArray(dev.mountpoints)) {
    const valid = dev.mountpoints.find((m) => typeof m === 'string' && m.trim().length > 0);
    if (valid) return valid;
  }
  return null;
}

function flattenChildren(children: RawLsblkDevice[] | undefined): BlockDeviceChild[] {
  const result: BlockDeviceChild[] = [];
  if (!children) return result;
  for (const child of children) {
    const devPath = child.path ?? (child.name ? `/dev/${child.name}` : '');
    result.push({
      name: child.name ?? '',
      path: devPath,
      type: child.type ?? '',
      sizeBytes: toBytes(child.size),
      fstype: child.fstype ?? null,
      mountpoint: firstMountpoint(child),
      uuid: child.uuid ?? null,
    });
    if (child.children && child.children.length > 0) {
      result.push(...flattenChildren(child.children));
    }
  }
  return result;
}

export function parseBlkidExport(output: string): Map<string, { type?: string; pttype?: string; uuid?: string }> {
  const map = new Map<string, { type?: string; pttype?: string; uuid?: string }>();
  const blocks = output.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    let devName = '';
    const info: { type?: string; pttype?: string; uuid?: string } = {};
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx);
      const val = line.slice(idx + 1);
      if (key === 'DEVNAME') devName = val;
      else if (key === 'TYPE') info.type = val;
      else if (key === 'PTTYPE') info.pttype = val;
      else if (key === 'UUID') info.uuid = val;
    }
    if (devName) {
      map.set(devName, info);
    }
  }
  return map;
}

export function parseFindmntSources(rawJson: string): Map<string, string[]> {
  const sourceToTargets = new Map<string, string[]>();
  try {
    const parsed = JSON.parse(rawJson) as RawFindmntOutput;
    const visit = (nodes: RawFindmntNode[] | undefined): void => {
      if (!nodes) return;
      for (const node of nodes) {
        if (node.source && node.target) {
          const baseSource = node.source.replace(/\[.*\]$/, '');
          const list = sourceToTargets.get(baseSource) ?? [];
          list.push(node.target);
          sourceToTargets.set(baseSource, list);
        }
        visit(node.children);
      }
    };
    visit(parsed.filesystems);
  } catch {
    // Fallback to empty map on non-JSON findmnt
  }
  return sourceToTargets;
}

export function parsePvsDevices(output: string): Set<string> {
  const pvsSet = new Set<string>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [pvPath] = trimmed.split(/\s+|\|/);
    if (pvPath) pvsSet.add(pvPath);
  }
  return pvsSet;
}

export class DiskDetector {
  constructor(private readonly executor: CommandExecutor = systemCommandExecutor) {}

  async detectDisks(): Promise<DiskDetectionResult> {
    const warnings: string[] = [];

    const [lsblkRes, blkidRes, pvsRes, findmntRes] = await Promise.all([
      this.executor.run({
        command: 'lsblk',
        args: ['-J', '-b', '-o', 'NAME,KNAME,PATH,TYPE,SIZE,MODEL,SERIAL,RO,RM,MOUNTPOINT,FSTYPE,UUID,PKNAME,PTTYPE,STATE'],
      }),
      this.executor.run({
        command: 'blkid',
        args: ['-o', 'export'],
      }),
      this.executor.run({
        command: 'pvs',
        args: ['--noheadings', '-o', 'pv_name'],
      }),
      this.executor.run({
        command: 'findmnt',
        args: ['-J', '-l'],
      }),
    ]);

    if (lsblkRes.exitCode !== 0) {
      throw new Error(`lsblk failed: ${lsblkRes.stderr.trim() || 'Unable to inspect block devices'}`);
    }

    let rawDevices: RawLsblkDevice[] = [];
    try {
      const parsed = JSON.parse(lsblkRes.stdout) as RawLsblkOutput;
      rawDevices = parsed.blockdevices ?? [];
    } catch (err) {
      throw new Error(`Failed to parse lsblk JSON output: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (pvsRes.exitCode !== 0) {
      warnings.push('`pvs` command did not succeed (LVM2 may not be installed or requires root); relying on lsblk/blkid for LVM detection.');
    }

    const blkidMap = blkidRes.exitCode === 0 ? parseBlkidExport(blkidRes.stdout) : new Map();
    const pvDevices = pvsRes.exitCode === 0 ? parsePvsDevices(pvsRes.stdout) : new Set<string>();
    const mountMap = findmntRes.exitCode === 0 ? parseFindmntSources(findmntRes.stdout) : new Map<string, string[]>();

    const disks: BlockDeviceInfo[] = [];

    for (const dev of rawDevices) {
      const devPath = dev.path ?? (dev.name ? `/dev/${dev.name}` : '');
      const devType = (dev.type ?? '').toLowerCase();
      const sizeBytes = toBytes(dev.size);
      const readOnly = toBool(dev.ro);
      const removable = toBool(dev.rm);
      const children = flattenChildren(dev.children);
      const blkidSelf = blkidMap.get(devPath);

      const fstype = dev.fstype ?? blkidSelf?.type ?? null;
      const pttype = dev.pttype ?? blkidSelf?.pttype ?? null;
      const directMount = firstMountpoint(dev);
      const findmntSelf = mountMap.get(devPath) ?? [];

      const allMounts = new Set<string>();
      if (directMount) allMounts.add(directMount);
      for (const m of findmntSelf) allMounts.add(m);
      for (const child of children) {
        if (child.mountpoint) allMounts.add(child.mountpoint);
        for (const cm of mountMap.get(child.path) ?? []) {
          allMounts.add(cm);
        }
      }

      const isOsDisk = Array.from(allMounts).some((m) => OS_MOUNT_PREFIXES.has(m));
      const hasMountedPaths = allMounts.size > 0;
      const hasPartitions =
        children.some((c) => c.type === 'part' || c.type === 'lvm' || c.type === 'crypt' || c.type.startsWith('raid')) ||
        Boolean(pttype);

      const allFsTypes = new Set<string>();
      if (fstype) allFsTypes.add(fstype.toLowerCase());
      for (const child of children) {
        if (child.fstype) allFsTypes.add(child.fstype.toLowerCase());
        const blkidChild = blkidMap.get(child.path);
        if (blkidChild?.type) allFsTypes.add(blkidChild.type.toLowerCase());
      }

      const hasFilesystem = Boolean(fstype) || children.some((c) => Boolean(c.fstype && c.fstype !== 'LVM2_member'));

      const isLvmMember =
        pvDevices.has(devPath) ||
        allFsTypes.has('lvm2_member') ||
        children.some((c) => pvDevices.has(c.path) || c.type === 'lvm');

      const isRaidMember =
        devType.startsWith('raid') ||
        devType === 'md' ||
        Array.from(allFsTypes).some((fs) => RAID_FSTYPES.has(fs)) ||
        children.some((c) => c.type.startsWith('raid') || c.type === 'md');

      const inUseByOtherStorage =
        Array.from(allFsTypes).some((fs) => OTHER_STORAGE_FSTYPES.has(fs)) ||
        children.some((c) => c.type === 'crypt' || c.type === 'dm' || c.type === 'mpath');

      const exclusionReasons: string[] = [];

      if (devType !== 'disk') {
        exclusionReasons.push(`Unsupported device type (${devType || 'unknown'})`);
      }
      if (!devPath.startsWith('/dev/')) {
        exclusionReasons.push('Invalid device path');
      }
      if (sizeBytes <= 0) {
        exclusionReasons.push('Zero or unknown capacity');
      }
      if (readOnly) {
        exclusionReasons.push('Read-only device');
      }
      if (isOsDisk) {
        exclusionReasons.push(`OS disk (contains ${Array.from(allMounts).join(', ')})`);
      } else if (hasMountedPaths) {
        exclusionReasons.push(`Mounted (${Array.from(allMounts).join(', ')})`);
      }
      if (isLvmMember) {
        exclusionReasons.push('Existing LVM member');
      }
      if (isRaidMember) {
        exclusionReasons.push('Existing RAID member');
      }
      if (inUseByOtherStorage) {
        exclusionReasons.push('Used by other storage subsystem (LUKS/ZFS/Btrfs/Multipath)');
      }
      if (hasPartitions) {
        const partCount = children.filter((c) => c.type === 'part').length;
        exclusionReasons.push(partCount > 0 ? `Contains ${partCount} existing partition(s)` : `Existing partition table (${pttype})`);
      }
      if (hasFilesystem) {
        exclusionReasons.push(`Existing filesystem (${Array.from(allFsTypes).join(', ')})`);
      }

      const eligible = exclusionReasons.length === 0;

      disks.push({
        name: dev.name ?? devPath.replace('/dev/', ''),
        path: devPath,
        type: devType,
        model: (dev.model ?? 'Unknown').trim() || 'Unknown',
        serial: (dev.serial ?? '').trim(),
        sizeBytes,
        sizeFormatted: formatBytes(sizeBytes),
        readOnly,
        removable,
        fstype,
        mountpoint: Array.from(allMounts).join(', ') || null,
        pttype,
        isOsDisk,
        isLvmMember,
        isRaidMember,
        inUseByOtherStorage,
        hasPartitions,
        hasFilesystem,
        children,
        eligible,
        exclusionReasons,
      });
    }

    const eligibleDisks = disks.filter((d) => d.eligible);
    const excludedDisks = disks.filter((d) => !d.eligible);

    logEvent('info', 'diskDetection', 'Completed block device scan', {
      totalDevices: disks.length,
      eligibleCount: eligibleDisks.length,
      eligiblePaths: eligibleDisks.map((d) => d.path),
    });

    return {
      disks,
      eligibleDisks,
      excludedDisks,
      warnings,
    };
  }
}
