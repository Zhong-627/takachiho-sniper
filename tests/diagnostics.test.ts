import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnostics, sanitizeUrl } from '../src/diagnostics.js';

const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'takachiho-diagnostics-'));
  temporary.push(dir);
  return dir;
}

interface RecordedEvent {
  timestamp: string;
  epochMs: number;
  jst: string;
  taipei: string;
  elapsedMs: number;
  slot?: string;
  event: string;
  data: Record<string, unknown>;
}

async function events(dir: string): Promise<RecordedEvent[]> {
  const content = await readFile(join(dir, 'events.jsonl'), 'utf8');
  return content.trim().split('\n').map((line) => JSON.parse(line) as RecordedEvent);
}

function mockedPage(): EventEmitter & {
  context: ReturnType<typeof vi.fn>; url: ReturnType<typeof vi.fn>; mainFrame: ReturnType<typeof vi.fn>;
} {
  const emitter = new EventEmitter();
  const frame = { url: () => 'https://example.test/calendar?session=DO-NOT-LOG' };
  return Object.assign(emitter, {
    context: vi.fn(() => ({ browser: () => ({ version: () => 'Chromium test' }), cookies: async () => [] })),
    url: vi.fn(() => 'https://example.test/calendar?session=DO-NOT-LOG'),
    mainFrame: vi.fn(() => frame),
  });
}

