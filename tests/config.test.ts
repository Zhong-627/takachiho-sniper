import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig, validateModeConfig } from '../src/config.js';

function liveConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    customers: {
      '10:00': { representativeName: 'Example Person A', fields: { representativeName: 'Example Person A' }, mappings: [{ key: 'representativeName', selector: '#name' }] },
      '10:30': { representativeName: 'Example Person B', fields: { representativeName: 'Example Person B' }, mappings: [{ key: 'representativeName', selector: '#name' }] },
    },
    ...overrides,
  });
}

describe('strict local config', () => {
  it('defaults to the target date and both independent slots', () => {
    const config = parseConfig({});
    expect(config.targetDate).toBe('2026-10-26');
    expect(config.releaseAt).toBe('2026-10-12T09:00:00+09:00');
    expect(config.slots).toEqual(['10:00', '10:30']);
    expect(config.browser.headless).toBe(false);
  });

  it('rejects unknown fields, invalid dates and offset-free release times', () => {
    expect(() => parseConfig({ mystery: true })).toThrow('Invalid local config');
    expect(() => parseConfig({ targetDate: '2026-02-30' })).toThrow('calendar date');
    expect(() => parseConfig({ releaseAt: '2026-10-12T09:00:00' })).toThrow();
    expect(() => parseConfig({ slots: ['10:00', '10:00'] })).toThrow('unique targets');
  });

  it('rejects request-flooding settings and unusable bounds', () => {
    expect(() => parseConfig({ polling: { maxAttempts: 0 } })).toThrow();
    expect(() => parseConfig({ polling: { baseDelayMs: 10 } })).toThrow();
    expect(() => parseConfig({ polling: { baseDelayMs: 2000, maxDelayMs: 1000 } })).toThrow('at least baseDelayMs');
  });

  it('rejects duplicate mappings before interacting with a browser', () => {
    expect(() => parseConfig({ customers: { '10:00': { mappings: [{ key: 'a', selector: '#one' }, { key: 'a', selector: '#two' }] } } })).toThrow('unique keys');
    expect(() => parseConfig({ customers: { '10:00': { mappings: [{ key: 'a', selector: '#one' }, { key: 'b', selector: '#one' }] } } })).toThrow('unique selectors');
  });

  it('safe modes work without customer data and side effects require the exact explicit flag', () => {
    const config = parseConfig({});
    expect(() => validateModeConfig(config, 'inspect', false)).not.toThrow();
    expect(() => validateModeConfig(config, 'rehearsal', false)).not.toThrow();
    expect(() => validateModeConfig(config, 'live', false)).toThrow('--confirm-reservation-side-effects');
    expect(() => validateModeConfig(config, 'full-rehearsal', false, '10:00')).toThrow('--confirm-reservation-side-effects');
  });

  it('full rehearsal needs one explicit slot but accepts an incomplete form mapping for discovery', () => {
    const config = parseConfig({ customers: { '10:00': { representativeName: 'Example Person A' } } });
    expect(() => validateModeConfig(config, 'full-rehearsal', true)).toThrow('--slot');
    expect(() => validateModeConfig(config, 'full-rehearsal', true, '10:00')).not.toThrow();
  });

  it('live pins both slots, the exact target date and release instant', () => {
    expect(() => validateModeConfig(liveConfig(), 'live', true)).not.toThrow();
    expect(() => validateModeConfig(liveConfig({ releaseAt: '2026-10-12T08:00:00+08:00' }), 'live', true)).not.toThrow();
    expect(() => validateModeConfig(liveConfig({ slots: ['10:00'] }), 'live', true)).toThrow('both independent');
    expect(() => validateModeConfig(liveConfig({ targetDate: '2026-10-25' }), 'live', true)).toThrow('pinned');
    expect(() => validateModeConfig(liveConfig({ releaseAt: '2026-10-12T09:00:01+09:00' }), 'live', true)).toThrow('pinned');
  });

  it('keeps reservation modes visible and checks separate representatives', () => {
    expect(() => validateModeConfig(liveConfig({ browser: { headless: true } }), 'live', true)).toThrow('visible browser');
    const config = liveConfig();
    config.customers['10:30']!.representativeName = ' Ｅxample Person A ';
    expect(() => validateModeConfig(config, 'live', true)).toThrow('different representative');
  });

  it('prevents distinct asserted names paired with a different actual autofill name', () => {
    const config = liveConfig();
    config.customers['10:30']!.fields.representativeName = 'Example Person A';
    expect(() => validateModeConfig(config, 'live', true)).toThrow('field value equals');
    config.customers['10:30']!.fields.representativeName = 'Example Person B';
    config.customers['10:30']!.mappings = [];
    expect(() => validateModeConfig(config, 'live', true)).toThrow('representativeName mapping');
  });

  it('does not include local values in config errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'takachiho-config-'));
    const path = join(directory, 'local.json');
    try {
      await writeFile(path, '{"personalName":"CONFIDENTIAL_PERSON",');
      await expect(loadConfig(path)).rejects.not.toThrow('CONFIDENTIAL_PERSON');
      await writeFile(path, JSON.stringify({ customers: { '10:00': { fields: { email: 777 } } } }));
      await expect(loadConfig(path)).rejects.toThrow('Invalid local config');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
