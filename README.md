# Ubuntu Server 24.04 Samba + Active Directory + LVM Automation TUI

A modular, interactive Terminal User Interface (TUI) application written in **TypeScript** with **React + Ink**, **Zod**, **Pino**, and **Bun.js**, compiled to a **standalone Linux executable binary** to automate end-to-end Ubuntu Server 24.04 file server deployment with Microsoft Active Directory, LVM2, XFS, and POSIX ACL-backed Samba shares.

---

## Key Capabilities

- **Main Menu & Stage Tracker**: 6-option keyboard-navigable TUI displaying live `COMPLETED` / `IN PROGRESS` / `PENDING` / `FAILED` stage statuses.
- **Two Package Installation Modes**:
  - **Mode A (Automatic)**: Inspects all 15 mandatory packages (`samba`, `samba-common-bin`, `winbind`, `libnss-winbind`, `libpam-winbind`, `krb5-user`, `realmd`, `adcli`, `lvm2`, `xfsprogs`, `acl`, `dnsutils`, `chrony`, `smbclient`, `ldap-utils`), installs only missing packages, verifies via `dpkg-query`, and allows unlimited retries on failure.
  - **Mode B (Preinstall)**: Dedicated preinstallation screen with prerequisite checks (`root`, `APT`, internet/mirror reachability), confirmation prompt, progress bar, and verification.
- **Centralized Zod Validation & Unlimited Retry**: Never exits on invalid inputs; explains rejection reasons inline, preserves valid entered fields, and offers `Retry`, `Back`, and `Exit` controls on failures.
- **Ubuntu Hostname Configuration**: Validates Linux RFC 1123 hostname rules, backs up `/etc/hostname` and `/etc/hosts`, configures `hostnamectl` and `/etc/hosts`, and verifies name resolution.
- **Active Directory + DNS + Kerberos + Winbind**:
  - Masks passwords (`*`), passes credentials only via `stdin` to `kinit`/`net`, and never logs or persists plaintext passwords, Kerberos tickets, or tokens.
  - Configures DNS (`systemd-resolved` / `netplan`, `NetworkManager`, or `/etc/resolv.conf`) after backing up existing configs and checks Domain A, DC DNS, `_kerberos._tcp`, `_ldap._tcp` SRV records, and TCP ports `88`/`389`/`445`.
  - Configures `/etc/chrony/chrony.conf`, `/etc/krb5.conf`, `/etc/samba/smb.conf` (`security = ADS`, `tdb` + `rid` idmap), `/etc/nsswitch.conf`, and PAM.
  - Joins AD and verifies with `net ads testjoin`, `wbinfo -t`, `wbinfo -u`, `wbinfo -g`, and `getent`.
- **Safe Disk Detection & LVM Storage**:
  - Scans `lsblk`, `blkid`, `pvs`, and `findmnt` and automatically excludes OS disks, mounted disks, partitioned disks, existing filesystems, LVM members, RAID members, LUKS/ZFS/Btrfs devices, optical drives, and read-only devices.
  - Multi-select eligible disks, supply a single base LVM name (e.g. `fileserver` → `vg_fileserver` / `lv_fileserver` / `/dev/vg_fileserver/lv_fileserver`), require explicit `WIPE` confirmation, revalidate live disks immediately before execution, combine all selected disks into one VG, and allocate `100%FREE` to one LV.
- **XFS & UUID Mount Configuration**:
  - Refuses to format an LV if an existing filesystem is detected.
  - Formats with `mkfs.xfs`, verifies UUID, backs up `/etc/fstab`, adds a `UUID=...` entry, mounts, and verifies with `findmnt` and `df -h`.
- **Samba Shares & POSIX ACL Consistency**:
  - Allows shares exclusively under configured LVM mount points (never arbitrary paths), prevents duplicate share names, and validates every AD user and group via `wbinfo --name-to-sid` and `getent` before acceptance.
  - Applies `chown`, `chmod 2770` (setgid), `setfacl -b`, and matching current + default POSIX ACLs (`o::---`), prevents conflicting RO/RW assignments, runs `testparm -s` before reloading Samba, and restores backup on `testparm` failure.
