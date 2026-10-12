import { scryptSync } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDiagnostics, type Diagnostics } from '../src/diagnostics.js';
import { ArtifactsMonitor } from '../src/monitor-source.js';
import { createMonitorServer } from '../src/monitor-server.js';

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
