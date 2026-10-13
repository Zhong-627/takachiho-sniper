import { scryptSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDiagnostics, type Diagnostics } from '../src/diagnostics.js';
import { ArtifactsMonitor } from '../src/monitor-source.js';
import { createMonitorServer } from '../src/monitor-server.js';
import type { MonitorSnapshot } from '../src/monitor-state.js';

const password = 'only-for-local-pwa-fixture';
let directory: string;
let diagnostics: Diagnostics;
let source: ArtifactsMonitor;
let server: Server;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let origin: string;
let upstreamUnavailable = false;
const errors: string[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'takachiho-monitor-browser-'));
  diagnostics = await createDiagnostics(directory, 'live');
  const now = Date.now();
  diagnostics.event('run_started', { targetDate: '2026-10-26', slots: ['11:00', '11:30'],
    releaseAt: new Date(now).toISOString(), monitorFromAt: new Date(now - 120_000).toISOString(), monitorUntil: new Date(now + 7_200_000).toISOString() });
  diagnostics.event('monitor_heartbeat', { automationActive: true });
  diagnostics.event('availability_request_started', { attempt: 12 }, '11:00');
  diagnostics.event('availability_detected', { attempt: 12, status: 'unavailable' }, '11:00');
  diagnostics.event('availability_request_started', { attempt: 9 }, '11:30');
  await diagnostics.writeJson('fixture-flush', {});
  source = new ArtifactsMonitor(directory);
  await source.refresh();
  const salt = 'a'.repeat(64);
  server = createMonitorServer({ secureCookies: false, credential: { salt, passwordHash: scryptSync(password, salt, 64).toString('hex') }, snapshot: () => source.snapshot() });
  const handleRequest = server.listeners('request')[0] as ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  if (!handleRequest) throw new Error('Missing fixture request handler');
  server.off('request', handleRequest);
  server.on('request', (request, response) => {
    if (upstreamUnavailable) {
      response.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    handleRequest(request, response);
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
}, 30_000);

function controlFixture() {
  const settings = {
    targetDate: '2026-10-26', monitorFrom: '2026-10-12T21:50:00+08:00',
    releaseAt: '2026-10-12T23:00:00+08:00', monitorUntil: '2026-10-13T01:00:00+08:00',
    baseDelayMs: 1000, manualCustomerForm: true,
    slots: [{ slot: '11:00', customerProfile: 'customer1' }, { slot: '11:30', customerProfile: 'customer2' }],
  };
  type Worker = {
    runId: string; targetDate: string; slots: Array<{ slot: string; active: boolean; handedOff: boolean; canHandoff: boolean; holdConfirmed: boolean }>;
    automationStopped: boolean; closed: boolean;
  };
  return { enabled: true, demo: true, busy: false, settings,
    profiles: [{ id: 'customer1', label: '船 A' }, { id: 'customer2', label: '船 B' }],
    worker: null as Worker | null, externalRun: false, error: null as string | null };
}

async function controlledPage(simulatedPush = false, status?: MonitorSnapshot, timezoneId?: string) {
  const control = controlFixture();
  if (status) control.demo = false;
  const commands: Array<{ command: string; body: Record<string, unknown> }> = [];
  const failures = new Set<string>();
  const pushSettings = { available: simulatedPush, publicKey: simulatedPush ? 'dGVzdA' : null };
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, timezoneId });
  if (simulatedPush) await phoneContext.addInitScript(() => {
    const state = { permissionRequests: 0, subscribed: false, subscribeCalls: 0, unsubscribeCalls: 0 };
    let keyBytes: ArrayBuffer | null = null;
    Object.defineProperty(window, 'pushFixture', { value: state });
    const notification = { permission: 'default', requestPermission: async () => { state.permissionRequests += 1; notification.permission = 'granted'; return 'granted'; } };
    Object.defineProperty(window, 'Notification', { value: notification });
    Object.defineProperty(window, 'PushManager', { value: {} });
    const subscription = {
      endpoint: 'https://push.example/device-fixture',
      get options() { return { applicationServerKey: keyBytes }; },
      toJSON: () => ({ endpoint: 'https://push.example/device-fixture', expirationTime: null, keys: { p256dh: 'fixture-key', auth: 'fixture-auth' } }),
      unsubscribe: async () => { state.subscribed = false; state.unsubscribeCalls += 1; return true; },
    };
    const registration = { pushManager: {
      getSubscription: async () => state.subscribed ? subscription : null,
      subscribe: async (options: { applicationServerKey: Uint8Array }) => { state.subscribed = true; state.subscribeCalls += 1; keyBytes = Uint8Array.from(options.applicationServerKey).buffer; return subscription; },
    } };
    Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(registration), register: async () => registration } });
  });
  const phone = await phoneContext.newPage();
  const phoneErrors: string[] = [];
  phone.on('pageerror', (error) => phoneErrors.push(error.message));
  await phone.route(/\/api\/control(?:\/[^/?]+)?$/, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') { await route.fulfill({ json: control }); return; }
    const command = new URL(request.url()).pathname.split('/').at(-1)!;
    const body = request.postDataJSON() as Record<string, unknown>;
    commands.push({ command, body });
    if (failures.has(command)) { await route.fulfill({ status: 409, json: { error: `${command} 未完成，請在 Mac 確認。` } }); return; }
    if (command === 'settings') control.settings = body as typeof control.settings;
    if (command === 'start') control.worker = {
      runId: 'run-fixture-1', targetDate: control.settings.targetDate, automationStopped: false, closed: false,
      slots: control.settings.slots.map(({ slot }) => ({ slot, active: true, handedOff: false, canHandoff: true, holdConfirmed: true })),
    };
    if (command === 'handoff') {
      const selected = control.worker?.slots.find((slot) => slot.slot === body.slot);
      if (selected) { selected.handedOff = true; selected.canHandoff = false; selected.active = false; }
    }
    if (command === 'stop' && control.worker) {
      control.worker.automationStopped = true;
      control.worker.slots.forEach((slot) => { slot.active = false; });
    }
    if (command === 'close' && control.worker) control.worker.closed = true;
    await route.fulfill({ json: control });
  });
  if (status) {
    // This isolated control fixture does not consume the shared server's login
    // burst allowance, and live SSE must not replace its historical snapshot.
    await phone.route(/\/api\/login$/, (route) => route.fulfill({ json: { authenticated: true } }));
    await phone.route(/\/api\/status$/, (route) => route.fulfill({ json: status }));
    await phone.route(/\/api\/events$/, (route) => route.fulfill({
      contentType: 'text/event-stream', body: `event: status\ndata: ${JSON.stringify(status)}\n\n`,
    }));
  }
  await phone.route(/\/api\/push$/, (route) => route.fulfill({ json: pushSettings }));
  await phone.goto(origin, { waitUntil: 'domcontentloaded' });
  await phone.locator('#password').fill(password);
  await phone.locator('#login-submit').click();
  await expect.poll(() => phone.locator('#control-start').isEnabled()).toBe(true);
  return { phone, phoneContext, control, commands, failures, phoneErrors, pushSettings };
}