- **Backup, State Persistence, Resume & Structured Logging**:
  - Timestamped backups stored in `backups/` with `manifest.json` rollback support.
  - Sanitized JSON state stored atomically in `state/installation-state.json`; **Resume** revalidates live system state (`hostname`, `net ads testjoin`, `lvs`, `findmnt`, `testparm`) before skipping completed stages.
  - Structured Pino JSONL logs stored in `logs/ubuntu-fileserver.jsonl` with automatic secret redaction and an in-TUI Log Viewer.

---

## Project Structure

```text
ubuntu-fileserver/
├── src/
│   ├── index.tsx                  # CLI flags (--help, --version, --check-packages) & Ink entrypoint
│   ├── app.tsx                    # Top-level TUI router, state persistence, resume revalidation, ErrorBoundary
│   ├── components/
│   │   ├── MainMenu.tsx           # 6-option keyboard menu & status overview
│   │   ├── StageSidebar.tsx       # Stage completion/pending checklist
│   │   ├── ProgressBar.tsx        # Animated progress indicator
│   │   ├── Confirmation.tsx       # Standard & destructive ("WIPE") confirmation prompts
│   │   ├── InputField.tsx         # Interactive text & masked password input
│   │   └── ErrorScreen.tsx        # Retry / Back / Exit recovery screen
│   ├── screens/
│   │   ├── PackageMenu.tsx        # Mode A automatic install & read-only package inspection
│   │   ├── PackagePreinstall.tsx  # Mode B preinstall workflow
│   │   ├── HostnameConfig.tsx
│   │   ├── ActiveDirectoryConfig.tsx
│   │   ├── DiskSelection.tsx
│   │   ├── LVMConfig.tsx
│   │   ├── MountConfig.tsx        # XFS formatting + UUID /etc/fstab mount
│   │   ├── SambaConfig.tsx        # Mount-restricted shares + AD identity & ACL builder
│   │   ├── FinalSummary.tsx       # Full verification report
│   │   └── LogViewer.tsx          # Structured log viewer
│   ├── modules/                   # System automation & diagnostics modules
│   ├── validation/                # Zod schemas & safe retry helpers
│   ├── state/                     # State persistence & live system revalidation
│   └── types/                     # Strict TypeScript domain interfaces
├── scripts/
│   └── build.ts                   # Bun standalone binary compiler & SHA-256 / metadata generator
├── tests/                         # Unit, integration, and Ink TUI tests (`bun test`)
├── dist/                          # Compiled Linux executable, SHA-256 checksum, build-info.txt
├── logs/                          # Structured JSONL logs & sanitized final verification reports
├── backups/                       # Timestamped config backups & manifests
├── package.json
├── bun.lock
└── tsconfig.json
```

---

## Prerequisites & Installing Bun (Development Machine)

On your development machine (Ubuntu 24.04 / Linux):

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

> **Note:** Bun and Node.js are **NOT** required on the target Ubuntu Server 24.04 machine when running the compiled standalone binary.

---

## Development & Testing Commands

```bash
# 1. Install dependencies using Bun
bun install

# 2. Run TypeScript strict type checking
bun run typecheck

# 3. Run unit, integration, and Ink TUI tests
bun test

# 4. Run both typecheck and tests
bun run check

# 5. Run directly in development mode
bun run dev
# or with root privileges when configuring a live test VM:
sudo -E env "PATH=$PATH" bun run src/index.tsx
```

---

## Building the Standalone Linux Executable

Compile the standalone Linux x64 executable (embedding the Bun runtime, React/Ink, Zod, Pino, and application code):

```bash
bun run build:x64
```

