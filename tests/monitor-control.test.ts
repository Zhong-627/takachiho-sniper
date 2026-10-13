import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import { applyControlSettings, createDemoControl, createMonitorControl, type ControlSettings } from '../src/monitor-control.js';
import { MonitorState, type MonitorSnapshot } from '../src/monitor-state.js';
import { boardingDateRange } from '../src/monitor-targets.js';
import type { WorkerStatus } from '../src/reservation-runner.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function fixture() {
  const releaseAt = new Date(Date.now() + 120_000).toISOString();
  return parseConfig({ targetDate: boardingDateRange().max, releaseAt,
    monitorFrom: new Date(Date.now()).toISOString(), monitorUntil: new Date(Date.now() + 7200_000).toISOString(),
    slots: ['11:00', '11:30'], customers: {
      '11:00': { representativeName: 'PRIVATE_PERSON_A', fields: { email: 'PRIVATE_EMAIL_A' }, mappings: [] },
      '11:30': { representativeName: 'PRIVATE_PERSON_B', fields: { email: 'PRIVATE_EMAIL_B' }, mappings: [] },
    } });
}
function selection(): ControlSettings {
  const config = fixture();
  return { targetDate: config.targetDate, releaseAt: config.releaseAt, monitorFrom: config.monitorFrom!, monitorUntil: config.monitorUntil!,
    baseDelayMs: 750, manualCustomerForm: true,
    slots: [{ slot: '10:00', customerProfile: '11:00' }, { slot: '10:30', customerProfile: '11:30' }] };
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'takachiho-control-'));
  directories.push(directory);
  const configPath = join(directory, 'config.local.json');
  const original = JSON.stringify(fixture());
  await writeFile(configPath, original, { mode: 0o600 });
  let current: WorkerStatus | null = null;
  let observed: MonitorSnapshot = new MonitorState('fixture').snapshot();
  let launchedConfig: unknown;
  const launch = vi.fn(async (path: string, manualCustomerForm: boolean, runId: string) => {
    expect(manualCustomerForm).toBeTypeOf('boolean');
    launchedConfig = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const config = parseConfig(launchedConfig);
    current = { runId, targetDate: config.targetDate, automationStopped: false, closed: false,
      slots: config.slots.map((slot) => ({ slot, active: true, handedOff: false, canHandoff: false, holdConfirmed: false })) };
  });
  const command = vi.fn(async (name: 'stop' | 'handoff' | 'close', runId: string, slot?: string) => {
    if (!current || current.runId !== runId) throw new Error('PRIVATE');
    const value = current;
    if (name === 'close') { value.closed = true; current = null; }
    else if (name === 'stop') { value.automationStopped = true; value.slots.forEach((entry) => { entry.active = false; }); }
    else { const target = value.slots.find((entry) => entry.slot === slot)!; target.handedOff = true; target.canHandoff = false; }
    return value;
  });
  const control = createMonitorControl({ configPath, directory: join(directory, 'control'), snapshot: () => observed,
    runtime: { status: async () => current, launch, command, preflight: async () => undefined, wait: async () => undefined } });
  return { directory, configPath, original, control, launch, command,
    config: () => launchedConfig, worker: () => current,
    observed: (value: MonitorSnapshot) => { observed = value; } };
}

