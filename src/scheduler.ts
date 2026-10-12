import { performance } from 'node:perf_hooks';
import { RetryableProbeError, retryDelayMs, type RetryPolicy } from './retry.js';
import { cancellableSleep, throwIfAborted, type TimingReporter } from './time.js';

export type SlotProbeResult =
  | { status: 'available'; details?: Record<string, unknown> }
  | { status: 'unavailable' | 'unknown'; reason?: string; targetAbsent?: true }
  | { status: 'limited'; retryAfterMs?: number; reason?: string }
  | { status: 'manual'; reason: string };

type TerminalActionResult = {
  status: 'customer-form-ready' | 'manual' | 'ambiguous' | 'failed' | 'deadline-reached';
  reason?: string;
};
export type ReservationActionResult = TerminalActionResult | { status: 'retry-monitoring'; reason: string };

export interface SlotOutcome {
  slot: string;
  status: TerminalActionResult['status'] | 'exhausted';
  attempts: number;
  elapsedMs: number;
  reason?: string;
}

export interface SlotPollingOptions {
  slot: string;
  probe: () => Promise<SlotProbeResult>;
  /** Repeated only after retry-monitoring: caller verified rejection and sold-out state. */
  act: () => Promise<ReservationActionResult>;
  signal?: AbortSignal;
  onEvent?: TimingReporter;
  retry?: RetryPolicy;
  maxAttempts?: number;
  maxElapsedMs?: number;
  /** When provided, replaces the default attempt/time budgets with an absolute cutoff. */
  deadlineAtMs?: number;
  /** Known release boundary during early monitoring; never overrides error pacing. */
  releaseAtMs?: number;
  wallNow?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  monotonicNow?: () => number;
}

/** Each slot owns its requests, timers and outcome. No failure aborts a sibling. */
export async function runIndependentSlots<Slot extends string, Result>(
  slots: readonly Slot[],
  worker: (slot: Slot) => Promise<Result>,
): Promise<PromiseSettledResult<Result>[]> {
  if (new Set(slots).size !== slots.length) throw new Error('Slot targets must be unique');
  return Promise.allSettled(slots.map((slot) => Promise.resolve().then(() => worker(slot))));
}

/**
 * Poll safe availability reads. An action repeats only after explicit rejection
 * and sold-out verification by its caller, never on timeout or a lost response.
 * Unknown availability can never become an action or a successful outcome.
 */