async function captureControlScreenshots(phone: Page, name: string) {
  if (!process.env.MONITOR_SCREENSHOT_DIR) return;
  await mkdir(process.env.MONITOR_SCREENSHOT_DIR, { recursive: true });
  await phone.screenshot({ path: join(process.env.MONITOR_SCREENSHOT_DIR, `${name}-phone.png`), fullPage: true });
  await phone.setViewportSize({ width: 1280, height: 900 });
  await phone.screenshot({ path: join(process.env.MONITOR_SCREENSHOT_DIR, `${name}-desktop.png`), fullPage: true });
  await phone.setViewportSize({ width: 390, height: 844 });
}

function idleControlStatus(): MonitorSnapshot {
  return {
    schemaVersion: 1, serverTime: Date.now(), connection: 'waiting', updatedAt: null, heartbeatAt: null,
    run: null, slots: [], recentEvents: [],
  };
}

async function scheduleValues(phone: Page): Promise<string[]> {
  return Promise.all(['setting-monitor-from', 'setting-release-at', 'setting-monitor-until']
    .map((id) => phone.locator(`#${id}`).inputValue()));
}

it('fills Taipei schedules on date changes, preserves manual edits and saved hydration, and restores defaults on request', async () => {
  const { phone, phoneContext, control, commands, phoneErrors } = await controlledPage(false, idleControlStatus(), 'America/Los_Angeles');
  try {
    expect(await scheduleValues(phone)).toEqual(['2026-10-12T21:50', '2026-10-12T23:00', '2026-10-13T01:00']);
    await phone.locator('#setting-date').fill('2026-10-27');
    expect(await scheduleValues(phone)).toEqual(['2026-10-13T07:48', '2026-10-13T07:55', '2026-10-13T10:05']);
    expect(commands).toEqual([]);
    expect(await phone.locator('#control-save').isEnabled()).toBe(true);
    expect(await phone.locator('#control-start').isDisabled()).toBe(true);

    const manual = ['2026-10-13T07:40', '2026-10-13T07:57', '2026-10-13T10:20'];
    await phone.locator('#setting-monitor-from').fill(manual[0]!);
    await phone.locator('#setting-release-at').fill(manual[1]!);
    await phone.locator('#setting-monitor-until').fill(manual[2]!);
    await phone.locator('#slot-1-time').fill('12:00');
    await phone.locator('#slot-1-profile').selectOption('customer2');
    await phone.locator('#slot-2-profile').selectOption('customer1');
    await phone.locator('#slot-2-enabled').uncheck();
    await phone.locator('#slot-2-enabled').check();
    expect(await scheduleValues(phone)).toEqual(manual);
    await phone.locator('#refresh').click();
    expect(await scheduleValues(phone)).toEqual(manual);

    await phone.locator('#control-save').click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('設定已儲存');
    expect(commands).toEqual([{ command: 'settings', body: control.settings }]);
    expect(control.settings).toMatchObject({
      targetDate: '2026-10-27', monitorFrom: '2026-10-13T07:40+08:00',
      releaseAt: '2026-10-13T07:57+08:00', monitorUntil: '2026-10-13T10:20+08:00',
      slots: [{ slot: '12:00', customerProfile: 'customer2' }, { slot: '11:30', customerProfile: 'customer1' }],
    });
    await phone.reload({ waitUntil: 'domcontentloaded' });
    await phone.locator('#password').fill(password);
    await phone.locator('#login-submit').click();
    await expect.poll(() => phone.locator('#control-start').isEnabled()).toBe(true);
    expect(await scheduleValues(phone)).toEqual(manual);
    expect(await phone.locator('#control-save').isDisabled()).toBe(true);

    await phone.locator('#setting-date').fill('2026-10-28');
    const defaults = ['2026-10-14T07:48', '2026-10-14T07:55', '2026-10-14T10:05'];
    expect(await scheduleValues(phone)).toEqual(defaults);
    await phone.locator('#setting-monitor-from').fill('2026-10-14T07:00');
    await phone.locator('#setting-release-at').fill('2026-10-14T08:00');
    await phone.locator('#setting-monitor-until').fill('2026-10-14T12:00');
    await phone.locator('#setting-schedule-reset').click();
    expect(await scheduleValues(phone)).toEqual(defaults);
    expect(commands).toHaveLength(1);
    expect(await phone.locator('#setting-date').inputValue()).toBe('2026-10-28');
    await phone.locator('#control-save').click();
    await expect.poll(() => control.settings.targetDate).toBe('2026-10-28');
    expect(commands.at(-1)).toMatchObject({ command: 'settings', body: {
      targetDate: '2026-10-28', monitorFrom: '2026-10-14T07:48+08:00',
      releaseAt: '2026-10-14T07:55+08:00', monitorUntil: '2026-10-14T10:05+08:00',
    } });
    expect(phoneErrors).toEqual([]);
  } finally { await phoneContext.close(); }
}, 30_000);

