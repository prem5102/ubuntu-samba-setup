import path from 'node:path';
import type { CommandExecutor, CommandOptions, CommandResult, FileSystemAdapter } from '../src/types/index.js';

export type CommandHandler = (options: CommandOptions) => Partial<CommandResult> | Promise<Partial<CommandResult>>;

export class MockCommandExecutor implements CommandExecutor {
  public history: CommandOptions[] = [];
  public root = true;
  public existingCommands = new Set<string>([
    'apt-get',
    'dpkg-query',
    'dpkg',
    'hostnamectl',
    'hostname',
    'getent',
    'systemctl',
    'resolvectl',
    'ip',
    'dig',
    'kinit',
    'kdestroy',
    'testparm',
    'net',
    'wbinfo',
    'pam-auth-update',
    'chronyc',
    'lsblk',
    'blkid',
    'pvs',
    'vgs',
    'lvs',
    'pvcreate',
    'vgcreate',
    'lvcreate',
    'mkfs.xfs',
    'findmnt',
    'mount',
    'df',
    'chown',
    'chmod',
    'setfacl',
    'getfacl',
  ]);
  public tcpReachable = new Map<string, boolean>();
  private handlers: Array<{
    match: (opts: CommandOptions) => boolean;
    handler: CommandHandler;
  }> = [];

  when(command: string, handler: CommandHandler): this;
  when(match: (opts: CommandOptions) => boolean, handler: CommandHandler): this;
  when(cmdOrMatch: string | ((opts: CommandOptions) => boolean), handler: CommandHandler): this {
    const match = typeof cmdOrMatch === 'string' ? (opts: CommandOptions) => opts.command === cmdOrMatch : cmdOrMatch;
    this.handlers.unshift({ match, handler });
    return this;
  }

  async run(options: CommandOptions): Promise<CommandResult> {
    this.history.push(options);
    for (const entry of this.handlers) {
      if (entry.match(options)) {
        const res = await entry.handler(options);
        return {
          exitCode: res.exitCode ?? 0,
          stdout: res.stdout ?? '',
          stderr: res.stderr ?? '',
          timedOut: res.timedOut ?? false,
          command: options.command,
          args: options.args,
          durationMs: res.durationMs ?? 1,
          errorMessage: res.errorMessage,
        };
      }
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      command: options.command,
      args: options.args,
      durationMs: 1,
    };
  }

  async commandExists(binaryName: string): Promise<boolean> {
    return this.existingCommands.has(binaryName);
  }

  async isRoot(): Promise<boolean> {
    return this.root;
  }

  async checkTcp(host: string, port: number): Promise<boolean> {
    const key = `${host}:${port}`;
    if (this.tcpReachable.has(key)) return this.tcpReachable.get(key)!;
    return true;
  }
}

interface FsEntry {
  kind: 'file' | 'dir' | 'symlink';
  content?: string;
  target?: string;
  mode: number;
}

export class MemoryFileSystem implements FileSystemAdapter {
  private entries = new Map<string, FsEntry>();

  constructor(initialFiles: Record<string, string> = {}) {
    this.entries.set('/', { kind: 'dir', mode: 0o755 });
    for (const [filePath, content] of Object.entries(initialFiles)) {
      this.setFileSync(filePath, content);
    }
  }

  setFileSync(filePath: string, content: string, mode = 0o644): void {
    const norm = path.posix.normalize(filePath);
    this.ensureParentsSync(path.posix.dirname(norm));
    this.entries.set(norm, { kind: 'file', content, mode });
  }

  setSymlinkSync(filePath: string, target: string): void {
    const norm = path.posix.normalize(filePath);
    this.ensureParentsSync(path.posix.dirname(norm));
    this.entries.set(norm, { kind: 'symlink', target, content: '', mode: 0o777 });
  }

  setDirSync(dirPath: string, mode = 0o755): void {
    this.ensureParentsSync(path.posix.normalize(dirPath), mode);
  }

  private ensureParentsSync(dirPath: string, mode = 0o755): void {
    const parts = dirPath.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      if (!this.entries.has(cur)) {
        this.entries.set(cur, { kind: 'dir', mode });
      }
    }
  }

  async exists(filePath: string): Promise<boolean> {
    return this.entries.has(path.posix.normalize(filePath));
  }

  async isDirectory(filePath: string): Promise<boolean> {
    return this.entries.get(path.posix.normalize(filePath))?.kind === 'dir';
  }

  async isSymlink(filePath: string): Promise<boolean> {
    return this.entries.get(path.posix.normalize(filePath))?.kind === 'symlink';
  }

  async readText(filePath: string): Promise<string> {
    const entry = this.entries.get(path.posix.normalize(filePath));
    if (!entry) throw new Error(`ENOENT: ${filePath}`);
    return entry.content ?? '';
  }

  async writeText(filePath: string, content: string, mode = 0o644): Promise<void> {
    this.setFileSync(filePath, content, mode);
  }

  async mkdir(dirPath: string, mode = 0o755): Promise<void> {
    this.setDirSync(dirPath, mode);
  }

  async readdir(dirPath: string): Promise<string[]> {
    const norm = path.posix.normalize(dirPath);
    const prefix = norm === '/' ? '/' : `${norm}/`;
    const children = new Set<string>();
    for (const key of this.entries.keys()) {
      if (key !== norm && key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const firstSeg = rest.split('/')[0];
        if (firstSeg) children.add(firstSeg);
      }
    }
    return Array.from(children).sort();
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const content = await this.readText(src);
    const mode = (await this.statMode(src)) ?? 0o644;
    this.setFileSync(dest, content, mode);
  }

  async unlink(filePath: string): Promise<void> {
    this.entries.delete(path.posix.normalize(filePath));
  }

  async readlink(filePath: string): Promise<string> {
    const entry = this.entries.get(path.posix.normalize(filePath));
    if (!entry || entry.kind !== 'symlink') throw new Error(`Not a symlink: ${filePath}`);
    return entry.target ?? '';
  }

  async statMode(filePath: string): Promise<number | null> {
    return this.entries.get(path.posix.normalize(filePath))?.mode ?? null;
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    const entry = this.entries.get(path.posix.normalize(filePath));
    if (!entry) throw new Error(`ENOENT: ${filePath}`);
    entry.mode = mode;
  }
}
