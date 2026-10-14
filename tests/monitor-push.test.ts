import { createECDH, randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMonitorPush, type MonitorPush, type MonitorPushOptions } from '../src/monitor-push.js';
import { MonitorState, type MonitorSnapshot } from '../src/monitor-state.js';
import { ArtifactsMonitor } from '../src/monitor-source.js';

type Send = NonNullable<MonitorPushOptions['send']>;
const temporary: string[] = [];
const instances: MonitorPush[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((push) => push.close()));
  vi.useRealTimers();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(send: MonitorPushOptions['send'] = vi.fn<Send>(async () => undefined)) {
  const directory = await mkdtemp(join(tmpdir(), 'takachiho-push-'));
  temporary.push(directory);
  const options = { directory, send, schedule: false };
  const push = await createMonitorPush(options);
  instances.push(push);
  return { directory, options, send, push };
}

function subscription(token = 'device-1') {
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  return { endpoint: `https://web.push.apple.com/${token}`, expirationTime: null,
    keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

function snapshot(held: readonly string[] = [], options: { runId?: string; phase?: 'held' | 'manual'; now?: number } = {}): MonitorSnapshot {
  const now = options.now ?? Date.now();
  const state = new MonitorState(options.runId ?? 'live-test-run');
  state.ingest({ mode: 'live', event: 'run_started', epochMs: now - 5000,
    data: { slots: ['11:00', '11:30'], targetDate: '2026-10-26' } });
  state.ingest({ mode: 'live', event: 'monitor_heartbeat', epochMs: now, data: { automationActive: true } });
  const result = state.snapshot(now);
  for (const slot of result.slots) {
    if (held.includes(slot.slot)) {
      slot.phase = options.phase ?? 'held';
      slot.holdConfirmed = true;
      slot.heldAt = now - 1000;
    }
  }
  return result;
}

function waiting(): MonitorSnapshot {
  return new MonitorState('waiting').snapshot();
}

describe('durable monitor Web Push', () => {
  it.each(['hold-response', 'customer-form-ready', 'customer_form_ready'].flatMap((event) => [
    { event, zone: '+08:00', releaseAt: '2026-10-14T17:05+08:00', monitorFromAt: '2026-10-14T17:04+08:00', monitorUntil: '2026-10-14T17:08+08:00' },
    { event, zone: 'Z', releaseAt: '2026-10-14T09:05Z', monitorFromAt: '2026-10-14T09:04Z', monitorUntil: '2026-10-14T09:08Z' },
  ]))('notifies and repeats a confirmed $event from artifact logs with minute-precision $zone schedules', async (schedule) => {
    vi.useFakeTimers();
    const now = Date.parse('2026-10-14T09:07:10.000Z');
    vi.setSystemTime(now);
    const send = vi.fn<Send>(async () => undefined);
    const { push, directory } = await fixture(send);
    await push.subscribe(subscription());
    const artifactsDir = join(directory, 'artifacts');
    const runDir = join(artifactsDir, '2026-10-14T09-07-00-000Z-live-abcdef12');
    await mkdir(runDir, { recursive: true });
    const eventsFile = join(runDir, 'events.jsonl');
    const line = (event: string, epochMs: number, data: Record<string, unknown> = {}, slot?: string): string =>
      `${JSON.stringify({ mode: 'live', epochMs, event, data, ...(slot ? { slot } : {}) })}\n`;
    await writeFile(eventsFile, line('run_started', now - 10_000, {
      slots: ['08:30'], targetDate: '2026-10-28', releaseAt: schedule.releaseAt,
      monitorFromAt: schedule.monitorFromAt, monitorUntil: schedule.monitorUntil,
    }) + line('monitor_heartbeat', now - 1000, { automationActive: true })
      + line('hold-response', now - 1, { status: 200, result: '0' }, '08:30'));
    const source = new ArtifactsMonitor(artifactsDir);
    await source.refresh();
    await push.observe(source.snapshot());
    expect(send).not.toHaveBeenCalled();
    expect(source.snapshot().run!.monitorUntil).toBe(Date.parse('2026-10-14T09:08:00Z'));

    await appendFile(eventsFile, line(schedule.event, now, { status: 200, result: '1' }, '08:30'));
    await source.refresh();
    expect(source.snapshot().slots[0]).toMatchObject({ holdConfirmed: true, heldAt: now });
    // Even an unavailable schedule projection cannot suppress proven holds.
    const held = source.snapshot();
    held.run!.monitorUntil = null;
    held.run!.releaseAt = null;
    held.run!.monitorFrom = null;
    await push.observe(held);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![1])).toMatchObject({ title: '高千穗船位已暫留',
      body: '2026-10-28 08:30 已暫留，請到 Mac 接手確認付款' });
    expect(push.status().reminders).toHaveLength(1);

    vi.setSystemTime(now + 1000);
    await appendFile(eventsFile, line('autofill_result', now + 1000, { customerFieldsVerified: false }, '08:30'));
    await source.refresh();
    await push.observe(source.snapshot());
    expect(source.snapshot().slots[0]).toMatchObject({ phase: 'manual', holdConfirmed: true, heldAt: now });
    expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(now + 3000);
    await push.observe(source.snapshot());
    expect(send).toHaveBeenCalledTimes(2);
    await push.stop(push.status().reminders.map((item) => item.id));
    vi.setSystemTime(now + 6000);
    await push.observe(source.snapshot());
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps VAPID keys and subscriptions private and reuses keys after restart', async () => {
    const { push, directory, options } = await fixture();
    await push.subscribe(subscription());
    const restarted = await createMonitorPush(options);
    expect(restarted.publicKey).toBe(push.publicKey);
    expect(restarted.status()).toEqual({ available: true, publicKey: push.publicKey, reminders: [] });
    for (const file of ['vapid.json', 'subscriptions.json']) {
      expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(join(directory, 'subscriptions.json'), 'utf8')).subscriptions).toHaveLength(1);
  });

  it('repeats every three seconds beyond the old cutoff with unique display tags and short provider TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    const send = vi.fn<Send>(async () => undefined);
    const { push } = await fixture(send);
    const item = subscription();
    await push.subscribe(item);
    await push.observe(waiting());
    const hold = snapshot(['11:00'], { phase: 'manual' });
    await push.observe(hold);
    vi.setSystemTime(Date.now() + 2999);
    await push.observe(hold);
    expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1);
    await push.observe(hold);
    expect(send).toHaveBeenCalledTimes(2);
    const first = JSON.parse(send.mock.calls[0]![1]);
    expect(first).toMatchObject({ url: '/', title: '高千穗船位已暫留',
      body: '2026-10-26 11:00 已暫留，請到 Mac 接手確認付款' });
    expect(send.mock.calls[0]![2]).toMatchObject({ TTL: 3, urgency: 'high', contentEncoding: 'aes128gcm' });
    expect(JSON.parse(send.mock.calls[1]![1]).tag).not.toBe(first.tag);
    expect(send.mock.calls[1]![2].topic).toBe(send.mock.calls[0]![2].topic);
    vi.setSystemTime(Date.now() + 180_000);
    hold.connection = 'ended';
    await push.observe(hold);
    expect(send).toHaveBeenCalledTimes(3);
    expect(push.status().reminders).toHaveLength(1);
  });

  it('baselines historical holds on startup, including stale snapshots that later become live', async () => {
    const send = vi.fn<Send>(async () => undefined);
    const { push } = await fixture(send);
    await push.subscribe(subscription());
    const prior = snapshot(['11:00']);
    prior.connection = 'stale';
    await push.observe(prior);
    await push.observe(snapshot(['11:00']));
    expect(send).not.toHaveBeenCalled();
    await push.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown, stale, ended, demo and unconfirmed holds without sending', async () => {
    const send = vi.fn<Send>(async () => undefined);
    const { push } = await fixture(send);
    await push.subscribe(subscription());
    await push.observe(waiting());
    const cases = [snapshot(['11:00']), snapshot(['11:00']), snapshot(['11:00']), snapshot(['11:00']), snapshot(['11:00'])];
    cases[0]!.connection = 'ended';
    cases[1]!.connection = 'stale';
    cases[2]!.heartbeatAt = Date.now() - 60_000;
    cases[3]!.slots[0]!.holdConfirmed = false;
    Object.assign(cases[4]!, { demo: true });
    for (const value of cases) await push.observe(value);
    const oldHold = snapshot(['11:00']);
    oldHold.run!.startedAt = Date.now() - 300_000;
    oldHold.slots[0]!.heldAt = Date.now() - 180_000;
    await push.observe(oldHold);
    expect(send).not.toHaveBeenCalled();
  });

  it('captures current recipients so new devices never receive a retroactive hold', async () => {
    const send = vi.fn<Send>(async () => undefined);
    const { push } = await fixture(send);
    await push.observe(waiting());
    await push.observe(snapshot(['11:00']));
    const item = subscription();
    await push.subscribe(item);
    await push.observe(snapshot(['11:00']));
    expect(send).not.toHaveBeenCalled();
    await push.test(item.endpoint);
    await push.observe(snapshot(['11:00']));
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![1]).tag).toBe('takachiho-test');
    await push.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('backs off failures without slowing healthy devices and resets backoff after recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    const good = subscription('good');
    const failing = subscription('failing');
    let failingNow = true;
    const send = vi.fn(async (item: { endpoint: string }) => {
      if (item.endpoint === failing.endpoint && failingNow) throw Object.assign(new Error('PRIVATE failure'), { statusCode: 503 });
    });
    const { push } = await fixture(send);
    await push.subscribe(good);
    await push.subscribe(failing);
    await push.observe(waiting());
    const hold = snapshot(['11:00']);
    await push.observe(hold);
    await push.observe(hold);
    expect(send).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 5000);
    hold.serverTime = Date.now(); hold.heartbeatAt = Date.now();
    await push.observe(hold);
    vi.setSystemTime(Date.now() + 10_000);
    hold.serverTime = Date.now(); hold.heartbeatAt = Date.now();
    await push.observe(hold);
    vi.setSystemTime(Date.now() + 20_000);
    hold.serverTime = Date.now(); hold.heartbeatAt = Date.now();
    await push.observe(hold);
    expect(send.mock.calls.filter(([item]) => item.endpoint === good.endpoint)).toHaveLength(4);
    expect(send.mock.calls.filter(([item]) => item.endpoint === failing.endpoint)).toHaveLength(4);
    failingNow = false;
    vi.setSystemTime(Date.now() + 40_000);
    await push.observe(hold);
    vi.setSystemTime(Date.now() + 3000);
    await push.observe(hold);
    expect(send.mock.calls.filter(([item]) => item.endpoint === failing.endpoint)).toHaveLength(6);
  });

  it('does not let a slow device block healthy repeats or the durable stop command', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    let release!: () => void;
    let notifyStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let first = true;
    const send = vi.fn<Send>(async () => {
      if (first) { first = false; notifyStarted(); await gate; }
    });
    const { push, options } = await fixture(send);
    await push.subscribe(subscription('first'));
    await push.subscribe(subscription('second'));
    await push.observe(waiting());
    const hold = snapshot(['11:00']);
    const running = push.observe(hold);
    await started;
    await push.observe(hold);
    expect(send).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + 3000);
    await push.observe(hold);
    expect(send).toHaveBeenCalledTimes(3);
    const ids = push.status().reminders.map((reminder) => reminder.id);
    await push.stop(ids);
    expect(push.status().reminders).toEqual([]);
    release();
    await running;
    vi.setSystemTime(Date.now() + 30_000);
    await push.observe(hold);
    const restarted = await createMonitorPush(options);
    await restarted.observe(hold);
    await restarted.observe(hold);
    expect(send).toHaveBeenCalledTimes(3);
    expect(restarted.status().reminders).toEqual([]);
  });

  it('resumes active reminders and recipient backoff across restart without replaying the first round', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    const good = subscription('good');
    const failing = subscription('failing');
    let failure = true;
    const send = vi.fn(async (item: { endpoint: string }) => {
      if (item.endpoint === failing.endpoint && failure) throw new Error('PRIVATE');
    });
    const { push, options } = await fixture(send);
    await push.subscribe(good);
    await push.subscribe(failing);
    await push.observe(waiting());
    const hold = snapshot(['11:00']);
    await push.observe(hold);
    const restarted = await createMonitorPush(options);
    await restarted.observe(hold);
    failure = false;
    vi.setSystemTime(Date.now() + 5000);
    hold.serverTime = Date.now(); hold.heartbeatAt = Date.now();
    await restarted.observe(hold);
    expect(send.mock.calls.filter(([item]) => item.endpoint === good.endpoint)).toHaveLength(2);
    expect(send.mock.calls.filter(([item]) => item.endpoint === failing.endpoint)).toHaveLength(2);
  });

  it('autonomously repeats without fresh snapshots and disposes its timer on close', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    let notifyNext!: () => void;
    const next = new Promise<void>((resolve) => { notifyNext = resolve; });
    const send = vi.fn<Send>(async () => { if (send.mock.calls.length === 2) notifyNext(); });
    const { options, push } = await fixture(send);
    await push.subscribe(subscription());
    await push.close();
    const scheduled = await createMonitorPush({ ...options, schedule: true });
    instances.push(scheduled);
    await scheduled.observe(waiting());
    await scheduled.observe(snapshot(['11:00']));
    await vi.advanceTimersByTimeAsync(2999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(send).toHaveBeenCalledTimes(2);
    await scheduled.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('stops only the selected reminders and lets a later hold start its own reminder', async () => {
    const send = vi.fn<Send>(async () => undefined);
    const { push } = await fixture(send);
    await push.subscribe(subscription());
    await push.observe(waiting());
    await push.observe(snapshot(['11:00']));
    const ids = push.status().reminders.map((item) => item.id);
    await push.observe(snapshot(['11:00', '11:30']));
    await push.stop(ids);
    await push.stop(ids); // A retry of the same stop is safe.
    expect(push.status().reminders.map((item) => item.slot)).toEqual(['11:30']);
    await push.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(2);
    await expect(push.stop([ids[0], 'a'.repeat(64)])).rejects.toMatchObject({ status: 404 });
    for (const value of [undefined, [], 'bad', ['bad'], [ids[0], ids[0]]]) {
      await expect(push.stop(value)).rejects.toMatchObject({ status: 400 });
    }
    expect(push.status().reminders.map((item) => item.slot)).toEqual(['11:30']);
  });

  it('does not convert legacy pending one-shot notifications into repeating alarms', async () => {
    const send = vi.fn<Send>(async () => undefined);
    const { push, options, directory } = await fixture(send);
    await push.subscribe(subscription());
    await push.observe(waiting());
    const hold = snapshot(['11:00']);
    await push.observe(hold);
    const state = JSON.parse(await readFile(join(directory, 'subscriptions.json'), 'utf8'));
    state.version = 1;
    state.deliveries = state.deliveries.map((item: { id: string; at: number; payload: string; recipients: { id: string; nextAttemptAt: number }[] }) => ({
      id: item.id, at: item.at, baseline: false, payload: item.payload,
      recipients: item.recipients.map((recipient) => ({ ...recipient, attempts: 1, delivered: false })),
    }));
    await writeFile(join(directory, 'subscriptions.json'), JSON.stringify(state));
    const restarted = await createMonitorPush(options);
    await restarted.observe(hold);
    await restarted.observe(hold);
    expect(send).toHaveBeenCalledTimes(1);
    expect(restarted.status().reminders).toEqual([]);
    expect(JSON.parse(await readFile(join(directory, 'subscriptions.json'), 'utf8')).version).toBe(3);
  });

  it('migrates version two without losing active alarms, stopped alarms or device cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    const send = vi.fn<Send>(async () => undefined);
    const { push, options, directory } = await fixture(send);
    await push.subscribe(subscription());
    await push.observe(waiting());
    const hold = snapshot(['11:00', '11:30']);
    await push.observe(hold);
    await push.stop([push.status().reminders[0]!.id]);
    await push.close();
    const prior = JSON.parse(await readFile(join(directory, 'subscriptions.json'), 'utf8'));
    prior.version = 2;
    delete prior.summaries;
    prior.subscriptions[0].nextAllowedAt = Date.now() + 12_000;
    await writeFile(join(directory, 'subscriptions.json'), JSON.stringify(prior));
    const restarted = await createMonitorPush(options);
    instances.push(restarted);
    await restarted.observe(hold);
    expect(restarted.status().reminders.map((item) => item.slot)).toEqual(['11:30']);
    expect(send).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 12_000);
    await restarted.observe(hold);
    expect(send).toHaveBeenCalledTimes(2);
    const migrated = JSON.parse(await readFile(join(directory, 'subscriptions.json'), 'utf8'));
    expect(migrated.version).toBe(3);
    expect(migrated.summaries).toEqual([]);
    expect(migrated.deliveries).toHaveLength(2);
  });

  it.each(['12', 'Tue, 13 Oct 2026 10:00:12 GMT'])('honors Retry-After %s across slots and restarts', async (retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    let fail = true;
    const send = vi.fn<Send>(async () => {
      if (fail) throw Object.assign(new Error('PRIVATE'), { statusCode: 429, headers: { 'retry-after': retryAfter } });
    });
    const { push, options } = await fixture(send);
    await push.subscribe(subscription());
    await push.observe(waiting());
    await push.observe(snapshot(['11:00']));
    await push.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(1);
    const restarted = await createMonitorPush(options);
    await restarted.observe(snapshot(['11:00', '11:30']));
    vi.setSystemTime(Date.now() + 11_999);
    await restarted.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(1);
    fail = false;
    vi.setSystemTime(Date.now() + 1);
    await restarted.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(2);
    // The other slot gets the same device after the first request has finished.
    await restarted.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('allows stopping reminders while a test notification is still in flight', async () => {
    let release!: () => void;
    let notifyStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const send = vi.fn<Send>(async (_item, body) => {
      if (JSON.parse(body).tag === 'takachiho-test') { notifyStarted(); await gate; }
    });
    const { push } = await fixture(send);
    const item = subscription();
    await push.subscribe(item);
    await push.observe(waiting());
    await push.observe(snapshot(['11:00']));
    const running = push.test(item.endpoint);
    await started;
    await push.stop(push.status().reminders.map((reminder) => reminder.id));
    expect(push.status().reminders).toEqual([]);
    release();
    await running;
  });

  it('serializes concurrent reminder groups for the same device while keeping both groups active', async () => {
    let release!: () => void;
    let notifyStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let first = true;
    const send = vi.fn<Send>(async () => {
      if (first) { first = false; notifyStarted(); await gate; }
    });
    const { push } = await fixture(send);
    await push.subscribe(subscription());
    await push.observe(waiting());
    const hold = snapshot(['11:00', '11:30']);
    const running = push.observe(hold);
    await started;
    await push.observe(hold);
    expect(send).toHaveBeenCalledTimes(1);
    expect(push.status().reminders.map((item) => item.slot)).toEqual(['11:00', '11:30']);
    release();
    await running;
    await push.observe(hold);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[0]![1]).body).toContain('11:00');
    expect(JSON.parse(send.mock.calls[1]![1]).body).toContain('11:30');
  });

  it('retains provider cooldown when the browser re-registers its subscription', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    let fail = true;
    const send = vi.fn<Send>(async () => {
      if (fail) throw Object.assign(new Error('PRIVATE'), { statusCode: 429, headers: { 'retry-after': '12' } });
    });
    const { push } = await fixture(send);
    const item = subscription();
    await push.subscribe(item);
    await push.observe(waiting());
    await push.observe(snapshot(['11:00']));
    await push.subscribe(item);
    vi.setSystemTime(Date.now() + 11_999);
    await push.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(1);
    fail = false;
    vi.setSystemTime(Date.now() + 1);
    await push.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([404, 410])('removes expired provider subscriptions on HTTP %i', async (statusCode) => {
    const send = vi.fn(async () => { throw Object.assign(new Error('PRIVATE'), { statusCode }); });
    const { push, directory } = await fixture(send);
    const item = subscription();
    await push.subscribe(item);
    await push.observe(waiting());
    await push.observe(snapshot(['11:00']));
    await push.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(directory, 'subscriptions.json'), 'utf8')).subscriptions).toEqual([]);
    await expect(push.test(item.endpoint)).rejects.toMatchObject({ status: 404 });
  });

  it('tests only a registered device, removes failed expired devices, and sanitizes errors', async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error('PRIVATE endpoint or secret'), { statusCode: 410 }); });
    const { push } = await fixture(send);
    const item = subscription();
    await expect(push.test(item.endpoint)).rejects.toMatchObject({ status: 404 });
    expect(send).not.toHaveBeenCalled();
    await push.subscribe(item);
    await expect(push.test(item.endpoint)).rejects.toMatchObject({ status: 410, message: '通知訂閱已失效，請重新啟用這台裝置的通知。' });
    await expect(push.test(item.endpoint)).rejects.toMatchObject({ status: 404 });
  });

  it('validates provider hosts, secure endpoints and real encryption key lengths before any request', async () => {
    const send = vi.fn<Send>(async () => undefined);
    const { push } = await fixture(send);
    const item = subscription();
    for (const url of ['http://web.push.apple.com/token', 'https://127.0.0.1/token', 'https://[::1]/token',
      'https://push.apple.com.evil.test/token', 'https://evilpush.apple.com/token', 'https://push.apple.com:8443/token',
      'https://user:password@web.push.apple.com/token', 'https://web.push.apple.com/token#fragment',
      'https://web.push.apple.com/']) {
      await expect(push.subscribe({ ...item, endpoint: url })).rejects.toMatchObject({ status: 400 });
      await expect(push.test(url)).rejects.toMatchObject({ status: 400 });
    }
    for (const keys of [{ ...item.keys, auth: 'short' }, { ...item.keys, p256dh: 'short' },
      { ...item.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') }, { ...item.keys, auth: '!invalid' }]) {
      await expect(push.subscribe({ ...item, keys })).rejects.toMatchObject({ status: 400 });
    }
    for (const provider of ['https://fcm.googleapis.com/fcm/send/token', 'https://updates.push.services.mozilla.com/wpush/v2/token']) {
      await push.subscribe({ ...item, endpoint: provider });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('bounds devices, reuses duplicate endpoints and removes unsubscribed devices', async () => {
    const { push } = await fixture();
    const item = subscription();
    for (let i = 0; i < 16; i += 1) await push.subscribe({ ...item, endpoint: `https://web.push.apple.com/device-${i}` });
    await push.subscribe({ ...item, endpoint: 'https://web.push.apple.com/device-0' });
    await expect(push.subscribe({ ...item, endpoint: 'https://web.push.apple.com/one-too-many' })).rejects.toMatchObject({ status: 429 });
    await push.unsubscribe('https://web.push.apple.com/device-0');
    await push.subscribe({ ...item, endpoint: 'https://web.push.apple.com/replacement' });
    await expect(push.test('https://web.push.apple.com/device-0')).rejects.toMatchObject({ status: 404 });
  });

  it('refuses symlinks and corrupt private keys without overwriting existing data', async () => {
    const { directory, options } = await fixture();
    const target = join(directory, 'foreign.json');
    await writeFile(target, 'private foreign data');
    await rm(join(directory, 'vapid.json'));
    await symlink(target, join(directory, 'vapid.json'));
    await expect(createMonitorPush(options)).rejects.toThrow('通知設定無法讀寫');
    expect(await readFile(target, 'utf8')).toBe('private foreign data');
    await rm(join(directory, 'vapid.json'));
    await writeFile(join(directory, 'vapid.json'), '{"publicKey":"broken","privateKey":"broken"}');
    await expect(createMonitorPush(options)).rejects.toThrow('通知設定無法讀寫');
    expect(await readFile(join(directory, 'vapid.json'), 'utf8')).toContain('broken');
  });
});