describe('PWA target control', () => {
  it('maps single/new slots to local customer profiles without overwriting or exposing personal data', async () => {
    const test = await setup();
    const value = selection();
    value.slots = [value.slots[1]!];
    const state = await test.control.save(value);
    expect(state.settings?.slots).toEqual([{ slot: '10:30', customerProfile: '11:30' }]);
    expect(JSON.stringify(state)).not.toContain('PRIVATE');
    const path = join(test.directory, 'control', 'settings.json');
    expect(await readFile(path, 'utf8')).not.toContain('PRIVATE');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await test.control.start(true);
    expect(test.launch).toHaveBeenCalledTimes(1);
    expect(test.config()).toMatchObject({ slots: ['10:30'], customers: { '10:30': { representativeName: 'PRIVATE_PERSON_B' } } });
    expect(await readFile(test.configPath, 'utf8')).toBe(test.original);
  });

  it('rejects duplicate targets/profiles, unknown profiles, impossible dates and unknown keys', () => {
    const base = fixture();
    for (const value of [
      { ...selection(), slots: [{ slot: '11:00', customerProfile: '11:00' }, { slot: '11:00', customerProfile: '11:30' }] },
      { ...selection(), slots: [{ slot: '11:00', customerProfile: '11:00' }, { slot: '11:30', customerProfile: '11:00' }] },
      { ...selection(), slots: [{ slot: '11:00', customerProfile: '12:00' }] },
      { ...selection(), targetDate: '2026-02-30' },
      { ...selection(), monitorUntil: selection().monitorFrom },
      { ...selection(), executable: '/untrusted' },
    ]) expect(() => applyControlSettings(base, value)).toThrow();
  });

  it('rejects dates outside the current Japan range and slots outside the half-hour boarding choices on save', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T09:00:00+09:00'));
    const test = await setup();
    const state = await test.control.snapshot();
    expect(state.targetDateRange).toEqual({ min: '2026-10-13', max: '2026-10-27' });
    for (const targetDate of ['2026-10-12', '2026-10-28']) {
      await expect(test.control.save({ ...selection(), targetDate })).rejects.toThrow('乘船日期只能');
    }
    for (const slot of ['07:30', '08:01', '11:15', '16:30']) {
      await expect(test.control.save({ ...selection(), slots: [{ slot, customerProfile: '11:00' }] })).rejects.toThrow('乘船時間只能');
    }
    expect((await test.control.snapshot()).settings).toEqual(state.settings);
    expect(test.launch).not.toHaveBeenCalled();
    const saved = await test.control.save({ ...selection(), targetDate: '2026-10-13',
      slots: [{ slot: '08:00', customerProfile: '11:00' }, { slot: '16:00', customerProfile: '11:30' }] });
    expect(saved.settings?.slots.map(({ slot }) => slot)).toEqual(['08:00', '16:00']);
  });

  it('keeps legacy default targets readable and editable but rejects their save and start', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T09:00:00+09:00'));
    for (const legacy of [
      { ...fixture(), targetDate: '2026-10-12' },
      { ...fixture(), slots: ['07:45'], customers: { '07:45': fixture().customers['11:00']! } },
    ]) {
      const test = await setup();
      await writeFile(test.configPath, JSON.stringify(legacy));
      const state = await test.control.snapshot();
      expect(state.enabled).toBe(true);
      expect(state.settings?.targetDate).toBe(legacy.targetDate);
      expect(state.settings?.slots.map(({ slot }) => slot)).toEqual(legacy.slots);
      await expect(test.control.save(state.settings)).rejects.toThrow(/乘船日期只能|乘船時間只能/u);
      await expect(test.control.start(true, state.settings)).rejects.toThrow(/乘船日期只能|乘船時間只能/u);
      expect(test.launch).not.toHaveBeenCalled();
      expect(await readFile(test.configPath, 'utf8')).toBe(JSON.stringify(legacy));
      const corrected = { ...state.settings!, targetDate: boardingDateRange().max,
        slots: state.settings!.slots.map((entry, index) => ({ ...entry, slot: index ? '08:30' : '08:00' })) };
      expect((await test.control.save(corrected)).settings).toEqual(corrected);
      await test.control.start(true);
      expect(test.launch).toHaveBeenCalledOnce();
    }
  });

  it('rechecks saved targets at start after Japan midnight without altering the saved selection', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T23:59:59+09:00'));
    const test = await setup();
    const settings = { ...selection(), targetDate: '2026-10-13' };
    await test.control.save(settings);
    now.mockReturnValue(Date.parse('2026-10-14T00:00:00+09:00'));
    const state = await test.control.snapshot();
    expect(state.settings).toEqual(settings);
    expect(state.targetDateRange).toEqual({ min: '2026-10-14', max: '2026-10-27' });
    await expect(test.control.start(true, settings)).rejects.toThrow('乘船日期只能');
    expect(test.launch).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(test.directory, 'control', 'settings.json'), 'utf8'))).toEqual(settings);
  });

  it('rechecks the target after asynchronous preflight crosses Japan midnight and removes pending launch files', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T23:59:59+09:00'));
    const test = await setup();
    await writeFile(test.configPath, JSON.stringify({ ...fixture(), targetDate: '2026-10-13' }));
    const directory = join(test.directory, 'control');
    const launch = vi.fn(async () => undefined);
    const preflight = vi.fn(async () => {
      now.mockReturnValue(Date.parse('2026-10-14T00:00:00+09:00'));
    });
    const control = createMonitorControl({ configPath: test.configPath, directory,
      snapshot: () => new MonitorState('none').snapshot(),
      runtime: { status: async () => null, launch, preflight, wait: async () => undefined } });
    await expect(control.start(true)).rejects.toThrow('乘船日期只能');
    expect(preflight).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
    expect((await control.snapshot()).settings?.targetDate).toBe('2026-10-13');
  });

  it('preserves arbitrary schedule minutes and seconds while constraining only boarding slots', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T09:00:00+09:00'));
    const test = await setup();
    const settings = { ...selection(), monitorFrom: '2026-10-13T07:48:13+08:00',
      releaseAt: '2026-10-13T07:55:27+08:00', monitorUntil: '2026-10-13T10:05:49+08:00' };
    expect((await test.control.save(settings)).settings).toEqual(settings);
    await test.control.start(true);
    expect(test.config()).toMatchObject({ monitorFrom: settings.monitorFrom, releaseAt: settings.releaseAt, monitorUntil: settings.monitorUntil });
  });

  it('rejects a start reviewed against settings that another client has since changed', async () => {
    const test = await setup();
    const reviewed = (await test.control.snapshot()).settings;
    await test.control.save(selection());
    await expect(test.control.start(true, reviewed)).rejects.toThrow('已被更新');
    expect(test.launch).not.toHaveBeenCalled();
    await test.control.start(true, (await test.control.snapshot()).settings);
    expect(test.launch).toHaveBeenCalledOnce();
  });

  it('locks settings and start until close, preserves the other slot when handing one off, and rejects stale IDs', async () => {
    const test = await setup();
    await test.control.save(selection());
    await expect(test.control.start(false)).rejects.toThrow('開始搶位');
    const state = await test.control.start(true);
    await expect(test.control.save(selection())).rejects.toThrow('仍開啟');
    await expect(test.control.start(true)).rejects.toThrow('仍開啟');
    await expect(test.control.command('stop', 'older-run')).rejects.toThrow('已變更');
    await expect(test.control.command('handoff', state.worker!.runId, '10:00')).rejects.toThrow('仍在執行');
    const target = test.worker()!.slots[0]!;
    target.active = false; target.canHandoff = true; target.holdConfirmed = true;
    const handed = await test.control.command('handoff', state.worker!.runId, '10:00');
    expect(handed.worker?.slots[0]?.handedOff).toBe(true);
    expect(handed.worker?.slots[1]?.active).toBe(true);
    expect(test.command).toHaveBeenCalledTimes(1);
    const stopped = await test.control.command('stop', state.worker!.runId);
    expect(stopped.worker?.automationStopped).toBe(true);
    expect(stopped.worker?.closed).toBe(false);
    await expect(test.control.start(true)).rejects.toThrow('仍開啟');
    expect((await test.control.command('close', state.worker!.runId)).worker).toBeNull();
    await test.control.save(selection());
  });

  it('blocks a separate terminal run and missing local config without spawning anything', async () => {
    const test = await setup();
    const source = new MonitorState('external');
    source.ingest({ mode: 'live', event: 'run_started', epochMs: Date.now(), data: { slots: ['11:00'], targetDate: '2026-11-04' } });
    test.observed(source.snapshot());
    expect((await test.control.snapshot()).externalRun).toBe(true);
    await expect(test.control.start(true)).rejects.toThrow('原終端');
    await rm(test.configPath);
    const missing = await test.control.snapshot();
    expect(missing.enabled).toBe(false);
    expect(missing.settings).toBeNull();
    expect(test.launch).not.toHaveBeenCalled();
  });

  it('keeps existing worker controls available when its source config later becomes unreadable', async () => {
    const test = await setup();
    const started = await test.control.start(true);
    await rm(test.configPath);
    const state = await test.control.snapshot();
    expect(state.enabled).toBe(true);
    expect(state.settings).toBeNull();
    expect(state.worker?.runId).toBe(started.worker!.runId);
    expect((await test.control.command('stop', started.worker!.runId)).worker?.automationStopped).toBe(true);
    expect((await test.control.command('close', started.worker!.runId)).worker).toBeNull();
  });

  it('keeps active worker controls available when local defaults no longer meet target restrictions', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T09:00:00+09:00'));
    const test = await setup();
    const started = await test.control.start(true);
    await writeFile(test.configPath, JSON.stringify({ ...fixture(), targetDate: '2026-10-12' }));
    const state = await test.control.snapshot();
    expect(state.enabled).toBe(true);
    expect(state.settings?.targetDate).toBe('2026-10-12');
    expect((await test.control.command('stop', started.worker!.runId)).worker?.automationStopped).toBe(true);
    expect((await test.control.command('close', started.worker!.runId)).worker).toBeNull();
  });

  it('unlocks finished stale history only after confirming the project reservation process is absent', async () => {
    const test = await setup();
    const now = Date.now();
    const historical: MonitorSnapshot = {
      ...new MonitorState('old-run').snapshot(), connection: 'stale', heartbeatAt: now - 8 * 3600_000,
      run: { id: 'old-run', targetDate: '2026-10-26', startedAt: now - 9 * 3600_000, mode: 'live',
        releaseAt: now - 9 * 3600_000, monitorFrom: now - 9 * 3600_000, monitorUntil: now - 8 * 3600_000 },
      slots: ['11:00', '11:30'].map((slot) => ({ slot, phase: 'stopped', attempts: 30, availability: 'unavailable',
        responseMs: 400, nextRetryAt: null, updatedAt: now - 8 * 3600_000, holdConfirmed: false, heldAt: null })),
    };
    let current: WorkerStatus | null = null;
    const check = vi.fn(async () => false);
    const control = createMonitorControl({ configPath: test.configPath, directory: join(test.directory, 'control'), snapshot: () => historical,
      runtime: { status: async () => current, externalProcessActive: check, preflight: async () => undefined,
        launch: async (_path, _manual, runId) => { current = { runId, targetDate: selection().targetDate, closed: false, automationStopped: false,
          slots: selection().slots.map(({ slot }) => ({ slot, active: true, handedOff: false, canHandoff: false, holdConfirmed: false })) }; } } });
    expect((await control.snapshot()).externalRun).toBe(false);
    await control.save(selection());
    expect((await control.start(true)).worker).not.toBeNull();
    expect(check).toHaveBeenCalledOnce();
  });

  it('does not relock expired history while a bounded log replay is still showing earlier polling phases', async () => {
    const test = await setup();
    const now = Date.now();
    for (const phase of ['waiting', 'warming', 'monitoring', 'retrying'] as const) {
      const historical: MonitorSnapshot = {
        ...new MonitorState('replayed').snapshot(), connection: 'stale', heartbeatAt: now - 8 * 3600_000,
        run: { id: 'replayed', targetDate: '2026-10-26', startedAt: now - 9 * 3600_000, mode: 'live',
          releaseAt: now - 9 * 3600_000, monitorFrom: now - 9 * 3600_000, monitorUntil: now - 8 * 3600_000 },
        slots: [{ slot: '11:00', phase, attempts: 300, availability: 'unavailable', responseMs: 400,
          nextRetryAt: null, updatedAt: now - 8 * 3600_000, holdConfirmed: false, heldAt: null }],
      };
      const check = vi.fn(async () => false);
      const control = createMonitorControl({ configPath: test.configPath, directory: join(test.directory, 'control'), snapshot: () => historical,
        runtime: { status: async () => null, externalProcessActive: check } });
      expect((await control.snapshot()).externalRun).toBe(false);
      await control.save(selection());
      expect(check).toHaveBeenCalledOnce();
    }
  });

  it('preserves current, uncertain, held, or not-yet-expired terminal run protection', async () => {
    const test = await setup();
    const now = Date.now();
    const base: MonitorSnapshot = {
      ...new MonitorState('legacy').snapshot(), connection: 'stale', heartbeatAt: now - 3600_000,
      run: { id: 'legacy', targetDate: '2026-10-26', startedAt: now - 3600_000, mode: 'live',
        releaseAt: now - 3600_000, monitorFrom: now - 3600_000, monitorUntil: now - 1800_000 },
      slots: [{ slot: '11:00', phase: 'stopped', attempts: 1, availability: null, responseMs: null,
        nextRetryAt: null, updatedAt: now - 1800_000, holdConfirmed: false, heldAt: null }],
    };
    const cases: MonitorSnapshot[] = [
      { ...base, connection: 'live' },
      { ...base, run: { ...base.run!, monitorUntil: now + 1800_000 } },
      { ...base, run: { ...base.run!, monitorUntil: null } },
      ...(['reserving', 'held', 'manual', 'ambiguous', 'handed-off', 'failed'] as const)
        .map((phase) => ({ ...base, slots: [{ ...base.slots[0]!, phase }] })),
      { ...base, slots: [{ ...base.slots[0]!, holdConfirmed: true, heldAt: now - 1800_000 }] },
      { ...base, slots: [{ ...base.slots[0]!, holdConfirmed: undefined }] },
    ];
    for (const observed of cases) {
      const check = vi.fn(async () => false);
      const control = createMonitorControl({ configPath: test.configPath, directory: join(test.directory, 'control'), snapshot: () => observed,
        runtime: { status: async () => null, externalProcessActive: check } });
      expect((await control.snapshot()).externalRun).toBe(true);
      await expect(control.save(selection())).rejects.toThrow('原終端');
      expect(check).not.toHaveBeenCalled();
    }
    for (const status of ['alive', 'uncertain', 'managed-lock'] as const) {
      const control = createMonitorControl({ configPath: test.configPath, directory: join(test.directory, 'control'), snapshot: () => base,
        runtime: {
          status: async () => { if (status === 'managed-lock') throw new Error('Uncertain worker'); return null; },
          externalProcessActive: async () => { if (status === 'uncertain') throw new Error('Private process error'); return true; },
        } });
      const state = await control.snapshot();
      expect(state.externalRun).toBe(true);
      expect(state.enabled).toBe(status === 'alive');
      await expect(control.save(selection())).rejects.toThrow();
    }
  });

  it('rejects overlapping starts and never retries an unconfirmed detached launch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'takachiho-control-timeout-'));
    directories.push(directory);
    const configPath = join(directory, 'config.local.json');
    await writeFile(configPath, JSON.stringify(fixture()));
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const launch = vi.fn(async () => gate);
    const control = createMonitorControl({ configPath, directory, snapshot: () => new MonitorState('none').snapshot(),
      runtime: { status: async () => null, launch, preflight: async () => undefined, wait: async () => undefined } });
    const pending = control.start(true);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    await expect(control.start(true)).rejects.toThrow('正在處理');
    release();
    await expect(pending).rejects.toThrow('尚未確認');
    await expect(control.start(true)).rejects.toThrow('前次啟動');
    expect(launch).toHaveBeenCalledOnce();
    const restarted = createMonitorControl({ configPath, directory, snapshot: () => new MonitorState('none').snapshot(),
      runtime: { status: async () => null, launch, preflight: async () => undefined, wait: async () => undefined } });
    await expect(restarted.start(true)).rejects.toThrow('前次啟動');
    await expect(restarted.save(selection())).rejects.toThrow('前次啟動');
    expect(launch).toHaveBeenCalledOnce();
  });

  it('never treats an unrelated worker as confirmation for a different launch attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'takachiho-control-identity-'));
    directories.push(directory);
    const configPath = join(directory, 'config.local.json');
    await writeFile(configPath, JSON.stringify(fixture()));
    let current: WorkerStatus | null = null;
    const control = createMonitorControl({ configPath, directory, snapshot: () => new MonitorState('none').snapshot(),
      runtime: {
        status: async () => current, preflight: async () => undefined, wait: async () => undefined,
        launch: async () => { current = { runId: 'other-run', targetDate: '2026-11-05', automationStopped: false, closed: false,
          slots: [{ slot: '12:00', active: true, handedOff: false, canHandoff: false, holdConfirmed: false }] }; },
      } });
    await expect(control.start(true)).rejects.toThrow('另一個搶位程序');
    expect((await control.snapshot()).worker?.runId).toBe('other-run');
    expect((await stat(join(directory, 'launch.json'))).mode & 0o777).toBe(0o600);
    current = null;
    await expect(control.start(true)).rejects.toThrow('前次啟動');
  });

  it('has a functional single-slot demo that never launches a real worker', async () => {
    const control = createDemoControl();
    const settings = (await control.snapshot()).settings!;
    settings.slots = [settings.slots[0]!];
    await control.save(settings);
    const started = await control.start(true);
    expect(control.monitorSnapshot().slots).toHaveLength(1);
    await control.command('stop', started.worker!.runId);
    await control.command('handoff', started.worker!.runId, settings.slots[0]!.slot);
    expect(control.monitorSnapshot().slots[0]?.phase).toBe('handed-off');
    await control.command('close', started.worker!.runId);
    expect(control.monitorSnapshot().run).toBeNull();
  });

  it('applies the same date and boarding choices in demo while preserving unrestricted schedules', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-13T08:59:59+09:00'));
    const control = createDemoControl();
    const state = await control.snapshot();
    expect(state.targetDateRange).toEqual({ min: '2026-10-13', max: '2026-10-26' });
    expect(state.settings?.targetDate).toBe('2026-10-26');
    await expect(control.save({ ...state.settings, targetDate: '2026-10-27' })).rejects.toThrow('乘船日期只能');
    await expect(control.save({ ...state.settings, slots: [{ slot: '11:15', customerProfile: '11:00' }] })).rejects.toThrow('乘船時間只能');
    const settings = { ...state.settings!, targetDate: '2026-10-13', monitorFrom: '2026-10-13T07:48:00+08:00',
      releaseAt: '2026-10-13T07:55:00+08:00', monitorUntil: '2026-10-13T10:05:00+08:00' };
    expect((await control.save(settings)).settings).toEqual(settings);
    now.mockReturnValue(Date.parse('2026-10-14T00:00:00+09:00'));
    expect((await control.snapshot()).settings).toEqual(settings);
    await expect(control.start(true)).rejects.toThrow('乘船日期只能');
    expect(control.monitorSnapshot().run).toBeNull();
  });
});
