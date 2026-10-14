import { createECDH, randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createMonitorPush, type MonitorPush, type MonitorPushOptions } from '../src/monitor-push.js';
import { ArtifactsMonitor } from '../src/monitor-source.js';
import { MonitorState, type MonitorSnapshot } from '../src/monitor-state.js';

type Send = NonNullable<MonitorPushOptions['send']>;
type SendMock = Mock<Send>;
interface Notification { title: string; body: string; url: string; tag: string }
interface SavedState {
  version: number;
  subscriptions: unknown[];
  summaries: {
    id: string; runId: string; at: number; payload: string;
    recipients: { id: string; attempts: number; delivered: boolean; failures: number; nextAttemptAt: number }[];
  }[];
}

const NOW = Date.parse('2026-10-14T08:30:00.000Z');
const temporary: string[] = [];
const instances: MonitorPush[] = [];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(async () => {
  await Promise.all(instances.splice(0).map((push) => push.close()));
  vi.useRealTimers();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(send: SendMock = vi.fn<Send>(async () => undefined)) {
  const directory = await mkdtemp(join(tmpdir(), 'takachiho-deadline-push-'));
  temporary.push(directory);
  const options = { directory, send, schedule: false };
  const observationTime = Date.now();
  vi.setSystemTime(observationTime - 2000);
  const push = await createMonitorPush(options);
  vi.setSystemTime(observationTime);
  instances.push(push);
  return { directory, options, send, push };
}

async function restart(options: MonitorPushOptions): Promise<MonitorPush> {
  const push = await createMonitorPush(options);
  instances.push(push);
  return push;
}

function subscription(token = 'device-1') {
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  return { endpoint: `https://web.push.apple.com/${token}`, expirationTime: null,
    keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

function emit(state: MonitorState, event: string, at: number, data: Record<string, unknown> = {}, slot?: string): void {
  state.ingest({ mode: 'live', event, epochMs: at, data, ...(slot ? { slot } : {}) });
}

function runState(runId = 'deadline-run', cutoffAt = NOW - 1000): MonitorState {
  const state = new MonitorState(runId);
  emit(state, 'run_started', NOW - 60_000, { slots: ['11:00', '11:30'], targetDate: '2026-10-26',
    monitorUntil: new Date(cutoffAt).toISOString() });
  emit(state, 'monitor_heartbeat', NOW - 1000, { automationActive: true });
  return state;
}

function completed(runId = 'deadline-run', finishedAt = Date.now()): MonitorSnapshot {
  const state = runState(runId);
  for (const slot of ['11:00', '11:30']) emit(state, 'slot_outcome', NOW - 800, { status: 'deadline-reached', attempts: 12 }, slot);
  emit(state, 'automation_finished', finishedAt);
  return state.snapshot();
}

function waiting(): MonitorSnapshot { return new MonitorState('waiting').snapshot(); }
function current(snapshot: MonitorSnapshot): MonitorSnapshot { return { ...snapshot, serverTime: Date.now() }; }
function notification(body: string): Notification { return JSON.parse(body) as Notification; }
function summaryCalls(send: SendMock) { return send.mock.calls.filter(([, body]) => notification(body).title === '高千穗監控已截止'); }
async function saved(directory: string): Promise<SavedState> {
  return JSON.parse(await readFile(join(directory, 'subscriptions.json'), 'utf8')) as SavedState;
}

describe('completed monitoring deadline summaries', () => {
  it.each([
    { zone: '+08:00', releaseAt: '2026-10-14T17:07+08:00', monitorFromAt: '2026-10-14T17:06+08:00', monitorUntil: '2026-10-14T17:08+08:00' },
    { zone: 'Z', releaseAt: '2026-10-14T09:07Z', monitorFromAt: '2026-10-14T09:06Z', monitorUntil: '2026-10-14T09:08Z' },
  ])('delivers a finished single-slot run from artifact logs with minute-precision $zone schedule values', async (schedule) => {
    const cutoffAt = Date.parse('2026-10-14T09:08:00.000Z');
    vi.setSystemTime(cutoffAt + 1000);
    const { push, send, directory } = await fixture();
    await push.subscribe(subscription());
    const artifactsDir = join(directory, 'artifacts');
    const runDir = join(artifactsDir, '2026-10-14T09-07-00-000Z-live-abcdef12');
    await mkdir(runDir, { recursive: true });
    const eventsFile = join(runDir, 'events.jsonl');
    const line = (event: string, at: number, data: Record<string, unknown> = {}, slot?: string): string =>
      `${JSON.stringify({ mode: 'live', epochMs: at, event, data, ...(slot ? { slot } : {}) })}\n`;
    await writeFile(eventsFile, line('run_started', cutoffAt - 60_000, { slots: ['08:30'], targetDate: '2026-10-28',
      releaseAt: schedule.releaseAt, monitorFromAt: schedule.monitorFromAt, monitorUntil: schedule.monitorUntil }));
    const source = new ArtifactsMonitor(artifactsDir);
    await source.refresh();
    await push.observe(source.snapshot());
    expect(source.snapshot().run).toMatchObject({ releaseAt: cutoffAt - 60_000,
      monitorFrom: cutoffAt - 120_000, monitorUntil: cutoffAt });

    await appendFile(eventsFile, line('monitoring_deadline_reached', cutoffAt, { attempts: 12 }, '08:30')
      + line('slot_outcome', cutoffAt + 1, { status: 'deadline-reached', attempts: 12 }, '08:30'));
    await source.refresh();
    await push.observe(source.snapshot());
    expect(send).not.toHaveBeenCalled();

    await appendFile(eventsFile, line('automation_finished', cutoffAt + 500));
    await source.refresh();
    await push.observe(source.snapshot());
    await source.refresh();
    await push.observe(source.snapshot());
    const summaries = summaryCalls(send);
    expect(summaries).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    const message = notification(summaries[0]![1]);
    expect(message.body).toContain('2026-10-28');
    expect(message.body).toContain('17:08:00');
    expect(message.body).toMatch(/台灣|臺灣|Taipei/u);
    expect(message.body).toMatch(/08:30[^\n]*未取得船位/u);
  });

  it('waits for the real finish event after a late hold/autofill result and preserves its repeating reminder', async () => {
    const { push, send } = await fixture();
    await push.subscribe(subscription());
    await push.observe(waiting());
    const cutoffAt = NOW + 1000;
    const state = runState('in-flight-run', cutoffAt);
    vi.setSystemTime(NOW + 1100);
    emit(state, 'monitoring_deadline_reached', NOW + 1000, { attempts: 12 }, '11:00');
    emit(state, 'slot_outcome', NOW + 1000, { status: 'deadline-reached', attempts: 12 }, '11:00');
    emit(state, 'hold-response', NOW + 1100, { status: 200, result: '1' }, '11:30');
    await push.observe(state.snapshot());
    expect(summaryCalls(send)).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(notification(send.mock.calls[0]![1]).title).toBe('高千穗船位已暫留');
    expect(push.status().reminders.map((item) => item.slot)).toEqual(['11:30']);

    vi.setSystemTime(NOW + 1800);
    emit(state, 'autofill_result', NOW + 1500, { customerFieldsVerified: false }, '11:30');
    emit(state, 'slot_outcome', NOW + 1600, { status: 'manual', attempts: 1 }, '11:30');
    await push.observe(state.snapshot());
    expect(summaryCalls(send)).toHaveLength(0);
    emit(state, 'automation_finished', NOW + 1800);
    await push.observe(state.snapshot());
    const summaries = summaryCalls(send);
    expect(summaries).toHaveLength(1);
    const message = notification(summaries[0]![1]);
    expect(message).toMatchObject({ title: '高千穗監控已截止', url: '/' });
    expect(message.body).toContain('2026-10-26');
    expect(message.body).toContain('16:30:01');
    expect(message.body).toMatch(/台灣|臺灣|Taipei/u);
    expect(message.body).toContain('日本');
    expect(message.body).toContain('11:00');
    expect(message.body).toContain('未取得船位');
    expect(message.body).toContain('11:30');
    expect(message.body).toContain('已暫留');
    expect(message.body).toContain('需人工');
    expect(summaries[0]![2]).toMatchObject({ urgency: 'high', contentEncoding: 'aes128gcm' });
    expect(summaries[0]![2].TTL).toBeGreaterThan(0);
    expect(summaries[0]![2].TTL).toBeLessThanOrEqual(120);
    expect(summaries[0]![2].topic).not.toBe(send.mock.calls[0]![2].topic);
    expect(message.tag).not.toBe(notification(send.mock.calls[0]![1]).tag);
    expect(push.status().reminders.map((item) => item.slot)).toEqual(['11:30']);

    vi.setSystemTime(NOW + 4100);
    await push.observe(state.snapshot());
    expect(summaryCalls(send)).toHaveLength(1);
    expect(send.mock.calls.filter(([, body]) => notification(body).title === '高千穗船位已暫留')).toHaveLength(2);
  });

  it('sends one summary per existing device from a fresh finish even after diagnostics have closed', async () => {
    const { push, send } = await fixture();
    await push.subscribe(subscription('first'));
    await push.subscribe(subscription('second'));
    await push.observe(waiting());
    const done = completed();
    done.connection = 'ended';
    done.heartbeatAt = NOW - 60_000;
    await push.observe(done);
    await push.observe(done);
    vi.setSystemTime(NOW + 10_000);
    await push.observe(current(done));
    expect(summaryCalls(send)).toHaveLength(2);
    expect(new Set(send.mock.calls.map(([item]) => item.endpoint)).size).toBe(2);
    expect(new Set(send.mock.calls.map(([, body]) => notification(body).tag)).size).toBe(1);
    expect(push.status().reminders).toEqual([]);
  });

  it('keeps deadline evidence when that slot is handed off before its sibling finishes', async () => {
    const { push, send } = await fixture();
    await push.subscribe(subscription());
    await push.observe(waiting());
    const state = runState('handoff-after-deadline');
    emit(state, 'monitoring_deadline_reached', NOW - 900, { attempts: 12 }, '11:00');
    emit(state, 'slot_outcome', NOW - 900, { status: 'deadline-reached', attempts: 12 }, '11:00');
    emit(state, 'human_handoff', NOW - 800, {}, '11:00');
    emit(state, 'slot_outcome', NOW - 700, { status: 'manual', attempts: 1 }, '11:30');
    await push.observe(state.snapshot());
    expect(summaryCalls(send)).toHaveLength(0);
    emit(state, 'automation_finished', NOW - 500);
    await push.observe(state.snapshot());
    const summaries = summaryCalls(send);
    expect(summaries).toHaveLength(1);
    expect(notification(summaries[0]![1]).body).toMatch(/11:00[^\n]*已交由人工處理/u);
    expect(notification(summaries[0]![1]).body).toMatch(/11:30[^\n]*需人工處理/u);
  });

  it('does not turn a manual stop followed by in-flight completion into a deadline notification', async () => {
    const { push, send } = await fixture();
    await push.subscribe(subscription());
    await push.observe(waiting());
    const state = runState();
    emit(state, 'slot_outcome', NOW - 900, { status: 'deadline-reached' }, '11:00');
    emit(state, 'automation_stopped', NOW - 800);
    emit(state, 'slot_outcome', NOW - 700, { status: 'manual' }, '11:30');
    emit(state, 'automation_finished', NOW - 500);
    await push.observe(state.snapshot());
    expect(summaryCalls(send)).toHaveLength(0);
  });

  it('does not notify when all slots finish before the deadline without a deadline outcome', async () => {
    const { push, send } = await fixture();
    await push.subscribe(subscription());
    await push.observe(waiting());
    const state = runState();
    emit(state, 'slot_outcome', NOW - 2000, { status: 'manual' }, '11:00');
    emit(state, 'slot_outcome', NOW - 2000, { status: 'ambiguous' }, '11:30');
    emit(state, 'automation_finished', NOW - 1500);
    await push.observe(state.snapshot());
    expect(summaryCalls(send)).toHaveLength(0);
  });

  it.each([
    ['missing completion', (value: MonitorSnapshot) => { value.automationFinishedAt = null; }],
    ['active sibling', (value: MonitorSnapshot) => { value.slots[1]!.phase = 'reserving'; }],
    ['missing cutoff', (value: MonitorSnapshot) => { value.run!.monitorUntil = null; }],
    ['completion before cutoff', (value: MonitorSnapshot) => { value.automationFinishedAt = value.run!.monitorUntil! - 1; }],
    ['future completion', (value: MonitorSnapshot) => { value.automationFinishedAt = NOW + 5001; }],
    ['old completion', (value: MonitorSnapshot) => {
      value.run!.startedAt = NOW - 180_000;
      value.run!.monitorUntil = NOW - 150_000;
      value.automationFinishedAt = NOW - 120_001;
    }],
    ['demo', (value: MonitorSnapshot) => { Object.assign(value, { demo: true }); }],
  ] as const)('rejects an unsafe or incomplete deadline snapshot: %s', async (_label, change) => {
    const { push, send } = await fixture();
    await push.subscribe(subscription());
    await push.observe(waiting());
    const done = completed();
    change(done);
    await push.observe(done);
    expect(summaryCalls(send)).toHaveLength(0);
  });

  it('baselines an already completed run on first observation and does not replay it after restart', async () => {
    const { push, send, options } = await fixture();
    await push.subscribe(subscription());
    const historical = completed();
    historical.connection = 'ended';
    await push.observe(historical);
    await push.observe(current(historical));
    await push.close();
    const restarted = await restart(options);
    await restarted.observe(current(historical));
    await restarted.observe(current(historical));
    expect(summaryCalls(send)).toHaveLength(0);
    await restarted.observe(completed('next-run'));
    expect(summaryCalls(send)).toHaveLength(1);
  });

  it('does not backfill a pre-start completion replayed after an initial partial historical snapshot', async () => {
    const { push, send } = await fixture();
    await push.subscribe(subscription());
    const state = runState('partial-historical-run', NOW - 5000);
    for (const slot of ['11:00', '11:30']) emit(state, 'slot_outcome', NOW - 4500, { status: 'deadline-reached' }, slot);
    // The first bounded log refresh has not reached the historical finish line yet.
    await push.observe(state.snapshot());
    emit(state, 'automation_finished', NOW - 4000);
    await push.observe(state.snapshot());
    await push.observe(state.snapshot());
    expect(summaryCalls(send)).toHaveLength(0);
  });

  it('captures recipients at completion so later subscriptions receive no retroactive summary', async () => {
    const { push, send } = await fixture();
    await push.observe(waiting());
    const done = completed();
    await push.observe(done);
    await push.subscribe(subscription('late'));
    await push.observe(done);
    expect(summaryCalls(send)).toHaveLength(0);
    await push.observe(completed('next-run'));
    expect(summaryCalls(send)).toHaveLength(1);
  });

  it('persists successful recipients and never repeats their summary after restart', async () => {
    const { push, send, directory, options } = await fixture();
    await push.subscribe(subscription());
    await push.observe(waiting());
    const done = completed();
    await push.observe(done);
    const state = await saved(directory);
    expect(state.version).toBe(3);
    expect(state.summaries).toHaveLength(1);
    expect(state.summaries[0]).toMatchObject({ runId: done.run!.id, at: done.automationFinishedAt,
      recipients: [{ attempts: 1, delivered: true, failures: 0 }] });
    expect(notification(state.summaries[0]!.payload).title).toBe('高千穗監控已截止');
    await push.close();
    const restarted = await restart(options);
    await restarted.observe(done);
    await restarted.observe(done);
    vi.setSystemTime(NOW + 30_000);
    await restarted.observe(current(done));
    expect(summaryCalls(send)).toHaveLength(1);
    expect(restarted.status().reminders).toEqual([]);
  });

  it('persists an in-flight success during close so restart cannot send the summary again', async () => {
    let release!: () => void;
    let notifyStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const send = vi.fn<Send>(async () => { notifyStarted(); await gate; });
    const { push, directory, options } = await fixture(send);
    await push.subscribe(subscription());
    await push.observe(waiting());
    const done = completed();
    const sending = push.observe(done);
    await started;
    const closing = push.close();
    release();
    await Promise.all([sending, closing]);
    expect((await saved(directory)).summaries[0]!.recipients).toMatchObject([{ attempts: 1, delivered: true }]);
    const restarted = await restart(options);
    await restarted.observe(done);
    await restarted.observe(done);
    expect(summaryCalls(send)).toHaveLength(1);
  });

  it.each([
    { retryAfter: '12', delayMs: 12_000 },
    { retryAfter: 'Wed, 14 Oct 2026 08:30:12 GMT', delayMs: 12_000 },
    { retryAfter: '12.3456', delayMs: 12_346 },
  ])('retries only a failed recipient after restart and honors Retry-After $retryAfter', async ({ retryAfter, delayMs }) => {
    const good = subscription('good');
    const failing = subscription('failing');
    let fail = true;
    const send = vi.fn<Send>(async (item) => {
      if (item.endpoint === failing.endpoint && fail) throw Object.assign(new Error('PRIVATE provider detail'), {
        statusCode: 429, headers: { 'retry-after': retryAfter },
      });
    });
    const { push, directory, options } = await fixture(send);
    await push.subscribe(good);
    await push.subscribe(failing);
    await push.observe(waiting());
    const done = completed();
    await push.observe(done);
    expect(summaryCalls(send)).toHaveLength(2);
    expect((await saved(directory)).summaries[0]!.recipients).toEqual(expect.arrayContaining([
      expect.objectContaining({ attempts: 1, delivered: true, failures: 0 }),
      expect.objectContaining({ attempts: 1, delivered: false, failures: 1, nextAttemptAt: NOW + delayMs }),
    ]));
    await push.close();
    const restarted = await restart(options);
    await restarted.subscribe(subscription('late'));
    await restarted.observe(done);
    vi.setSystemTime(NOW + delayMs - 1);
    await restarted.observe(current(done));
    expect(summaryCalls(send)).toHaveLength(2);
    fail = false;
    vi.setSystemTime(NOW + delayMs);
    await restarted.observe(current(done));
    await restarted.observe(current(done));
    expect(send.mock.calls.filter(([item]) => item.endpoint === good.endpoint)).toHaveLength(1);
    expect(send.mock.calls.filter(([item]) => item.endpoint === failing.endpoint)).toHaveLength(2);
    expect(send.mock.calls.some(([item]) => item.endpoint.endsWith('/late'))).toBe(false);
    expect((await saved(directory)).summaries[0]!.recipients.every((item) => item.delivered)).toBe(true);
    expect(JSON.stringify(await saved(directory))).not.toContain('PRIVATE');
  });

  it('limits transient failures to three attempts per recipient', async () => {
    const send = vi.fn<Send>(async () => { throw Object.assign(new Error('temporary failure'), { statusCode: 503 }); });
    const { push, directory } = await fixture(send);
    await push.subscribe(subscription());
    await push.observe(waiting());
    const done = completed();
    await push.observe(done);
    vi.setSystemTime(NOW + 5000);
    await push.observe(current(done));
    vi.setSystemTime(NOW + 15_000);
    await push.observe(current(done));
    vi.setSystemTime(NOW + 60_000);
    await push.observe(current(done));
    expect(summaryCalls(send)).toHaveLength(3);
    expect((await saved(directory)).summaries[0]!.recipients).toMatchObject([{ attempts: 3, delivered: false, failures: 3 }]);
  });

  it('never retries a summary after its 120 second window even if Retry-After is longer', async () => {
    const send = vi.fn<Send>(async () => { throw Object.assign(new Error('temporary failure'), {
      statusCode: 429, headers: { 'retry-after': '121' },
    }); });
    const { push, options } = await fixture(send);
    await push.subscribe(subscription());
    await push.observe(waiting());
    const done = completed();
    await push.observe(done);
    vi.setSystemTime(NOW + 121_000);
    await push.observe(current(done));
    await push.close();
    const restarted = await restart(options);
    await restarted.observe(current(done));
    expect(summaryCalls(send)).toHaveLength(1);
  });

  it.each([404, 410])('removes a deadline recipient subscription rejected with HTTP %i', async (statusCode) => {
    const send = vi.fn<Send>(async () => { throw Object.assign(new Error('expired'), { statusCode }); });
    const { push, directory } = await fixture(send);
    await push.subscribe(subscription());
    await push.observe(waiting());
    const done = completed();
    await push.observe(done);
    vi.setSystemTime(NOW + 30_000);
    await push.observe(current(done));
    expect(summaryCalls(send)).toHaveLength(1);
    expect((await saved(directory)).subscriptions).toEqual([]);
  });
});
