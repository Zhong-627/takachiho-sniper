import { describe, expect, it } from 'vitest';
import { MIN_POLL_DELAY_MS, parseRetryAfter, retryDelayMs } from '../src/retry.js';

describe('retry pacing', () => {
  it('backs off exponentially within a local cap', () => {
    const policy = { baseDelayMs: 1000, maxDelayMs: 8000, jitterRatio: 0 };
    expect([1, 2, 3, 4, 5, 1000].map((attempt) => retryDelayMs(attempt, policy))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('honors long Retry-After minimums above the local cap even with downward jitter', () => {
    const delay = retryDelayMs(1, { baseDelayMs: 1000, maxDelayMs: 8000, random: () => 0 }, 120_000);
    expect(delay).toBe(120_000);
  });

  it('never produces a fast polling interval when jitter is at its minimum', () => {
    expect(retryDelayMs(1, { baseDelayMs: 750, jitterRatio: 1, random: () => 0 })).toBe(MIN_POLL_DELAY_MS);
    expect(retryDelayMs(1, { baseDelayMs: 1000, jitterRatio: 0.2, random: () => 1 })).toBe(1200);
  });

  it('rejects flooding settings, invalid attempts and invalid random sources', () => {
    expect(() => retryDelayMs(1, { minDelayMs: 10 })).toThrow();
    expect(() => retryDelayMs(1, { baseDelayMs: 10 })).toThrow();
    expect(() => retryDelayMs(0)).toThrow();
    expect(() => retryDelayMs(1, { random: () => Number.NaN })).toThrow();
    expect(() => retryDelayMs(1, {}, -1)).toThrow();
  });
});

describe('Retry-After header', () => {
  it('understands delta seconds and absolute HTTP dates', () => {
    const now = Date.UTC(2026, 9, 12);
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter('Mon, 12 Oct 2026 00:02:00 GMT', now)).toBe(120_000);
    expect(parseRetryAfter('Mon, 12 Oct 2026 00:00:00 GMT', now + 1000)).toBe(0);
  });

  it('keeps absent, negative and malformed headers unknown', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('-5')).toBeUndefined();
    expect(parseRetryAfter('later please')).toBeUndefined();
  });
});
