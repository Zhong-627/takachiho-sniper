import { describe, expect, it, vi } from 'vitest';
import { RetryableProbeError } from '../src/retry.js';
import { pollSlot, runIndependentSlots, type SlotProbeResult } from '../src/scheduler.js';

const pacing = { baseDelayMs: 1000, maxDelayMs: 8000, jitterRatio: 0 };

function simulatedSleep(): { now: () => number; sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>> } {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: vi.fn(async (ms: number) => { elapsed += ms; }),
  };
}

describe('independent slot workers', () => {
  it('starts both targets before either finishes and a slow request cannot block its sibling', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseSlow: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const task = runIndependentSlots(['10:00', '10:30'], async (slot) => {
      started.push(slot);
      if (slot === '10:00') await slow;
      finished.push(slot);
      return slot;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['10:00', '10:30']);
    expect(finished).toEqual(['10:30']);
    releaseSlow?.();
    const results = await task;
    expect(results).toEqual([
      { status: 'fulfilled', value: '10:00' },
      { status: 'fulfilled', value: '10:30' },
    ]);
  });

  it('preserves the second flow after the first flow throws', async () => {
    const results = await runIndependentSlots(['10:00', '10:30'], async (slot) => {
      if (slot === '10:00') throw new Error('Navigation timeout');
      return { slot, status: 'customer-form-ready' };
    });
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: { slot: '10:30', status: 'customer-form-ready' } });
  });

  it('rejects duplicate slot targets', async () => {
    await expect(runIndependentSlots(['10:00', '10:00'], async (slot) => slot)).rejects.toThrow(/unique/u);
  });
});

