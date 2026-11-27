import { describe, expect, test } from 'bun:test';
import { MemoryFileSystem, MockCommandExecutor } from './helpers.js';
import { ActiveDirectoryManager } from '../src/modules/activeDirectory.js';
import { AdIdentityValidator, filterAdSuggestions } from '../src/modules/adValidation.js';
import { BackupManager } from '../src/modules/backup.js';
import { DiskDetector } from '../src/modules/diskDetection.js';
import { DnsManager } from '../src/modules/dns.js';
import { FilesystemManager } from '../src/modules/filesystem.js';
import { HostnameManager } from '../src/modules/hostname.js';
import { buildLvmPlan, LvmManager } from '../src/modules/lvm.js';
import { MountManager } from '../src/modules/mount.js';
import { PackageManager, REQUIRED_PACKAGES } from '../src/modules/packageManager.js';
import { PermissionsManager, validateShareAclConsistency } from '../src/modules/permissions.js';
import { SambaManager } from '../src/modules/samba.js';
import { VerificationManager } from '../src/modules/verification.js';
import { createInitialInstallationState } from '../src/state/persistence.js';
import type { SambaShareConfig } from '../src/types/index.js';

const SAMPLE_LSBLK_JSON = JSON.stringify({
  blockdevices: [
    {
      name: 'sda',
      path: '/dev/sda',
      type: 'disk',
      size: 128849018880,
      model: 'VMware Virtual S',
      ro: false,
      rm: false,
      children: [
        { name: 'sda1', path: '/dev/sda1', type: 'part', size: 1048576, fstype: null, mountpoint: null },
        { name: 'sda2', path: '/dev/sda2', type: 'part', size: 2147483648, fstype: 'ext4', mountpoint: '/boot' },
        {
          name: 'sda3',
          path: '/dev/sda3',
          type: 'part',
          size: 126698389504,
          fstype: 'LVM2_member',
          mountpoint: null,
          children: [
            { name: 'ubuntu--vg-ubuntu--lv', path: '/dev/mapper/ubuntu--vg-ubuntu--lv', type: 'lvm', size: 126697340928, fstype: 'ext4', mountpoint: '/' },
          ],
        },
      ],
    },
    {
      name: 'sr0',
      path: '/dev/sr0',
      type: 'rom',
      size: 4080486400,
      model: 'Virtual CDRW',
      ro: false,
      rm: true,
      fstype: 'iso9660',
    },
    {
      name: 'sdb',
      path: '/dev/sdb',
      type: 'disk',
      size: 536870912000,
      model: 'NVMe Data Disk 1',
      ro: false,
      rm: false,
      fstype: null,
      mountpoint: null,
    },
    {
      name: 'sdc',
      path: '/dev/sdc',
      type: 'disk',
      size: 536870912000,
      model: 'NVMe Data Disk 2',
      ro: false,
      rm: false,
      fstype: null,
      mountpoint: null,
    },
    {
      name: 'sdd',
      path: '/dev/sdd',
      type: 'disk',
      size: 107374182400,
      model: 'Existing RAID',
      ro: false,
      rm: false,
      fstype: 'linux_raid_member',
      mountpoint: null,
    },
    {
      name: 'sde',
      path: '/dev/sde',
      type: 'disk',
      size: 107374182400,
      model: 'ReadOnly Disk',
      ro: true,
      rm: false,
      fstype: null,
      mountpoint: null,
    },
  ],
});

