import { PassThrough } from 'node:stream';
import React from 'react';
import { render } from 'ink';
import { describe, expect, test } from 'bun:test';
import { MockCommandExecutor, MemoryFileSystem } from './helpers.js';
import { InputField } from '../src/components/InputField.js';
import { MainMenu, type MainMenuChoice } from '../src/components/MainMenu.js';
import { AdIdentityValidator } from '../src/modules/adValidation.js';
import { BackupManager } from '../src/modules/backup.js';
import { DiskDetector } from '../src/modules/diskDetection.js';
import { FilesystemManager } from '../src/modules/filesystem.js';
import { HostnameManager } from '../src/modules/hostname.js';
import { LvmManager } from '../src/modules/lvm.js';
import { MountManager } from '../src/modules/mount.js';
import { PackageManager, REQUIRED_PACKAGES } from '../src/modules/packageManager.js';
import { SambaManager } from '../src/modules/samba.js';
import { PermissionsManager } from '../src/modules/permissions.js';
import { VerificationManager } from '../src/modules/verification.js';
import { App } from '../src/app.js';
import { ActiveDirectoryConfig } from '../src/screens/ActiveDirectoryConfig.js';
import { FinalSummary } from '../src/screens/FinalSummary.js';
import { HostnameConfig } from '../src/screens/HostnameConfig.js';
import { LVMConfig } from '../src/screens/LVMConfig.js';
import { MountConfig } from '../src/screens/MountConfig.js';
import { PackagePreinstall } from '../src/screens/PackagePreinstall.js';
import { PostSambaNext } from '../src/screens/PostSambaNext.js';
import { SambaConfig } from '../src/screens/SambaConfig.js';
import { createInitialInstallationState } from '../src/state/persistence.js';

function createInkStreams(): {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  getOutput: () => string;
  sendKey: (chunk: string) => Promise<void>;
  sendKeys: (keys: string[]) => Promise<void>;
} {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  (stdin as unknown as { isTTY: boolean }).isTTY = true;
  (stdin as unknown as { setRawMode: () => void }).setRawMode = () => {};
  (stdin as unknown as { ref: () => void }).ref = () => {};
  (stdin as unknown as { unref: () => void }).unref = () => {};

  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough;
  (stdout as unknown as { columns: number }).columns = 120;
  (stdout as unknown as { rows: number }).rows = 40;
  (stdout as unknown as { isTTY: boolean }).isTTY = true;

  let output = '';
  stdout.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  const sendKey = async (chunk: string): Promise<void> => {
    (stdin as unknown as PassThrough).write(chunk);
    await new Promise((r) => setTimeout(r, 25));
  };

  const sendKeys = async (keys: string[]): Promise<void> => {
    for (const k of keys) {
      await sendKey(k);
    }
  };

  return {
    stdin,
    stdout,
    getOutput: () => output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''),
    sendKey,
    sendKeys,
  };
}

