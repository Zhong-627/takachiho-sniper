import { describe, it, expect } from 'vitest';
import { parseCli } from '../src/cli-options.js';
describe('CLI authorization', () => {
  it('requires the explicit side effects flag', () => {
    expect(() => parseCli(['live'])).toThrow('confirm');
    expect(() => parseCli(['full-rehearsal', '--slot', '10:00'])).toThrow('confirm');
  });
  it('refuses typo flags and deceptive boolean assignments', () => {
    expect(() => parseCli(['rehearsal', '--confrm-reservation-side-effects'])).toThrow();
    expect(() => parseCli(['live', '--confirm-reservation-side-effects=false'])).toThrow();
  });
  it('requires human-visible reservation sessions and pinned live targets', () => {
    expect(() => parseCli(['live', '--confirm-reservation-side-effects', '--headless'])).toThrow('visible');
    expect(() => parseCli(['live', '--confirm-reservation-side-effects', '--slot', '10:00'])).toThrow('both');
  });
});
