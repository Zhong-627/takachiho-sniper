import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MonitorSnapshot } from './monitor-state.js';
import { ControlFailure, type MonitorControl } from './monitor-control.js';
import { MonitorPushError, type MonitorPush } from './monitor-push.js';

export interface MonitorCredential {
  salt: string;
  passwordHash: string;
}

export interface MonitorServerOptions {
  credential: MonitorCredential;
  snapshot: () => MonitorSnapshot;
  webDir?: string;
  secureCookies?: boolean;
  /** Explicit public HTTPS origin, when a trusted reverse proxy rewrites Host. */
  expectedOrigin?: string;
  now?: () => number;
  control?: MonitorControl;
  push?: MonitorPush;
}

const SESSION_COOKIE = 'takachiho_monitor_session';
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;
const MAX_STREAMS = 30;
const MAX_BODY_BYTES = 4096;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const LOGIN_BURST = 8;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_IN_FLIGHT = 2;

const ASSETS: Readonly<Record<string, { file: string; contentType: string }>> = Object.freeze({
  '/': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', contentType: 'text/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', contentType: 'text/css; charset=utf-8' },
  '/manifest.webmanifest': { file: 'manifest.webmanifest', contentType: 'application/manifest+json; charset=utf-8' },
  '/sw.js': { file: 'sw.js', contentType: 'text/javascript; charset=utf-8' },
  '/icons/icon.svg': { file: 'icons/icon.svg', contentType: 'image/svg+xml' },
  '/icons/icon-192.png': { file: 'icons/icon-192.png', contentType: 'image/png' },
  '/icons/icon-512.png': { file: 'icons/icon-512.png', contentType: 'image/png' },
});

class RequestFailure extends Error {
  constructor(readonly status: number) { super('Request rejected'); }
}

function securityHeaders(response: ServerResponse, secure: boolean): void {
  response.setHeader('X-Takachiho-Monitor', '1');
  response.setHeader('X-Takachiho-Monitor-Transport', secure ? 'https' : 'local');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vary', 'Cookie');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'",
    "connect-src 'self'", "font-src 'self'", "manifest-src 'self'", "worker-src 'self'",
    "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; '));
  if (secure) response.setHeader('Strict-Transport-Security', 'max-age=86400');
}

function reply(response: ServerResponse, status: number, data: Record<string, unknown>): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

function sessionToken(request: IncomingMessage): string | undefined {
  const matches = (request.headers.cookie ?? '').split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return undefined;
  const token = matches[0]?.slice(SESSION_COOKIE.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : undefined;
}

function sameOrigin(request: IncomingMessage, secure: boolean, expectedOrigin?: string): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host || Array.isArray(origin)) return false;
  try {
    const candidate = new URL(origin);
    if (candidate.origin !== origin) return false;
    return origin === (expectedOrigin ?? new URL(`${secure ? 'https' : 'http'}://${host}`).origin);
  } catch { return false; }
}

function isLoopbackHost(host: string | undefined): boolean {
  return !!host && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/iu.test(host);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '')) {
    throw new RequestFailure(415);
  }
  const declaredLength = request.headers['content-length'];
  if (declaredLength && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
    throw new RequestFailure(413);
  }
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const timer = setTimeout(() => finish(new RequestFailure(408)), 5000);
    timer.unref();
    const cleanup = (): void => {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAbort);
      request.off('error', onAbort);
    };
    const finish = (error?: RequestFailure): void => {
      if (done) return;
      done = true;
      cleanup();
      if (error) { request.resume(); reject(error); }
      else resolve(Buffer.concat(chunks, length));
    };
    const onData = (chunk: Buffer): void => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) finish(new RequestFailure(413));
      else chunks.push(chunk);
    };
    const onEnd = (): void => finish();
    const onAbort = (): void => finish(new RequestFailure(400));
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('aborted', onAbort);
    request.on('error', onAbort);
  });
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid object');
    return parsed as Record<string, unknown>;
  } catch { throw new RequestFailure(400); }
}

function passwordMatches(password: string, credential: MonitorCredential): Promise<boolean> {
  return new Promise((resolve, reject) => {
    scrypt(password, credential.salt, 64, (error, derived) => {
      if (error) { reject(error); return; }
      resolve(timingSafeEqual(derived, Buffer.from(credential.passwordHash, 'hex')));
    });
  });
}

