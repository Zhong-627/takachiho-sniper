import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertReservationTargetsUnchanged, loadConfig, parseConfig, validateModeConfig, type CustomerConfig } from '../src/config.js';
import { TEST_TARGET } from './fixtures/config.js';

function configWith(overrides: Record<string, unknown> = {}) {
  return parseConfig({ ...TEST_TARGET, ...overrides });
}

function fixtureCustomer(name: string): CustomerConfig {
  return { representativeName: name, fields: { representativeName: name }, mappings: [{ key: 'representativeName', selector: '#name' }] };
}

function liveConfig(overrides: Record<string, unknown> = {}) {
  return configWith({
    customers: {
      '10:00': { representativeName: 'Example Person A', fields: { representativeName: 'Example Person A' }, mappings: [{ key: 'representativeName', selector: '#name' }] },
      '10:30': { representativeName: 'Example Person B', fields: { representativeName: 'Example Person B' }, mappings: [{ key: 'representativeName', selector: '#name' }] },
    },
    ...overrides,
  });
}

describe('strict local config', () => {
  it('reads explicit targets and defaults only the non-target browser settings', () => {
    const config = configWith();
    expect(config.targetDate).toBe('2026-10-26');
    expect(config.releaseAt).toBe('2026-10-12T09:00:00+09:00');
    expect(config.slots).toEqual(['10:00', '10:30']);
    expect(config.browser.headless).toBe(false);
  });

  it.each(['targetDate', 'releaseAt', 'slots'])('rejects missing %s instead of silently restoring the original target', (key) => {
    const input: Record<string, unknown> = { ...TEST_TARGET };
    delete input[key];
    expect(() => parseConfig(input)).toThrow(key);
  });

  it('rejects unknown fields, invalid dates and offset-free release times', () => {
    expect(() => configWith({ mystery: true })).toThrow('Invalid local config');
    expect(() => configWith({ targetDate: '2026-02-30' })).toThrow('calendar date');
    expect(() => configWith({ releaseAt: '2026-10-12T09:00:00' })).toThrow();
    expect(() => configWith({ releaseAt: '2026-10-12T09:00:00+99:99' })).toThrow();
    expect(() => configWith({ slots: ['10:00', '10:00'] })).toThrow('unique targets');
  });

  it.each(['00:00', '08:30', '11:15', '23:59'])('accepts the configured Japan-local slot %s', (slot) => {
    const config = configWith({ slots: [slot], customers: { [slot]: fixtureCustomer('Example Person A') } });
    expect(() => validateModeConfig(config, 'live', true)).not.toThrow();
    expect(() => validateModeConfig(config, 'full-rehearsal', true, slot)).not.toThrow();
  });

  it.each(['9:00', '24:00', '11:60', '11:30:00', ' 11:30', ''])('rejects invalid slot %s in targets and customer keys', (slot) => {
    expect(() => configWith({ slots: [slot] })).toThrow('HH:mm');
    expect(() => configWith({ customers: { [slot]: fixtureCustomer('Example Person A') } })).toThrow('Invalid local config');
  });

  it('keeps the one-or-two independent target limit', () => {
    expect(() => configWith({ slots: [] })).toThrow();
    expect(() => configWith({ slots: ['08:30', '11:15', '12:00'] })).toThrow();
  });

  it('rejects request-flooding settings and unusable bounds', () => {
    expect(() => configWith({ polling: { maxAttempts: 0 } })).toThrow();
    expect(() => configWith({ polling: { baseDelayMs: 10 } })).toThrow();
    expect(() => configWith({ polling: { baseDelayMs: 2000, maxDelayMs: 1000 } })).toThrow('at least baseDelayMs');
  });

  it('rejects duplicate mappings before interacting with a browser', () => {
    expect(() => configWith({ customers: { '10:00': { mappings: [{ key: 'a', selector: '#one' }, { key: 'a', selector: '#two' }] } } })).toThrow('unique keys');
    expect(() => configWith({ customers: { '10:00': { mappings: [{ key: 'a', selector: '#one' }, { key: 'b', selector: '#one' }] } } })).toThrow('unique selectors');
  });

  it('safe modes work without customer data and side effects require the exact explicit flag', () => {
    const config = configWith();
    expect(() => validateModeConfig(config, 'inspect', false)).not.toThrow();
    expect(() => validateModeConfig(config, 'rehearsal', false)).not.toThrow();
    expect(() => validateModeConfig(config, 'live', false)).toThrow('--confirm-reservation-side-effects');
    expect(() => validateModeConfig(config, 'full-rehearsal', false, '10:00')).toThrow('--confirm-reservation-side-effects');
  });

  it('full rehearsal needs one explicit slot but accepts an incomplete form mapping for discovery', () => {
    const config = configWith({ customers: { '10:00': { representativeName: 'Example Person A' } } });
    expect(() => validateModeConfig(config, 'full-rehearsal', true)).toThrow('--slot');
    expect(() => validateModeConfig(config, 'full-rehearsal', true, '10:00')).not.toThrow();
    expect(() => validateModeConfig(config, 'full-rehearsal', true, '09:00')).toThrow('configured target slot');
  });

  it('live accepts configured dates, release instants and one or two arbitrary slots', () => {
    expect(() => validateModeConfig(liveConfig(), 'live', true)).not.toThrow();
    expect(() => validateModeConfig(liveConfig({ releaseAt: '2026-10-12T08:00:00+08:00' }), 'live', true)).not.toThrow();
    expect(() => validateModeConfig(liveConfig({ slots: ['10:00'] }), 'live', true)).not.toThrow();
    const changed = liveConfig({ targetDate: '2026-11-03', releaseAt: '2026-10-20T08:00:00+08:00', slots: ['09:15', '11:45'],
      customers: { '09:15': fixtureCustomer('Example Person A'), '11:45': fixtureCustomer('Example Person B') } });
    expect(() => validateModeConfig(changed, 'live', true)).not.toThrow();
    expect(changed.targetDate).toBe('2026-11-03');
    expect(changed.releaseAt).toBe('2026-10-20T08:00:00+08:00');
    expect(changed.customers['11:45']?.representativeName).toBe('Example Person B');
  });

  it('refuses missing customer data after a slot rename rather than reusing an old slot', () => {
    expect(() => validateModeConfig(liveConfig({ slots: ['09:15'] }), 'live', true)).toThrow('actual representativeName');
    const config = liveConfig({ slots: ['09:15', '11:45'], customers: {
      '09:15': fixtureCustomer('Example Person A'), '11:45': fixtureCustomer(' Ｅxample Person A '),
    } });
    expect(() => validateModeConfig(config, 'live', true)).toThrow('different representative');
  });

  it('freezes running reservation targets while allowing customer edits and equivalent timezone notation', () => {
    const original = liveConfig();
    const updated = liveConfig({ releaseAt: '2026-10-12T08:00:00+08:00', slots: ['10:30', '10:00'] });
    updated.customers['10:00']!.fields.email = 'fixture@example.invalid';
    expect(() => assertReservationTargetsUnchanged(original, updated)).not.toThrow();
    for (const overrides of [{ targetDate: '2026-10-27' }, { releaseAt: '2026-10-12T09:00:01+09:00' }, { slots: ['09:15', '11:45'] }, { slots: ['10:00'] }]) {
      expect(() => assertReservationTargetsUnchanged(original, liveConfig(overrides))).toThrow('預約目標已變更');
    }
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
      await writeFile(path, JSON.stringify({ ...TEST_TARGET, customers: { '10:00': { fields: { email: 777 } } } }));
      await expect(loadConfig(path)).rejects.toThrow('Invalid local config');
      await writeFile(path, JSON.stringify({ ...TEST_TARGET, customers: { CONFIDENTIAL_PERSON: fixtureCustomer('PRIVATE_NAME') } }));
      await expect(loadConfig(path)).rejects.not.toThrow('CONFIDENTIAL_PERSON');
      await expect(loadConfig(path)).rejects.not.toThrow('PRIVATE_NAME');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
