import { systemCommandExecutor } from './commandExecutor.js';
import { logEvent } from './logger.js';
import type { AdIdentityKind, CommandExecutor, ResolvedAdIdentity } from '../types/index.js';
import { adIdentityInputSchema } from '../validation/schemas.js';
import { validateInput } from '../validation/retry.js';

export interface AdIdentityResolutionResult {
  valid: boolean;
  identity?: ResolvedAdIdentity;
  error?: string;
}

export function parseWbinfoSidOutput(stdout: string): { sid: string; sidTypeCode?: number; sidTypeLabel?: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // Typical output: "S-1-5-21-123456-789-1001 SID_USER (1)" or "S-1-5-21-...-513 SID_DOM_GROUP (2)"
  const match = trimmed.match(/^(S-\d+-\d+(?:-\d+)+)\s+(\S+)(?:\s+\((\d+)\))?/);
  if (!match) return null;
  return {
    sid: match[1]!,
    sidTypeLabel: match[2],
    sidTypeCode: match[3] ? Number.parseInt(match[3], 10) : undefined,
  };
}

export function parseGetentNumericId(stdout: string): { resolvedName: string; numericId: number } | null {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const cols = line.split(':');
  // passwd: name:x:uid:gid:...
  // group:  name:x:gid:members
  if (cols.length < 3) return null;
  const numericId = Number.parseInt(cols[2]!, 10);
  if (!Number.isInteger(numericId) || numericId < 0) return null;
  return {
    resolvedName: cols[0]!,
    numericId,
  };
}

export function filterAdSuggestions(
  candidates: string[],
  query: string,
  alreadySelected: string[],
  limit = 6,
): string[] {
  const excludedSet = new Set<string>();
  for (const existing of alreadySelected) {
    const lower = existing.toLowerCase();
    excludedSet.add(lower);
    const shortPart = lower.includes('\\') ? lower.split('\\')[1]! : lower;
    excludedSet.add(shortPart);
  }

  const q = query.trim().toLowerCase();
  const prefixMatches: string[] = [];
  const substringMatches: string[] = [];

  for (const cand of candidates) {
    const lower = cand.toLowerCase();
    const shortPart = lower.includes('\\') ? lower.split('\\')[1]! : lower;
    if (excludedSet.has(lower) || excludedSet.has(shortPart)) {
      continue;
    }

    if (!q) {
      prefixMatches.push(cand);
      continue;
    }

    if (shortPart.startsWith(q) || lower.startsWith(q)) {
      prefixMatches.push(cand);
    } else if (shortPart.includes(q) || lower.includes(q)) {
      substringMatches.push(cand);
    }
  }

  return [...prefixMatches, ...substringMatches].slice(0, limit);
}

export class AdIdentityValidator {
  constructor(private readonly executor: CommandExecutor = systemCommandExecutor) {}

  async listAvailableIdentities(kind: AdIdentityKind): Promise<string[]> {
    const flag = kind === 'user' ? '-u' : '-g';
    const res = await this.executor.run({
      command: 'wbinfo',
      args: [flag],
      timeoutMs: 5000,
    });
    if (res.exitCode !== 0 || !res.stdout.trim()) {
      return [];
    }
    const unique = new Set<string>();
    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) unique.add(trimmed);
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }

  async validateIdentity(
    rawInput: string,
    expectedKind: AdIdentityKind,
    netbiosName?: string,
  ): Promise<AdIdentityResolutionResult> {
    const schemaCheck = validateInput(adIdentityInputSchema, rawInput);
    if (!schemaCheck.success || !schemaCheck.data) {
      return {
        valid: false,
        error: schemaCheck.errorSummary ?? 'Invalid AD identity syntax.',
      };
    }

    const input = schemaCheck.data;
    const candidates = [input];
    if (netbiosName && !input.includes('\\') && !input.includes('@')) {
      candidates.push(`${netbiosName.toUpperCase()}\\${input}`);
    }

    let lastFailure = `AD ${expectedKind} "${input}" could not be resolved through Winbind.`;

    for (const candidate of candidates) {
      const sidRes = await this.executor.run({
        command: 'wbinfo',
        args: ['--name-to-sid', candidate],
      });

      if (sidRes.exitCode !== 0) {
        lastFailure = `wbinfo could not resolve "${candidate}" to an Active Directory SID.`;
        continue;
      }

      const parsedSid = parseWbinfoSidOutput(sidRes.stdout);
      if (!parsedSid) {
        lastFailure = `Unexpected wbinfo SID output for "${candidate}".`;
        continue;
      }

      // Check SID type matches user (1) vs group (2, 4, 5)
      if (expectedKind === 'user' && parsedSid.sidTypeCode !== undefined && parsedSid.sidTypeCode !== 1) {
        return {
          valid: false,
          error: `"${input}" resolved to a ${parsedSid.sidTypeLabel ?? 'non-user'} object, not an AD user.`,
        };
      }
      if (
        expectedKind === 'group' &&
        parsedSid.sidTypeCode !== undefined &&
        parsedSid.sidTypeCode !== 2 &&
        parsedSid.sidTypeCode !== 4 &&
        parsedSid.sidTypeCode !== 5
      ) {
        return {
          valid: false,
          error: `"${input}" resolved to a ${parsedSid.sidTypeLabel ?? 'non-group'} object, not an AD group.`,
        };
      }

      const getentDb = expectedKind === 'user' ? 'passwd' : 'group';
      let getentRes = await this.executor.run({
        command: 'getent',
        args: [getentDb, candidate],
      });

      // If DOMAIN\name didn't match getent because winbind use default domain = yes, try plain short name
      if (getentRes.exitCode !== 0 && candidate.includes('\\')) {
        const shortPart = candidate.split('\\')[1]!;
        getentRes = await this.executor.run({
          command: 'getent',
          args: [getentDb, shortPart],
        });
      }

      if (getentRes.exitCode !== 0) {
        lastFailure = `"${candidate}" exists in AD (${parsedSid.sid}) but did not resolve via NSS (\`getent ${getentDb}\`). Check Winbind and nsswitch.conf.`;
        continue;
      }

      const parsedId = parseGetentNumericId(getentRes.stdout);
      if (!parsedId) {
        lastFailure = `Failed to extract numeric ${expectedKind === 'user' ? 'UID' : 'GID'} for "${candidate}" from NSS.`;
        continue;
      }

      const normalized = netbiosName && !parsedId.resolvedName.includes('\\')
        ? `${netbiosName.toUpperCase()}\\${parsedId.resolvedName}`
        : parsedId.resolvedName;

      logEvent('info', 'adValidation', `Validated AD ${expectedKind}`, {
        input,
        normalized,
        sid: parsedSid.sid,
        numericId: parsedId.numericId,
      });

      return {
        valid: true,
        identity: {
          input,
          normalized,
          kind: expectedKind,
          sid: parsedSid.sid,
          numericId: parsedId.numericId,
        },
      };
    }

    logEvent('warn', 'adValidation', `Rejected unresolved AD ${expectedKind}`, {
      input,
      reason: lastFailure,
    });

    return {
      valid: false,
      error: lastFailure,
    };
  }
}
