import { performance } from 'node:perf_hooks';
import { RetryableProbeError, retryDelayMs, type RetryPolicy } from './retry.js';
import { cancellableSleep, throwIfAborted, type TimingReporter } from './time.js';

export type SlotProbeResult =
  | { status: 'available'; details?: Record<string, unknown> }
  | { status: 'unavailable' | 'unknown'; reason?: string }
  | { status: 'limited'; retryAfterMs?: number; reason?: string }
  | { status: 'manual'; reason: string };

export type ReservationActionResult = {
  status: 'customer-form-ready' | 'manual' | 'ambiguous' | 'failed';
  reason?: string;
};

export interface SlotOutcome {
  slot: string;
  status: ReservationActionResult['status'] | 'exhausted';
  attempts: number;
  elapsedMs: number;
  reason?: string;
}

export interface SlotPollingOptions {
  slot: string;
  probe: () => Promise<SlotProbeResult>;
  /** Invoked at most once. Its caller owns the side-effect safety guard. */
  act: () => Promise<ReservationActionResult>;
  signal?: AbortSignal;
  onEvent?: TimingReporter;
  retry?: RetryPolicy;
  maxAttempts?: number;
  maxElapsedMs?: number;
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
 * Poll only safe availability reads. Once an action begins this worker never
 * repeats it, including on timeout or a lost response: a hold may already exist.
 * Unknown availability can never become an action or a successful outcome.
 */
export async function pollSlot(options: SlotPollingOptions): Promise<SlotOutcome> {
  const maxAttempts = options.maxAttempts ?? 120;
  const maxElapsedMs = options.maxElapsedMs ?? 20 * 60_000;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttempts must be positive');
  if (!Number.isFinite(maxElapsedMs) || maxElapsedMs < 1) throw new RangeError('maxElapsedMs must be positive');
  const sleep = options.sleep ?? cancellableSleep;
  const now = options.monotonicNow ?? (() => performance.now());
  const started = now();
  const emit = (event: string, data: Record<string, unknown> = {}): void => {
    options.onEvent?.(event, { slot: options.slot, elapsedMs: now() - started, ...data });
  };
  const finish = (status: SlotOutcome['status'], attempts: number, reason?: string): SlotOutcome => ({
    slot: options.slot, status, attempts, elapsedMs: now() - started, ...(reason ? { reason } : {}),
  });
  let lastReason: string | undefined;
  let backoffAttempt = 0;
  emit('slot_worker_started');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    if (now() - started >= maxElapsedMs) {
      emit('slot_polling_exhausted', { attempts: attempt - 1, reason: 'Polling time budget elapsed' });
      return finish('exhausted', attempt - 1, 'Polling time budget elapsed');
    }
    let retryAfterMs: number | undefined;
    let probeResult: SlotProbeResult;
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
    if (probeResult.status === 'available') {
      emit('reservation_action_started', { attempt });
      try {
        const actionResult = await options.act();
        emit('reservation_action_finished', { attempt, status: actionResult.status, reason: actionResult.reason });
        return finish(actionResult.status, attempt, actionResult.reason);
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
    // Ordinary unavailable responses use steady pacing. Errors, unknown states
    // and 429 responses grow their own per-slot backoff; no global lock is used.
    backoffAttempt = probeResult.status === 'unavailable' ? 1 : backoffAttempt + 1;
    if (attempt === maxAttempts) {
      emit('slot_polling_exhausted', { attempts: attempt, reason: lastReason });
      return finish('exhausted', attempt, lastReason);
    }
    const delayMs = retryDelayMs(backoffAttempt, options.retry, retryAfterMs);
    const remainingMs = maxElapsedMs - (now() - started);
    if (delayMs >= remainingMs) {
      emit('slot_polling_exhausted', { attempts: attempt, reason: 'Next retry exceeds polling time budget', delayMs });
      return finish('exhausted', attempt, 'Next retry exceeds polling time budget');
    }
    emit('availability_retry_scheduled', { attempt, delayMs, retryAfterMs });
    await sleep(delayMs, options.signal);
  }
  // Loop exits only through a return above; retained for exhaustive TS checking.
  return finish('exhausted', maxAttempts, lastReason);
}
