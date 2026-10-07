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
});