it.each([
  { targetDate: '2026-11-03', scheduleDate: '2026-10-20', timezoneId: 'America/Los_Angeles' },
  { targetDate: '2027-01-07', scheduleDate: '2026-12-24', timezoneId: 'Pacific/Auckland' },
  { targetDate: '2028-03-14', scheduleDate: '2028-02-29', timezoneId: 'America/New_York' },
  { targetDate: '2026-03-10', scheduleDate: '2026-02-24', timezoneId: 'America/New_York' },
])('subtracts 14 calendar days from $targetDate independently of device timezone $timezoneId', async ({ targetDate, scheduleDate, timezoneId }) => {
  const { phone, phoneContext, commands, phoneErrors } = await controlledPage(false, idleControlStatus(), timezoneId);
  try {
    expect(await phone.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(timezoneId);
    await phone.locator('#setting-date').fill(targetDate);
    expect(await scheduleValues(phone)).toEqual([
      `${scheduleDate}T07:48`, `${scheduleDate}T07:55`, `${scheduleDate}T10:05`,
    ]);
    expect(commands).toEqual([]);
    expect(phoneErrors).toEqual([]);
  } finally { await phoneContext.close(); }
}, 30_000);

it('saves one selected slot or two independent slots with explicit Taipei schedules, and locks the target while browsers remain open', async () => {
  const fixture = await controlledPage();
  const { phone, phoneContext, control, commands, phoneErrors } = fixture;
  try {
    expect(await phone.locator('#control-demo').isVisible()).toBe(true);
    expect(await phone.locator('#slot-1-time').inputValue()).toBe('11:00');
    expect(await phone.locator('#setting-release-at').inputValue()).toBe('2026-10-12T23:00');
    await captureControlScreenshots(phone, 'control-ready');
    await phone.locator('#slot-1-enabled').uncheck();
    expect(await phone.locator('#control-start').isDisabled()).toBe(true);
    await phone.locator('#control-save').click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('設定已儲存');
    expect(control.settings.slots).toEqual([{ slot: '11:30', customerProfile: 'customer2' }]);
    expect(commands.at(-1)?.body.releaseAt).toBe('2026-10-12T23:00+08:00');
    await phone.locator('#control-start').click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('程式已啟動');
    expect(commands.at(-1)).toEqual({ command: 'start', body: { confirmed: true, settings: control.settings } });
    expect(await phone.locator('#setting-date').isDisabled()).toBe(true);
    expect(await phone.locator('#slot-1-enabled').isDisabled()).toBe(true);
    await phone.locator('#control-stop').click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('頁面保留');
    expect(await phone.locator('#setting-date').isDisabled()).toBe(true);
    expect(control.worker?.closed).toBe(false);
    await phone.locator('#control-close').click();
    await expect.poll(() => phone.locator('#setting-date').isEnabled()).toBe(true);
    await phone.locator('#slot-2-enabled').check();
    await phone.locator('#slot-2-time').fill('12:00');
    await phone.locator('#slot-2-profile').selectOption('customer1');
    await phone.locator('#control-save').click();
    await expect.poll(() => control.settings.slots.length).toBe(2);
    expect(control.settings.slots).toEqual([{ slot: '11:30', customerProfile: 'customer2' }, { slot: '12:00', customerProfile: 'customer1' }]);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(phoneErrors).toEqual([]);
  } finally { await phoneContext.close(); }
}, 30_000);

it('keeps ride settings editable when the latest run is historical and no worker is active', async () => {
  const now = Date.now();
  const lastHeartbeat = now - 6 * 3_600_000;
  const status: MonitorSnapshot = {
    schemaVersion: 1, serverTime: now, connection: 'stale', updatedAt: lastHeartbeat, heartbeatAt: lastHeartbeat,
    run: {
      id: 'historical-stale-run', targetDate: '2026-10-26', startedAt: now - 8 * 3_600_000,
      releaseAt: now - 7 * 3_600_000, monitorFrom: now - 8 * 3_600_000,
      monitorUntil: now - 5 * 3_600_000, mode: 'live',
    },
    slots: ['11:00', '11:30'].map((slot) => ({
      slot, phase: 'stopped', attempts: 12, availability: 'unavailable', responseMs: null,
      nextRetryAt: null, updatedAt: lastHeartbeat, holdConfirmed: false, heldAt: null,
    })),
    recentEvents: [{ at: lastHeartbeat, slot: null, label: '自動化已停止' }],
  };
  const { phone, phoneContext, control, commands, phoneErrors } = await controlledPage(false, status);
  try {
    await expect.poll(() => phone.locator('.phase-badge').first().textContent()).toContain('最後：已停止');
    expect(control).toMatchObject({ enabled: true, busy: false, worker: null, externalRun: false });
    for (const id of ['setting-date', 'setting-monitor-from', 'setting-release-at', 'setting-monitor-until', 'slot-1-time', 'slot-2-time']) {
      expect(await phone.locator(`#${id}`).isEnabled()).toBe(true);
    }
    await phone.locator('#setting-date').fill('2026-10-27');
    await phone.locator('#slot-1-time').fill('12:00');
    await phone.locator('#setting-monitor-from').fill('2026-10-13T21:50');
    await phone.locator('#setting-release-at').fill('2026-10-13T23:00');
    await phone.locator('#setting-monitor-until').fill('2026-10-14T01:00');
    expect(await phone.locator('#control-start').isDisabled()).toBe(true);
    await phone.locator('#control-save').click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('設定已儲存');
    expect(control.settings).toMatchObject({
      targetDate: '2026-10-27', monitorFrom: '2026-10-13T21:50+08:00',
      releaseAt: '2026-10-13T23:00+08:00', monitorUntil: '2026-10-14T01:00+08:00',
      slots: [{ slot: '12:00', customerProfile: 'customer1' }, { slot: '11:30', customerProfile: 'customer2' }],
    });
    expect(commands).toEqual([{ command: 'settings', body: control.settings }]);
    expect(await phone.locator('#control-start').isEnabled()).toBe(true);
    expect(await phone.locator('#setting-date').isEnabled()).toBe(true);
    expect(phoneErrors).toEqual([]);
  } finally { await phoneContext.close(); }
}, 30_000);

it('reports start, Mac handoff, and stop failures without claiming success, and hands off only the selected slot', async () => {
  const { phone, phoneContext, control, commands, failures, phoneErrors } = await controlledPage();
  try {
    failures.add('start');
    await phone.locator('#control-start').click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('start 未完成');
    expect(control.worker).toBeNull();
    expect(await phone.locator('#control-start').isEnabled()).toBe(true);
    failures.delete('start');
    await phone.locator('#control-start').click();
    await expect.poll(() => phone.getByRole('button', { name: '11:00 交接到 Mac' }).isEnabled()).toBe(true);
    await captureControlScreenshots(phone, 'control-running');
    failures.add('handoff');
    await phone.getByRole('button', { name: '11:00 交接到 Mac' }).click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('handoff 未完成');
    expect(control.worker?.slots[0]?.handedOff).toBe(false);
    failures.delete('handoff');
    await phone.getByRole('button', { name: '11:00 交接到 Mac' }).click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('11:00 已交接');
    expect(commands.at(-1)).toEqual({ command: 'handoff', body: { runId: 'run-fixture-1', slot: '11:00' } });
    expect(control.worker?.slots[1]?.active).toBe(true);
    expect(await phone.getByRole('button', { name: '11:00 交接到 Mac' }).isDisabled()).toBe(true);
    failures.add('stop');
    await phone.locator('#control-stop').click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('stop 未完成');
    expect(control.worker?.automationStopped).toBe(false);
    expect(await phone.locator('#control-stop').isEnabled()).toBe(true);
    expect(phoneErrors).toEqual([]);
  } finally { await phoneContext.close(); }
}, 30_000);

it('requests notification permission only on the enable gesture and confirms subscription, test, and device unsubscribe responses', async () => {
  const { phone, phoneContext, phoneErrors } = await controlledPage(true);
  const pushCommands: Array<{ command: string; body: Record<string, unknown> }> = [];
  let testFailureStatus = 503;
  try {
    await phone.route(/\/api\/push\/[^/?]+$/, async (route) => {
      const command = new URL(route.request().url()).pathname.split('/').at(-1)!;
      pushCommands.push({ command, body: route.request().postDataJSON() as Record<string, unknown> });
      const status = command === 'test' ? testFailureStatus || 200 : 200;
      await route.fulfill({ status, json: status === 410 ? { error: '訂閱失效，請重新啟用通知。' } : status >= 400 ? { error: '推播暫時無法送出。' } : { ok: true } });
    });
    const notificationState = () => phone.evaluate(() => Reflect.get(window, 'pushFixture') as { permissionRequests: number; subscribed: boolean });
    await expect.poll(() => phone.locator('#push-enable').isEnabled()).toBe(true);
    expect((await notificationState()).permissionRequests).toBe(0);
    await phone.locator('#push-enable').click();
    await expect.poll(() => phone.locator('#push-feedback').textContent()).toContain('已啟用');
    expect((await notificationState()).permissionRequests).toBe(1);
    expect(pushCommands[0]).toMatchObject({ command: 'subscribe', body: { subscription: { endpoint: 'https://push.example/device-fixture' } } });
    await phone.locator('#push-test').click();
    await expect.poll(() => phone.locator('#push-feedback').textContent()).toBe('推播暫時無法送出。');
    testFailureStatus = 410;
    await phone.locator('#push-test').click();
    await expect.poll(() => phone.locator('#push-feedback').textContent()).toContain('訂閱失效');
    expect((await notificationState()).subscribed).toBe(false);
    expect(await phone.locator('#push-test').isVisible()).toBe(false);
    expect(await phone.locator('#push-enable').isEnabled()).toBe(true);
    await phone.locator('#push-enable').click();
    await expect.poll(() => phone.locator('#push-test').isVisible()).toBe(true);
    testFailureStatus = 0;
    await phone.locator('#push-test').click();
    await expect.poll(() => phone.locator('#push-feedback').textContent()).toContain('測試通知已送出');
    await phone.locator('#push-disable').click();
    await expect.poll(() => phone.locator('#push-feedback').textContent()).toContain('已停用');
    expect(pushCommands.at(-1)).toEqual({ command: 'unsubscribe', body: { endpoint: 'https://push.example/device-fixture' } });
    expect((await notificationState()).subscribed).toBe(false);
    expect(await phone.locator('#push-enable').isVisible()).toBe(true);
    expect(phoneErrors).toEqual([]);
  } finally { await phoneContext.close(); }
}, 30_000);

it('rolls back a rejected new push subscription, retries an unregistered device, and renews rotated VAPID keys only on an enable gesture', async () => {
  const { phone, phoneContext, pushSettings } = await controlledPage(true);
  let rejectSubscribe = true;
  try {
    await phone.route(/\/api\/push\/subscribe$/, (route) => route.fulfill({ status: rejectSubscribe ? 503 : 200, json: rejectSubscribe ? { error: '通知登記失敗。' } : { ok: true } }));
    const state = () => phone.evaluate(() => Reflect.get(window, 'pushFixture') as { permissionRequests: number; subscribed: boolean; subscribeCalls: number; unsubscribeCalls: number });
    await expect.poll(() => phone.locator('#push-enable').isEnabled()).toBe(true);
    await phone.locator('#push-enable').click();
    await expect.poll(() => phone.locator('#push-feedback').textContent()).toBe('通知登記失敗。');
    expect((await state()).subscribed).toBe(false);
    expect((await state()).unsubscribeCalls).toBe(1);
    expect(await phone.locator('#push-test').isVisible()).toBe(false);
    expect(await phone.locator('#push-enable').isVisible()).toBe(true);
    rejectSubscribe = false;
    await phone.locator('#push-enable').click();
    await expect.poll(() => phone.locator('#push-test').isVisible()).toBe(true);
    rejectSubscribe = true;
    await phone.locator('#refresh').click();
    await expect.poll(() => phone.locator('#push-copy').textContent()).toContain('尚未成功登記');
    expect(await phone.locator('#push-enable').isVisible()).toBe(true);
    expect((await state()).subscribed).toBe(true);
    rejectSubscribe = false;
    await phone.locator('#push-enable').click();
    await expect.poll(() => phone.locator('#push-test').isVisible()).toBe(true);
    pushSettings.publicKey = 'cm90YXRlZA';
    await phone.locator('#refresh').click();
    await expect.poll(() => phone.locator('#push-copy').textContent()).toContain('金鑰已更新');
    expect((await state()).unsubscribeCalls).toBe(1);
    await phone.locator('#push-enable').click();
    await expect.poll(() => phone.locator('#push-feedback').textContent()).toContain('已啟用');
    expect((await state()).subscribeCalls).toBe(3);
    expect((await state()).unsubscribeCalls).toBe(2);
    expect((await state()).permissionRequests).toBe(1);
  } finally { await phoneContext.close(); }
}, 30_000);

it('never sends controls to an external run or a replacement run, and does not invent missing settings', async () => {
  const { phone, phoneContext, control, commands } = await controlledPage();
  try {
    control.externalRun = true;
    await phone.locator('#refresh').click();
    await expect.poll(() => phone.locator('#control-note').textContent()).toContain('原終端機');
    expect(await phone.locator('#control-start').isDisabled()).toBe(true);
    expect(await phone.locator('#setting-date').isDisabled()).toBe(true);
    control.externalRun = false;
    await phone.locator('#refresh').click();
    await expect.poll(() => phone.locator('#control-start').isEnabled()).toBe(true);
    await phone.locator('#control-start').click();
    await expect.poll(() => phone.locator('#control-close').isEnabled()).toBe(true);
    control.worker!.runId = 'replacement-run';
    const commandCount = commands.length;
    await phone.locator('#control-close').click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('狀態已變更');
    expect(commands.length).toBe(commandCount);
    await phone.route(/\/api\/control$/, (route) => route.fulfill({ json: { enabled: false, demo: false, busy: false, settings: null, profiles: [], worker: null, externalRun: false, error: '請在 Mac 準備本機搶位設定。' } }));
    await phone.locator('#refresh').click();
    await expect.poll(() => phone.locator('#control-note').textContent()).toContain('準備本機');
    expect(await phone.locator('#control-save').isDisabled()).toBe(true);
    expect(await phone.locator('#control-start').isDisabled()).toBe(true);
  } finally { await phoneContext.close(); }
}, 30_000);

it('keeps Mac handoff, stop, and close usable for an active worker when local settings become unreadable', async () => {
  const { phone, phoneContext, control } = await controlledPage();
  try {
    await phone.locator('#control-start').click();
    await expect.poll(() => phone.getByRole('button', { name: '11:00 交接到 Mac' }).isEnabled()).toBe(true);
    await phone.route(/\/api\/control$/, (route) => route.fulfill({ json: {
      ...control, settings: null, profiles: [], error: '本機搶位設定無法讀取。',
    } }));
    await phone.locator('#refresh').click();
    await expect.poll(() => phone.locator('#control-note').textContent()).toContain('仍可交接、停止或結束');
    expect(await phone.locator('#setting-date').isDisabled()).toBe(true);
    expect(await phone.locator('#control-start').isDisabled()).toBe(true);
    expect(await phone.locator('#control-save').isDisabled()).toBe(true);
    expect(await phone.locator('#control-stop').isEnabled()).toBe(true);
    expect(await phone.locator('#control-close').isEnabled()).toBe(true);
    await phone.getByRole('button', { name: '11:00 交接到 Mac' }).click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('11:00 已交接');
    expect(control.worker?.slots[1]?.active).toBe(true);
    await phone.locator('#control-stop').click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('頁面保留');
    expect(await phone.locator('#control-close').isEnabled()).toBe(true);
    await phone.locator('#control-close').click();
    await expect.poll(() => phone.locator('#control-feedback').textContent()).toContain('瀏覽器已結束');
    expect(control.worker?.closed).toBe(true);
    expect(await phone.locator('#setting-date').isDisabled()).toBe(true);
  } finally { await phoneContext.close(); }
}, 30_000);

it('shows push reminders and opens only the same-origin control page on notification clicks', async () => {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const notifications: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  let focused = false;
  let closed = false;
  let clients: Array<{ url: string; navigate: (url: string) => Promise<void>; focus: () => Promise<void> }> = [];
  runInNewContext(await readFile(new URL('../web/monitor/sw.js', import.meta.url), 'utf8'), {
    URL, self: {
      location: { origin }, addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => listeners.set(name, handler),
      registration: { showNotification: async (title: string, options: Record<string, unknown>) => { notifications.push({ title, options }); } },
      clients: { matchAll: async () => clients, openWindow: async (url: string) => { opened.push(url); } },
    },
  });
  let work = Promise.resolve();
  listeners.get('push')!({ data: { json: () => ({ title: '11:00 已暫留', body: '請到 Mac 填單付款。', tag: 'one-hold', url: 'https://unexpected.example' }) }, waitUntil: (value: Promise<void>) => { work = value; } });
  await work;
  expect(notifications).toEqual([{ title: '11:00 已暫留', options: expect.objectContaining({ body: '請到 Mac 填單付款。', tag: 'one-hold', data: { url: '/' } }) }]);
  const click = { notification: { close: () => { closed = true; }, data: { url: 'https://unexpected.example' } }, waitUntil: (value: Promise<void>) => { work = value; } };
  listeners.get('notificationclick')!(click);
  await work;
  expect(closed).toBe(true);
  expect(opened).toEqual([`${origin}/`]);
  clients = [{ url: `${origin}/old`, navigate: async (url) => { navigated.push(url); }, focus: async () => { focused = true; } }];
  listeners.get('notificationclick')!(click);
  await work;
  expect(navigated).toEqual([`${origin}/`]);
  expect(focused).toBe(true);
});

afterAll(async () => {
  await context?.close();
  await browser?.close();
  if (server?.listening) await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  await diagnostics?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 30_000);

it('shows sanitized live events on a phone, remembers login, recovers offline and upstream errors, and revokes logout without caching private data', async () => {
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  expect((await context.request.get(`${origin}/api/status`)).status()).toBe(401);
  await page.locator('#password').fill('wrong-password');
  await page.locator('#login-submit').click();
  await expect.poll(() => page.locator('#login-feedback').textContent()).toContain('無法登入');
  await page.locator('#password').fill(password);
  await page.locator('#login-submit').click();
  await expect.poll(() => page.locator('.slot-card').count()).toBe(2);
  expect(await page.locator('.attempts').allTextContents()).toEqual(['12', '9']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.locator('#status-view').isVisible()).toBe(true);
  await expect.poll(() => page.locator('.slot-card').count()).toBe(2);
  diagnostics.event('availability-detected', { status: 'available', responseMs: 384 }, '11:00');
  diagnostics.event('reservation_action_started', { attempt: 12 }, '11:00');
  diagnostics.event('customer-form-ready', {}, '11:00');
  diagnostics.event('monitor_heartbeat', { automationActive: true });
  await diagnostics.writeJson('fixture-flush', {});
  await source.refresh();
  await expect.poll(() => page.locator('.phase-badge').first().textContent()).toBe('已暫留');
  expect(await page.locator('.phase-description').first().textContent()).toContain('尚未完成預約');
  if (process.env.MONITOR_SCREENSHOT_DIR) {
    await mkdir(process.env.MONITOR_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.MONITOR_SCREENSHOT_DIR, 'monitor-phone.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: join(process.env.MONITOR_SCREENSHOT_DIR, 'monitor-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await context.setOffline(true);
  await expect.poll(() => page.locator('#connection-title').textContent()).toContain('離線');
  await expect.poll(() => page.locator('.phase-badge').first().textContent()).toBe('最後：已暫留');
  await context.setOffline(false);
  await expect.poll(() => page.locator('.phase-badge').first().textContent()).toBe('已暫留');
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    return (await Promise.all(keys.map(async (key) => (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname)))).flat();
  });
  expect(cached).toContain('/app.js');
  expect(cached.some((path) => path.startsWith('/api/'))).toBe(false);
  // Funnel's empty 502 is an HTTP response, unlike the rejected fetch when offline.
  // A reload must retain the cached shell, explain the outage, and leave APIs uncached.
  upstreamUnavailable = true;
  const fallback = await page.reload({ waitUntil: 'domcontentloaded' });
  expect(fallback?.status()).toBe(200);
  await expect.poll(() => page.locator('#login-feedback').textContent()).toContain('暫時無法連到 Mac');
  expect(await page.locator('#login-view').isVisible()).toBe(true);
  expect((await context.request.get(`${origin}/api/session`)).status()).toBe(502);
  expect(await page.evaluate(async () => {
    const shell = await caches.match('/');
    return shell ? { status: shell.status, html: await shell.text() } : null;
  })).toMatchObject({ status: 200, html: expect.stringContaining('login-view') });
  expect(await page.evaluate(async () => Boolean(await caches.match('/api/session')))).toBe(false);
  upstreamUnavailable = false;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.locator('.phase-badge').first().textContent()).toBe('已暫留');
  await page.locator('#logout').click();
  await expect.poll(() => page.locator('#login-feedback').textContent()).toBe('已登出。');
  expect(await page.locator('.slot-card').count()).toBe(0);
  expect((await context.request.get(`${origin}/api/status`)).status()).toBe(401);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.locator('#login-view').isVisible()).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);