/** Authenticated status/control service; the caller listens only on loopback. */
export function createMonitorServer(options: MonitorServerOptions): Server {
  if (!/^[a-f0-9]{32,128}$/iu.test(options.credential.salt)
    || !/^[a-f0-9]{128}$/iu.test(options.credential.passwordHash)) {
    throw new Error('Invalid monitoring credential');
  }
  const secure = options.secureCookies ?? true;
  if (options.expectedOrigin) {
    let valid = false;
    try {
      const origin = new URL(options.expectedOrigin);
      valid = secure && origin.protocol === 'https:' && origin.origin === options.expectedOrigin;
    } catch { /* Reject non-origin values without exposing their contents. */ }
    if (!valid) throw new Error('Monitoring public origin must be an HTTPS origin');
  }
  const now = options.now ?? Date.now;
  const webDir = options.webDir ?? fileURLToPath(new URL('../web/monitor/', import.meta.url));
  const sessions = new Map<string, number>();
  const clients = new Map<ServerResponse, string>();
  let loginTokens = LOGIN_BURST;
  let lastRefill = now();
  let loginsInFlight = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const validSession = (token: string | undefined): boolean => {
    if (!token) return false;
    const expires = sessions.get(token);
    if (expires === undefined) return false;
    if (expires <= now()) { sessions.delete(token); return false; }
    return true;
  };
  const pruneSessions = (): void => {
    for (const [token, expires] of sessions) if (expires <= now()) sessions.delete(token);
  };
  const clearTickerIfIdle = (): void => {
    if (!clients.size && ticker) { clearInterval(ticker); ticker = undefined; }
  };
  const removeClient = (response: ServerResponse): void => {
    clients.delete(response);
    clearTickerIfIdle();
  };
  const stopClients = (): void => {
    if (ticker) { clearInterval(ticker); ticker = undefined; }
    for (const response of clients.keys()) response.end();
    clients.clear();
  };
  const statusPayload = (): string => {
    const payload = JSON.stringify(options.snapshot());
    if (Buffer.byteLength(payload) > MAX_SNAPSHOT_BYTES) throw new Error('Status too large');
    return payload;
  };
  const sendStatus = (response: ServerResponse, payload: string): void => {
    if (response.destroyed || response.writableEnded) { removeClient(response); return; }
    if (!response.write(`event: status\ndata: ${payload}\n\n`)) {
      // A slow phone must not grow an unbounded response queue or block booking.
      removeClient(response);
      response.destroy();
    }
  };
  const tick = (): void => {
    try {
      for (const [response, token] of clients) {
        if (!validSession(token)) {
          response.end('event: unauthenticated\ndata: {}\n\n');
          removeClient(response);
        }
      }
      if (clients.size) {
        const payload = statusPayload();
        for (const response of clients.keys()) sendStatus(response, payload);
      }
    } catch {
      for (const response of clients.keys()) response.destroy();
      clients.clear();
      clearTickerIfIdle();
    }
  };
  const sessionCookie = (token: string, expire = false): string => [
    `${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${expire ? 0 : SESSION_LIFETIME_MS / 1000}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
  const allowLogin = (): boolean => {
    const timestamp = now();
    loginTokens = Math.min(LOGIN_BURST, loginTokens + Math.max(0, timestamp - lastRefill) * LOGIN_BURST / LOGIN_WINDOW_MS);
    lastRefill = Math.max(timestamp, lastRefill);
    if (loginTokens < 1 || loginsInFlight >= MAX_LOGIN_IN_FLIGHT) return false;
    loginTokens -= 1;
    return true;
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    securityHeaders(response, secure);
    if (!secure && !isLoopbackHost(request.headers.host)) {
      reply(response, 403, { error: 'Request rejected' }); return;
    }
    const path = request.url ?? '';
    // Match raw paths against a fixed allowlist. No decoding, traversal, arbitrary
    // file serving, or password/query URL handling is part of this service.
    if (path.includes('?') || path.includes('#')) { reply(response, 404, { error: 'Not found' }); return; }
    const apiMethods: Readonly<Record<string, string>> = {
      '/api/session': 'GET', '/api/status': 'GET', '/api/events': 'GET',
      '/api/login': 'POST', '/api/logout': 'POST',
      ...(options.control ? {
        '/api/control': 'GET', '/api/control/settings': 'POST', '/api/control/start': 'POST',
        '/api/control/stop': 'POST', '/api/control/handoff': 'POST', '/api/control/close': 'POST',
      } : {}),
      '/api/push': 'GET',
      ...(options.push ? {
        '/api/push/subscribe': 'POST', '/api/push/unsubscribe': 'POST', '/api/push/test': 'POST', '/api/push/stop': 'POST',
      } : {}),
    };
    const requiredMethod = apiMethods[path];
    const asset = Object.hasOwn(ASSETS, path) ? ASSETS[path] : undefined;
    if (!requiredMethod && !asset) { reply(response, 404, { error: 'Not found' }); return; }
    if (requiredMethod ? request.method !== requiredMethod : !['GET', 'HEAD'].includes(request.method ?? '')) {
      response.setHeader('Allow', requiredMethod ?? 'GET, HEAD');
      reply(response, 405, { error: 'Method not allowed' }); return;
    }
    pruneSessions();
    const token = sessionToken(request);
    if (path === '/api/session') { reply(response, 200, { authenticated: validSession(token) }); return; }
    if (request.method === 'POST' && !sameOrigin(request, secure, options.expectedOrigin)) {
      reply(response, 403, { error: 'Request rejected' }); return;
    }
    if (path === '/api/login') {
      if (!allowLogin()) {
        response.setHeader('Retry-After', '60');
        reply(response, 429, { error: 'Try again later' }); return;
      }
      loginsInFlight += 1;
      try {
        const body = await jsonBody(request);
        const password = body.password;
        if (typeof password !== 'string' || !password || Buffer.byteLength(password) > MAX_BODY_BYTES
          || !await passwordMatches(password, options.credential)) {
          reply(response, 401, { error: 'Unable to sign in' }); return;
        }
        if (token) sessions.delete(token);
        while (sessions.size >= MAX_SESSIONS) {
          const oldest = sessions.keys().next().value;
          if (oldest) sessions.delete(oldest);
          else break;
        }
        const nextToken = randomBytes(32).toString('base64url');
        sessions.set(nextToken, now() + SESSION_LIFETIME_MS);
        response.setHeader('Set-Cookie', sessionCookie(nextToken));
        reply(response, 200, { authenticated: true });
      } finally { loginsInFlight -= 1; }
      return;
    }
    if (path === '/api/logout') {
      await jsonBody(request);
      if (token) {
        sessions.delete(token);
        for (const [client, clientToken] of clients) if (clientToken === token) {
          client.end('event: unauthenticated\ndata: {}\n\n');
          removeClient(client);
        }
      }
      response.setHeader('Set-Cookie', sessionCookie('', true));
      reply(response, 200, { authenticated: false }); return;
    }
    if (path.startsWith('/api/control') || path.startsWith('/api/push')) {
      if (!validSession(token)) { reply(response, 401, { error: 'Sign in required' }); return; }
      if (path === '/api/control' && options.control) {
        reply(response, 200, { ...await options.control.snapshot() }); return;
      }
      if (path === '/api/push') {
        reply(response, 200, options.push ? { ...options.push.status() } : { available: false, publicKey: '', reminders: [] }); return;
      }
      const body = await jsonBody(request);
      if (path === '/api/control/settings' && options.control) {
        reply(response, 200, { ...await options.control.save(body) }); return;
      }
      if (path === '/api/control/start' && options.control) {
        if (body.settings === undefined || Object.keys(body).some((key) => !['confirmed', 'settings'].includes(key))) throw new RequestFailure(400);
        reply(response, 200, { ...await options.control.start(body.confirmed, body.settings) }); return;
      }
      if (options.control && ['/api/control/stop', '/api/control/handoff', '/api/control/close'].includes(path)) {
        const command = path.slice('/api/control/'.length) as 'stop' | 'handoff' | 'close';
        if (Object.keys(body).some((key) => !['runId', ...(command === 'handoff' ? ['slot'] : [])].includes(key))) throw new RequestFailure(400);
        reply(response, 200, { ...await options.control.command(command, body.runId, body.slot) }); return;
      }
      if (options.push) {
        if (path === '/api/push/stop') {
          if (Object.keys(body).some((key) => key !== 'reminderIds')) throw new RequestFailure(400);
          await options.push.stop(body.reminderIds);
        } else if (path === '/api/push/subscribe') {
          if (Object.keys(body).some((key) => key !== 'subscription')) throw new RequestFailure(400);
          await options.push.subscribe(body.subscription);
        } else {
          if (Object.keys(body).some((key) => key !== 'endpoint')) throw new RequestFailure(400);
          if (path === '/api/push/unsubscribe') await options.push.unsubscribe(body.endpoint);
          else if (path === '/api/push/test') await options.push.test(body.endpoint);
        }
        reply(response, 200, { ok: true }); return;
      }
    }
    if (path === '/api/status' || path === '/api/events') {
      if (!validSession(token)) { reply(response, 401, { error: 'Sign in required' }); return; }
      if (path === '/api/status') {
        const payload = statusPayload();
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(payload); return;
      }
      if (clients.size >= MAX_STREAMS) { reply(response, 503, { error: 'Try again later' }); return; }
      const payload = statusPayload();
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      response.flushHeaders();
      clients.set(response, token as string);
      response.on('close', () => removeClient(response));
      sendStatus(response, payload);
      if (clients.size && !ticker) { ticker = setInterval(tick, 1000); ticker.unref(); }
      return;
    }
    if (asset) {
      let content: Buffer;
      try { content = await readFile(join(webDir, asset.file)); }
      catch { reply(response, 404, { error: 'Not found' }); return; }
      response.writeHead(200, { 'Content-Type': asset.contentType, 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    }
  };

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      response.setHeader('Connection', 'close');
      const expected = error instanceof ControlFailure || error instanceof MonitorPushError;
      reply(response, error instanceof RequestFailure || expected ? error.status : 500,
        { error: expected ? error.message : 'Request rejected' });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  server.maxConnections = 100;
  const close = server.close.bind(server);
  server.close = (callback?: (error?: Error) => void): Server => {
    stopClients();
    return close(callback);
  };
  server.on('close', () => { stopClients(); sessions.clear(); });
  return server;
}