describe('Ink TUI Components and Screens', () => {
  test('MainMenu renders all 6 menu options, stage statuses, and navigates via keyboard', async () => {
    const streams = createInkStreams();
    const choices: MainMenuChoice[] = [];
    const state = createInitialInstallationState();

    const inst = render(
      <MainMenu state={state} isRoot={false} onSelect={(c) => choices.push(c)} />,
      { stdin: streams.stdin, stdout: streams.stdout, debug: true },
    );

    await new Promise((r) => setTimeout(r, 30));
    const text = streams.getOutput();
    expect(text).toContain('1. Start complete server configuration');
    expect(text).toContain('2. Preinstall required packages');
    expect(text).toContain('3. Check installed package status');
    expect(text).toContain('4. Resume previous configuration');
    expect(text).toContain('5. View installation logs');
    expect(text).toContain('6. Exit');
    expect(text).toContain('Package Installation');
    expect(text).toContain('PENDING');

    await streams.sendKey('2');
    expect(choices).toEqual(['preinstall_packages']);
    inst.unmount();
  });

  test('InputField masks password input so plaintext never renders on terminal', async () => {
    const streams = createInkStreams();
    let captured = '';
    const Harness: React.FC = () => {
      const [val, setVal] = React.useState('');
      return (
        <InputField
          label="AD Password"
          value={val}
          mask="*"
          onChange={(v) => {
            captured = v;
            setVal(v);
          }}
        />
      );
    };

    const inst = render(<Harness />, { stdin: streams.stdin, stdout: streams.stdout, debug: true });
    await new Promise((r) => setTimeout(r, 25));
    await streams.sendKey('Secret99!');

    const rendered = streams.getOutput();
    expect(captured).toBe('Secret99!');
    expect(rendered).toContain('*********');
    expect(rendered).not.toContain('Secret99!');
    inst.unmount();
  });

  test('HostnameConfig rejects invalid hostnames, stays open for unlimited retries, and applies on valid input', async () => {
    const streams = createInkStreams();
    const mfs = new MemoryFileSystem({
      '/etc/hostname': 'oldbox\n',
      '/etc/hosts': '127.0.0.1 localhost\n',
    });
    const exec = new MockCommandExecutor();
    exec.when('hostname', () => ({ stdout: 'oldbox\n' }));
    exec.when('getent', () => ({ stdout: '127.0.1.1 fs01\n' }));
    const hm = new HostnameManager(exec, mfs, new BackupManager(mfs, '/backups'));

    let completedHostname = '';
    const inst = render(
      <HostnameConfig
        initialHostname=""
        hostnameManager={hm}
        onComplete={(h) => {
          completedHostname = h;
        }}
        onBack={() => {}}
        onExit={() => {}}
      />,
      { stdin: streams.stdin, stdout: streams.stdout, debug: true },
    );

    await new Promise((r) => setTimeout(r, 40));
    // Clear prefilled 'oldbox' using Ctrl+U, enter invalid hostname, press Enter
    await streams.sendKey('\x15');
    await streams.sendKey('-bad');
    await streams.sendKey('\r');

    let out = streams.getOutput();
    expect(out).toContain('Hostname must contain only lowercase letters');
    expect(completedHostname).toBe('');

    // Clear with Ctrl+U, enter another invalid hostname (unlimited retries!)
    await streams.sendKey('\x15');
    await streams.sendKey('localhost');
    await streams.sendKey('\r');
    expect(streams.getOutput()).toContain('reserved loopback name');

    // Now enter valid hostname
    await streams.sendKey('\x15');
    exec.when('hostname', (o) => ({ stdout: o.args[0] === '-s' ? 'fs01\n' : 'fs01\n' }));
    await streams.sendKey('fs01');
    await streams.sendKey('\r');

    out = streams.getOutput();
    expect(out).toContain('Apply Hostname Configuration');

    // Confirm with Y
    await streams.sendKey('y');
    await new Promise((r) => setTimeout(r, 40));
    expect(streams.getOutput()).toContain('Hostname configured and verified: fs01');

    await streams.sendKey('\r');
    expect(completedHostname).toBe('fs01');
    inst.unmount();
  });

  test('ActiveDirectoryConfig preserves valid fields on validation error and masks password', async () => {
    const streams = createInkStreams();
    const inst = render(
      <ActiveDirectoryConfig
        initialConfig={{
          domain: 'bad',
          netbiosName: 'CORP',
          dcIp: '192.168.1.10',
          username: 'Administrator',
          dnsConfigured: false,
          kerberosConfigured: false,
          sambaAdsConfigured: false,
          nssConfigured: false,
          pamConfigured: false,
          joined: false,
          verified: false,
        }}
        onComplete={() => {}}
        onBack={() => {}}
        onExit={() => {}}
      />,
      { stdin: streams.stdin, stdout: streams.stdout, debug: true },
    );

    await new Promise((r) => setTimeout(r, 30));
    // Move down 4 fields to Password using individual Down arrow keypresses
    await streams.sendKeys(['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B']);
    await streams.sendKey('MyPass123!');
    await streams.sendKey('\r');

    const out = streams.getOutput();
    expect(out).toContain('AD DNS domain must contain at least one dot');
    expect(out).toContain('CORP');
    expect(out).toContain('192.168.1.10');
    expect(out).not.toContain('MyPass123!');
    inst.unmount();
  });

  test('PackagePreinstall displays missing/installed status and allows retry on failure', async () => {
    const streams = createInkStreams();
    const exec = new MockCommandExecutor();
    const installed = new Set<string>(['samba', 'lvm2']);

    exec.when('dpkg-query', () => ({
      stdout: REQUIRED_PACKAGES.map((p) =>
        installed.has(p.name) ? `${p.name}\tii \t1.0` : `${p.name}\tun \t`,
      ).join('\n'),
    }));
    exec.when('apt-get', () => ({ exitCode: 1, stderr: 'APT lock held' }));

    const pm = new PackageManager(exec);
    let backCalled = false;

    const inst = render(
      <PackagePreinstall
        packageManager={pm}
        onPackagesUpdated={() => {}}
        onBack={() => {
          backCalled = true;
        }}
        onExit={() => {}}
      />,
      { stdin: streams.stdin, stdout: streams.stdout, debug: true },
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(streams.getOutput()).toContain('INSTALLED');
    expect(streams.getOutput()).toContain('MISSING');

    await streams.sendKey('\r');
    await streams.sendKey('y');
    await new Promise((r) => setTimeout(r, 60));
    expect(streams.getOutput()).toContain('Package Preinstallation Error');
    expect(streams.getOutput()).toContain('Retry');

    exec.when('apt-get', (o) => {
      if (o.args[0] === 'install') installed.add(o.args[o.args.length - 1]!);
      return { exitCode: 0 };
    });
    await streams.sendKey('r');
    await new Promise((r) => setTimeout(r, 120));
    expect(streams.getOutput()).toContain('Package preinstallation complete and verified!');

    await streams.sendKey('\r');
    expect(backCalled).toBe(true);
    inst.unmount();
  });

  test('LVMConfig requires exact WIPE keyword and blocks wrong confirmation words', async () => {
    const streams = createInkStreams();
    const exec = new MockCommandExecutor();
    exec.when('vgs', () => ({ stdout: '  ubuntu-vg\n' }));
    exec.when('lvs', (o) =>
      o.args.includes('/dev/vg_fileserver/lv_fileserver')
        ? { stdout: '/dev/vg_fileserver/lv_fileserver\n' }
        : { stdout: '/dev/ubuntu-vg/ubuntu-lv\n' },
    );
    exec.when('lsblk', () => ({
      stdout: JSON.stringify({
        blockdevices: [
          { name: 'sdb', path: '/dev/sdb', type: 'disk', size: 100000000000, model: 'DataDisk', ro: false, rm: false },
        ],
      }),
    }));
    exec.when('blkid', () => ({ exitCode: 2, stdout: '' }));
    exec.when('pvs', () => ({ stdout: '' }));
    exec.when('findmnt', () => ({ stdout: JSON.stringify({ filesystems: [] }) }));

    const lvmMgr = new LvmManager(exec, new DiskDetector(exec));
    let createdVg = '';

    const inst = render(
      <LVMConfig
        selectedDisks={['/dev/sdb']}
        totalBytes={100000000000}
        lvmManager={lvmMgr}
        onComplete={(r) => {
          createdVg = r.plan.vgName;
        }}
        onBack={() => {}}
        onExit={() => {}}
      />,
      { stdin: streams.stdin, stdout: streams.stdout, debug: true },
    );

    await new Promise((r) => setTimeout(r, 30));
    // Submit default 'fileserver' -> confirm WIPE screen
    await streams.sendKey('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(streams.getOutput()).toContain('vg_fileserver');
    expect(streams.getOutput()).toContain('lv_fileserver');

    // Type lowercase 'wipe' -> rejected!
    await streams.sendKey('wipe');
    await streams.sendKey('\r');
    expect(streams.getOutput()).toContain('type exact keyword "WIPE"');
    expect(exec.history.some((h) => h.command === 'pvcreate')).toBe(false);

    // Clear and type 'WIPE'
    await streams.sendKey('\x15');
    await streams.sendKey('WIPE');
    await streams.sendKey('\r');
    await new Promise((r) => setTimeout(r, 50));

    expect(streams.getOutput()).toContain('LVM Storage Created Successfully!');
    await streams.sendKey('\r');
    expect(createdVg).toBe('vg_fileserver');
    inst.unmount();
  });

  test('SambaConfig rejects invalid AD groups and allows retrying on the same screen', async () => {
    const streams = createInkStreams();
    const exec = new MockCommandExecutor();
    const mfs = new MemoryFileSystem({
      '/etc/samba/smb.conf': '[global]\n  security = ADS\n  workgroup = CORP\n  realm = CORP.EXAMPLE.COM\n',
    });
    mfs.setDirSync('/data/fileserver');

    exec.when('wbinfo', (o) => {
      if (o.args[0] === '--name-to-sid' && o.args[1]?.includes('finance_rw')) {
        return { stdout: 'S-1-5-21-1-2-3-2001 SID_DOM_GROUP (2)\n' };
      }
      return { exitCode: 1, stderr: 'Not found' };
    });
    exec.when('getent', (o) =>
      o.args[1]?.includes('finance_rw') ? { stdout: 'finance_rw:x:12001:\n' } : { exitCode: 2, stdout: '' },
    );

    const adVal = new AdIdentityValidator(exec);
    const sambaMgr = new SambaManager(exec, mfs, new PermissionsManager(exec, mfs), new BackupManager(mfs, '/backups'));

    const inst = render(
      <SambaConfig
        configuredMountPoints={['/data/fileserver']}
        existingShares={[]}
        adConfig={{
          domain: 'corp.example.com',
          netbiosName: 'CORP',
          dcIp: '10.0.0.10',
          username: 'Administrator',
          dnsConfigured: true,
          kerberosConfigured: true,
          sambaAdsConfigured: true,
          nssConfigured: true,
          pamConfigured: true,
          joined: true,
          verified: true,
        }}
        adValidator={adVal}
        sambaManager={sambaMgr}
        onComplete={() => {}}
        onBack={() => {}}
        onExit={() => {}}
      />,
      { stdin: streams.stdin, stdout: streams.stdout, debug: true },
    );

    await new Promise((r) => setTimeout(r, 30));
    // Select mount point '/data/fileserver'
    await streams.sendKey('\r');
    // Share details: name, description, skip subfolder, access mode, trash (default ON)
    await streams.sendKey('finance');
    await streams.sendKey('\r');
    await streams.sendKey('Finance Department');
    await streams.sendKey('\r');
    await streams.sendKey('\r');
    await streams.sendKey('\r');
    expect(streams.getOutput()).toContain('Trash (Recycle Bin)');
    await streams.sendKey('\r');

    // Now on AD identity builder: enter invalid group
    await streams.sendKey('ghost_group');
    await streams.sendKey('\r');
    await new Promise((r) => setTimeout(r, 30));

    expect(streams.getOutput()).toContain('could not resolve');

    // Clear and enter valid group 'finance_rw'
    await streams.sendKey('\x15');
    await streams.sendKey('finance_rw');
    await streams.sendKey('\r');
    await new Promise((r) => setTimeout(r, 30));

    expect(streams.getOutput()).toContain('CORP\\finance_rw(12001)');
    inst.unmount();
  });

  test('Full App navigation into Option 2 (Preinstall required packages) stays stable, installs missing packages, and updates MainMenu state', async () => {
    const streams = createInkStreams();
    const exec = new MockCommandExecutor();
    const installed = new Set<string>(['samba', 'lvm2']);

    exec.when('dpkg-query', () => ({
      stdout: REQUIRED_PACKAGES.map((p) =>
        installed.has(p.name) ? `${p.name}\tii \t1.0` : `${p.name}\tun \t`,
      ).join('\n'),
    }));
    exec.when('apt-get', (o) => {
      if (o.args[0] === 'install') {
        installed.add(o.args[o.args.length - 1]!);
      }
      return { exitCode: 0 };
    });

    const pm = new PackageManager(exec);
    const initialState = createInitialInstallationState();

    const inst = render(
      <App initialStateOverride={initialState} packageManagerOverride={pm} />,
      { stdin: streams.stdin, stdout: streams.stdout, debug: true },
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(streams.getOutput()).toContain('2. Preinstall required packages');

    // Navigate down to Option 2 and press Enter
    await streams.sendKey('\x1b[B');
    await streams.sendKey('\r');
    await new Promise((r) => setTimeout(r, 80));

    // Must settle in review phase (not stuck in infinite loading loop!)
    const reviewOut = streams.getOutput();
    expect(reviewOut).toContain('Mode B: Preinstall Required Packages');
    expect(reviewOut).toContain('2/19 installed');
    expect(reviewOut).toContain('Press [Enter] or [I] to install missing packages');

    // Press Enter -> Confirmation -> Y -> Installs missing packages -> Success
    await streams.sendKey('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(streams.getOutput()).toContain('Install Missing Required Packages');

    await streams.sendKey('y');
    await new Promise((r) => setTimeout(r, 150));
    expect(streams.getOutput()).toContain('Package preinstallation complete and verified!');

    // Return to MainMenu and verify stage [1] Package Installation is COMPLETED
    await streams.sendKey('\r');
    await new Promise((r) => setTimeout(r, 50));
    const backOut = streams.getOutput();
    expect(backOut).toContain('COMPLETED');
    inst.unmount();
  });

  test('MountConfig ignores stale previous UUID when live LV is unformatted, prompts XFS format, and mounts', async () => {
    const streams = createInkStreams();
    const exec = new MockCommandExecutor();
    const mfs = new MemoryFileSystem({ '/etc/fstab': 'UUID=root-uuid / ext4 defaults 0 1\n' });
    let formatted = false;
    let mounted = false;

    exec.when('lvs', () => ({ stdout: '/dev/vg_project/lv_project\n' }));
    exec.when('blkid', (o) => {
      if (!formatted) return { exitCode: 2, stdout: '' };
      if (o.args.includes('TYPE')) return { stdout: 'xfs\n' };
      if (o.args.includes('UUID')) return { stdout: 'new-project-uuid-9999\n' };
      return { exitCode: 2, stdout: '' };
    });
    exec.when('mkfs.xfs', () => {
      formatted = true;
      return { exitCode: 0 };
    });
    exec.when('findmnt', (o) => {
      if (o.args.includes('--mountpoint')) return { exitCode: 1, stdout: '' };
      if (o.args.includes('--target')) {
        return mounted ? { stdout: '/data/project /dev/mapper/vg_project-lv_project xfs\n' } : { exitCode: 1, stdout: '' };
      }
      return { exitCode: 1, stdout: '' };
    });
    exec.when('mount', () => {
      mounted = true;
      return { exitCode: 0 };
    });

    const fsMgr = new FilesystemManager(exec);
    const mountMgr = new MountManager(exec, mfs, fsMgr, new BackupManager(mfs, '/backups'));
    let completedUuid = '';

    const inst = render(
      <MountConfig
        lvDevicePath="/dev/vg_project/lv_project"
        initialXfsFormatted={true}
        initialUuid="stale-old-lv-uuid-140b9860"
        initialMountPoint="/data/project"
        filesystemManager={fsMgr}
        mountManager={mountMgr}
        onXfsReady={() => {}}
        onComplete={(r) => {
          completedUuid = r.uuid;
        }}
        onBack={() => {}}
        onExit={() => {}}
      />,
      { stdin: streams.stdin, stdout: streams.stdout, debug: true },
    );

    await new Promise((r) => setTimeout(r, 40));
    const promptOut = streams.getOutput();
    // Must prompt for XFS formatting instead of reusing stale-old-lv-uuid-140b9860!
    expect(promptOut).toContain('Format Logical Volume with XFS');
    expect(promptOut).not.toContain('stale-old-lv-uuid-140b9860');

    await streams.sendKey('y');
    await new Promise((r) => setTimeout(r, 40));
    expect(streams.getOutput()).toContain('XFS filesystem verified (UUID: new-project-uuid-9999)');

    // Accept /data/project and confirm mount
    await streams.sendKey('\r');
    await new Promise((r) => setTimeout(r, 30));
    await streams.sendKey('y');
    await new Promise((r) => setTimeout(r, 50));
    expect(streams.getOutput()).toContain('XFS Volume Mounted and Persisted via UUID!');

    await streams.sendKey('\r');
    expect(completedUuid).toBe('new-project-uuid-9999');
    inst.unmount();
  });

  test('SambaConfig provides live AD user/group suggestions as you type and allows removing added users/groups', async () => {
    const streams = createInkStreams();
    const exec = new MockCommandExecutor();
    const mfs = new MemoryFileSystem({
      '/etc/samba/smb.conf': '[global]\n  security = ADS\n  workgroup = PROJECT\n  realm = PROJECT.LOCAL\n',
    });
    mfs.setDirSync('/data/project');

    exec.when('wbinfo', (o) => {
      if (o.args[0] === '-g') return { stdout: 'PROJECT\\finance_rw\nPROJECT\\finance_ro\nPROJECT\\domain users\n' };
      if (o.args[0] === '-u') return { stdout: 'PROJECT\\alice\nPROJECT\\bob\n' };
      if (o.args[0] === '--name-to-sid') {
        const name = o.args[1]!;
        if (name.includes('finance_rw')) return { stdout: 'S-1-5-21-1-2-3-2001 SID_DOM_GROUP (2)\n' };
        if (name.includes('finance_ro')) return { stdout: 'S-1-5-21-1-2-3-2002 SID_DOM_GROUP (2)\n' };
        if (name.includes('alice')) return { stdout: 'S-1-5-21-1-2-3-1001 SID_USER (1)\n' };
      }
      return { exitCode: 1, stderr: 'Not found' };
    });
    exec.when('getent', (o) => {
      const name = o.args[1]!;
      if (name.includes('finance_rw')) return { stdout: 'PROJECT\\finance_rw:x:12001:\n' };
      if (name.includes('finance_ro')) return { stdout: 'PROJECT\\finance_ro:x:12002:\n' };
      if (name.includes('alice')) return { stdout: 'PROJECT\\alice:x:11001:10513::/home/PROJECT/alice:/sbin/nologin\n' };
      return { exitCode: 2, stdout: '' };
    });

    const adVal = new AdIdentityValidator(exec);
    const sambaMgr = new SambaManager(exec, mfs, new PermissionsManager(exec, mfs), new BackupManager(mfs, '/backups'));

    const inst = render(
      <SambaConfig
        configuredMountPoints={['/data/project']}
        existingShares={[]}
        adValidator={adVal}
        sambaManager={sambaMgr}
        onComplete={() => {}}
        onBack={() => {}}
        onExit={() => {}}
      />,
      { stdin: streams.stdin, stdout: streams.stdout, debug: true },
    );

    await new Promise((r) => setTimeout(r, 40));
    await streams.sendKey('\r');
    await streams.sendKey('proj');
    await streams.sendKey('\r');
    await streams.sendKey('Project Share');
    await streams.sendKey('\r');
    await streams.sendKey('\r');
    await streams.sendKey('\r');
    // Trash (Recycle Bin): accept default ON -> advance to AD identity builder
    await streams.sendKey('\r');

    // Type partial group 'fin' and check live suggestions appear!
    await streams.sendKey('fin');
    await new Promise((r) => setTimeout(r, 30));
    expect(streams.getOutput()).toContain('PROJECT\\finance_rw');
    expect(streams.getOutput()).toContain('PROJECT\\finance_ro');

    // Select first alphabetical suggestion (finance_ro) with Down arrow and press Enter to add
    await streams.sendKey('\x1b[B');
    await streams.sendKey('\r');
    await new Promise((r) => setTimeout(r, 30));
    expect(streams.getOutput()).toContain('PROJECT\\finance_ro(12002)');

    // Enter Remove Mode via Ctrl+R (\x12) and remove the added group with Delete/Backspace (\x7f)
    await streams.sendKey('\x12');
    await new Promise((r) => setTimeout(r, 25));
    expect(streams.getOutput()).toContain('MODE: REMOVE ADDED');
    await streams.sendKey('\x7f');
    await new Promise((r) => setTimeout(r, 25));
    expect(streams.getOutput()).toContain('RW Groups (0): None');
    inst.unmount();
  });

  test('PostSambaNext allows configuring another disk or finishing/exiting setup', async () => {
    const streams = createInkStreams();
    const exec = new MockCommandExecutor();
    exec.when('lsblk', () => ({
      stdout: JSON.stringify({
        blockdevices: [
          { name: 'sdc', path: '/dev/sdc', type: 'disk', size: 21474836480, model: 'SpareDisk', ro: false, rm: false },
        ],
      }),
    }));
    exec.when('blkid', () => ({ exitCode: 2, stdout: '' }));
    exec.when('pvs', () => ({ stdout: '' }));
    exec.when('findmnt', () => ({ stdout: JSON.stringify({ filesystems: [] }) }));

    let anotherCalled = false;
    let finishCalled = false;

    const inst = render(
      <PostSambaNext
        configuredMounts={[
          {
            lvDevicePath: '/dev/vg_project/lv_project',
            xfsFormatted: true,
            uuid: 'u-1',
            mountPoint: '/data/project',
            fstabUpdated: true,
            mounted: true,
          },
        ]}
        shares={[]}
        diskDetector={new DiskDetector(exec)}
        onConfigureAnotherDisk={() => {
          anotherCalled = true;
        }}
        onFinishVerification={() => {
          finishCalled = true;
        }}
        onReturnToMenu={() => {}}
        onExit={() => {}}
      />,
      { stdin: streams.stdin, stdout: streams.stdout, debug: true },
    );

    await new Promise((r) => setTimeout(r, 50));
    const out = streams.getOutput();
    expect(out).toContain('Would you like to configure another disk for Samba?');
    expect(out).toContain('/dev/sdc');

    await streams.sendKey('1');
    expect(anotherCalled).toBe(true);
    await streams.sendKey('2');
    expect(finishCalled).toBe(true);
    inst.unmount();
  });

  test('FinalSummary displays each verification section as its own switchable page without scrolling', async () => {
    const streams = createInkStreams();
    const exec = new MockCommandExecutor();
    const mfs = new MemoryFileSystem({
      '/etc/krb5.conf': '[libdefaults]\n  default_realm = PROJECT.LOCAL\n',
      '/etc/fstab': 'UUID=uuid-1 /data/project xfs defaults 0 2\n',
    });
    exec.when('hostname', () => ({ stdout: 'fs01.project.local\n' }));
    exec.when('dig', () => ({ stdout: '192.168.161.137\n' }));
    exec.when('dpkg-query', () => ({ stdout: REQUIRED_PACKAGES.map((p) => `${p.name}\tii \t1.0`).join('\n') }));
    exec.when('wbinfo', (o) => ({ stdout: o.args[0] === '-t' ? 'ok\n' : 'alice\n' }));
    exec.when('pvs', () => ({ stdout: '/dev/sdd vg_project\n' }));
    exec.when('vgs', () => ({ stdout: 'vg_project 20g\n' }));
    exec.when('lvs', () => ({ stdout: '/dev/vg_project/lv_project 20g\n' }));
    exec.when('blkid', (o) => ({ stdout: o.args.includes('TYPE') ? 'xfs\n' : 'uuid-1\n' }));
    exec.when('findmnt', () => ({ stdout: '/data/project /dev/mapper/vg_project-lv_project xfs\n' }));
    exec.when('systemctl', () => ({ stdout: 'active\n' }));

    const state = createInitialInstallationState();
    state.hostname = { hostname: 'fs01', fqdn: 'fs01.project.local', configured: true };
    state.activeDirectory = {
      domain: 'project.local',
      netbiosName: 'PROJECT',
      dcIp: '192.168.161.137',
      username: 'Administrator',
      dnsConfigured: true,
      kerberosConfigured: true,
      sambaAdsConfigured: true,
      nssConfigured: true,
      pamConfigured: true,
      joined: true,
      verified: true,
    };
    state.configuredMounts = [
      {
        lvDevicePath: '/dev/vg_project/lv_project',
        xfsFormatted: true,
        uuid: 'uuid-1',
        mountPoint: '/data/project',
        fstabUpdated: true,
        mounted: true,
      },
    ];

    const verMgr = new VerificationManager(exec, mfs, new PackageManager(exec));
    const inst = render(
      <FinalSummary
        state={state}
        verificationManager={verMgr}
        onReportGenerated={() => {}}
        onReturnToMenu={() => {}}
        onExit={() => {}}
      />,
      { stdin: streams.stdin, stdout: streams.stdout, debug: true },
    );

    await new Promise((r) => setTimeout(r, 80));
    expect(streams.getOutput()).toContain('Page: System (1/5)');

    await streams.sendKey('2');
    expect(streams.getOutput()).toContain('Page: Active Directory (2/5)');

    await streams.sendKey('3');
    expect(streams.getOutput()).toContain('Page: Storage (3/5)');

    await streams.sendKey('5');
    expect(streams.getOutput()).toContain('Page: Summary (5/5)');
    inst.unmount();
  });
});
