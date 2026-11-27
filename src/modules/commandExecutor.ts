import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { CommandExecutor, CommandOptions, CommandResult, FileSystemAdapter } from '../types/index.js';
import { logEvent, sanitizeLogString } from './logger.js';

const DEFAULT_TIMEOUT_MS = 120_000;

export function sanitizeArgsForLog(args: string[], redactIndices: number[] = []): string[] {
  const indexSet = new Set(redactIndices);
  return args.map((arg, idx) => (indexSet.has(idx) ? '[REDACTED]' : sanitizeLogString(arg)));
}

export class BunCommandExecutor implements CommandExecutor {
  async run(options: CommandOptions): Promise<CommandResult> {
    const start = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const safeArgs = sanitizeArgsForLog(options.args, options.redactArgs);

    if (options.command.includes('\0') || options.args.some((a) => a.includes('\0'))) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'Null byte detected in command or arguments',
        timedOut: false,
        command: options.command,
        args: safeArgs,
        durationMs: 0,
        errorMessage: 'Invalid command parameters',
      };
    }

    logEvent('debug', 'commandExecutor', `Executing: ${options.command}`, {
      command: options.command,
      args: safeArgs,
      hasStdin: Boolean(options.stdin),
    });

    try {
      const proc = Bun.spawn([options.command, ...options.args], {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        stdin: options.stdin !== undefined ? new Response(options.stdin) : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill('SIGTERM');
          setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // Ignore already-exited process
            }
          }, 2000);
        } catch {
          // Ignore already-exited process
        }
      }, timeoutMs);

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);

      const durationMs = Date.now() - start;

      if (exitCode !== 0 || timedOut) {
        logEvent('warn', 'commandExecutor', `Command exited with code ${exitCode}`, {
          command: options.command,
          args: safeArgs,
          exitCode,
          timedOut,
          durationMs,
          stderr: options.redactOutput ? '[REDACTED]' : stderr.slice(0, 1000),
        });
      } else {
        logEvent('info', 'commandExecutor', `Command succeeded: ${options.command}`, {
          command: options.command,
          args: safeArgs,
          exitCode,
          durationMs,
        });
      }

      return {
        exitCode: timedOut ? 124 : exitCode,
        stdout,
        stderr,
        timedOut,
        command: options.command,
        args: safeArgs,
        durationMs,
        errorMessage: timedOut ? `Command timed out after ${timeoutMs}ms` : undefined,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      logEvent('error', 'commandExecutor', `Command spawn failed: ${options.command}`, {
        command: options.command,
        args: safeArgs,
        durationMs,
        error: message,
      });
      return {
        exitCode: 127,
        stdout: '',
        stderr: message,
        timedOut: false,
        command: options.command,
        args: safeArgs,
        durationMs,
        errorMessage: message,
      };
    }
  }

  async commandExists(binaryName: string): Promise<boolean> {
    if (Bun.which(binaryName) !== null) return true;
    const extraDirs = ['/usr/sbin', '/sbin', '/usr/local/sbin', '/usr/bin', '/bin'];
    for (const dir of extraDirs) {
      try {
        await fs.access(path.join(dir, binaryName));
        return true;
      } catch {
        // Continue checking
      }
    }
    return false;
  }

  async isRoot(): Promise<boolean> {
    if (typeof process.getuid === 'function') {
      return process.getuid() === 0;
    }
    const res = await this.run({ command: 'id', args: ['-u'] });
    return res.exitCode === 0 && res.stdout.trim() === '0';
  }

  async checkTcp(host: string, port: number, timeoutMs = 4000): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.connect(port, host);
    });
  }
}

export class BunFileSystemAdapter implements FileSystemAdapter {
  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.lstat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async isDirectory(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async isSymlink(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.lstat(filePath);
      return stat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async readText(filePath: string): Promise<string> {
    return await Bun.file(filePath).text();
  }

  async writeText(filePath: string, content: string, mode?: number): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await Bun.write(filePath, content);
    if (mode !== undefined) {
      await fs.chmod(filePath, mode);
    }
  }

  async mkdir(dirPath: string, mode?: number): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true, mode });
  }

  async readdir(dirPath: string): Promise<string[]> {
    return await fs.readdir(dirPath);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }

  async unlink(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  async readlink(filePath: string): Promise<string> {
    return await fs.readlink(filePath);
  }

  async statMode(filePath: string): Promise<number | null> {
    try {
      const stat = await fs.lstat(filePath);
      return stat.mode & 0o7777;
    } catch {
      return null;
    }
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    await fs.chmod(filePath, mode);
  }
}

export const systemCommandExecutor = new BunCommandExecutor();
export const systemFileSystem = new BunFileSystemAdapter();