This runs [`scripts/build.ts`](./scripts/build.ts) using `Bun.build({ compile: { target: 'bun-linux-x64', outfile: 'dist/ubuntu-fileserver' } })` (with a build-time stub for Ink's optional `react-devtools-core` dev import) and produces:

- `dist/ubuntu-fileserver` — Standalone ELF 64-bit Linux x86-64 executable
- `dist/ubuntu-fileserver.sha256` — SHA-256 checksum file
- `dist/build-info.txt` — Target architecture, version, build timestamp, and checksum
- `dist/README.txt` — Deployment quick start

For Linux ARM64 hosts (build and test directly on an `arm64` environment before distributing):

```bash
bun run build:arm64
```

> **Architecture Support Note:** Only `bun-linux-x64` (`dist/ubuntu-fileserver`) has been built and verified on `x86_64` Ubuntu 24.04. Build and verify `bun-linux-arm64` on an ARM64 Linux host before shipping ARM64 binaries.

---

## Deploying & Running on Ubuntu Server 24.04

Copy `dist/ubuntu-fileserver` and `dist/ubuntu-fileserver.sha256` to a fresh Ubuntu Server 24.04 machine:

```bash
sha256sum -c ubuntu-fileserver.sha256
chmod +x ./ubuntu-fileserver
sudo ./ubuntu-fileserver
```

Optional non-interactive utility flags:

```bash
./ubuntu-fileserver --help
./ubuntu-fileserver --version
./ubuntu-fileserver --check-packages
```

---

## Workflow Guide

1. **Package Preinstallation (Menu Option 2)** or **Automatic Install (Menu Option 1)**:
   - Verifies root privileges, APT availability, and network/mirror reachability.
   - Skips already-installed packages and installs missing packages with `DEBIAN_FRONTEND=noninteractive`.
2. **Hostname Configuration**:
   - Sets system hostname via `hostnamectl` and updates `127.0.1.1` in `/etc/hosts`.
3. **Active Directory Configuration**:
   - Enter AD DNS domain (e.g. `corp.example.com`), NetBIOS name (e.g. `CORP`), DC IP, Domain-Join username, and masked password.
   - Configures DNS, verifies A & SRV records (`_kerberos._tcp`, `_ldap._tcp`) and ports `88`/`389`/`445`, syncs time via `chrony`, tests `kinit`, configures Samba ADS + Winbind (`rid` backend) + NSS/PAM, and verifies `net ads testjoin`, `wbinfo -t/-u/-g`, and `getent`.
4. **Disk Selection & LVM Configuration**:
   - Select one or more eligible unused disks (`Space` to toggle, `Enter` to confirm).
   - Provide one LVM base name (e.g. `fileserver`), inspect generated `vg_fileserver` / `lv_fileserver`, and type `WIPE` to authorize `pvcreate`, `vgcreate`, and `lvcreate -l 100%FREE`.
5. **XFS & Mount Configuration**:
   - Formats the new LV with `mkfs.xfs` (refuses to overwrite existing filesystems), adds a `UUID=...` entry to `/etc/fstab`, mounts, and verifies via `findmnt` and `df -h`.
6. **Samba Share & ACL Creation**:
   - Select a configured LVM mount point (and optional subfolder), enter share details, add validated AD groups/users (verified live via `wbinfo --name-to-sid` and `getent`), apply `chown`/`chmod 2770`/`setfacl`, validate with `testparm -s`, and reload `smbd`.
7. **Resuming an Interrupted Installation**:
   - Select **4. Resume previous configuration** from the Main Menu. The application revalidates live system state against `state/installation-state.json` before skipping completed stages and jumps directly to the next incomplete stage.

---

## Troubleshooting

- **Non-root warning**: Configuration changes require root privileges. Start the binary with `sudo ./ubuntu-fileserver`.
- **APT lock or mirror failure**: Wait for unattended-upgrades to finish or run `sudo dpkg --configure -a`, then press `Retry` inside the TUI.
- **DNS or Kerberos `kinit` failure**: Verify the DC IP is reachable on UDP/TCP 53, 88, 389, 445, check SRV records (`dig _kerberos._tcp.<domain> SRV`), and check clock synchronization (`chronyc tracking`).
- **Disk excluded from selection**: OS disks, mounted partitions, RAID/LUKS/LVM members, read-only devices, and disks with existing partition tables are intentionally excluded for data safety. Inspect the exclusion reason shown in the Disk Detection table.
- **Inspecting logs & backups**: Use **Menu Option 5 (View installation logs)** or inspect `logs/ubuntu-fileserver.jsonl` and `backups/<timestamp>_<stage>/manifest.json`.
