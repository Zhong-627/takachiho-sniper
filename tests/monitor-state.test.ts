import { describe, expect, it } from 'vitest';
import { MonitorState } from '../src/monitor-state.js';

const START = Date.parse('2026-10-12T00:00:00.000Z');

function emit(state: MonitorState, event: string, data: Record<string, unknown> = {}, slot?: string, at = START): void {
  state.ingest({ mode: 'live', epochMs: at, event, data, ...(slot ? { slot } : {}) });
}

function started(): MonitorState {
  const state = new MonitorState('run-1');
  emit(state, 'run_started', { nodeVersion: 'private runtime' });
  emit(state, 'run_started', {
    targetDate: '2026-10-26', slots: ['10:00', '10:30'],
    releaseAt: '2026-10-12T01:00:00.000Z', monitorFromAt: '2026-10-12T00:58:00.000Z',
    monitorUntil: '2026-10-12T01:30:00.000Z',
  }, undefined, START + 1);
  return state;
}

describe('safe monitor state projection', () => {
  it.each([
    ['2026-10-14T17:08+08:00', '2026-10-14T09:08:00.000Z'],
    ['2026-10-14T09:08Z', '2026-10-14T09:08:00.000Z'],
    ['2026-10-14T03:38-05:30', '2026-10-14T09:08:00.000Z'],
    ['2026-10-14T17:08:00+08:00', '2026-10-14T09:08:00.000Z'],
    ['2026-10-14T17:08:00.123+08:00', '2026-10-14T09:08:00.123Z'],
  ])('projects a valid schedule %s at the precision accepted by the settings form', (value, expected) => {
    const state = new MonitorState('minute-precision');
    emit(state, 'run_started', { slots: ['08:30'], targetDate: '2026-10-28',
      releaseAt: value, monitorFromAt: value, monitorUntil: value });
    expect(state.snapshot().run).toMatchObject({
      releaseAt: Date.parse(expected), monitorFrom: Date.parse(expected), monitorUntil: Date.parse(expected),
    });
  });

  it.each(['2026-02-30T17:08+08:00', '2026-10-14T24:00+08:00', '2026-10-14T17:60+08:00',
    '2026-10-14T17:08+24:00', '2026-10-14T17:08+08:60', '2026-10-14T17:08',
    '2026-10-14T17:08.123+08:00', '2026-10-14T17:08+0800', '2026-10-14T17:08:60+08:00'])(
    'rejects malformed or timezone-free schedules %s', (value) => {
      const state = new MonitorState('invalid-schedule');
      emit(state, 'run_started', { slots: ['08:30'], releaseAt: value, monitorFromAt: value, monitorUntil: value });
      expect(state.snapshot().run).toMatchObject({ releaseAt: null, monitorFrom: null, monitorUntil: null });
    },
  );

  it('waits for target metadata after preliminary run_started and copies snapshots defensively', () => {
    const state = new MonitorState('/Users/private/person/artifacts');
    emit(state, 'run_started', { platform: 'private' });
    expect(state.snapshot(START)).toMatchObject({ connection: 'waiting', run: null, slots: [],
      automationFinishedAt: null, automationStoppedAt: null });
    emit(state, 'run_started', { targetDate: '2026-02-30', slots: ['10:00'],
      release: { utc: '2026-10-12T01:00:00.000Z', taipei: 'private' }, monitorFrom: { utc: '2026-10-12T00:58:00.000Z' } }, undefined, START + 1);
    const result = state.snapshot(START + 2);
    expect(result.run).toEqual({ id: 'live-run', targetDate: null, startedAt: START, releaseAt: START + 3_600_000,
      monitorFrom: START + 3_480_000, monitorUntil: null, mode: 'live' });
    result.slots[0]!.phase = 'failed';
    result.run!.targetDate = 'changed';
    result.recentEvents[0]!.label = 'changed';
    expect(state.snapshot(START + 2)).toMatchObject({ run: { targetDate: null }, slots: [{ phase: 'waiting' }], recentEvents: [{ label: '搶位監控已開始' }] });
  });

  it('uses only heartbeat for freshness despite recent progress or network logs', () => {
    const state = started();
    emit(state, 'monitor_heartbeat', { automationActive: true }, undefined, START + 10_000);
    emit(state, 'availability_request_started', { attempt: 1 }, '10:00', START + 40_000);
    emit(state, 'network_response', { status: 200, durationMs: 5 }, '10:00', START + 50_000);
    expect(state.snapshot(START + 45_000).connection).toBe('live');
    expect(state.snapshot(START + 45_001)).toMatchObject({ connection: 'stale', heartbeatAt: START + 10_000, updatedAt: START + 40_000 });
    emit(state, 'monitor_heartbeat', { automationActive: false }, undefined, START + 50_000);
    expect(state.snapshot(START + 50_001).connection).toBe('live');
    emit(state, 'monitor_heartbeat', { automationActive: 'true' }, undefined, START + 60_000);
    expect(state.snapshot(START + 85_001).connection).toBe('stale');
    expect(started().snapshot(START + 35_001).connection).toBe('stale');
  });

  it('tracks independent attempts, availability, latency and next retry', () => {
    const state = started();
    emit(state, 'session_warmed', {}, '10:00', START + 100);
    emit(state, 'availability_request_started', { attempt: 3 }, '10:00', START + 200);
    emit(state, 'availability-detected', { status: 'unavailable', responseMs: 125.5 }, '10:00', START + 325);
    emit(state, 'availability_retry_scheduled', { attempt: 3, delayMs: 1_000 }, '10:00', START + 330);
    emit(state, 'availability_request_started', { attempt: 1 }, '10:30', START + 400);
    emit(state, 'availability_detected', { attempt: 1, status: 'limited' }, '10:30', START + 410);
    expect(state.snapshot(START + 500).slots).toEqual([
      { slot: '10:00', phase: 'retrying', attempts: 3, availability: 'unavailable', responseMs: 126, nextRetryAt: START + 1330, updatedAt: START + 330, holdConfirmed: false, heldAt: null },
      { slot: '10:30', phase: 'monitoring', attempts: 1, availability: 'limited', responseMs: 10, nextRetryAt: null, updatedAt: START + 410, holdConfirmed: false, heldAt: null },
    ]);
    emit(state, 'availability_request_started', { attempt: 4 }, '10:00', START + 1330);
    expect(state.snapshot(START + 1330).slots[0]).toMatchObject({ phase: 'monitoring', attempts: 4, nextRetryAt: null });
  });

  it('distinguishes a held customer form and human handoff from completed bookings', () => {
    const state = started();
    emit(state, 'reservation_action_started', { attempt: 1 }, '10:00', START + 100);
    emit(state, 'hold-response', { status: 200, result: 'unknown' }, '10:00', START + 110);
    expect(state.snapshot(START + 110).slots[0]!.phase).toBe('reserving');
    emit(state, 'hold-response', { status: 200, result: '1' }, '10:00', START + 120);
    emit(state, 'customer-form-ready', {}, '10:00', START + 125);
    emit(state, 'reservation_action_finished', { status: 'customer-form-ready', attempt: 1 }, '10:00', START + 130);
    emit(state, 'slot_outcome', { status: 'customer-form-ready', attempts: 1 }, '10:00', START + 135);
    emit(state, 'automation_stopped', {}, undefined, START + 140);
    emit(state, 'slot_error', { message: 'abort error' }, '10:30', START + 145);
    expect(state.snapshot(START + 150).slots.map((slot) => slot.phase)).toEqual(['held', 'stopped']);
    expect(JSON.stringify(state.snapshot(START + 150))).toContain('待人工確認付款');
    emit(state, 'human_handoff', {}, '10:00', START + 160);
    emit(state, 'autofill_result', { customerFieldsVerified: false }, '10:00', START + 170);
    emit(state, 'automation_finished', {}, undefined, START + 180);
    emit(state, 'diagnostics_closed', {}, undefined, START + 190);
    expect(state.snapshot(START + 200)).toMatchObject({ connection: 'ended', slots: [{ phase: 'handed-off' }, { phase: 'stopped' }] });
  });

  it('preserves manual or ambiguous outcomes on finish and marks deadlines separately', () => {
    const state = started();
    emit(state, 'reservation_action_ambiguous', { error: 'private reason' }, '10:00', START + 100);
    emit(state, 'manual_intervention_required', { reason: 'private reason' }, '10:30', START + 110);
    emit(state, 'automation_finished', {}, undefined, START + 120);
    expect(state.snapshot(START + 130).slots.map((slot) => slot.phase)).toEqual(['ambiguous', 'manual']);
    const deadline = started();
    emit(deadline, 'monitoring_deadline_reached', { attempts: 17 }, '10:00', START + 100);
    emit(deadline, 'slot_outcome', { status: 'deadline-reached', attempts: 17 }, '10:00', START + 110);
    emit(deadline, 'automation_finished', {}, undefined, START + 120);
    expect(deadline.snapshot(START + 130).slots.map((slot) => slot.phase)).toEqual(['deadline', 'stopped']);
  });

  it('preserves deadline evidence when a finished slot is handed off before the other slot settles', () => {
    const state = started();
    expect(state.snapshot(START + 10).slots.every((slot) => slot.deadlineReachedAt === undefined)).toBe(true);
    emit(state, 'monitoring_deadline_reached', { attempts: 17 }, '10:00', START + 100);
    emit(state, 'slot_outcome', { status: 'deadline-reached', attempts: 17 }, '10:00', START + 110);
    emit(state, 'hold-response', { status: 200, result: '1' }, '10:30', START + 120);
    emit(state, 'human_handoff', {}, '10:00', START + 130);
    expect(state.snapshot(START + 140)).toMatchObject({
      automationFinishedAt: null,
      slots: [{ phase: 'handed-off', deadlineReachedAt: START + 100 }, { phase: 'held', holdConfirmed: true }],
    });
    emit(state, 'autofill_result', { customerFieldsVerified: false }, '10:30', START + 150);
    emit(state, 'slot_outcome', { status: 'manual', attempts: 1 }, '10:30', START + 160);
    emit(state, 'automation_finished', {}, undefined, START + 170);
    emit(state, 'diagnostics_closed', {}, undefined, START + 180);
    expect(state.snapshot(START + 190)).toMatchObject({
      automationFinishedAt: START + 170, connection: 'ended',
      slots: [{ phase: 'handed-off', deadlineReachedAt: START + 100 }, { phase: 'manual', holdConfirmed: true }],
    });
    expect(state.snapshot(START + 190).slots[1]!.deadlineReachedAt).toBeUndefined();
  });

  it.each([
    ['monitoring_deadline_reached', 'reservation_action_finished', 'slot_outcome'],
    ['reservation_action_finished', 'slot_outcome', 'monitoring_deadline_reached'],
    ['slot_outcome', 'monitoring_deadline_reached', 'reservation_action_finished'],
  ])('keeps the first deadline timestamp from %s despite later deadline sources', (first, second, third) => {
    const state = started();
    emit(state, first!, { status: 'deadline-reached' }, '10:00', START + 100);
    emit(state, 'human_handoff', {}, '10:00', START + 110);
    emit(state, second!, { status: 'deadline-reached' }, '10:00', START + 120);
    emit(state, third!, { status: 'deadline-reached' }, '10:00', START + 130);
    expect(state.snapshot(START + 140).slots[0]).toMatchObject({
      phase: 'handed-off', deadlineReachedAt: START + 100,
    });
  });

  it('requires explicit automation completion after terminal phases and late autofill results', () => {
    const state = started();
    emit(state, 'monitoring_deadline_reached', { attempts: 17 }, '10:00', START + 100);
    emit(state, 'slot_outcome', { status: 'deadline-reached', attempts: 17 }, '10:00', START + 110);
    emit(state, 'hold-response', { status: 200, result: '1' }, '10:30', START + 120);
    emit(state, 'monitor_heartbeat', { automationActive: false }, undefined, START + 130);
    expect(state.snapshot(START + 140)).toMatchObject({
      automationFinishedAt: null, automationStoppedAt: null,
      slots: [{ phase: 'deadline' }, { phase: 'held', holdConfirmed: true }],
    });
    emit(state, 'autofill_result', { customerFieldsVerified: false }, '10:30', START + 150);
    emit(state, 'slot_outcome', { status: 'manual', attempts: 1 }, '10:30', START + 160);
    expect(state.snapshot(START + 170).automationFinishedAt).toBeNull();
    emit(state, 'automation_finished', {}, undefined, START + 180);
    emit(state, 'automation_finished', {}, undefined, START + 190);
    emit(state, 'diagnostics_closed', {}, undefined, START + 200);
    expect(state.snapshot(START + 210)).toMatchObject({
      automationFinishedAt: START + 180, automationStoppedAt: null, connection: 'ended',
      slots: [{ phase: 'deadline' }, { phase: 'manual', holdConfirmed: true, heldAt: START + 120 }],
    });
  });

  it('retains the explicit stop request when in-flight results subsequently finish', () => {
    const state = started();
    emit(state, 'monitoring_deadline_reached', { attempts: 17 }, '10:00', START + 100);
    emit(state, 'automation_stopped', {}, undefined, START + 110);
    emit(state, 'automation_stopped', {}, undefined, START + 120);
    expect(state.snapshot(START + 130)).toMatchObject({
      automationFinishedAt: null, automationStoppedAt: START + 110,
    });
    emit(state, 'hold-response', { status: 200, result: '1' }, '10:30', START + 140);
    emit(state, 'slot_outcome', { status: 'manual', attempts: 1 }, '10:30', START + 150);
    emit(state, 'automation_finished', {}, undefined, START + 160);
    expect(state.snapshot(START + 170)).toMatchObject({
      automationFinishedAt: START + 160, automationStoppedAt: START + 110,
      slots: [{ phase: 'deadline' }, { phase: 'manual', holdConfirmed: true }],
    });
  });

  it.each([
    { events: [['automation_stopped', START + 100], ['automation_finished', START + 100]], stoppedAt: START + 100 },
    { events: [['automation_finished', START + 100], ['automation_stopped', START + 100]], stoppedAt: null },
    { events: [['automation_finished', START + 100], ['automation_stopped', START + 110]], stoppedAt: null },
  ] as const)('distinguishes a stop before completion from later browser cleanup: $events', ({ events, stoppedAt }) => {
    const state = started();
    for (const [event, at] of events) emit(state, event, {}, undefined, at);
    // run.close() also emits automation_stopped before it closes diagnostics.
    emit(state, 'diagnostics_closed', {}, undefined, START + 120);
    expect(state.snapshot(START + 130)).toMatchObject({
      connection: 'ended', automationFinishedAt: START + 100, automationStoppedAt: stoppedAt,
    });
  });

  it('does not infer lifecycle timestamps from closing diagnostics or invalid events', () => {
    const state = new MonitorState('run-1');
    emit(state, 'automation_finished', {}, undefined, START - 1);
    emit(state, 'automation_stopped', {}, undefined, START - 1);
    emit(state, 'run_started', { slots: ['10:00'] });
    state.ingest({ mode: 'live', event: 'automation_finished', epochMs: NaN, data: {} });
    state.ingest({ mode: 'rehearsal', event: 'automation_stopped', epochMs: START + 100, data: {} });
    emit(state, 'diagnostics_closed', {}, undefined, START + 110);
    expect(state.snapshot(START + 120)).toMatchObject({
      connection: 'ended', automationFinishedAt: null, automationStoppedAt: null, slots: [{ phase: 'stopped' }],
    });
  });

  it('keeps confirmed hold evidence when later autofill needs manual work and rejects unknown/failed responses', () => {
    const state = started();
    emit(state, 'hold-response', { status: 200, result: '1' }, '10:00', START + 100);
    emit(state, 'autofill_result', { customerFieldsVerified: false }, '10:00', START + 110);
    emit(state, 'slot_outcome', { status: 'manual' }, '10:00', START + 120);
    expect(state.snapshot(START + 130).slots[0]).toMatchObject({ phase: 'manual', holdConfirmed: true, heldAt: START + 100 });
    emit(state, 'hold-response', { status: 500, result: '1' }, '10:30', START + 100);
    emit(state, 'hold-response', { status: 200, result: 1 }, '10:30', START + 110);
    emit(state, 'hold-response', { status: 200, result: '0' }, '10:30', START + 120);
    expect(state.snapshot(START + 130).slots[1]).toMatchObject({ holdConfirmed: false, heldAt: null });
  });

  it('returns to monitoring only for the explicit rejected and sold-out path', () => {
    const state = started();
    emit(state, 'availability_request_started', { attempt: 7 }, '10:00', START + 100);
    emit(state, 'reservation_action_started', { attempt: 7 }, '10:00', START + 110);
    emit(state, 'hold-rejected-sold-out', {}, '10:00', START + 120);
    emit(state, 'reservation_action_finished', { status: 'retry-monitoring', attempt: 7 }, '10:00', START + 130);
    emit(state, 'reservation_returned_to_monitoring', { attempt: 7 }, '10:00', START + 140);
    expect(state.snapshot(START + 150).slots[0]).toMatchObject({ phase: 'monitoring', availability: 'unavailable', attempts: 7 });
  });

  it('never exposes arbitrary data, invalid scalar metadata or unconfigured slots', () => {
    const state = started();
    const secret = 'PRIVATE alice@example.test /Users/person SECRET-TOKEN https://site/customer?token=private';
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      emit(state, 'availability_request_error', { attempt, error: secret, url: secret, phone: secret, nested: { note: secret } }, '10:00', START + attempt);
    }
    emit(state, 'availability_detected', { status: secret, attempt: Infinity, responseMs: -1 }, '10:00', START + 50);
    emit(state, 'availability_detected', { status: 'available', attempt: 900 }, '11:00', START + 60);
    emit(state, 'availability_detected', { status: 'available' }, secret, START + 70);
    state.ingest({ mode: 'rehearsal', event: 'customer-form-ready', epochMs: START + 80, slot: '10:00', data: {} });
    state.ingest({ mode: 'live', event: 'customer-form-ready', epochMs: NaN, slot: '10:00', data: {} });
    const snapshot = state.snapshot(START + 90);
    expect(snapshot.recentEvents).toHaveLength(20);
    expect(snapshot.slots).toHaveLength(2);
    expect(snapshot.slots[0]).toMatchObject({ phase: 'retrying', attempts: 30, availability: 'unknown' });
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE|alice|Users|SECRET|https|private/u);
  });

  it.each([[], ['10:00', '10:30', '11:00'], ['25:00'], ['10:00', '10:00'], ['10:00', 'private']].map((slots) => ({ slots })))('rejects malformed configured slots $slots', ({ slots }) => {
    const state = new MonitorState('run-1');
    emit(state, 'run_started', { slots });
    expect(state.snapshot(START).run).toBeNull();
  });
});
