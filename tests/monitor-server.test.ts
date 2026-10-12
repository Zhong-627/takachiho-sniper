import { scryptSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMonitorServer, type MonitorServerOptions } from '../src/monitor-server.js';
import { MonitorState } from '../src/monitor-state.js';

const password = 'Test-monitor-password-2026';
const salt = 'abcd'.repeat(8);
const credential = { salt, passwordHash: scryptSync(password, salt, 64).toString('hex') };
const servers: Server[] = [];
const directories: string[] = [];
const controllers: AbortController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function start(extra: Partial<MonitorServerOptions> = {}): Promise<{ server: Server; url: string }> {
  const webDir = await mkdtemp(join(tmpdir(), 'takachiho-monitor-server-'));
  directories.push(webDir);
  await mkdir(join(webDir, 'icons'));
  await Promise.all([
    writeFile(join(webDir, 'index.html'), '<!doctype html><title>Monitor shell</title>'),
    writeFile(join(webDir, 'app.js'), 'console.log("shell");'),
    writeFile(join(webDir, 'sw.js'), '/* cache only shell */'),
    writeFile(join(webDir, 'icons/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    writeFile(join(webDir, 'private.json'), '{"secret":"DO-NOT-SERVE"}'),
  ]);
  const server = createMonitorServer({
    credential, snapshot: () => new MonitorState('test-run').snapshot(), secureCookies: false, webDir, ...extra,
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

async function signIn(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await post(url, '/api/login', { password }, headers);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ authenticated: true });
  const cookie = response.headers.get('set-cookie');
  expect(cookie).toMatch(/HttpOnly; SameSite=Strict; Max-Age=2592000/u);
  if (!cookie) throw new Error('Missing test cookie');
  return cookie.split(';')[0] as string;
}

async function rawGet(url: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = httpRequest({ hostname: parsed.hostname, port: parsed.port, path, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function stream(url: string, cookie: string): Promise<{ response: Response; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`${url}/api/events`, { headers: { Cookie: cookie }, signal: controller.signal });
  if (!response.body) throw new Error('Missing test stream');
  return { response, reader: response.body.getReader() };
}

describe('monitoring authentication', () => {
  it('keeps the shell public while protecting all booking status and never caching API responses', async () => {
    const { url } = await start();
    const shell = await fetch(url);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('Monitor shell');
    expect(shell.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(shell.headers.get('content-security-policy')).toContain("worker-src 'self'");
    expect(shell.headers.get('x-takachiho-monitor')).toBe('1');
    expect(shell.headers.get('x-takachiho-monitor-transport')).toBe('local');
    for (const path of ['/api/status', '/api/events']) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe('Cookie');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(await response.text()).not.toContain('slots');
    }
    expect(await (await fetch(`${url}/api/session`)).json()).toEqual({ authenticated: false });
    const failure = await post(url, '/api/login', { password: 'wrong-secret' });
    expect(failure.status).toBe(401);
    expect(await failure.json()).toEqual({ error: 'Unable to sign in' });
    expect(failure.headers.get('set-cookie')).toBeNull();
    const cookie = await signIn(url);
    expect(await (await fetch(`${url}/api/session`, { headers: { Cookie: cookie } })).json()).toEqual({ authenticated: true });
    const status = await fetch(`${url}/api/status`, { headers: { Cookie: cookie } });
    expect(await status.json()).toMatchObject({ schemaVersion: 1, connection: 'waiting', run: null, slots: [] });
    expect(await (await fetch(`${url}/api/session`, { headers: { Cookie: `${cookie}; ${cookie}` } })).json()).toEqual({ authenticated: false });
  });

  it('uses secure cookies for the configured public origin and rejects cross-origin or originless writes', async () => {
    const publicOrigin = 'https://monitor.test.ts.net';
    const { url } = await start({ secureCookies: true, expectedOrigin: publicOrigin });
    const success = await post(url, '/api/login', { password }, { Origin: publicOrigin });
    expect(success.status).toBe(200);
    expect(success.headers.get('set-cookie')).toContain('; Secure');
    expect(success.headers.get('x-takachiho-monitor-transport')).toBe('https');
    for (const origin of ['https://evil.test', 'null', `${publicOrigin}/`, 'http://monitor.test.ts.net']) {
      const response = await post(url, '/api/login', { password }, { Origin: origin, 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'https' });
      expect(response.status).toBe(403);
    }
    const originless = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    expect(originless.status).toBe(403);
  });

  it('checks exact Host and protocol while preventing non-loopback hosts in local HTTP mode', async () => {
    const { url } = await start();
    expect((await rawGet(url, '/api/session', { Host: 'public.example.test' })).status).toBe(403);
    const foreign = await post(url, '/api/login', { password }, { Origin: 'http://localhost:1234' });
    expect(foreign.status).toBe(403);
    const { url: secureUrl } = await start({ secureCookies: true });
    const cookie = await signIn(secureUrl, { Origin: secureUrl.replace('http:', 'https:') });
    expect(cookie).toMatch(/^takachiho_monitor_session=[A-Za-z0-9_-]{43}$/u);
    expect((await post(secureUrl, '/api/logout', {}, { Origin: secureUrl, Cookie: cookie })).status).toBe(403);
  });

  it('expires sessions after thirty days and revokes them on logout', async () => {
    let clock = 1_000_000;
    const { url } = await start({ now: () => clock });
    const cookie = await signIn(url);
    const logout = await post(url, '/api/logout', {}, { Cookie: cookie });
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await logout.json()).toEqual({ authenticated: false });
    expect((await fetch(`${url}/api/status`, { headers: { Cookie: cookie } })).status).toBe(401);
    const nextCookie = await signIn(url);
    expect(nextCookie).not.toBe(cookie);
    clock += 30 * 24 * 60 * 60 * 1000;
    expect(await (await fetch(`${url}/api/session`, { headers: { Cookie: nextCookie } })).json()).toEqual({ authenticated: false });
    expect((await fetch(`${url}/api/status`, { headers: { Cookie: nextCookie } })).status).toBe(401);
  });

  it('globally limits login attempts even when clients forge proxy headers', async () => {
    let clock = 1_000_000;
    const { url } = await start({ now: () => clock });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await post(url, '/api/login', { password: 'incorrect' }, { 'X-Forwarded-For': `192.0.2.${attempt}` })).status).toBe(401);
    }
    const throttled = await post(url, '/api/login', { password }, { 'X-Forwarded-For': '198.51.100.1' });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('60');
    clock += 60_000;
    await signIn(url);
  });

  it('bounds concurrent unfinished login bodies instead of queuing unlimited scrypt work', async () => {
    const { url } = await start();
    const parsed = new URL(url);
    const pending = [0, 1].map(() => {
      const request = httpRequest({
        hostname: parsed.hostname, port: parsed.port, path: '/api/login', method: 'POST',
        headers: { Origin: url, 'Content-Type': 'application/json', 'Content-Length': '100' },
      });
      request.on('error', () => undefined);
      request.flushHeaders();
      request.write('{');
      return request;
    });
    try {
      // Synchronize on a request completed by the same server, after headers have
      // arrived; neither unfinished body is allowed to start password derivation.
      await fetch(`${url}/api/session`);
      expect((await post(url, '/api/login', { password })).status).toBe(429);
    } finally { for (const request of pending) request.destroy(); }
  });
});

describe('monitoring route boundaries', () => {
  it('serves only fixed shell assets and rejects file paths, encoded traversal, queries and control routes', async () => {
    const { url } = await start();
    for (const path of ['/private.json', '/config.local.json', '/artifacts/events.jsonl', '/../index.html', '/%2e%2e/index.html', '/icons/../index.html', '/api/stop', '/api/login?password=DO-NOT-SERVE', '/__proto__']) {
      const response = await rawGet(url, path);
      expect(response.status, path).toBe(404);
      expect(response.body).not.toContain('DO-NOT-SERVE');
    }
    expect((await fetch(`${url}/icons/icon.svg`)).status).toBe(200);
    const head = await fetch(`${url}/app.js`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await fetch(`${url}/api/login`)).status).toBe(405);
    expect((await post(url, '/api/status', {})).status).toBe(405);
  });

  it('requires bounded JSON request bodies and returns generic errors', async () => {
    const { url } = await start();
    const incorrectType = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { Origin: url, 'Content-Type': 'text/plain' }, body: password,
    });
    expect(incorrectType.status).toBe(415);
    const malformed = await fetch(`${url}/api/login`, {
      method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: '{private',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toBe('{"error":"Request rejected"}');
    expect((await post(url, '/api/login', { password: 'x'.repeat(5000) })).status).toBe(413);
    expect((await post(url, '/api/login', ['not', 'an', 'object'])).status).toBe(400);
    expect((await post(url, '/api/logout', {})).status).toBe(200);
  });

  it('validates credentials and configured origins without reflecting their values', () => {
    const common = { snapshot: () => new MonitorState('test').snapshot() };
    expect(() => createMonitorServer({ ...common, credential: { salt: '', passwordHash: '' } })).toThrow('Invalid monitoring credential');
    for (const expectedOrigin of ['http://monitor.test', 'https://monitor.test/path', 'https://user:secret@monitor.test', 'private-secret']) {
      expect(() => createMonitorServer({ ...common, credential, expectedOrigin })).toThrow('Monitoring public origin must be an HTTPS origin');
    }
  });

  it('keeps snapshot failures generic and bounds status payloads before streaming', async () => {
    let oversized = false;
    const { url } = await start({ snapshot: () => {
      if (!oversized) throw new Error('PRIVATE-FILESYSTEM-PATH');
      return { ...new MonitorState('test').snapshot(), recentEvents: [{ at: 1, slot: null, label: 'x'.repeat(300_000) }] };
    } });
    const cookie = await signIn(url);
    for (const path of ['/api/status', '/api/events']) {
      const response = await fetch(`${url}${path}`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"Request rejected"}');
    }
    oversized = true;
    expect((await fetch(`${url}/api/events`, { headers: { Cookie: cookie } })).status).toBe(500);
  });
});

