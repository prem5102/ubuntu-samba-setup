import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { LogEntry } from '../types/index.js';

export interface AppPaths {
  baseDir: string;
  logsDir: string;
  backupsDir: string;
  stateDir: string;
  logFile: string;
  stateFile: string;
}

let cachedPaths: AppPaths | null = null;

function isDirWritable(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveAppPaths(): AppPaths {
  if (cachedPaths) return cachedPaths;

  const envBase = process.env['UBUNTU_FILESERVER_DATA_DIR'];
  let baseDir = envBase && envBase.trim().length > 0 ? path.resolve(envBase) : process.cwd();

  if (!envBase && !isDirWritable(path.join(baseDir, 'logs'))) {
    const fallback = '/var/lib/ubuntu-fileserver';
    if (isDirWritable(fallback)) {
      baseDir = fallback;
    } else {
      baseDir = '/tmp/ubuntu-fileserver';
    }
  }

  const logsDir = path.join(baseDir, 'logs');
  const backupsDir = path.join(baseDir, 'backups');
  const stateDir = path.join(baseDir, 'state');

  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  cachedPaths = {
    baseDir,
    logsDir,
    backupsDir,
    stateDir,
    logFile: path.join(logsDir, 'ubuntu-fileserver.jsonl'),
    stateFile: path.join(stateDir, 'installation-state.json'),
  };

  return cachedPaths;
}

export function resetAppPathsCache(): void {
  cachedPaths = null;
}

const SECRET_PATTERNS: RegExp[] = [
  /(password\s*[:=]\s*)([^\s'"]+|'[^']*'|"[^"]*")/gi,
  /(PASSWD\s*=\s*)([^\s]+)/gi,
  /(secret\s*[:=]\s*)([^\s'"]+)/gi,
  /(token\s*[:=]\s*)([^\s'"]+)/gi,
  /(krbtgt[^\s]*)/gi,
];

export function sanitizeLogString(input: string, extraSecrets: string[] = []): string {
  let out = input;
  for (const secret of extraSecrets) {
    if (secret && secret.length > 0) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '$1[REDACTED]');
  }
  return out;
}

const SENSITIVE_KEY_RE = /^(password|pass|passwd|secret|token|ticket|krb5ticket|credential|credentials|auth)$/i;

export function sanitizeLogValue(value: unknown, extraSecrets: string[] = []): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeLogString(value, extraSecrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item, extraSecrets));
  if (typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        clean[key] = '[REDACTED]';
      } else {
        clean[key] = sanitizeLogValue(val, extraSecrets);
      }
    }
    return clean;
  }
  return value;
}

function createPinoInstance(logFilePath: string): pino.Logger {
  const destination = pino.destination({
    dest: logFilePath,
    mkdir: true,
    sync: true,
  });

  return pino(
    {
      level: process.env['LOG_LEVEL'] ?? 'info',
      redact: {
        paths: [
          'password',
          'pass',
          'passwd',
          'secret',
          'token',
          'ticket',
          'credentials',
          '*.password',
          '*.pass',
          '*.secret',
          '*.token',
          '*.ticket',
          '*.credentials',
        ],
        censor: '[REDACTED]',
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
    },
    destination,
  );
}

let loggerInstance: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (!loggerInstance) {
    const paths = resolveAppPaths();
    loggerInstance = createPinoInstance(paths.logFile);
  }
  return loggerInstance;
}

export function resetLogger(): void {
  loggerInstance = null;
}

export function logEvent(
  level: 'info' | 'warn' | 'error' | 'debug',
  moduleName: string,
  message: string,
  details?: Record<string, unknown>,
  extraSecrets: string[] = [],
): void {
  const logger = getLogger();
  const cleanMsg = sanitizeLogString(message, extraSecrets);
  const cleanDetails = details ? (sanitizeLogValue(details, extraSecrets) as Record<string, unknown>) : {};
  logger[level]({ module: moduleName, ...cleanDetails }, cleanMsg);
}

export async function readLogEntries(limit = 200, levelFilter?: string): Promise<LogEntry[]> {
  const paths = resolveAppPaths();
  const file = Bun.file(paths.logFile);
  if (!(await file.exists())) {
    return [];
  }
  const content = await file.text();
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const entries: LogEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const level = typeof parsed['level'] === 'string' ? parsed['level'] : 'info';
      if (levelFilter && levelFilter !== 'all' && level !== levelFilter) {
        continue;
      }
      const time = typeof parsed['time'] === 'string' ? parsed['time'] : '';
      const msg = typeof parsed['msg'] === 'string' ? parsed['msg'] : '';
      const moduleName = typeof parsed['module'] === 'string' ? parsed['module'] : undefined;
      const details: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k !== 'level' && k !== 'time' && k !== 'msg' && k !== 'module' && k !== 'pid' && k !== 'hostname') {
          details[k] = v;
        }
      }
      entries.push({
        level,
        time,
        msg,
        module: moduleName,
        details: Object.keys(details).length > 0 ? details : undefined,
      });
    } catch {
      entries.push({
        level: 'raw',
        time: '',
        msg: line,
      });
    }
  }

  if (entries.length <= limit) return entries;
  return entries.slice(entries.length - limit);
}
