import type { Browser, BrowserContext, Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import type { Diagnostics } from '../src/diagnostics.js';
import { reservationRuntime, startReservationRun, startRun, type ReservationRun, type ReservationRuntime } from '../src/reservation-runner.js';
import type { SafetyGuard } from '../src/safety.js';
import { describeActionPlan, type SiteEvent } from '../src/site.js';

function config() {
  return parseConfig({ targetDate: '2030-10-26', releaseAt: '2020-10-12T09:00:00+09:00', monitorUntil: '2099-10-12T10:00:00+08:00',
    slots: ['10:00', '10:30'], customers: {
      '10:00': { representativeName: 'Fixture Person A', fields: {}, mappings: [] },
      '10:30': { representativeName: 'Fixture Person B', fields: {}, mappings: [] },
    } });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeRuntime(gates: Record<string, Promise<void>> = {}) {
  const closeBrowser = vi.fn(async () => undefined);
  const handoff = vi.fn(async () => undefined);
  const action = vi.fn();
  const pages = new WeakMap<Page, string>();
  const states = new WeakMap<SafetyGuard, { holdConfirmed: boolean }>();
  let nextSlot = 0;
  const diagnostics = { dir: 'fixture', event: vi.fn(), writeJson: vi.fn(async () => undefined), snapshot: vi.fn(async () => undefined),
    attach: vi.fn(), close: vi.fn(async () => undefined), addSecrets: vi.fn() } as unknown as Diagnostics;
  const runtime: ReservationRuntime = { ...reservationRuntime,
    createDiagnostics: async () => diagnostics,
    launchSlotBrowser: async () => ({ close: closeBrowser } as unknown as Browser),
    createGuardedContext: async () => {
      const slot = ['10:00', '10:30'][nextSlot++]!;
      const page = { setDefaultTimeout: vi.fn() } as unknown as Page;
      pages.set(page, slot);
      const state = { holdConfirmed: false };
      const guard = { state, handoffToHuman: handoff } as unknown as SafetyGuard;
      states.set(guard, state);
      return { guard, context: { newPage: async () => page } as unknown as BrowserContext };
    },
    openCalendar: async () => ({ payload: {}, httpStatus: 200, responseMs: 1, clientEvents: [], domEvents: [] }),
    waitUntilRelease: async () => undefined,
    probeAvailability: async (page) => {
      const slot = pages.get(page)!;
      const event: SiteEvent = { service_cd: 'fixture-service', session_cd: 'fixture-session',
        service_start_datetime: `2030/10/26 ${slot}:00`, service_end_datetime: `2030/10/26 ${slot === '10:00' ? '10:30' : '11:00'}:00`,
        calendar_select_action_type: '1', ordable: true, reserve_possible: true, is_reserve_started: true, is_reserve_dead: false, is_full: false, enabled_flg: true, is_accept: true };
      return { status: 'available', reason: 'fixture', event };
    },
    performReservation: async (page, event, guard) => {
      const slot = pages.get(page)!;
      action(slot);
      if (gates[slot]) await gates[slot];
      states.get(guard)!.holdConfirmed = true;
      return { status: 'customer-form-ready', plan: describeActionPlan(event) };
    },
    prepareCustomerForm: async () => ({ status: 'manual', verificationRecordFailed: false,
      result: { status: 'manual-required', customerFieldsVerified: false, schema: { ready: true, controls: [] }, filledKeys: [], missingMappingKeys: [], missingRequiredControls: [], manualControls: [], errors: [] } }),
  };
  return { runtime, action, handoff, closeBrowser, diagnostics };
}

const running: ReservationRun[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((run) => run.close())); vi.restoreAllMocks(); });

