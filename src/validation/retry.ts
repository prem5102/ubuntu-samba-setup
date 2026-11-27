import type { ZodType, ZodTypeDef } from 'zod';

export interface ValidationOutcome<T> {
  success: boolean;
  data?: T;
  errorSummary?: string;
  fieldErrors: Record<string, string>;
}

export function validateInput<Output, Def extends ZodTypeDef = ZodTypeDef, Input = Output>(
  schema: ZodType<Output, Def, Input>,
  rawInput: unknown,
): ValidationOutcome<Output> {
  const result = schema.safeParse(rawInput);
  if (result.success) {
    return {
      success: true,
      data: result.data,
      fieldErrors: {},
    };
  }

  const fieldErrors: Record<string, string> = {};
  const messages: string[] = [];

  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_root';
    if (!fieldErrors[key]) {
      fieldErrors[key] = issue.message;
    }
    const label = key === '_root' ? '' : `${key}: `;
    messages.push(`${label}${issue.message}`);
  }

  return {
    success: false,
    errorSummary: messages[0] ?? 'Validation failed.',
    fieldErrors,
  };
}

export interface RetryAttemptRecord {
  attempt: number;
  timestamp: string;
  error: string;
}

export interface SafeOperationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
  recoverable: boolean;
  attempts: number;
}

/**
 * Wraps an operation so expected exceptions never crash the TUI.
 * Never automatically retries operations; caller decides whether user requests Retry/Back/Exit.
 */
export async function runSafely<T>(
  operation: () => Promise<T>,
  fallbackError = 'Unexpected operation error.',
): Promise<SafeOperationResult<T>> {
  try {
    const value = await operation();
    return {
      ok: true,
      value,
      recoverable: true,
      attempts: 1,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : fallbackError;
    return {
      ok: false,
      error: msg,
      recoverable: true,
      attempts: 1,
    };
  }
}

export function formatPreconditionError(label: string, reasons: string[]): string {
  return `Precondition check failed for ${label}: ${reasons.join('; ')}`;
}