describe('slot polling', () => {
  it('stops polling immediately once the customer form is ready', async () => {
    const probe = vi.fn<() => Promise<SlotProbeResult>>().mockResolvedValue({ status: 'available' });
    const act = vi.fn().mockResolvedValue({ status: 'customer-form-ready' });
    const clock = simulatedSleep();
    const result = await pollSlot({ slot: '10:00', probe, act, retry: pacing, sleep: clock.sleep, monotonicNow: clock.now });
    expect(result).toMatchObject({ status: 'customer-form-ready', attempts: 1, slot: '10:00' });
    expect(probe).toHaveBeenCalledOnce();
    expect(act).toHaveBeenCalledOnce();
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('never treats unknown availability as success or selects the slot', async () => {
    const act = vi.fn();
    const clock = simulatedSleep();
    const result = await pollSlot({
      slot: '10:30', probe: async () => ({ status: 'unknown', reason: 'Unknown DOM' }), act,
      maxAttempts: 3, retry: pacing, sleep: clock.sleep, monotonicNow: clock.now,
    });
    expect(result.status).toBe('exhausted');
    expect(act).not.toHaveBeenCalled();
    expect(clock.sleep.mock.calls.map((call) => call[0])).toEqual([1000, 2000]);
  });

  it('does not retry an ambiguous reservation action after losing its response', async () => {
    const probe = vi.fn<() => Promise<SlotProbeResult>>().mockResolvedValue({ status: 'available' });
    const act = vi.fn().mockRejectedValue(new Error('Connection lost after click'));
    const sleep = vi.fn();
    const result = await pollSlot({ slot: '10:00', probe, act, sleep });
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'Connection lost after click' });
    expect(act).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops before any action when a manual security challenge is detected', async () => {
    const act = vi.fn();
    const result = await pollSlot({ slot: '10:00', probe: async () => ({ status: 'manual', reason: 'CAPTCHA' }), act });
    expect(result.status).toBe('manual');
    expect(act).not.toHaveBeenCalled();
  });

  it('paces ordinary unavailable responses without increasing request frequency', async () => {
    const clock = simulatedSleep();
    const probe = vi.fn<() => Promise<SlotProbeResult>>()
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({ status: 'available' });
    const result = await pollSlot({
      slot: '10:30', probe, act: async () => ({ status: 'customer-form-ready' }),
      retry: pacing, sleep: clock.sleep, monotonicNow: clock.now,
    });
    expect(result.status).toBe('customer-form-ready');
    expect(clock.sleep.mock.calls.map((call) => call[0])).toEqual([1000, 1000]);
  });

  it('polls a valid absent target every 750 ms from 07:58 to 08:00 without accumulating backoff', async () => {
    const clock = simulatedSleep();
    const start = Date.parse('2026-10-12T07:58:00+08:00');
    const release = start + 120_000;
    const requests: number[] = [];
    const act = vi.fn().mockResolvedValue({ status: 'customer-form-ready' });
    const result = await pollSlot({ slot: '11:00', act, releaseAtMs: release, deadlineAtMs: release + 60_000,
      wallNow: () => start + clock.now(), monotonicNow: clock.now, sleep: clock.sleep,
      retry: { baseDelayMs: 750, jitterRatio: 0 },
      probe: async () => {
        requests.push(start + clock.now());
        return start + clock.now() < release ? { status: 'unknown', targetAbsent: true } : { status: 'available' };
      } });
    expect(result).toMatchObject({ status: 'customer-form-ready', attempts: 161 });
    expect(requests[0]).toBe(start);
    expect(requests.at(-1)).toBe(release);
    expect(clock.sleep.mock.calls.every(([delay]) => delay === 750)).toBe(true);
    expect(act).toHaveBeenCalledOnce();
  });

  it('aligns the next ordinary read with release when a 750 ms wait would cross it', async () => {
    const clock = simulatedSleep();
    const requests: number[] = [];
    const result = await pollSlot({ slot: '11:30', releaseAtMs: 2000, maxAttempts: 4,
      wallNow: clock.now, monotonicNow: clock.now, sleep: clock.sleep,
      retry: { baseDelayMs: 750, jitterRatio: 0 }, act: async () => ({ status: 'customer-form-ready' }),
      probe: async () => {
        requests.push(clock.now());
        return clock.now() < 2000 ? { status: 'unavailable' } : { status: 'available' };
      } });
    expect(result.status).toBe('customer-form-ready');
    expect(requests).toEqual([0, 750, 1500, 2000]);
    expect(clock.sleep.mock.calls.map(([delay]) => delay)).toEqual([750, 750, 500]);
  });

  it('rechecks after a normal pre-release read finishes late without another delay', async () => {
    const clock = simulatedSleep();
    const requests: number[] = [];
    const result = await pollSlot({ slot: '11:00', releaseAtMs: 1000, maxAttempts: 2,
      wallNow: clock.now, monotonicNow: clock.now, sleep: clock.sleep,
      retry: { baseDelayMs: 750, jitterRatio: 0 }, act: async () => ({ status: 'customer-form-ready' }),
      probe: async () => {
        requests.push(clock.now());
        if (requests.length === 1) {
          await clock.sleep(1100);
          return { status: 'unknown', targetAbsent: true };
        }
        return { status: 'available' };
      } });
    expect(result.status).toBe('customer-form-ready');
    expect(requests).toEqual([0, 1100]);
    expect(clock.sleep.mock.calls.map(([delay]) => delay)).toEqual([1100, 0]);
  });

  it('preserves unknown-response backoff across release instead of resetting errors', async () => {
    const clock = simulatedSleep();
    const act = vi.fn();
    const result = await pollSlot({ slot: '11:30', releaseAtMs: 1000, maxAttempts: 3,
      wallNow: clock.now, monotonicNow: clock.now, sleep: clock.sleep,
      retry: { baseDelayMs: 750, jitterRatio: 0 }, act,
      probe: async () => ({ status: 'unknown', reason: 'Malformed response' }) });
    expect(result.status).toBe('exhausted');
    expect(clock.sleep.mock.calls.map(([delay]) => delay)).toEqual([750, 1500]);
    expect(act).not.toHaveBeenCalled();
  });

  it('keeps backing off for missing targets after release', async () => {
    const clock = simulatedSleep();
    const act = vi.fn();
    await pollSlot({ slot: '11:00', releaseAtMs: 0, maxAttempts: 3,
      wallNow: clock.now, monotonicNow: clock.now, sleep: clock.sleep,
      retry: { baseDelayMs: 750, jitterRatio: 0 }, act,
      probe: async () => ({ status: 'unknown', targetAbsent: true }) });
    expect(clock.sleep.mock.calls.map(([delay]) => delay)).toEqual([750, 1500]);
    expect(act).not.toHaveBeenCalled();
  });

  it('honors a pre-release 429 Retry-After even when it extends beyond release', async () => {
    const clock = simulatedSleep();
    const probe = vi.fn<() => Promise<SlotProbeResult>>()
      .mockRejectedValueOnce(new RetryableProbeError('HTTP 429', 5000))
      .mockResolvedValueOnce({ status: 'available' });
    const result = await pollSlot({ slot: '11:30', releaseAtMs: 1000, maxAttempts: 2,
      wallNow: clock.now, monotonicNow: clock.now, sleep: clock.sleep,
      retry: { baseDelayMs: 750, jitterRatio: 0 }, probe, act: async () => ({ status: 'customer-form-ready' }) });
    expect(result).toMatchObject({ status: 'customer-form-ready', elapsedMs: 5000 });
    expect(clock.sleep.mock.calls.map(([delay]) => delay)).toEqual([5000]);
  });

  it('honors 429 Retry-After and then recovers on the next safe read', async () => {
    const clock = simulatedSleep();
    const probe = vi.fn<() => Promise<SlotProbeResult>>()
      .mockRejectedValueOnce(new RetryableProbeError('HTTP 429', 120_000))
      .mockResolvedValueOnce({ status: 'available' });
    const result = await pollSlot({
      slot: '10:00', probe, act: async () => ({ status: 'customer-form-ready' }),
      retry: pacing, sleep: clock.sleep, monotonicNow: clock.now,
    });
    expect(clock.sleep.mock.calls[0]?.[0]).toBe(120_000);
    expect(result.status).toBe('customer-form-ready');
  });

  it('stops instead of shortening Retry-After when it exceeds the polling budget', async () => {
    const clock = simulatedSleep();
    const probe = vi.fn<() => Promise<SlotProbeResult>>().mockResolvedValue({ status: 'limited', retryAfterMs: 120_000 });
    const act = vi.fn();
    const result = await pollSlot({
      slot: '10:30', probe, act, maxElapsedMs: 10_000,
      retry: pacing, sleep: clock.sleep, monotonicNow: clock.now,
    });
    expect(result.status).toBe('exhausted');
    expect(probe).toHaveBeenCalledOnce();
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it('tags every log event with its own slot', async () => {
    const events = vi.fn();
    await pollSlot({
      slot: '10:30', probe: async () => ({ status: 'available' }),
      act: async () => ({ status: 'customer-form-ready' }), onEvent: events,
    });
    expect(events.mock.calls.every((call) => call[1]?.slot === '10:30')).toBe(true);
  });

  it('continues beyond 80 reads and 20 minutes with unchanged ordinary pacing until success', async () => {
    const clock = simulatedSleep();
    let reads = 0;
    const probe = vi.fn(async (): Promise<SlotProbeResult> => ({ status: ++reads === 1301 ? 'available' : 'unavailable' }));
    const act = vi.fn().mockResolvedValue({ status: 'customer-form-ready' });
    const result = await pollSlot({ slot: '10:00', probe, act, deadlineAtMs: 2 * 3_600_000,
      wallNow: clock.now, monotonicNow: clock.now, sleep: clock.sleep, retry: pacing });
    expect(result).toMatchObject({ status: 'customer-form-ready', attempts: 1301, elapsedMs: 1_300_000 });
    expect(act).toHaveBeenCalledOnce();
    expect(clock.sleep.mock.calls.every(([delay]) => delay === 1000)).toBe(true);
  });

  it('returns to safe reads after verified sold-out rejection and stops after later success', async () => {
    const clock = simulatedSleep();
    const probe = vi.fn<() => Promise<SlotProbeResult>>()
      .mockResolvedValueOnce({ status: 'available' }).mockResolvedValueOnce({ status: 'unavailable' })
      .mockResolvedValueOnce({ status: 'available' });
    const act = vi.fn().mockResolvedValueOnce({ status: 'retry-monitoring', reason: 'Verified rejection and full event' })
      .mockResolvedValueOnce({ status: 'customer-form-ready' });
    const result = await pollSlot({ slot: '10:00', probe, act, deadlineAtMs: 100_000,
      wallNow: clock.now, monotonicNow: clock.now, sleep: clock.sleep, retry: pacing });
    expect(result).toMatchObject({ status: 'customer-form-ready', attempts: 3 });
    expect(act).toHaveBeenCalledTimes(2);
    expect(clock.sleep.mock.calls.map(([delay]) => delay)).toEqual([1000, 1000]);
  });

  it.each(['ambiguous', 'failed', 'manual'] as const)('does not turn terminal %s actions into retries', async (status) => {
    const clock = simulatedSleep();
    const act = vi.fn().mockResolvedValue({ status });
    const probe = vi.fn<() => Promise<SlotProbeResult>>().mockResolvedValue({ status: 'available' });
    expect((await pollSlot({ slot: '10:00', probe, act, deadlineAtMs: 100_000,
      wallNow: clock.now, monotonicNow: clock.now, sleep: clock.sleep })).status).toBe(status);
    expect(act).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('does not read or hold at an already reached deadline', async () => {
    const probe = vi.fn();
    const act = vi.fn();
    expect(await pollSlot({ slot: '10:00', probe, act, deadlineAtMs: 10_000, wallNow: () => 10_000 }))
      .toMatchObject({ status: 'deadline-reached', attempts: 0 });
    expect(probe).not.toHaveBeenCalled();
    expect(act).not.toHaveBeenCalled();
  });

  it('refuses a hold if an available read finishes after the cutoff', async () => {
    const clock = simulatedSleep();
    const act = vi.fn();
    const result = await pollSlot({ slot: '10:00', deadlineAtMs: 1000, wallNow: clock.now,
      monotonicNow: clock.now, sleep: clock.sleep, act,
      probe: async () => { await clock.sleep(1001); return { status: 'available' }; } });
    expect(result).toMatchObject({ status: 'deadline-reached', attempts: 1 });
    expect(act).not.toHaveBeenCalled();
  });

  it('waits until the cutoff without shortening Retry-After to dispatch another read', async () => {
    const clock = simulatedSleep();
    const probe = vi.fn<() => Promise<SlotProbeResult>>().mockResolvedValue({ status: 'limited', retryAfterMs: 120_000 });
    const result = await pollSlot({ slot: '10:00', probe, act: vi.fn(), deadlineAtMs: 10_000,
      wallNow: clock.now, monotonicNow: clock.now, sleep: clock.sleep, retry: pacing });
    expect(result).toMatchObject({ status: 'deadline-reached', elapsedMs: 10_000 });
    expect(probe).toHaveBeenCalledOnce();
    expect(clock.sleep.mock.calls.map(([delay]) => delay)).toEqual([10_000]);
  });

  it('manual cancellation interrupts continuous monitoring before another read', async () => {
    const abort = new AbortController();
    const probe = vi.fn<() => Promise<SlotProbeResult>>().mockResolvedValue({ status: 'unavailable' });
    await expect(pollSlot({ slot: '10:00', probe, act: vi.fn(), signal: abort.signal,
      deadlineAtMs: Date.now() + 100_000, sleep: async () => { abort.abort(); } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(probe).toHaveBeenCalledOnce();
  });
});
