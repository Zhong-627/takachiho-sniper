import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Frame, Page, Request, Response } from 'playwright';
import type { RunMode } from './config.js';
import { formatReleaseTimes } from './time.js';

const OMITTED = '[REDACTED]';
const PRIVATE_KEY = /^(?:value|values|body|postData|headers|storageState|localStorage|sessionStorage|customer|customerData|fields|representativeName|email|phone|telephone|creditCard|cardNumber|otp)$|(?:password|secret|token|authorization|csrf|session.?id)/iu;
const EMAIL = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/giu;

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, '-').slice(0, 100) || 'diagnostic';
}

/** No credentials, query values, fragments, or obvious path-carried tokens survive. */
export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return `[${url.protocol.replace(':', '')} URL omitted]`;
    const pathname = url.pathname
      .replace(/;(?:jsessionid|sessionid|sid)=[^/;]+/giu, ';session=[REDACTED]')
      .split('/')
      .map((segment) => {
        if (/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(segment)
          || /^[A-Za-z\d_-]{32,}$/u.test(segment)
          || /(?:@|%40)/iu.test(segment)) return OMITTED;
        return segment;
      }).join('/');
    const keys = [...new Set(url.searchParams.keys())]
      .map((key) => /^[A-Za-z\d_-]{32,}$/u.test(key) ? OMITTED : encodeURIComponent(key));
    return `${url.origin}${pathname}${keys.length ? `?${keys.join('&')}` : ''}`;
  } catch {
    return '[invalid URL omitted]';
  }
}

interface RequestTrace {
  id: number;
  started: number;
}

interface LogRecord {
  timestamp: string;
  epochMs: number;
  jst: string;
  taipei: string;
  elapsedMs: number;
  mode: RunMode;
  event: string;
  slot?: string;
  data: Record<string, unknown>;
}

/** JSONL diagnostics contain metadata, never HTTP bodies, storage dumps or raw HTML. */
export class Diagnostics {
  readonly dir: string;
  private readonly started = performance.now();
  private readonly startedAt = Date.now();
  private secrets: readonly string[] = [];
  private pending: Promise<void> = Promise.resolve();
  private readonly background = new Set<Promise<void>>();
  private readonly detach = new Map<Page, () => void>();
  private readonly requests = new WeakMap<Request, RequestTrace>();
  private readonly counts: Record<string, number> = {};
  private readonly latestSlotEvent: Record<string, string> = {};
  private requestSequence = 0;
  private screenshotSequence = 0;
  private writeFailures = 0;
  private closed = false;

  constructor(dir: string, private readonly mode: RunMode, secretValues: readonly string[] = []) {
    this.dir = dir;
    this.addSecrets(secretValues);
  }

  /** Extend redaction after a local customer config is reloaded. Names can be short. */
  addSecrets(values: readonly string[]): void {
    this.secrets = [...new Set([...this.secrets, ...values.filter((value) => value.length > 0)])]
      .sort((a, b) => b.length - a.length);
  }

  private scrubString(value: string): string {
    let result = value;
    for (const secret of this.secrets) {
      // URL-encoded and escaped copies must be as private as the original.
      for (const representation of new Set([secret, encodeURIComponent(secret), encodeURI(secret)])) {
        result = result.split(representation).join(OMITTED);
      }
    }
    return result.replace(EMAIL, OMITTED)
      .replace(/\beyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+\b/gu, OMITTED)
      .replace(/\b(?:0\d{1,4}[- ]\d{1,4}[- ]\d{4}|0\d{9,10})\b/gu, OMITTED)
      .replace(/\+\d[\d -]{8,}\d/gu, OMITTED);
  }