export async function pollSlot(options: SlotPollingOptions): Promise<SlotOutcome> {
  const continuous = options.deadlineAtMs !== undefined;
  const maxAttempts = options.maxAttempts ?? (continuous ? Infinity : 120);
  const maxElapsedMs = options.maxElapsedMs ?? (continuous ? Infinity : 20 * 60_000);
  if (options.maxAttempts !== undefined && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)) throw new RangeError('maxAttempts must be positive');
  if (options.maxElapsedMs !== undefined && (!Number.isFinite(maxElapsedMs) || maxElapsedMs < 1)) throw new RangeError('maxElapsedMs must be positive');
  if (continuous && !Number.isFinite(options.deadlineAtMs)) throw new RangeError('Monitoring deadline must be finite');
  if (options.releaseAtMs !== undefined && !Number.isFinite(options.releaseAtMs)) throw new RangeError('Release instant must be finite');
  const sleep = options.sleep ?? cancellableSleep;
  const now = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => Date.now());
  const started = now();
  const emit = (event: string, data: Record<string, unknown> = {}): void => {
    options.onEvent?.(event, { slot: options.slot, elapsedMs: now() - started, ...data });
  };
  const finish = (status: SlotOutcome['status'], attempts: number, reason?: string): SlotOutcome => ({
    slot: options.slot, status, attempts, elapsedMs: now() - started, ...(reason ? { reason } : {}),
  });
  let lastReason: string | undefined;
  let backoffAttempt = 0;
  const deadlineReached = (attempts: number): SlotOutcome => {
    emit('monitoring_deadline_reached', { attempts, deadlineAtMs: options.deadlineAtMs });
    return finish('deadline-reached', attempts, 'Configured monitoring deadline reached');
  };
  emit('slot_worker_started');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    if (continuous && wallNow() >= options.deadlineAtMs!) return deadlineReached(attempt - 1);
    if (now() - started >= maxElapsedMs) {
      emit('slot_polling_exhausted', { attempts: attempt - 1, reason: 'Polling time budget elapsed' });
      return finish('exhausted', attempt - 1, 'Polling time budget elapsed');
    }
    let retryAfterMs: number | undefined;
    let probeResult: SlotProbeResult;
    const requestStartedAtMs = wallNow();
    emit('availability_request_started', { attempt });
    try {
      probeResult = await options.probe();
      emit('availability_detected', { attempt, status: probeResult.status });
    } catch (error) {
      throwIfAborted(options.signal);
      lastReason = error instanceof Error ? error.message : String(error);
      retryAfterMs = error instanceof RetryableProbeError ? error.retryAfterMs : undefined;
      emit('availability_request_error', { attempt, error: lastReason, retryAfterMs });
      probeResult = { status: 'unknown', reason: lastReason };
    }
    throwIfAborted(options.signal);
    // A response arriving after the cutoff must never trigger a new hold.
    if (continuous && wallNow() >= options.deadlineAtMs!) return deadlineReached(attempt);
    if (probeResult.status === 'available') {
      emit('reservation_action_started', { attempt });
      try {
        const actionResult = await options.act();
        emit('reservation_action_finished', { attempt, status: actionResult.status, reason: actionResult.reason });
        if (actionResult.status !== 'retry-monitoring') return finish(actionResult.status, attempt, actionResult.reason);
        emit('reservation_returned_to_monitoring', { attempt, reason: actionResult.reason });
        probeResult = { status: 'unavailable', reason: actionResult.reason };
      } catch (error) {
        // Even an abort after clicking must not trigger another hold action.
        const reason = error instanceof Error ? error.message : String(error);
        emit('reservation_action_ambiguous', { attempt, error: reason });
        return finish('ambiguous', attempt, reason);
      }
    }
    if (probeResult.status === 'manual') {
      emit('manual_intervention_required', { attempt, reason: probeResult.reason });
      return finish('manual', attempt, probeResult.reason);
    }
    lastReason = probeResult.reason ?? lastReason;
    if (probeResult.status === 'limited') retryAfterMs = probeResult.retryAfterMs;
    // A valid calendar missing the target before release is ordinary waiting,
    // never permission to reserve. Malformed/ambiguous reads and 429 still back off.
    const beforeRelease = options.releaseAtMs !== undefined && requestStartedAtMs < options.releaseAtMs;
    const steadyPacing = probeResult.status === 'unavailable'
      || (beforeRelease && probeResult.status === 'unknown' && probeResult.targetAbsent === true);
    backoffAttempt = steadyPacing ? 1 : backoffAttempt + 1;
    if (attempt === maxAttempts) {
      emit('slot_polling_exhausted', { attempts: attempt, reason: lastReason });
      return finish('exhausted', attempt, lastReason);
    }
    let delayMs = retryDelayMs(backoffAttempt, options.retry, retryAfterMs);
    if (steadyPacing && beforeRelease && retryAfterMs === undefined) {
      // Align one normal read with release instead of sleeping across it. If the
      // preceding read finishes late, recheck immediately; never overlap reads.
      delayMs = Math.min(delayMs, Math.max(0, options.releaseAtMs! - wallNow()));
    }
    const remainingMs = Math.min(maxElapsedMs - (now() - started), continuous ? options.deadlineAtMs! - wallNow() : Infinity);
    if (delayMs >= remainingMs) {
      if (continuous) {
        // Wait through the remaining window, without shortening server pacing
        // to send another request just before the cutoff.
        await sleep(Math.max(0, remainingMs), options.signal);
        return deadlineReached(attempt);
      }
      emit('slot_polling_exhausted', { attempts: attempt, reason: 'Next retry exceeds polling time budget', delayMs });
      return finish('exhausted', attempt, 'Next retry exceeds polling time budget');
    }
    emit('availability_retry_scheduled', { attempt, delayMs, retryAfterMs });
    await sleep(delayMs, options.signal);
  }
  // Loop exits only through a return above; retained for exhaustive TS checking.
  return finish('exhausted', maxAttempts, lastReason);
}