describe('monitoring streams', () => {
  it('sends an initial full snapshot, closes at authentication expiry and keeps HTTP shutdown finite', async () => {
    let clock = 1_000_000;
    const state = new MonitorState('stream-test');
    const { url, server } = await start({ now: () => clock, snapshot: () => state.snapshot(clock) });
    const cookie = await signIn(url);
    const { response, reader } = await stream(url, cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const initial = new TextDecoder().decode((await reader.read()).value);
    expect(initial).toContain('event: status\n');
    expect(JSON.parse(initial.split('data: ')[1] as string)).toEqual(state.snapshot(clock));
    clock += 1000;
    const update = new TextDecoder().decode((await reader.read()).value);
    expect(JSON.parse(update.split('data: ')[1] as string)).toEqual(state.snapshot(clock));
    clock += 30 * 24 * 60 * 60 * 1000;
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: unauthenticated');
    expect((await reader.read()).done).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('revokes open streams on logout and removes disconnected clients from the thirty-client bound', async () => {
    const { url, server } = await start();
    const cookie = await signIn(url);
    const active = await Promise.all(Array.from({ length: 30 }, () => stream(url, cookie)));
    for (const client of active) expect(client.response.status).toBe(200);
    const rejected = await fetch(`${url}/api/events`, { headers: { Cookie: cookie } });
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({ error: 'Try again later' });
    for (const client of active) await client.reader.read();
    const disconnected = active.pop();
    await disconnected?.reader.cancel();
    await fetch(`${url}/api/session`);
    const reconnected = await stream(url, cookie);
    expect(reconnected.response.status).toBe(200);
    await reconnected.reader.read();
    active.push(reconnected);
    const logout = await post(url, '/api/logout', {}, { Cookie: cookie });
    expect(logout.status).toBe(200);
    for (const client of active) {
      expect(new TextDecoder().decode((await client.reader.read()).value)).toContain('event: unauthenticated');
      expect((await client.reader.read()).done).toBe(true);
    }
    const nextCookie = await signIn(url);
    const replacement = await stream(url, nextCookie);
    expect(replacement.response.status).toBe(200);
    await replacement.reader.read();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect((await replacement.reader.read()).done).toBe(true);
  });
});