describe('shared reservation runner', () => {
  it('keeps two independent holds and only hands an inactive slot to the Mac operator', async () => {
    const gate = deferred();
    const fake = fakeRuntime({ '10:30': gate.promise });
    const run = await startReservationRun(config(), { manualCustomerForm: true, runtime: fake.runtime });
    running.push(run);
    await vi.waitFor(() => expect(run.status().slots[0]?.canHandoff).toBe(true));
    expect(run.status().slots[0]?.holdConfirmed).toBe(true);
    expect(run.status().slots[1]?.active).toBe(true);
    await expect(run.handoff('10:30')).rejects.toThrow('running');
    await run.handoff('10:00');
    expect(run.status().slots[0]?.handedOff).toBe(true);
    expect(run.status().slots[1]?.active).toBe(true);
    expect(fake.handoff).toHaveBeenCalledTimes(1);
    gate.resolve();
    await run.wait();
    expect(run.status().slots.every((slot) => slot.holdConfirmed)).toBe(true);
    expect(fake.action.mock.calls.map(([slot]) => slot)).toEqual(['10:00', '10:30']);
    expect(fake.closeBrowser).not.toHaveBeenCalled();
  });

  it('stop preserves in-flight holds and browsers while explicit close waits for the response', async () => {
    const gate = deferred();
    const fake = fakeRuntime({ '10:00': gate.promise, '10:30': gate.promise });
    const run = await startReservationRun(config(), { manualCustomerForm: true, runtime: fake.runtime });
    running.push(run);
    await vi.waitFor(() => expect(fake.action).toHaveBeenCalledTimes(2));
    run.stop();
    expect(run.status().automationStopped).toBe(true);
    expect(run.status().closed).toBe(false);
    expect(fake.closeBrowser).not.toHaveBeenCalled();
    const closing = run.close();
    expect(run.status().slots.every((slot) => !slot.canHandoff)).toBe(true);
    expect(fake.closeBrowser).not.toHaveBeenCalled();
    gate.resolve();
    await closing;
    expect(run.status().slots.every((slot) => slot.holdConfirmed)).toBe(true);
    expect(run.status().closed).toBe(true);
    expect(fake.closeBrowser).toHaveBeenCalledTimes(2);
    expect(fake.action).toHaveBeenCalledTimes(2);
  });

  it('retains visible-browser and live-window preflight checks before launch', async () => {
    const fake = fakeRuntime();
    const launch = vi.spyOn(fake.runtime, 'launchSlotBrowser');
    await expect(startReservationRun({ ...config(), browser: { channel: 'chromium', headless: true } }, { manualCustomerForm: true, runtime: fake.runtime })).rejects.toThrow('visible browser');
    await expect(startReservationRun({ ...config(), monitorUntil: '2021-10-12T10:00:00+08:00' }, { manualCustomerForm: true, runtime: fake.runtime })).rejects.toThrow('deadline');
    expect(launch).not.toHaveBeenCalled();
  });

  it('preserves safe CLI modes: no hold and no removal of reservation protection', async () => {
    const fake = fakeRuntime();
    const run = await startRun(config(), { mode: 'inspect', confirmed: false, manualCustomerForm: false, runtime: fake.runtime });
    running.push(run);
    await run.wait();
    expect(fake.action).not.toHaveBeenCalled();
    expect(run.status().slots.every((slot) => !slot.canHandoff && !slot.holdConfirmed)).toBe(true);
    await expect(run.handoff('10:00')).rejects.toThrow();
  });

  it('refuses target changes when refilling an existing held page', async () => {
    const fake = fakeRuntime();
    const input = config();
    const customers = Object.fromEntries(Object.entries(input.customers).map(([slot, customer]) => [slot, { ...customer!, fields: { representativeName: customer!.representativeName }, mappings: [{ key: 'representativeName', selector: '#name' }] }]));
    const run = await startReservationRun({ ...input, customers }, { manualCustomerForm: false, runtime: fake.runtime });
    running.push(run);
    await run.wait();
    await expect(run.refill({ ...input, customers, targetDate: '2030-10-27' })).rejects.toThrow('預約目標已變更');
  });
});