  private safeValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof value === 'string') {
      const sanitized = value.replace(/https?:\/\/[^\s"'<>]+/giu, (url) => sanitizeUrl(url));
      return this.scrubString(sanitized);
    }
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular value omitted]';
    seen.add(value);
    if (value instanceof Error) {
      // A generic caller's errors still get secret scrubbing; page errors never
      // enter here with messages or stacks because web scripts can echo PII.
      return { name: this.safeValue(value.name), message: this.safeValue(value.message) };
    }
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((entry) => this.safeValue(entry, seen));
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      this.scrubString(key), PRIVATE_KEY.test(key) ? OMITTED : this.safeValue(entry, seen),
    ]));
  }

  private serialize(value: unknown, pretty = false): string {
    const serialized = JSON.stringify(this.safeValue(value), (_key, entry: unknown) => {
      if (typeof entry === 'bigint') return entry.toString();
      return entry;
    }, pretty ? 2 : undefined);
    // Scrub every serialized string token, including object keys, preserving
    // valid JSON even if a secret contains a quote, newline or backslash.
    return (serialized ?? 'null').replace(/"(?:\\.|[^"\\])*"/gu, (token) => {
      const decoded = JSON.parse(token) as string;
      return JSON.stringify(this.scrubString(decoded));
    });
  }

  private enqueue(operation: () => Promise<void>): void {
    this.pending = this.pending.then(operation).catch(() => {
      this.writeFailures += 1;
      // Never echo the filesystem error: local paths can contain personal names.
      process.stderr.write('Diagnostics write failed; automation continues.\n');
    });
  }

  event(event: string, data: Record<string, unknown> = {}, slot?: string): void {
    if (this.closed) return;
    const epochMs = Date.now();
    const times = formatReleaseTimes(epochMs);
    const record: LogRecord = {
      timestamp: times.utc, epochMs, jst: times.jst, taipei: times.taipei,
      elapsedMs: roundMs(performance.now() - this.started), mode: this.mode,
      event, ...(slot ? { slot } : {}), data,
    };
    this.counts[event] = (this.counts[event] ?? 0) + 1;
    if (slot) this.latestSlotEvent[slot] = event;
    try {
      const line = `${this.serialize(record)}\n`;
      this.enqueue(() => appendFile(join(this.dir, 'events.jsonl'), line, { mode: 0o600 }));
    } catch {
      this.writeFailures += 1;
    }
  }

  /** Files share the same redaction policy as events; filenames cannot escape dir. */
  async writeJson(name: string, value: unknown): Promise<void> {
    if (this.closed) return;
    const filename = safeFilename(name.endsWith('.json') ? name : `${name}.json`);
    try {
      const contents = `${this.serialize(value, true)}\n`;
      this.enqueue(() => writeFile(join(this.dir, filename), contents, { mode: 0o600 }));
      await this.pending;
    } catch {
      this.writeFailures += 1;
    }
  }

  private trace(request: Request): RequestTrace {
    const existing = this.requests.get(request);
    if (existing) return existing;
    const created = { id: ++this.requestSequence, started: performance.now() };
    this.requests.set(request, created);
    return created;
  }

  private track(operation: Promise<void>): void {
    const settled = operation.catch(() => {
      this.event('diagnostic_metadata_unavailable');
    });
    this.background.add(settled);
    void settled.finally(() => this.background.delete(settled));
  }

  /** Attach once per page. Listeners observe metadata and never affect requests. */
  attach(page: Page, slot?: string): void {
    if (this.closed || this.detach.has(page)) return;
    const request = (request: Request): void => {
      const trace = this.trace(request);
      const previous = request.redirectedFrom();
      this.event('network_request', {
        requestId: trace.id, method: request.method(), resourceType: request.resourceType(),
        url: sanitizeUrl(request.url()), navigation: request.isNavigationRequest(),
        ...(previous ? { redirectFrom: sanitizeUrl(previous.url()), previousRequestId: this.trace(previous).id } : {}),
      }, slot);
    };
    const response = (response: Response): void => {
      this.track((async () => {
        const trace = this.trace(response.request());
        const status = response.status();
        this.event('network_response', {
          requestId: trace.id, status, url: sanitizeUrl(response.url()),
          durationMs: roundMs(performance.now() - trace.started),
        }, slot);
        if (status >= 300 && status < 400) {
          const location = await response.headerValue('location');
          if (location) this.event('network_redirect', {
            requestId: trace.id, status, from: sanitizeUrl(response.url()),
            to: sanitizeUrl(new URL(location, response.url()).href),
          }, slot);
        }
      })());
    };
    const finished = (request: Request): void => {
      const trace = this.trace(request);
      this.event('network_request_finished', {
        requestId: trace.id, url: sanitizeUrl(request.url()), durationMs: roundMs(performance.now() - trace.started),
        timing: request.timing(),
      }, slot);
    };
    const failed = (request: Request): void => {
      const trace = this.trace(request);
      const errorCode = request.failure()?.errorText.match(/net::ERR_[A-Z_]+/u)?.[0] ?? 'REQUEST_FAILED';
      this.event('network_request_failed', {
        requestId: trace.id, url: sanitizeUrl(request.url()), durationMs: roundMs(performance.now() - trace.started), errorCode,
      }, slot);
    };
    const pageerror = (error: Error): void => {
      const errorType = /^(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError)$/u.test(error.name) ? error.name : 'Error';
      this.event('page_error', { errorType, message: '[web script message omitted]' }, slot);
    };
    const navigated = (frame: Frame): void => {
      const mainFrame = frame === page.mainFrame();
      this.event(mainFrame ? 'page_navigation' : 'frame_navigation', {
        url: sanitizeUrl(frame.url()), mainFrame,
      }, slot);
    };
    const loaded = (): void => this.event('page_load', { url: sanitizeUrl(page.url()) }, slot);
    const domReady = (): void => this.event('page_domcontentloaded', { url: sanitizeUrl(page.url()) }, slot);
    const crashed = (): void => this.event('page_crash', {}, slot);
    const pageClosed = (): void => this.event('page_closed', {}, slot);
    page.on('request', request);
    page.on('response', response);
    page.on('requestfinished', finished);
    page.on('requestfailed', failed);
    page.on('pageerror', pageerror);
    page.on('framenavigated', navigated);
    page.on('domcontentloaded', domReady);
    page.on('load', loaded);
    page.on('crash', crashed);
    page.on('close', pageClosed);
    this.detach.set(page, () => {
      page.off('request', request);
      page.off('response', response);
      page.off('requestfinished', finished);
      page.off('requestfailed', failed);
      page.off('pageerror', pageerror);
      page.off('framenavigated', navigated);
      page.off('domcontentloaded', domReady);
      page.off('load', loaded);
      page.off('crash', crashed);
      page.off('close', pageClosed);
    });
    this.event('runtime_browser', {
      browserVersion: page.context().browser()?.version() ?? 'unavailable',
      nodeVersion: process.version, platform: process.platform, arch: process.arch,
    }, slot);
  }

  /** Best-effort and privacy-first: failure to prepare a mask skips the image. */
  async snapshot(page: Page, label: string, slot?: string): Promise<void> {
    if (this.closed) return;
    const name = safeFilename(`${++this.screenshotSequence}-${slot ?? 'site'}-${label}`);
    this.event('snapshot_started', { label }, slot);
    try {
      const structure = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('input, select, textarea, button, a[href], [role="button"]')].slice(0, 1500).map((element) => {
          // Keep this inline: tsx can inject a Node-only __name helper into
          // locally named functions, which Playwright cannot serialize.
          const tag = element.tagName.toLowerCase();
          const classes = [...element.classList].slice(0, 4).map((value) => `.${CSS.escape(value)}`).join('');
          const name = element.getAttribute('name');
          const selector = element.id ? `${tag}#${CSS.escape(element.id)}` : `${tag}${classes}${name ? `[name=${JSON.stringify(name)}]` : ''}`;
          const control = element as HTMLInputElement;
          const isHidden = element.getAttribute('type') === 'hidden';
          const label = !isHidden && 'labels' in control
            ? [...(control.labels ?? [])].map((label) => label.textContent?.trim().slice(0, 160) ?? '').join(' | ')
            : '';
          return {
            tag, selector,
            id: element.id || undefined, name: element.getAttribute('name') ?? undefined,
            type: element.getAttribute('type') ?? undefined, role: element.getAttribute('role') ?? undefined,
            required: element.hasAttribute('required'), disabled: element.hasAttribute('disabled'),
            label: label || element.getAttribute('aria-label')?.slice(0, 160) || undefined,
            ...(element.tagName === 'BUTTON' || element.getAttribute('role') === 'button'
              ? { buttonLabel: element.textContent?.trim().slice(0, 160) } : {}),
            ...(element.tagName === 'A' ? { href: element.getAttribute('href') } : {}),
            // All control values, including hidden CSRF/hold tokens, are omitted.
            ...(element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT'
              ? { value: '[REDACTED]' } : {}),
          };
        });
        const navigation = window.performance.getEntriesByType('navigation').map((entry) => {
          const nav = entry as PerformanceNavigationTiming;
          return {
            type: nav.type, duration: nav.duration, redirectCount: nav.redirectCount,
            redirectStart: nav.redirectStart, redirectEnd: nav.redirectEnd,
            domainLookupStart: nav.domainLookupStart, domainLookupEnd: nav.domainLookupEnd,
            connectStart: nav.connectStart, connectEnd: nav.connectEnd,
            secureConnectionStart: nav.secureConnectionStart,
            requestStart: nav.requestStart, responseStart: nav.responseStart, responseEnd: nav.responseEnd,
            domInteractive: nav.domInteractive, domContentLoadedEventStart: nav.domContentLoadedEventStart,
            domContentLoadedEventEnd: nav.domContentLoadedEventEnd, loadEventStart: nav.loadEventStart, loadEventEnd: nav.loadEventEnd,
            transferSize: nav.transferSize, encodedBodySize: nav.encodedBodySize, decodedBodySize: nav.decodedBodySize,
          };
        });
        return { controls, navigation };
      });
      // Relative links are sanitized before writing, just like network URLs.
      const controls = structure.controls.map((control) => ({
        ...control,
        ...(control.href ? { href: sanitizeUrl(new URL(control.href, page.url()).href) } : {}),
      }));
      const cookies = (await page.context().cookies()).map(({ name, domain, path, expires, httpOnly, secure, sameSite }) => ({
        name, domain, path, expires, httpOnly, secure, sameSite, session: expires === -1,
      }));
      await this.writeJson(`${name}.json`, {
        url: sanitizeUrl(page.url()), label, ...(slot ? { slot } : {}), controls,
        navigation: structure.navigation, cookies,
      });
    } catch {
      this.event('snapshot_metadata_unavailable', { label, reason: 'Page changed or closed; raw error omitted' }, slot);
    }

    const maskId = randomUUID();
    try {
      // Mark only text-node parents, so a name/email echoed outside the form
      // is masked too. No matching text itself comes back into diagnostics.
      await page.evaluate(({ secrets, maskId }) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const marked = new Set<Element>();
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const parent = node.parentElement;
          if (!parent || /^(SCRIPT|STYLE|NOSCRIPT)$/u.test(parent.tagName)) continue;
          const text = node.textContent ?? '';
          if (secrets.some((secret) => text.includes(secret))
            || /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/iu.test(text)
            || /\b(?:0\d{1,4}[- ]\d{1,4}[- ]\d{4}|0\d{9,10})\b/u.test(text)
            || /\+\d[\d -]{8,}\d/u.test(text)) marked.add(parent);
        }
        for (const element of marked) element.setAttribute('data-takachiho-diagnostic-mask', maskId);
      }, { secrets: [...this.secrets], maskId });
      await page.screenshot({
        path: join(this.dir, `${name}.png`), fullPage: true, timeout: 15_000,
        mask: [
          page.locator('input, textarea, select, [contenteditable]'),
          page.locator(`[data-takachiho-diagnostic-mask="${maskId}"]`),
        ], maskColor: '#202020',
        style: '*::before, *::after { visibility: hidden !important; }',
      });
      this.event('screenshot_saved', { label, file: `${name}.png`, customerInputsMasked: true }, slot);
    } catch {
      this.event('screenshot_unavailable', { label, reason: 'Mask or screenshot failed; raw error omitted' }, slot);
    } finally {
      await page.evaluate((maskId) => {
        for (const element of document.querySelectorAll(`[data-takachiho-diagnostic-mask="${maskId}"]`)) {
          element.removeAttribute('data-takachiho-diagnostic-mask');
        }
      }, maskId).catch(() => undefined);
    }
    this.event('snapshot_finished', { label }, slot);
  }

  /** Flush logs and release diagnostic listeners; keep all browsers open. */
  async close(): Promise<void> {
    if (this.closed) return;
    for (const cleanup of this.detach.values()) cleanup();
    this.detach.clear();
    await Promise.allSettled([...this.background]);
    this.event('diagnostics_closed', { writeFailures: this.writeFailures });
    await this.writeJson('summary.json', {
      mode: this.mode, startedAt: formatReleaseTimes(this.startedAt), endedAt: formatReleaseTimes(Date.now()),
      elapsedMs: roundMs(performance.now() - this.started), eventCounts: this.counts,
      latestSlotEvent: this.latestSlotEvent, writeFailures: this.writeFailures,
    });
    this.closed = true;
    await this.pending;
  }
}

export async function createDiagnostics(
  artifactsDir: string,
  mode: RunMode,
  secretValues: readonly string[] = [],
): Promise<Diagnostics> {
  const runName = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${mode}-${randomUUID().slice(0, 8)}`;
  const dir = resolve(artifactsDir, runName);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const diagnostics = new Diagnostics(dir, mode, secretValues);
  diagnostics.event('run_started', { nodeVersion: process.version, platform: process.platform, arch: process.arch });
  return diagnostics;
}