describe('diagnostic persistence', () => {
  it('records timezone milliseconds, independent slot labels and monotonic elapsed time', async () => {
    let wall = Date.UTC(2026, 9, 12, 0, 0, 0, 123);
    let mono = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const diagnostics = await createDiagnostics(await directory(), 'live');
    mono += 123.456;
    diagnostics.event('slot_selection', { attempt: 1 }, '10:00');
    wall -= 1000;
    mono += 10;
    diagnostics.event('customer_form_ready', {}, '10:30');
    await diagnostics.close();
    const records = await events(diagnostics.dir);
    const selected = records.find((entry) => entry.event === 'slot_selection');
    expect(selected).toMatchObject({
      slot: '10:00', timestamp: '2026-10-12T00:00:00.123Z',
      jst: '2026-10-12 09:00:00.123 Asia/Tokyo', taipei: '2026-10-12 08:00:00.123 Asia/Taipei',
      elapsedMs: 123.456,
    });
    expect(records.find((entry) => entry.event === 'customer_form_ready')).toMatchObject({ slot: '10:30', elapsedMs: 133.456 });
    const summary = JSON.parse(await readFile(join(diagnostics.dir, 'summary.json'), 'utf8')) as Record<string, unknown>;
    expect(summary.eventCounts).toMatchObject({ slot_selection: 1, customer_form_ready: 1 });
  });

  it('redacts known secrets, escaped strings, emails, token fields and URL query values in every file', async () => {
    const privateName = '田中 "予約"\\local\n秘密';
    const privateToken = 'VERY-PRIVATE-TOKEN';
    const diagnostics = await createDiagnostics(await directory(), 'inspect', [privateName, privateToken]);
    const data = {
      nested: { label: `Customer ${privateName}`, access_token: 'unregistered-secret', value: 'hidden-unknown-secret' },
      note: 'alice@example.test 090-1234-5678',
      encoded: encodeURIComponent(privateToken),
      url: 'https://example.test/calendar?session=UNREGISTERED-SECRET&date=2026-10-26#hidden',
      description: `Unexpected redirect https://example.test/customer?email=unknown@example.test&hold=RAW-HOLD-TOKEN`,
    };
    diagnostics.event('diagnostic', data, '10:00');
    await diagnostics.writeJson('metadata', data);
    await diagnostics.close();
    const files = (await readdir(diagnostics.dir)).filter((name) => name.endsWith('.json') || name.endsWith('.jsonl'));
    for (const file of files) {
      const content = await readFile(join(diagnostics.dir, file), 'utf8');
      expect(content).not.toContain(privateName);
      expect(content).not.toContain(privateToken);
      expect(content).not.toContain('alice@example.test');
      expect(content).not.toContain('090-1234-5678');
      expect(content).not.toContain('unregistered-secret');
      expect(content).not.toContain('hidden-unknown-secret');
      expect(content).not.toContain('UNREGISTERED-SECRET');
      expect(content).not.toContain('RAW-HOLD-TOKEN');
      if (file.endsWith('.json')) expect(() => JSON.parse(content)).not.toThrow();
      else for (const line of content.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
    }
    const metadata = JSON.parse(await readFile(join(diagnostics.dir, 'metadata.json'), 'utf8')) as Record<string, unknown>;
    expect(metadata.url).toBe('https://example.test/calendar?session&date');
  });

  it('cannot write diagnostic filenames outside the run directory', async () => {
    const parent = await directory();
    const diagnostics = await createDiagnostics(parent, 'rehearsal');
    await diagnostics.writeJson('../../outside', { safe: true });
    await diagnostics.close();
    expect(await readdir(parent)).toEqual([diagnostics.dir.split('/').at(-1)]);
    expect(await readdir(diagnostics.dir)).toContain('..-..-outside.json');
  });

  it('extends redaction for reloaded config and short names without filtering them out', async () => {
    const diagnostics = await createDiagnostics(await directory(), 'live');
    diagnostics.addSecrets(['王明', 'RELOADED-PRIVATE-SECRET']);
    diagnostics.event('reloaded_config_metadata', { note: '代表者：王明 RELOADED-PRIVATE-SECRET' }, '10:00');
    await diagnostics.close();
    const content = await readFile(join(diagnostics.dir, 'events.jsonl'), 'utf8');
    expect(content).not.toContain('王明');
    expect(content).not.toContain('RELOADED-PRIVATE-SECRET');
    expect(content).toContain('[REDACTED]');
  });
});

describe('URL metadata', () => {
  it('keeps the origin, path and query key names without query values or fragments', () => {
    expect(sanitizeUrl('https://user:password@example.test/calendar?date=2026-10-26&session=secret&date=other#secret'))
      .toBe('https://example.test/calendar?date&session');
  });

  it('omits path-carried session tokens and non-HTTP URLs', () => {
    expect(sanitizeUrl('https://example.test/customer/550e8400-e29b-41d4-a716-446655440000?email=secret')).toBe('https://example.test/customer/[REDACTED]?email');
    expect(sanitizeUrl('https://example.test/customer;jsessionid=secret')).toBe('https://example.test/customer;session=[REDACTED]');
    expect(sanitizeUrl('data:text/html,secret')).toBe('[data URL omitted]');
    expect(sanitizeUrl('not-a-url')).toBe('[invalid URL omitted]');
  });
});

describe('page observers', () => {
  it('reports actual frame navigation URLs separately from the main page', async () => {
    const diagnostics = await createDiagnostics(await directory(), 'inspect');
    const page = mockedPage();
    diagnostics.attach(page as unknown as Page, '10:00');
    page.emit('framenavigated', { url: () => 'https://challenge.example.test/queue?token=PRIVATE-IFRAME-TOKEN' });
    page.emit('framenavigated', page.mainFrame());
    await diagnostics.close();
    const records = await events(diagnostics.dir);
    expect(records.filter((entry) => entry.event === 'frame_navigation')).toHaveLength(1);
    expect(records.find((entry) => entry.event === 'frame_navigation')?.data).toEqual({
      url: 'https://challenge.example.test/queue?token', mainFrame: false,
    });
    expect(records.filter((entry) => entry.event === 'page_navigation')).toHaveLength(1);
    expect(records.find((entry) => entry.event === 'page_navigation')?.data).toEqual({
      url: 'https://example.test/calendar?session', mainFrame: true,
    });
    expect(await readFile(join(diagnostics.dir, 'events.jsonl'), 'utf8')).not.toContain('PRIVATE-IFRAME-TOKEN');
  });

  it('logs request latency and redirect destinations without bodies, headers or raw script errors', async () => {
    const diagnostics = await createDiagnostics(await directory(), 'rehearsal');
    const page = mockedPage();
    diagnostics.attach(page as unknown as Page, '10:30');
    const request = {
      url: () => 'https://example.test/calendar?session=UNREGISTERED-TOKEN',
      redirectedFrom: () => null, method: () => 'POST', resourceType: () => 'document', isNavigationRequest: () => true,
      timing: () => ({ startTime: 1000, responseEnd: 25 }),
      failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET alice@example.test RAW-FAILURE-TOKEN' }),
      postData: vi.fn(() => 'PRIVATE-BODY'), headers: vi.fn(() => ({ cookie: 'SECRET-COOKIE' })),
    };
    page.emit('request', request);
    const response = {
      request: () => request, status: () => 302, url: request.url,
      headerValue: vi.fn(async () => '/customer?hold=SECRET-HOLD&email=alice@example.test'),
    };
    page.emit('response', response);
    page.emit('requestfailed', request);
    page.emit('pageerror', new Error('RAW-WEB-SCRIPT-SECRET alice@example.test'));
    await diagnostics.close();
    const records = await events(diagnostics.dir);
    expect(records.find((entry) => entry.event === 'network_request')?.data).toMatchObject({
      method: 'POST', url: 'https://example.test/calendar?session', requestId: 1,
    });
    expect(records.find((entry) => entry.event === 'network_response')?.data.durationMs).toEqual(expect.any(Number));
    expect(records.find((entry) => entry.event === 'network_redirect')?.data.to).toBe('https://example.test/customer?hold&email');
    expect(records.find((entry) => entry.event === 'network_request_failed')?.data.errorCode).toBe('net::ERR_CONNECTION_RESET');
    expect(records.find((entry) => entry.event === 'page_error')?.data).toEqual({ errorType: 'Error', message: '[web script message omitted]' });
    const contents = await readFile(join(diagnostics.dir, 'events.jsonl'), 'utf8');
    for (const secret of ['UNREGISTERED-TOKEN', 'PRIVATE-BODY', 'SECRET-COOKIE', 'RAW-WEB-SCRIPT-SECRET', 'SECRET-HOLD', 'RAW-FAILURE-TOKEN']) expect(contents).not.toContain(secret);
    expect(request.postData).not.toHaveBeenCalled();
    expect(request.headers).not.toHaveBeenCalled();
    expect(page.listenerCount('request')).toBe(0);
  });

  it('saves structural metadata and cookie flags while masking form controls in screenshots', async () => {
    const diagnostics = await createDiagnostics(await directory(), 'full-rehearsal', ['Example Customer']);
    const page = mockedPage();
    page.context.mockReturnValue({
      browser: () => ({ version: () => 'Chromium test' }),
      cookies: async () => [{ name: 'SESSIONID', domain: 'example.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax', value: 'NEVER-WRITE-THIS' }],
    });
    const screenshot = vi.fn<(options: Record<string, unknown>) => Promise<void>>(async () => undefined);
    const evaluate = vi.fn()
      .mockResolvedValueOnce({ controls: [{ tag: 'input', name: 'customer_name', type: 'text', label: 'Name: Example Customer', value: 'NEVER-WRITE-THIS-EITHER' }], navigation: [{ requestStart: 10, responseEnd: 25 }] })
      .mockResolvedValue(undefined);
    const locator = vi.fn((selector: string) => ({ selector }));
    Object.assign(page, { evaluate, screenshot, locator });
    await diagnostics.snapshot(page as unknown as Page, 'customer-form', '10:00');
    await diagnostics.close();
    const metadataName = (await readdir(diagnostics.dir)).find((name) => name.startsWith('1-10-00-customer-form') && name.endsWith('.json'));
    expect(metadataName).toBeDefined();
    const metadata = await readFile(join(diagnostics.dir, metadataName ?? ''), 'utf8');
    expect(metadata).not.toContain('NEVER-WRITE-THIS');
    expect(metadata).not.toContain('Example Customer');
    expect(metadata).toContain('SESSIONID');
    expect(metadata).toContain('httpOnly');
    expect(locator).toHaveBeenCalledWith('input, textarea, select, [contenteditable]');
    expect(screenshot).toHaveBeenCalledOnce();
    expect(screenshot.mock.calls[0]?.[0]).toMatchObject({ fullPage: true, maskColor: '#202020' });
  });

  it('skips a screenshot if its privacy mask cannot be prepared and does not throw', async () => {
    const diagnostics = await createDiagnostics(await directory(), 'inspect');
    const page = mockedPage();
    const screenshot = vi.fn();
    Object.assign(page, { evaluate: vi.fn().mockRejectedValue(new Error('Page closed with RAW-SECRET')), screenshot });
    await expect(diagnostics.snapshot(page as unknown as Page, 'closed-page')).resolves.toBeUndefined();
    await diagnostics.close();
    expect(screenshot).not.toHaveBeenCalled();
    const records = await events(diagnostics.dir);
    expect(records.some((entry) => entry.event === 'screenshot_unavailable')).toBe(true);
    expect(await readFile(join(diagnostics.dir, 'events.jsonl'), 'utf8')).not.toContain('RAW-SECRET');
  });
});
