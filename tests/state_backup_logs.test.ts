import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryFileSystem, MockCommandExecutor } from './helpers.js';
import { BackupManager } from '../src/modules/backup.js';
import { logEvent, readLogEntries, resetAppPathsCache, resetLogger } from '../src/modules/logger.js';
import { revalidateStateAgainstSystem, updateStageStatus } from '../src/state/installationState.js';
import {
  createInitialInstallationState,
  loadInstallationState,
  saveInstallationState,
  stripCredentialsFromState,
} from '../src/state/persistence.js';

const tempDirs: string[] = [];

afterEach(async () => {
  resetLogger();
  resetAppPathsCache();
  delete process.env['UBUNTU_FILESERVER_DATA_DIR'];
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('Backup, State Persistence, and Logging', () => {
  test('BackupManager creates timestamped backups and restores/removes files accurately', async () => {
    const mfs = new MemoryFileSystem({
      '/etc/hosts': '127.0.0.1 localhost\n',
      '/etc/fstab': 'UUID=abc / ext4 defaults 0 1\n',
    });
    const bm = new BackupManager(mfs, '/backups');

    const manifest = await bm.createBackupSession('hostname', ['/etc/hosts', '/etc/fstab', '/etc/new_conf']);
    expect(manifest.files.length).toBe(3);

    await mfs.writeText('/etc/hosts', 'CORRUPTED\n');
    await mfs.writeText('/etc/new_conf', 'NEW_DATA\n');

    const restore = await bm.restoreBackupSession(manifest.sessionId);
    expect(restore.errors).toEqual([]);
    expect(await mfs.readText('/etc/hosts')).toBe('127.0.0.1 localhost\n');
    expect(await mfs.exists('/etc/new_conf')).toBe(false);
  });

  test('stripCredentialsFromState and saveInstallationState never write passwords or secrets', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ufs-state-'));
    tempDirs.push(tmpDir);
    const stateFile = path.join(tmpDir, 'state.json');

    const base = createInitialInstallationState();
    const polluted = {
      ...base,
      activeDirectory: {
        domain: 'corp.example.com',
        netbiosName: 'CORP',
        dcIp: '10.0.0.10',
        username: 'Administrator',
        password: 'SUPER_SECRET_PASSWORD_123',
        ticket: 'TGT_SECRET',
        dnsConfigured: true,
        kerberosConfigured: true,
        sambaAdsConfigured: true,
        nssConfigured: true,
        pamConfigured: true,
        joined: true,
        verified: true,
      },
    };

    const stripped = stripCredentialsFromState(polluted);
    expect('password' in stripped.activeDirectory).toBe(false);
    expect('ticket' in stripped.activeDirectory).toBe(false);

    await saveInstallationState(polluted as typeof base, stateFile);
    const rawDisk = await fs.readFile(stateFile, 'utf8');
    expect(rawDisk).not.toContain('SUPER_SECRET_PASSWORD_123');
    expect(rawDisk).not.toContain('TGT_SECRET');

    const loaded = await loadInstallationState(stateFile);
    expect(loaded?.activeDirectory?.domain).toBe('corp.example.com');
  });

  test('revalidateStateAgainstSystem resets completed stages if live system no longer matches', async () => {
    let state = createInitialInstallationState();
    state.hostname = { hostname: 'fs01', fqdn: 'fs01.corp.local', configured: true };
    state.lvm = {
      baseName: 'fileserver',
      vgName: 'vg_fileserver',
      lvName: 'lv_fileserver',
      lvDevicePath: '/dev/vg_fileserver/lv_fileserver',
      pvCreated: ['/dev/sdb'],
      vgCreated: true,
      lvCreated: true,
      wipeConfirmed: true,
    };
    state.mount = {
      lvDevicePath: '/dev/vg_fileserver/lv_fileserver',
      xfsFormatted: true,
      uuid: '1234-5678',
      mountPoint: '/data/fileserver',
      fstabUpdated: true,
      mounted: true,
    };

    state = updateStageStatus(state, 'packages', 'completed');
    state = updateStageStatus(state, 'hostname', 'completed');
    state = updateStageStatus(state, 'active_directory', 'completed');
    state = updateStageStatus(state, 'disk_selection', 'completed');
    state = updateStageStatus(state, 'lvm', 'completed');
    state = updateStageStatus(state, 'mount', 'completed');

    const exec = new MockCommandExecutor();
    exec.when('hostname', () => ({ stdout: 'fs01\n' }));
    exec.when((o) => o.command === 'net' && o.args[0] === 'ads', () => ({ exitCode: 1, stderr: 'Join broken' }));
    exec.when('lvs', () => ({ stdout: '/dev/vg_fileserver/lv_fileserver\n' }));
    exec.when('findmnt', () => ({ exitCode: 1, stdout: '' }));

    const reval = await revalidateStateAgainstSystem(state, exec);
    expect(reval.state.stages.hostname.status).toBe('completed');
    expect(reval.state.stages.active_directory.status).toBe('pending');
    expect(reval.state.stages.mount.status).toBe('pending');
    expect(reval.resumeStage).toBe('active_directory');
    expect(reval.adjustments.length).toBe(2);

    // Mismatched mount LV vs current LV resets stale mount state
    let mismatched = createInitialInstallationState();
    mismatched.lvm = {
      baseName: 'project',
      vgName: 'vg_project',
      lvName: 'lv_project',
      lvDevicePath: '/dev/vg_project/lv_project',
      pvCreated: ['/dev/sdd'],
      vgCreated: true,
      lvCreated: true,
      wipeConfirmed: true,
    };
    mismatched.mount = {
      lvDevicePath: '/dev/vg_data/lv_data',
      xfsFormatted: true,
      uuid: 'old-uuid',
      mountPoint: '/data/data',
      fstabUpdated: true,
      mounted: true,
    };
    mismatched = updateStageStatus(mismatched, 'lvm', 'completed');
    mismatched = updateStageStatus(mismatched, 'mount', 'completed');
    const revalMismatch = await revalidateStateAgainstSystem(mismatched, exec);
    expect(revalMismatch.state.mount).toBeUndefined();
    expect(revalMismatch.state.stages.mount.status).toBe('pending');
  });

  test('logger redacts sensitive credentials and supports structured log reading', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ufs-log-'));
    tempDirs.push(tmpDir);
    process.env['UBUNTU_FILESERVER_DATA_DIR'] = tmpDir;
    resetAppPathsCache();
    resetLogger();

    logEvent('info', 'testMod', 'Auth attempt with password=MySecretPass123!', {
      username: 'Administrator',
      password: 'MySecretPass123!',
      token: 'tok-999',
    }, ['MySecretPass123!']);

    const entries = await readLogEntries(50, 'info');
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    expect(entry.msg).not.toContain('MySecretPass123!');
    expect(entry.msg).toContain('[REDACTED]');
    expect(entry.details?.['password']).toBe('[REDACTED]');
    expect(entry.details?.['token']).toBe('[REDACTED]');
  });
});
