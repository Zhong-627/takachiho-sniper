import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGuardedContext, type GuardOptions, type ReservationPlan } from '../src/safety.js';

// Local fixtures only. No test contacts eipro, reserves a slot, or reads personal data.
describe('browser safety guard against accidental side effects', () => {
  let browser: Browser;
  let server: Server;
  let origin: string;
  const received: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      received.push(`${req.method} ${req.url}`);
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/redirect-stage' }); res.end();
      } else if (req.url === '/redirect-stage') {
        res.writeHead(302, { location: '/unsafe-redirect' }); res.end();
      } else if (req.url === '/calendar') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html><head><title>Local calendar</title></head><body>Read-only fixture</body></html>');
      } else if (req.url?.startsWith('/hold')) {
        const result = new URL(req.url, 'http://localhost').searchParams.get('result') ?? '1';
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: { result: result === 'numeric' ? 1 : result } }));
      } else {
        res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Customer fixture</title><input name="customer">');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server address missing.');
    origin = `http://127.0.0.1:${address.port}`;
    const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  function options(mode: GuardOptions['mode'] = 'rehearsal'): GuardOptions {
    return {
      mode, confirmed: mode === 'live' || mode === 'full-rehearsal', origin,
      readRules: [
        { pathname: '/calendar', method: 'GET' },
        { pathname: '/redirect', method: 'GET' },
        { pathname: '/redirect-stage', method: 'GET' },
      ],
      holdPath: '/hold', customerPath: '/orders',
    };
  }

  it('blocks unknown GET, POST, sendBeacon, iframe, image and popup requests before server dispatch', async () => {
    received.length = 0;
    const { context } = await createGuardedContext(browser, {}, options());
    try {
      const page = await context.newPage();
      await page.goto(origin + '/calendar');
      await page.evaluate(async () => {
        const calls = [fetch('/unsafe-get'), fetch('/unsafe-post', { method: 'POST', body: 'hold=true' })];
        navigator.sendBeacon('/unsafe-beacon', 'hold=true');
        const iframe = document.createElement('iframe'); iframe.src = '/unsafe-frame'; document.body.append(iframe);
        const img = document.createElement('img'); img.src = '/unsafe-image'; document.body.append(img);
        window.open('/unsafe-popup');
        await Promise.allSettled(calls);
      });
      await page.waitForTimeout(200);
      expect(received.filter(item => item.includes('unsafe'))).toEqual([]);
      expect(received).toContain('GET /calendar');
    } finally { await context.close(); }
  });

  it('checks every redirect hop and aborts before an unverified destination is requested', async () => {
    received.length = 0;
    const { context } = await createGuardedContext(browser, {}, options());
    try {
      const page = await context.newPage();
      await page.goto(origin + '/redirect').catch(() => undefined);
      expect(received).toEqual(['GET /redirect', 'GET /redirect-stage']);
    } finally { await context.close(); }
  });

  it('blocks automatic GET form submissions and service-worker registration', async () => {
    received.length = 0;
    const { context } = await createGuardedContext(browser, {}, options('inspect'));
    try {
      const page = await context.newPage();
      await page.goto(origin + '/calendar');
      await page.evaluate(async () => {
        await navigator.serviceWorker.register('/unsafe-worker.js').catch(() => undefined);
        const form = document.createElement('form'); form.action = '/unsafe-form'; form.method = 'GET'; document.body.append(form); form.submit();
      });
      await page.waitForTimeout(200).catch(() => undefined);
      expect(received.filter(item => item.includes('unsafe'))).toEqual([]);
    } finally { await context.close(); }
  });

  it('allows exactly one armed hold and customer page, keeping payment blocked through autofill', async () => {
    received.length = 0;
    const { context, guard } = await createGuardedContext(browser, {}, options('live'));
    try {
      const page = await context.newPage();
      await page.goto(origin + '/calendar');
      const body = 'slot=10%3A00';
      const plan: ReservationPlan = { slotKey: '10:00', hold: { url: origin + '/hold', method: 'POST', body, contentType: 'application/x-www-form-urlencoded' }, customerNavigation: { url: origin + '/orders?slot=10%3A00', method: 'GET', body: null } };
      guard.armReservation(plan);
      const attemptHold = () => page.evaluate(async value => {
        try { const response = await fetch('/hold', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: value }); return response.ok; } catch { return false; }
      }, body);
      expect(await attemptHold()).toBe(true);
      expect(await attemptHold()).toBe(false);
      await page.goto(plan.customerNavigation.url);
      await page.locator('input[name="customer"]').fill('LOCAL TEST');
      await expect(page.locator('input[name="customer"]').inputValue()).resolves.toBe('LOCAL TEST');
      const paymentAllowed = await page.evaluate(async () => {
        try { await fetch('/orders', { method: 'POST', body: 'payment=true' }); return true; } catch { return false; }
      });
      expect(paymentAllowed).toBe(false);
      expect(received.filter(item => item.startsWith('POST /hold'))).toHaveLength(1);
      expect(received.filter(item => item.startsWith('POST /orders'))).toHaveLength(0);
      expect(guard.state.customerDispatched).toBe(true);
      await guard.handoffToHuman(context);
      expect(guard.state.handedOff).toBe(true);
      expect(() => guard.assertCanReserve()).toThrow('ended');
      // Deliberate terminal handoff permits the human's ordinary final confirmation.
      expect(await page.evaluate(async () => (await fetch('/orders', { method: 'POST', body: 'local-human-fixture=true' })).ok)).toBe(true);
    } finally { await context.close(); }
  });

  it('permits terminal human takeover before hold only in explicitly authorized modes', async () => {
    const safe = await createGuardedContext(browser, {}, options('rehearsal'));
    const authorized = await createGuardedContext(browser, {}, options('live'));
    try {
      await expect(safe.guard.handoffToHuman(safe.context)).rejects.toThrow('--confirm-reservation-side-effects');
      expect(safe.guard.state.handedOff).toBe(false);
      await authorized.guard.handoffToHuman(authorized.context);
      expect(authorized.guard.state).toEqual({ holdDispatched: false, holdConfirmed: false, customerDispatched: false, handedOff: true });
      expect(() => authorized.guard.assertCanReserve()).toThrow('ended');
    } finally {
      await safe.context.close();
      await authorized.context.close();
    }
  });

  it.each(['9', '0', 'unknown', 'numeric'])('blocks official customer redirect/navigation when hold result is %s', async (result) => {
    received.length = 0;
    const { context, guard } = await createGuardedContext(browser, {}, options('live'));
    try {
      const page = await context.newPage();
      await page.goto(origin + '/calendar');
      const holdPath = `/hold?result=${result}`;
      const plan: ReservationPlan = { slotKey: '10:00', hold: { url: origin + holdPath, method: 'POST', body: 'slot=10%3A00', contentType: 'application/x-www-form-urlencoded' }, customerNavigation: { url: origin + '/orders?slot=10%3A00', method: 'GET', body: null } };
      guard.armReservation(plan);
      await page.evaluate(async ({ path, body }) => {
        await fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      }, { path: holdPath, body: plan.hold.body ?? '' });
      await page.goto(plan.customerNavigation.url).catch(() => undefined);
      expect(guard.state.holdDispatched).toBe(true);
      expect(guard.state.holdConfirmed).toBe(false);
      expect(guard.state.customerDispatched).toBe(false);
      expect(received.filter(item => item.startsWith('GET /orders'))).toHaveLength(0);
    } finally { await context.close(); }
  });
});
