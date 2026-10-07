export interface RetryPolicy {
  baseDelayMs?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

export const MIN_POLL_DELAY_MS = 750;

function finiteRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

/** Parse both Retry-After delta seconds and HTTP dates; invalid values stay unknown. */
export function parseRetryAfter(value: string | undefined | null, nowMs = Date.now()): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const header = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(header)) {
    const milliseconds = Number(header) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  // Reject negative numbers before Date.parse can interpret them as dates.
  if (/^[+-]?\d+(?:\.\d+)?$/u.test(header)) return undefined;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : undefined;
}

/**
 * attempt starts at 1. Local retries are bounded; the server's Retry-After is
 * always a minimum, even when it exceeds our local cap. Jitter never lowers it.
 */
export function retryDelayMs(attempt: number, policy: RetryPolicy = {}, retryAfterMs?: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('Retry attempt must be at least 1');
  const minimum = finiteRange(policy.minDelayMs ?? MIN_POLL_DELAY_MS, MIN_POLL_DELAY_MS, Number.MAX_SAFE_INTEGER, 'Minimum retry delay');
  const base = finiteRange(policy.baseDelayMs ?? 1200, minimum, Number.MAX_SAFE_INTEGER, 'Base retry delay');
  const maximum = finiteRange(policy.maxDelayMs ?? 15_000, base, Number.MAX_SAFE_INTEGER, 'Maximum retry delay');
  const jitterRatio = finiteRange(policy.jitterRatio ?? 0.15, 0, 1, 'Jitter ratio');
  const random = finiteRange((policy.random ?? Math.random)(), 0, 1, 'Random value');
  if (retryAfterMs !== undefined) finiteRange(retryAfterMs, 0, Number.MAX_SAFE_INTEGER, 'Retry-After delay');
  const exponent = Math.min(attempt - 1, 53);
  const bounded = Math.min(maximum, base * 2 ** exponent);
  const jittered = Math.min(maximum, Math.max(minimum, bounded * (1 + (random * 2 - 1) * jitterRatio)));
  return Math.ceil(Math.max(jittered, retryAfterMs ?? 0));
}

/** An HTTP 429 or other safely retryable read failure can carry server pacing. */
export class RetryableProbeError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RetryableProbeError';
    this.retryAfterMs = retryAfterMs;
  }
}
