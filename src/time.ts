import { performance } from 'node:perf_hooks';

export type TimingReporter = (event: string, data: Record<string, unknown>) => void;

export interface Clock {
  wallNow(): number;
  monotonicNow(): number;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

export class WaitCancelledError extends Error {
  constructor() {
    super('Operation cancelled');
    this.name = 'AbortError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WaitCancelledError();
}

/** Timers, rather than busy spinning, keep waiting cheap and interruptible. */
export function cancellableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return Promise.reject(new RangeError('Sleep duration must be a nonnegative finite number'));
  }
  if (signal?.aborted) return Promise.reject(new WaitCancelledError());
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let remaining = Math.ceil(milliseconds);
    const cleanup = (): void => signal?.removeEventListener('abort', cancel);
    const cancel = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new WaitCancelledError());
    };
    // Node clamps delays beyond 2^31-1 to 1 ms. Chunking also preserves very
    // large Retry-After values instead of accidentally hammering the server.
    const schedule = (): void => {
      const chunk = Math.min(remaining, 2 ** 31 - 1);
      timer = setTimeout(() => {
        remaining -= chunk;
        if (remaining > 0) schedule();
        else {
          cleanup();
          resolve();
        }
      }, chunk);
    };
    schedule();
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export const systemClock: Clock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
  sleep: cancellableSleep,
};

export function releaseEpochMs(value: string | Date | number): number {
  if (typeof value === 'string' && !/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new RangeError('Release time must include an explicit UTC offset or Z');
  }
  const epochMs = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(epochMs)) throw new RangeError('Invalid release time');
  return epochMs;
}

export function formatZonedTime(epochMs: number, zone: 'Asia/Tokyo' | 'Asia/Taipei'): string {
  if (!Number.isFinite(epochMs)) throw new RangeError('Invalid timestamp');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    fractionalSecondDigits: 3, hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const match = parts.find((entry) => entry.type === type);
    if (!match) throw new Error(`Missing date part: ${type}`);
    return match.value;
  };
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}.${part('fractionalSecond')} ${zone}`;
}

export function formatReleaseTimes(epochMs: number): { utc: string; jst: string; taipei: string } {
  return {
    utc: new Date(epochMs).toISOString(),
    jst: formatZonedTime(epochMs, 'Asia/Tokyo'),
    taipei: formatZonedTime(epochMs, 'Asia/Taipei'),
  };
}

export interface ReleaseWaitOptions {
  signal?: AbortSignal;
  onEvent?: TimingReporter;
  clock?: Clock;
  /** Wall-clock drift is rechecked at this interval, including during a long wait. */
  checkIntervalMs?: number;
  driftThresholdMs?: number;
}

/**
 * Use a monotonic deadline for normal waiting, but resynchronize when the OS wall
 * clock changes. A final wall-clock check prevents acting before the release.
 * Accuracy still depends on the local OS clock; this does not measure server skew.
 */
export async function waitUntilRelease(
  releaseAt: string | Date | number,
  options: ReleaseWaitOptions = {},
): Promise<void> {
  const target = releaseEpochMs(releaseAt);
  const clock = options.clock ?? systemClock;
  const interval = options.checkIntervalMs ?? 1000;
  const driftThreshold = options.driftThresholdMs ?? 100;
  if (!Number.isFinite(interval) || interval < 1 || interval > 60_000) {
    throw new RangeError('Clock check interval must be between 1 and 60000 ms');
  }
  if (!Number.isFinite(driftThreshold) || driftThreshold < 0) {
    throw new RangeError('Clock drift threshold must be nonnegative');
  }
  throwIfAborted(options.signal);
  let wallOrigin = clock.wallNow();
  let monotonicOrigin = clock.monotonicNow();
  let deadline = monotonicOrigin + (target - wallOrigin);
  options.onEvent?.('release_wait_armed', {
    ...formatReleaseTimes(wallOrigin),
    releaseAt: formatReleaseTimes(target),
    remainingMs: Math.max(0, target - wallOrigin),
  });

  for (;;) {
    throwIfAborted(options.signal);
    const wall = clock.wallNow();
    const monotonic = clock.monotonicNow();
    const drift = wall - (wallOrigin + monotonic - monotonicOrigin);
    if (Math.abs(drift) > driftThreshold) {
      options.onEvent?.('clock_drift_detected', { driftMs: drift, ...formatReleaseTimes(wall) });
      wallOrigin = wall;
      monotonicOrigin = monotonic;
      deadline = monotonic + (target - wall);
    }
    const wallRemaining = target - wall;
    if (wallRemaining <= 0) {
      options.onEvent?.('release_reached', {
        ...formatReleaseTimes(wall),
        latenessMs: wall - target,
      });
      return;
    }
    // If small clock drift left the monotonic deadline behind us, use the wall
    // deadline; otherwise there could be a zero-delay spin before release.
    const monotonicRemaining = deadline - monotonic;
    const remaining = monotonicRemaining > 0
      ? Math.min(wallRemaining, monotonicRemaining)
      : wallRemaining;
    await clock.sleep(Math.max(1, Math.ceil(Math.min(interval, remaining))), options.signal);
  }
}
