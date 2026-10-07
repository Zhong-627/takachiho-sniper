import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RELEASE_AT, cancellableSleep, formatReleaseTimes, releaseEpochMs,
  waitUntilRelease, type Clock,
} from '../src/time.js';

afterEach(() => vi.useRealTimers());

function fakeClock(start: number, jump?: { onSleep: number; wallBy: number }): Clock & { sleeps: number[]; wallNow(): number } {
  let wall = start;
  let mono = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    wallNow: () => wall,
    monotonicNow: () => mono,
    sleep: async (ms) => {
      sleeps.push(ms);
      mono += ms;
      wall += ms;
      if (jump?.onSleep === sleeps.length) wall += jump.wallBy;
    },
  };
}

describe('release time', () => {
  it('maps 09:00 JST to 08:00 Taipei at the exact UTC release instant', () => {
    const epoch = releaseEpochMs(DEFAULT_RELEASE_AT);
    expect(epoch).toBe(Date.UTC(2026, 9, 12, 0, 0, 0));
    expect(formatReleaseTimes(epoch)).toEqual({
      utc: '2026-10-12T00:00:00.000Z',
      jst: '2026-10-12 09:00:00.000 Asia/Tokyo',
      taipei: '2026-10-12 08:00:00.000 Asia/Taipei',
    });
    expect(formatReleaseTimes(epoch + 123).jst).toContain('09:00:00.123');
    expect(releaseEpochMs('2026-10-12T08:00:00+08:00')).toBe(epoch);
  });

  it('rejects timezone-free and invalid release inputs', () => {
    expect(() => releaseEpochMs('2026-10-12T09:00:00')).toThrow(/offset/u);
    expect(() => releaseEpochMs('invalidZ')).toThrow(/Invalid/u);
    expect(() => releaseEpochMs(Number.NaN)).toThrow();
  });

  it('waits with bounded timer wakes and releases exactly at the deadline', async () => {
    const epoch = releaseEpochMs(DEFAULT_RELEASE_AT);
    const clock = fakeClock(epoch - 2550);
    const events = vi.fn();
    await waitUntilRelease(epoch, { clock, onEvent: events });
    expect(clock.sleeps).toEqual([1000, 1000, 550]);
    expect(clock.wallNow()).toBe(epoch);
    expect(events.mock.calls.at(-1)?.[0]).toBe('release_reached');
    expect(events.mock.calls.at(-1)?.[1]).toMatchObject({ latenessMs: 0 });
  });

  it('resynchronizes a backward wall-clock jump and never releases early', async () => {
    const epoch = releaseEpochMs(DEFAULT_RELEASE_AT);
    const clock = fakeClock(epoch - 2500, { onSleep: 1, wallBy: -2000 });
    const events = vi.fn();
    await waitUntilRelease(epoch, { clock, onEvent: events });
    expect(clock.wallNow()).toBe(epoch);
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(4500);
    expect(events.mock.calls.find((call) => call[0] === 'clock_drift_detected')?.[1]).toMatchObject({ driftMs: -2000 });
  });

  it('handles a forward wall-clock jump without waiting out an obsolete deadline', async () => {
    const epoch = releaseEpochMs(DEFAULT_RELEASE_AT);
    const clock = fakeClock(epoch - 2500, { onSleep: 1, wallBy: 3000 });
    await waitUntilRelease(epoch, { clock });
    expect(clock.sleeps).toEqual([1000]);
    expect(clock.wallNow()).toBe(epoch + 1500);
  });

  it('records late start without sleeping', async () => {
    const epoch = releaseEpochMs(DEFAULT_RELEASE_AT);
    const clock = fakeClock(epoch + 10);
    const events = vi.fn();
    await waitUntilRelease(epoch, { clock, onEvent: events });
    expect(clock.sleeps).toHaveLength(0);
    expect(events.mock.calls.at(-1)?.[1]).toMatchObject({ latenessMs: 10 });
  });
});

describe('interruptible sleep', () => {
  it('cancels and removes its pending timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const wait = cancellableSleep(10_000, controller.signal);
    const result = expect(wait).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a Retry-After longer than Node maximum timer duration', async () => {
    vi.useFakeTimers();
    const resolved = vi.fn();
    const wait = cancellableSleep(2 ** 31 + 2000).then(resolved);
    await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
    expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2001);
    await wait;
    expect(resolved).toHaveBeenCalledOnce();
  });

  it('rejects an already aborted wait and invalid durations', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(cancellableSleep(1000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(cancellableSleep(-1)).rejects.toThrow();
    await expect(cancellableSleep(Number.POSITIVE_INFINITY)).rejects.toThrow();
  });
});
