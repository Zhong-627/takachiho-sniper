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
  it('requires human-visible sessions and takes live targets only from local config', () => {
    expect(() => parseCli(['live', '--confirm-reservation-side-effects', '--headless'])).toThrow('visible');
    for (const option of [['--slot', '09:15'], ['--date', '2026-11-03'], ['--attempts', '3'], ['--date', ''], ['--slot', ''], ['--attempts', '']]) {
      expect(() => parseCli(['live', '--confirm-reservation-side-effects', ...option])).toThrow('local config');
    }
  });
  it('accepts an arbitrary HH:mm rehearsal slot and custom local config path', () => {
    expect(parseCli(['full-rehearsal', '--config', 'config/alternate.local.json', '--slot', '09:15', '--confirm-reservation-side-effects']))
      .toMatchObject({ mode: 'full-rehearsal', config: 'config/alternate.local.json', slot: '09:15', confirmed: true });
  });
  it('requires a rehearsal slot and rejects malformed times', () => {
    expect(() => parseCli(['full-rehearsal', '--confirm-reservation-side-effects'])).toThrow('--slot');
    for (const slot of ['9:15', '24:00', '09:60', '', '09:15:00']) {
      expect(() => parseCli(['full-rehearsal', '--slot', slot, '--confirm-reservation-side-effects'])).toThrow('HH:mm');
    }
  });
  it('allows manual customer entry only in live and doctor, retaining reservation authorization', () => {
    expect(parseCli(['live', '--manual-customer-form', '--confirm-reservation-side-effects'])).toMatchObject({ mode: 'live', manualCustomerForm: true });
    expect(parseCli(['doctor', '--manual-customer-form'])).toMatchObject({ mode: 'doctor', manualCustomerForm: true });
    expect(() => parseCli(['live', '--manual-customer-form'])).toThrow('confirm');
    expect(() => parseCli(['live', '--manual-customer-form', '--confirm-reservation-side-effects', '--headless'])).toThrow('visible');
    for (const mode of ['inspect', 'rehearsal', 'full-rehearsal']) expect(() => parseCli([mode, '--manual-customer-form'])).toThrow('only with live or doctor');
    expect(() => parseCli(['doctor', '--manual-customer-form=false'])).toThrow();
  });
});
