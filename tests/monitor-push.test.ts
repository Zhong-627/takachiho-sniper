import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMonitorPush, type MonitorPushOptions } from '../src/monitor-push.js';
import { MonitorState, type MonitorSnapshot } from '../src/monitor-state.js';

type Send = NonNullable<MonitorPushOptions['send']>;
const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(send: MonitorPushOptions['send'] = vi.fn<Send>(async () => undefined)) {
  const directory = await mkdtemp(join(tmpdir(), 'takachiho-push-'));
  temporary.push(directory);
  const options = { directory, send };
  return { directory, options, send, push: await createMonitorPush(options) };
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
  it('keeps VAPID keys and subscriptions private and reuses keys after restart', async () => {
    const { push, directory, options } = await fixture();
    await push.subscribe(subscription());
    const restarted = await createMonitorPush(options);
    expect(restarted.publicKey).toBe(push.publicKey);
    expect(restarted.status()).toEqual({ available: true, publicKey: push.publicKey });
    for (const file of ['vapid.json', 'subscriptions.json']) {
      expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(join(directory, 'subscriptions.json'), 'utf8')).subscriptions).toHaveLength(1);
  });

  it('notifies each confirmed slot once even when its final phase is manual, including after restart', async () => {
    const send = vi.fn<Send>(async () => undefined);
    const { push, options } = await fixture(send);
    const item = subscription();
    await push.subscribe(item);
    await push.observe(waiting());
    await push.observe(snapshot(['11:00'], { phase: 'manual' }));
    await push.observe(snapshot(['11:00'], { phase: 'manual' }));
    await push.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(2);
    const first = JSON.parse(send.mock.calls[0]![1]);
    expect(first).toMatchObject({ url: '/', title: '高千穗船位已暫留',
      body: '2026-10-26 11:00 已暫留，請到 Mac 接手確認付款', tag: 'takachiho-live-test-run-1100' });
    expect(send.mock.calls[0]![2]).toMatchObject({ TTL: 119, urgency: 'high', contentEncoding: 'aes128gcm' });
    const restarted = await createMonitorPush(options);
    await restarted.observe(snapshot(['11:00', '11:30']));
    await restarted.observe(snapshot(['11:00', '11:30']));
    expect(send).toHaveBeenCalledTimes(2);
    await restarted.observe(snapshot(['11:00'], { runId: 'another-run' }));
    expect(send).toHaveBeenCalledTimes(3);
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

  it('retries failed recipients only with a bounded count and isolates all send errors', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    const good = subscription('good');
    const failing = subscription('failing');
    const send = vi.fn(async (item: { endpoint: string }) => {
      if (item.endpoint === failing.endpoint) throw Object.assign(new Error('PRIVATE failure'), { statusCode: 503 });
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
    expect(send.mock.calls.filter(([item]) => item.endpoint === good.endpoint)).toHaveLength(1);
    expect(send.mock.calls.filter(([item]) => item.endpoint === failing.endpoint)).toHaveLength(3);
  });

  it('coalesces a slow send backlog and recalculates TTL when later recipients are sent', async () => {
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
    const { push } = await fixture(send);
    await push.subscribe(subscription('first'));
    await push.subscribe(subscription('second'));
    await push.observe(waiting());
    let reads = 0;
    const observed = (held: readonly string[]) => {
      const value = snapshot(held);
      const slots = value.slots;
      Object.defineProperty(value, 'slots', { get: () => { reads += 1; return slots; } });
      return value;
    };
    const running = push.observe(observed(['11:00']));
    await started;
    for (let i = 0; i < 100; i += 1) expect(push.observe(observed(['11:00', '11:30']))).toBe(running);
    vi.setSystemTime(Date.now() + 15_000);
    release();
    await running;
    expect(reads).toBe(2);
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls[0]![2]).toMatchObject({ TTL: 119 });
    expect(send.mock.calls[1]![2]).toMatchObject({ TTL: 104 });
    expect(send.mock.calls[2]![2]).toMatchObject({ TTL: 104 });
  });

  it('resumes pending recipient retries across restart without resending to successful devices', async () => {
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
    expect(send.mock.calls.filter(([item]) => item.endpoint === good.endpoint)).toHaveLength(1);
    expect(send.mock.calls.filter(([item]) => item.endpoint === failing.endpoint)).toHaveLength(2);
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