describe('Core Modules Integration', () => {
  test('PackageManager skips installed packages, installs only missing ones, and verifies', async () => {
    const exec = new MockCommandExecutor();
    const installedSet = new Set(['samba', 'lvm2', 'acl']);

    exec.when('dpkg-query', () => ({
      stdout: REQUIRED_PACKAGES.map((p) =>
        installedSet.has(p.name) ? `${p.name}\tii \t1.0.0` : `${p.name}\tun \t`,
      ).join('\n'),
    }));

    exec.when('apt-get', (opts) => {
      if (opts.args[0] === 'install') {
        const pkg = opts.args[opts.args.length - 1]!;
        if (pkg === 'chrony') {
          return { exitCode: 1, stderr: 'Temporary mirror failure' };
        }
        installedSet.add(pkg);
      }
      return { exitCode: 0 };
    });

    const firstRun = await new PackageManager(exec).installMissingPackages();
    expect(firstRun.success).toBe(false);
    expect(firstRun.skipped).toEqual(['samba', 'lvm2', 'acl']);
    expect(firstRun.failed).toEqual([{ name: 'chrony', reason: 'Temporary mirror failure' }]);

    // Retry succeeds only for remaining missing package (chrony)
    exec.when('apt-get', (opts) => {
      if (opts.args[0] === 'install') {
        installedSet.add(opts.args[opts.args.length - 1]!);
      }
      return { exitCode: 0 };
    });

    const secondRun = await new PackageManager(exec).installMissingPackages();
    expect(secondRun.success).toBe(true);
    expect(secondRun.installed).toEqual(['chrony']);
    expect(secondRun.verified.length).toBe(REQUIRED_PACKAGES.length);
  });

  test('HostnameManager configures /etc/hostname, /etc/hosts, verifies, and restores on failure', async () => {
    const mfs = new MemoryFileSystem({
      '/etc/hostname': 'oldhost\n',
      '/etc/hosts': '127.0.0.1 localhost\n127.0.1.1 oldhost\n',
    });
    const bm = new BackupManager(mfs, '/backups');
    const exec = new MockCommandExecutor();

    exec.when('hostname', (o) => ({ stdout: o.args[0] === '-s' ? 'fs01\n' : 'fs01.corp.example.com\n' }));
    exec.when('getent', () => ({ stdout: '127.0.1.1 fs01.corp.example.com fs01\n' }));

    const hm = new HostnameManager(exec, mfs, bm);
    const okRes = await hm.applyHostname({ hostname: 'fs01', domain: 'corp.example.com' });
    expect(okRes.success).toBe(true);
    expect(await mfs.readText('/etc/hostname')).toBe('fs01\n');
    expect(await mfs.readText('/etc/hosts')).toContain('127.0.1.1\tfs01.corp.example.com fs01');

    // Failure restores original /etc/hostname and /etc/hosts
    exec.when('hostnamectl', () => ({ exitCode: 1, stderr: 'dbus error' }));
    const failRes = await hm.applyHostname({ hostname: 'fs02' });
    expect(failRes.success).toBe(false);
    expect(await mfs.readText('/etc/hostname')).toBe('fs01\n');
  });

  test('ActiveDirectoryManager configures DNS, krb5, smb.conf, nsswitch, joins via kinit stdin, and verifies', async () => {
    const mfs = new MemoryFileSystem({
      '/etc/hosts': '127.0.0.1 localhost\n127.0.1.1 fs01\n',
      '/etc/nsswitch.conf': 'passwd: files systemd\ngroup: files systemd\n',
      '/etc/chrony/chrony.conf': 'pool ntp.ubuntu.com iburst\n',
      '/etc/resolv.conf': 'nameserver 127.0.0.53\n',
    });
    mfs.setDirSync('/etc/netplan');
    const bm = new BackupManager(mfs, '/backups');
    const exec = new MockCommandExecutor();

    exec.when('systemctl', () => ({ stdout: 'active\n' }));
    exec.when('hostname', () => ({ stdout: 'fs01\n' }));
    exec.when('dig', (o) => {
      if (o.args.includes('SRV')) return { stdout: '0 100 88 dc01.corp.example.com.\n' };
      return { stdout: '192.168.10.10\n' };
    });
    exec.when('wbinfo', (o) => {
      if (o.args[0] === '-t') return { stdout: 'checking the trust secret for domain CORP via RPC calls succeeded\n' };
      if (o.args[0] === '-u') return { stdout: 'alice\nbob\n' };
      if (o.args[0] === '-g') return { stdout: 'domain users\nfinance\n' };
      return { stdout: '' };
    });
    exec.when('getent', (o) => ({ stdout: `${o.args[1]}:x:10500:\n` }));

    const dns = new DnsManager(exec, mfs, bm);
    const ad = new ActiveDirectoryManager(exec, mfs, dns, bm);

    const res = await ad.configureAndJoin(
      {
        domain: 'corp.example.com',
        netbiosName: 'CORP',
        dcIp: '192.168.10.10',
        username: 'Administrator',
        password: 'VerySecretAdPassword!',
      },
      'fs01',
    );

    expect(res.success).toBe(true);
    expect(await mfs.readText('/etc/krb5.conf')).toContain('default_realm = CORP.EXAMPLE.COM');
    expect(await mfs.readText('/etc/samba/smb.conf')).toContain('security = ADS');
    expect(await mfs.readText('/etc/nsswitch.conf')).toContain('winbind');

    // Verify kinit received password ONLY via stdin and NEVER in argv!
    const kinitCall = exec.history.find((h) => h.command === 'kinit');
    expect(kinitCall).toBeDefined();
    expect(kinitCall!.stdin).toBe('VerySecretAdPassword!\n');
    expect(kinitCall!.args.join(' ')).not.toContain('VerySecretAdPassword!');

    // Verify .local AD domains configure unicast routing (~local and MulticastDNS=no) in systemd-resolved
    const localDnsRes = await dns.configureAdDns('project.local', '192.168.161.137');
    expect(localDnsRes.success).toBe(true);
    const resolvedDropIn = await mfs.readText('/etc/systemd/resolved.conf.d/99-ubuntu-fileserver-ad.conf');
    expect(resolvedDropIn).toContain('Domains=~project.local ~local project.local');
    expect(resolvedDropIn).toContain('MulticastDNS=no');
  });

  test('DiskDetector filters OS, optical, RAID, and read-only disks while keeping eligible unused disks', async () => {
    const exec = new MockCommandExecutor();
    exec.when('lsblk', () => ({ stdout: SAMPLE_LSBLK_JSON }));
    exec.when('blkid', () => ({ stdout: 'DEVNAME=/dev/sda2\nTYPE=ext4\n' }));
    exec.when('pvs', () => ({ stdout: '  /dev/sda3\n' }));
    exec.when('findmnt', () => ({
      stdout: JSON.stringify({
        filesystems: [
          { target: '/', source: '/dev/mapper/ubuntu--vg-ubuntu--lv', children: [{ target: '/boot', source: '/dev/sda2' }] },
        ],
      }),
    }));

    const result = await new DiskDetector(exec).detectDisks();
    expect(result.eligibleDisks.map((d) => d.path)).toEqual(['/dev/sdb', '/dev/sdc']);

    const sda = result.excludedDisks.find((d) => d.path === '/dev/sda')!;
    expect(sda.isOsDisk).toBe(true);
    expect(sda.isLvmMember).toBe(true);

    const sr0 = result.excludedDisks.find((d) => d.path === '/dev/sr0')!;
    expect(sr0.exclusionReasons.some((r) => r.includes('rom'))).toBe(true);

    const sdd = result.excludedDisks.find((d) => d.path === '/dev/sdd')!;
    expect(sdd.isRaidMember).toBe(true);

    const sde = result.excludedDisks.find((d) => d.path === '/dev/sde')!;
    expect(sde.readOnly).toBe(true);
  });

  test('LvmManager, FilesystemManager, and MountManager enforce wipe/existing-fs safeguards and configure UUID mount', async () => {
    const mfs = new MemoryFileSystem({
      '/etc/fstab': 'UUID=root-uuid / ext4 defaults 0 1\n',
    });
    const bm = new BackupManager(mfs, '/backups');
    const exec = new MockCommandExecutor();

    exec.when('lsblk', () => ({ stdout: SAMPLE_LSBLK_JSON }));
    exec.when('blkid', (o) => {
      if (o.args.includes('-o') && o.args.includes('export')) {
        return { stdout: '' };
      }
      if (o.args.includes('/dev/vg_fileserver/lv_fileserver')) {
        // Return xfs + uuid ONLY after mkfs.xfs ran
        const formatted = exec.history.some((h) => h.command === 'mkfs.xfs');
        if (!formatted) return { exitCode: 2, stdout: '' };
        if (o.args.includes('TYPE')) return { stdout: 'xfs\n' };
        if (o.args.includes('UUID')) return { stdout: 'aaaa-bbbb-cccc-dddd\n' };
      }
      return { exitCode: 2, stdout: '' };
    });
    exec.when('pvs', () => ({ stdout: '  /dev/sda3\n' }));
    exec.when('vgs', () => ({ stdout: '  ubuntu-vg\n' }));
    exec.when('lvs', (o) => {
      const created = exec.history.some((h) => h.command === 'lvcreate');
      if (o.args.includes('/dev/vg_fileserver/lv_fileserver')) {
        return created ? { stdout: '  /dev/vg_fileserver/lv_fileserver\n' } : { exitCode: 5, stdout: '' };
      }
      return { stdout: '  /dev/ubuntu-vg/ubuntu-lv\n' };
    });
    exec.when('findmnt', (o) => {
      if (o.args.includes('--mountpoint') && o.args.includes('/data/fileserver')) {
        return { exitCode: 1, stdout: '' };
      }
      if (o.args.includes('--target') && o.args.includes('/data/fileserver')) {
        const mounted = exec.history.some((h) => h.command === 'mount');
        return mounted ? { stdout: '/data/fileserver /dev/mapper/vg_fileserver-lv_fileserver xfs rw\n' } : { exitCode: 1, stdout: '' };
      }
      return { stdout: JSON.stringify({ filesystems: [{ target: '/', source: '/dev/mapper/ubuntu--vg-ubuntu--lv' }] }) };
    });
    exec.when('df', () => ({ stdout: 'Filesystem Size Used Avail Use% Mounted on\n/dev/mapper/vg_fileserver-lv_fileserver 1.0T 1G 1.0T 1% /data/fileserver\n' }));

    const detector = new DiskDetector(exec);
    const lvmMgr = new LvmManager(exec, detector);
    const plan = buildLvmPlan('fileserver', ['/dev/sdb', '/dev/sdc'], 1073741824000);

    // Rejects wrong confirmation keyword without executing pvcreate
    const badWipe = await lvmMgr.createLvmStorage(plan, 'wipe');
    expect(badWipe.success).toBe(false);
    expect(exec.history.some((h) => h.command === 'pvcreate')).toBe(false);

    // Succeeds with exact WIPE
    const lvmOk = await lvmMgr.createLvmStorage(plan, 'WIPE');
    expect(lvmOk.success).toBe(true);
    expect(lvmOk.pvCreated).toEqual(['/dev/sdb', '/dev/sdc']);

    const vgCall = exec.history.find((h) => h.command === 'vgcreate')!;
    expect(vgCall.args).toEqual(['vg_fileserver', '/dev/sdb', '/dev/sdc']);
    const lvCall = exec.history.find((h) => h.command === 'lvcreate')!;
    expect(lvCall.args).toEqual(['-y', '-l', '100%FREE', '-n', 'lv_fileserver', 'vg_fileserver']);

    // Format with XFS
    const fsMgr = new FilesystemManager(exec);
    const xfsOk = await fsMgr.formatLvWithXfs(plan.lvDevicePath);
    expect(xfsOk.success).toBe(true);
    expect(xfsOk.uuid).toBe('aaaa-bbbb-cccc-dddd');

    // Refuses to reformat already-formatted XFS volume!
    const reformatBlocked = await fsMgr.formatLvWithXfs(plan.lvDevicePath);
    expect(reformatBlocked.success).toBe(false);
    expect(reformatBlocked.alreadyFormatted).toBe(true);

    // Mount via UUID
    const mountMgr = new MountManager(exec, mfs, fsMgr, bm);
    const mountOk = await mountMgr.configureAndMount(plan.lvDevicePath, '/data/fileserver');
    expect(mountOk.success).toBe(true);
    expect(mountOk.findmntVerified).toBe(true);
    expect(await mfs.readText('/etc/fstab')).toContain('UUID=aaaa-bbbb-cccc-dddd\t/data/fileserver\txfs');
  });

  test('AdIdentityValidator, PermissionsManager, SambaManager, and VerificationManager enforce AD & ACL consistency', async () => {
    const mfs = new MemoryFileSystem({
      '/etc/samba/smb.conf': '[global]\n   workgroup = CORP\n   security = ADS\n   realm = CORP.EXAMPLE.COM\n',
      '/etc/krb5.conf': '[libdefaults]\n    default_realm = CORP.EXAMPLE.COM\n',
      '/etc/fstab': 'UUID=aaaa-bbbb /data/fileserver xfs defaults 0 2\n',
    });
    mfs.setDirSync('/data/fileserver');
    const bm = new BackupManager(mfs, '/backups');
    const exec = new MockCommandExecutor();

    exec.when('wbinfo', (o) => {
      if (o.args[0] === '--name-to-sid') {
        const target = o.args[1]!;
        if (target.includes('finance_rw')) return { stdout: 'S-1-5-21-1-2-3-2001 SID_DOM_GROUP (2)\n' };
        if (target.includes('auditors_ro')) return { stdout: 'S-1-5-21-1-2-3-2002 SID_DOM_GROUP (2)\n' };
        if (target.includes('alice')) return { stdout: 'S-1-5-21-1-2-3-1001 SID_USER (1)\n' };
        return { exitCode: 1, stderr: 'WBC_ERR_DOMAIN_NOT_FOUND' };
      }
      if (o.args[0] === '-t') return { stdout: 'trust ok\n' };
      if (o.args[0] === '-u') return { stdout: 'alice\n' };
      if (o.args[0] === '-g') return { stdout: 'finance_rw\nauditors_ro\n' };
      return { stdout: '' };
    });
    exec.when('getent', (o) => {
      const name = o.args[1]!;
      if (name.includes('finance_rw')) return { stdout: 'finance_rw:x:12001:\n' };
      if (name.includes('auditors_ro')) return { stdout: 'auditors_ro:x:12002:\n' };
      if (name.includes('alice')) return { stdout: 'alice:x:11001:10513::/home/CORP/alice:/sbin/nologin\n' };
      return { exitCode: 2, stdout: '' };
    });
    exec.when('getfacl', () => ({ stdout: '# file: /data/fileserver/finance\nuser::rwx\ngroup::rwx\nother::---\n' }));
    exec.when('systemctl', () => ({ stdout: 'active\n' }));
    exec.when('hostname', () => ({ stdout: 'fs01.corp.example.com\n' }));
    exec.when('dig', () => ({ stdout: '192.168.10.10\n' }));
    exec.when('dpkg-query', () => ({ stdout: REQUIRED_PACKAGES.map((p) => `${p.name}\tii \t1.0`).join('\n') }));
    exec.when('pvs', () => ({ stdout: '/dev/sdb vg_fileserver\n' }));
    exec.when('vgs', () => ({ stdout: 'vg_fileserver 1.0t\n' }));
    exec.when('lvs', () => ({ stdout: '/dev/vg_fileserver/lv_fileserver 1.0t\n' }));
    exec.when('blkid', (o) => ({ stdout: o.args.includes('TYPE') ? 'xfs\n' : 'aaaa-bbbb\n' }));
    exec.when('findmnt', () => ({ stdout: '/data/fileserver /dev/mapper/vg_fileserver-lv_fileserver xfs\n' }));

    const idVal = new AdIdentityValidator(exec);
    const badGroup = await idVal.validateIdentity('nonexistent_group', 'group', 'CORP');
    expect(badGroup.valid).toBe(false);

    // Rejects user entered where group was expected
    const wrongKind = await idVal.validateIdentity('alice', 'group', 'CORP');
    expect(wrongKind.valid).toBe(false);

    const rwGrp = await idVal.validateIdentity('finance_rw', 'group', 'CORP');
    const roGrp = await idVal.validateIdentity('auditors_ro', 'group', 'CORP');
    const roUsr = await idVal.validateIdentity('alice', 'user', 'CORP');
    expect(rwGrp.valid && roGrp.valid && roUsr.valid).toBe(true);

    const share: SambaShareConfig = {
      name: 'finance',
      description: 'Finance Share',
      baseMountPoint: '/data/fileserver',
      sharePath: '/data/fileserver/finance',
      accessMode: 'read_write',
      readWriteGroups: [rwGrp.identity!],
      readOnlyGroups: [roGrp.identity!],
      readWriteUsers: [],
      readOnlyUsers: [roUsr.identity!],
      createdAt: new Date().toISOString(),
    };

    // Blocks paths outside configured LVM mount points
    const rogueShare: SambaShareConfig = { ...share, sharePath: '/etc/shadow' };
    expect(validateShareAclConsistency(rogueShare).length).toBeGreaterThan(0);

    const permMgr = new PermissionsManager(exec, mfs);
    const sambaMgr = new SambaManager(exec, mfs, permMgr, bm);

    const applyRes = await sambaMgr.applySharesAndReload([share], ['/data/fileserver']);
    expect(applyRes.success).toBe(true);
    expect(applyRes.testparmPassed).toBe(true);
    const smbText = await mfs.readText('/etc/samba/smb.conf');
    expect(smbText).toContain('[finance]');
    expect(smbText).toContain('write list = "@CORP\\finance_rw"');
    expect(smbText).toContain('read list = "@CORP\\auditors_ro", "CORP\\alice"');

    // Run final verification
    const state = createInitialInstallationState();
    state.hostname = { hostname: 'fs01', fqdn: 'fs01.corp.example.com', configured: true };
    state.activeDirectory = {
      domain: 'corp.example.com',
      netbiosName: 'CORP',
      dcIp: '192.168.10.10',
      username: 'Administrator',
      dnsConfigured: true,
      kerberosConfigured: true,
      sambaAdsConfigured: true,
      nssConfigured: true,
      pamConfigured: true,
      joined: true,
      verified: true,
    };
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
      uuid: 'aaaa-bbbb',
      mountPoint: '/data/fileserver',
      fstabUpdated: true,
      mounted: true,
    };
    state.samba = { shares: [share], testparmPassed: true, servicesReloaded: true };

    const verMgr = new VerificationManager(exec, mfs, new PackageManager(exec));
    const report = await verMgr.runFullVerification(state);
    expect(report.overallPassed).toBe(true);
    expect(report.summaryText).toContain('[PASS]');

    // Test live AD identity listing & suggestion filtering
    const listedGroups = await idVal.listAvailableIdentities('group');
    expect(listedGroups).toEqual(['auditors_ro', 'finance_rw']);
    const listedUsers = await idVal.listAvailableIdentities('user');
    expect(listedUsers).toEqual(['alice']);

    const suggestions = filterAdSuggestions(
      ['PROJECT\\Domain Users', 'PROJECT\\finance_rw', 'PROJECT\\finance_ro', 'PROJECT\\hr_users'],
      'fin',
      ['PROJECT\\finance_rw'],
    );
    expect(suggestions).toEqual(['PROJECT\\finance_ro']);
  });
});
