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
  it('waits for target metadata after preliminary run_started and copies snapshots defensively', () => {
    const state = new MonitorState('/Users/private/person/artifacts');
    emit(state, 'run_started', { platform: 'private' });
    expect(state.snapshot(START)).toMatchObject({ connection: 'waiting', run: null, slots: [] });
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
      { slot: '10:00', phase: 'retrying', attempts: 3, availability: 'unavailable', responseMs: 126, nextRetryAt: START + 1330, updatedAt: START + 330 },
      { slot: '10:30', phase: 'monitoring', attempts: 1, availability: 'limited', responseMs: 10, nextRetryAt: null, updatedAt: START + 410 },
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
