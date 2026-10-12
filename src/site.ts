import type { Page, Response } from 'playwright';
import { isCustomerFormReady } from './autofill.js';
import { parseRetryAfter, RetryableProbeError } from './retry.js';
import { SafetyError, type ReservationPlan, type SafetyGuard } from './safety.js';
import { CUSTOMER_PATH, EIPRO_ORIGIN, HOLD_PATH } from './site-rules.js';

/** All site-specific selectors below were observed in the public calendar DOM. */
export const SELECTORS = Object.freeze({
  calendar: '#service-full-calendar',
  controlbar: '#mainForm .fullcalendar_control_bar',
  dayView: '#mainForm [data-target_view_name="agendaDay"]',
  // bindCalendar changes data-target_selector to an ID plus generated UUID
  // class at boot. mainForm is the confirmed stable parent of this dropdown.
  dateList: '#mainForm .fullcalendar_control_date_list',
  event: '#service-full-calendar .fc-event',
  eventStart: 'input.service_unit_service_start_datetime',
  eventEnd: 'input.service_unit_service_end_datetime',
  eventService: 'input.service_unit_service_cd',
  eventSession: 'input.service_unit_service_session_cd',
});

export const CALENDAR_URL = `${EIPRO_ORIGIN}/takachiho1/eventCalendars/index`;
export const SEARCH_PATH = '/takachiho1/eventCalendars/search';
export type SiteLog = (event: string, data?: Record<string, unknown>) => void;
export interface SiteTimeouts { navigationMs: number; actionMs: number; customerFormMs: number }

export interface SiteEvent {
  service_cd: string;
  session_cd: string;
  service_start_datetime: string;
  service_end_datetime: string;
  calendar_select_action_type: '1';
  ordable: boolean;
  reserve_possible: boolean;
  is_reserve_started: boolean;
  is_reserve_dead: boolean;
  is_full: boolean;
  enabled_flg: boolean;
  is_accept: boolean;
  order_remain_amount?: unknown;
  min_service_end_datetime?: string | null;
  max_service_end_datetime?: string | null;
}

export interface SlotObservation {
  status: 'available' | 'unavailable' | 'unknown';
  reason: string;
  /** Only a valid, error-free calendar response can establish target absence. */
  targetAbsent?: true;
  event?: SiteEvent;
}

export interface CalendarSnapshot {
  payload: unknown;
  httpStatus: number;
  responseMs: number;
  clientEvents: unknown[];
  domEvents: Array<{ text: string; start: string | null; end: string | null; service: string | null; session: string | null }>;
}

export interface ManualSignal {
  kind: 'captcha' | 'queue' | 'maintenance' | 'access-denied';
  reason: string;
}

export class SiteInspectionRequiredError extends Error {
  override name = 'SiteInspectionRequiredError';
}

export class ManualInterventionError extends Error {
  override name = 'ManualInterventionError';
  constructor(readonly signal: ManualSignal) { super(signal.reason); }
}

export class AmbiguousReservationError extends Error {
  override name = 'AmbiguousReservationError';
}

const positiveFlags = ['ordable', 'reserve_possible', 'is_reserve_started', 'enabled_flg', 'is_accept'] as const;
const negativeFlags = ['is_reserve_dead', 'is_full'] as const;
const eventKeys = ['service_cd', 'session_cd', 'service_start_datetime', 'service_end_datetime',
  'calendar_select_action_type', ...positiveFlags, ...negativeFlags, 'order_remain_amount',
  'min_service_end_datetime', 'max_service_end_datetime'] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function dateTime(value: unknown): { date: string; time: string; epoch: number } | undefined {
  if (typeof value !== 'string' || !/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) return undefined;
  const date = value.slice(0, 10).replaceAll('/', '-');
  const clock = value.slice(11);
  const epoch = Date.parse(`${date}T${clock}+09:00`);
  if (!Number.isFinite(epoch)) return undefined;
  // Date.parse normalizes invalid days, so reject those before accepting an action.
  if (new Date(epoch + 9 * 3_600_000).toISOString().slice(0, 19) !== `${date}T${clock}`) return undefined;
  return { date, time: clock.slice(0, 5), epoch };
}

function validEvent(value: unknown): SiteEvent | undefined {
  const event = record(value);
  if (!event) return undefined;
  if (typeof event.service_cd !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(event.service_cd)
      || typeof event.session_cd !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(event.session_cd)) return undefined;
  const start = dateTime(event.service_start_datetime);
  const end = dateTime(event.service_end_datetime);
  if (!start || !end || end.epoch <= start.epoch || end.epoch - start.epoch > 86_400_000) return undefined;
  if (event.calendar_select_action_type !== '1') return undefined;
  if ([...positiveFlags, ...negativeFlags].some((key) => typeof event[key] !== 'boolean')) return undefined;
  const minimum = event.min_service_end_datetime ?? null;
  const maximum = event.max_service_end_datetime ?? null;
  if (minimum !== maximum || (minimum !== null && !dateTime(minimum))) return undefined;
  return Object.fromEntries(eventKeys.filter((key) => event[key] !== undefined).map((key) => [key, event[key]])) as unknown as SiteEvent;
}

/** Remaining quantity and calendar glyphs are never proof of reservability. */
export function parseAvailability(payload: unknown, targetDate: string, slot: string): SlotObservation {
  const body = record(payload);
  if (!body || !Array.isArray(body.results)) return { status: 'unknown', reason: 'Unrecognized official search response schema.' };
  if (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length > 0)) return { status: 'unknown', reason: 'Official search reports errors or an unknown error schema.' };
  const matches = body.results.filter((value) => {
    const event = record(value);
    const start = dateTime(event?.service_start_datetime);
    return start?.date === targetDate && start.time === slot && typeof event?.service_start_datetime === 'string' && event.service_start_datetime.endsWith(':00');
  });
  if (matches.length !== 1) return {
    status: 'unknown',
    reason: matches.length === 0 ? 'Target slot was not explicitly present in the current response.' : 'Multiple events match the target; manual inspection is required.',
    ...(matches.length === 0 && body.results.every((value) => validEvent(value) !== undefined) ? { targetAbsent: true as const } : {}),
  };
  const event = validEvent(matches[0]);
  if (!event) return { status: 'unknown', reason: 'Target event identifiers, time range, action type, or availability flags are unconfirmed.' };
  const available = positiveFlags.every((key) => event[key] === true) && negativeFlags.every((key) => event[key] === false);
  return available
    ? { status: 'available', event, reason: 'All explicit official availability flags permit reservation.' }
    : { status: 'unavailable', event, reason: 'Explicit official availability flags currently prohibit reservation.' };
}

/** Read-only preview: describing requests never authorizes or dispatches them. */
export function describeActionPlan(event: SiteEvent): ReservationPlan {
  const checked = validEvent(event);
  if (!checked) throw new SafetyError('An action preview requires a complete verified official event.');
  const fields = {
    service_cd: checked.service_cd,
    service_session_cd: checked.session_cd,
    service_start_datetime: checked.service_start_datetime,
    service_end_datetime: checked.service_end_datetime,
  };
  const hold = new URLSearchParams(Object.entries(fields).map(([key, value]) => [`data[${key}]`, value]));
  const customer = new URL(`${EIPRO_ORIGIN}${CUSTOMER_PATH}`);
  for (const [key, value] of Object.entries(fields)) customer.searchParams.set(key, value);
  return {
    slotKey: `${checked.service_start_datetime.slice(0, 10).replaceAll('/', '-')} ${checked.service_start_datetime.slice(11, 16)}`,
    hold: { url: `${EIPRO_ORIGIN}${HOLD_PATH}`, method: 'POST', body: hold.toString(), contentType: 'application/x-www-form-urlencoded' },
    customerNavigation: { url: customer.href, method: 'GET', body: null },
  };
}

export function createActionPlan(event: SiteEvent): ReservationPlan {
  const checked = validEvent(event);
  if (!checked || positiveFlags.some((key) => checked[key] !== true) || negativeFlags.some((key) => checked[key] !== false)) {
    throw new SafetyError('An action requires a complete explicitly available official event.');
  }
  return describeActionPlan(checked);
}

function matchesSearch(response: Response, date: string): boolean {
  const request = response.request();
  if (new URL(response.url()).pathname !== SEARCH_PATH || request.method() !== 'POST') return false;
  const data = new URLSearchParams(request.postData() ?? '');
  return data.get('calendar_view_name') === 'agendaDay'
    && data.get('data[conds][ServiceView][max_session_dateOver]') === date.replaceAll('-', '/');
}

async function boundedJson(response: Response, timeoutMs: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      response.json() as Promise<unknown>,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new RetryableProbeError('Read response body timed out.')), timeoutMs); }),
    ]);
  } catch (error) {
    if (error instanceof RetryableProbeError) throw error;
    throw new RetryableProbeError('Official calendar response could not be parsed as JSON.');
  } finally { if (timer) clearTimeout(timer); }
}

async function currentCalendarState(page: Page): Promise<{ view: string | null; date: string | null }> {
  return page.evaluate(() => {
    const runtime = window as unknown as { jQuery?: (selector: string) => { fullCalendar: (operation: string) => unknown } };
    const calendar = runtime.jQuery?.('#service-full-calendar');
    if (!calendar || typeof calendar.fullCalendar !== 'function') return { view: null, date: null };
    const view = calendar.fullCalendar('getView') as { name?: string } | null;
    const date = calendar.fullCalendar('getDate') as { format?: (format: string) => string } | null;
    return { view: view?.name ?? null, date: date?.format?.('YYYY-MM-DD') ?? null };
  });
}

export async function detectManualSignal(page: Page): Promise<ManualSignal | undefined> {
  return page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0;
    };
    // Standard security provider embeds are inspected only; they are never clicked.
    const security = Array.from(document.querySelectorAll('iframe,[id],[class]')).filter(visible).find((element) => {
      const marker = `${element.id} ${element.getAttribute('class') ?? ''} ${element.getAttribute('src') ?? ''}`;
      return /(?:recaptcha|hcaptcha|turnstile|captcha[-_ ]?(?:challenge|widget))/iu.test(marker);
    });
    if (security) return { kind: 'captcha' as const, reason: 'A visible CAPTCHA/security challenge requires manual operation.' };
    const calendarPresent = !!document.querySelector('#service-full-calendar');
    const title = document.title;
    const headings = Array.from(document.querySelectorAll('h1,h2,[role="dialog"],dialog')).filter(visible).map((element) => element.textContent ?? '').join(' ');
    // Site notices mention scheduled maintenance; do not treat ordinary homepage notices as an active gate.
    const text = `${title} ${headings}${calendarPresent ? '' : ` ${document.body?.innerText.slice(0, 1500) ?? ''}`}`;
    if (/queue[- ]?it|waiting room|待機室|順番待ち|アクセスが集中.*(?:お待ち|待機)/iu.test(text)) return { kind: 'queue' as const, reason: 'An official queue/waiting room requires manual operation.' };
    if (/maintenance|メンテナンス(?:中|を行って)|サービス(?:停止|休止)中/iu.test(text) && !calendarPresent) return { kind: 'maintenance' as const, reason: 'The site currently displays a maintenance gate.' };
    if (/access denied|forbidden|アクセス(?:拒否|を制限)|robot verification|verify you are human|人間であること/iu.test(text)) return { kind: 'access-denied' as const, reason: 'The site requests access/security verification; manual operation is required.' };
    return undefined;
  });
}

async function throwIfManual(page: Page): Promise<void> {
  const signal = await detectManualSignal(page);
  if (signal) throw new ManualInterventionError(signal);
}

async function snapshot(page: Page, response: Response, started: number, timeouts: SiteTimeouts, log: SiteLog): Promise<CalendarSnapshot> {
  const status = response.status();
  const responseMs = performance.now() - started;
  log('calendar-response', { status, responseMs });
  if (status === 429 || status >= 500) {
    throw new RetryableProbeError(`Official calendar read returned HTTP ${status}.`, parseRetryAfter(response.headers()['retry-after']));
  }
  if (status < 200 || status >= 300) {
    await throwIfManual(page);
    throw new SiteInspectionRequiredError(`Official calendar read returned HTTP ${status}; inspect the site manually.`);
  }
  const payload = await boundedJson(response, timeouts.actionMs);
  await throwIfManual(page);
  const body = record(payload);
  if (Array.isArray(body?.results)) {
    const expected = body.results.map((value: unknown) => {
      const event = record(value) ?? {};
      return Object.fromEntries(eventKeys.filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));
    });
    try {
      // waitForResponse observes headers before the official jQuery callback.
      // Require that callback to install this exact response before acting.
      await page.waitForFunction(({ keys, expectedEvents }) => {
        const site = window as unknown as { jQuery?: (selector: string) => { fullCalendar: (operation: string) => unknown } };
        const current = site.jQuery?.('#service-full-calendar').fullCalendar('clientEvents');
        if (!Array.isArray(current)) return false;
        // The confirmed loadHolidays eventSource adds auxiliary background
        // events to clientEvents, separately from this service search response.
        const serviceEvents = current.filter((event: Record<string, unknown>) => {
          const classes = Array.isArray(event.className) ? event.className
            : typeof event.className === 'string' ? event.className.split(/\s+/u) : [];
          return !(event.rendering === 'background' && classes.includes('fc-holiday'));
        });
        const values = serviceEvents.map((event: Record<string, unknown>) => Object.fromEntries(keys.filter((key) => event[key] !== undefined).map((key) => [key, event[key]])));
        const fingerprint = (events: unknown[]): string => JSON.stringify(events.map((event) => JSON.stringify(event)).sort());
        return fingerprint(values) === fingerprint(expectedEvents);
      }, { keys: [...eventKeys], expectedEvents: expected }, { timeout: timeouts.actionMs, polling: 50 });
    } catch {
      await throwIfManual(page);
      throw new SiteInspectionRequiredError('The official calendar did not render the current search response. No stale event will be reserved.');
    }
  }
  // Read only confirmed event properties: fullCalendar's Moment/source values can be circular.
  const clientEvents = await page.evaluate((keys) => {
    const runtime = window as unknown as { jQuery?: (selector: string) => { fullCalendar: (operation: string) => unknown } };
    const events = runtime.jQuery?.('#service-full-calendar').fullCalendar('clientEvents');
    if (!Array.isArray(events)) return [];
    return events.map((event: Record<string, unknown>) => Object.fromEntries(keys.filter((key) => event[key] !== undefined).map((key) => [key, event[key]])));
  }, [...eventKeys]);
  const domEvents = await page.locator(SELECTORS.event).evaluateAll((elements, selectors) => elements.map((element) => {
    const input = (selector: string): string | null => element.querySelector<HTMLInputElement>(selector)?.value ?? null;
    return { text: element.textContent?.trim().slice(0, 250) ?? '', start: input(selectors.eventStart), end: input(selectors.eventEnd), service: input(selectors.eventService), session: input(selectors.eventSession) };
  }), SELECTORS);
  return { payload, httpStatus: status, responseMs, clientEvents, domEvents };
}

async function triggerRead(page: Page, date: string, timeouts: SiteTimeouts, log: SiteLog, action: () => Promise<void>): Promise<CalendarSnapshot> {
  const started = performance.now();
  const waiting = page.waitForResponse((response) => matchesSearch(response, date), { timeout: timeouts.navigationMs });
  // Attach a catch immediately; a failed action must not leave an unhandled response timeout.
  void waiting.catch(() => undefined);
  await action();
  let response: Response;
  try { response = await waiting; }
  catch { await throwIfManual(page); throw new RetryableProbeError('No bounded official calendar search response arrived.'); }
  return snapshot(page, response, started, timeouts, log);
}

async function refetch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = window as unknown as { jQuery?: (selector: string) => { fullCalendar: (operation: string) => unknown } };
    const calendar = runtime.jQuery?.('#service-full-calendar');
    if (!calendar || typeof calendar.fullCalendar !== 'function') throw new Error('Confirmed FullCalendar API is unavailable.');
    calendar.fullCalendar('refetchEvents');
  });
}

export async function openCalendar(page: Page, targetDate: string, timeouts: SiteTimeouts, log: SiteLog): Promise<CalendarSnapshot> {
  const started = performance.now();
  log('navigation-start', { pathname: '/takachiho1/eventCalendars/index' });
  try { await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: timeouts.navigationMs }); }
  catch { await throwIfManual(page); throw new RetryableProbeError('Calendar navigation failed or timed out.'); }
  log('navigation-ready', { durationMs: performance.now() - started, pathname: new URL(page.url()).pathname });
  await throwIfManual(page);
  try {
    await page.locator(SELECTORS.calendar).waitFor({ state: 'visible', timeout: timeouts.actionMs });
    // The observed toolbar consists of floated children and can have zero own
    // height. Its real button must be visible, rather than its wrapper's box.
    await page.locator(SELECTORS.dayView).waitFor({ state: 'visible', timeout: timeouts.actionMs });
    await page.waitForFunction(() => {
      try {
        const runtime = window as unknown as { jQuery?: (selector: string) => { fullCalendar?: (operation: string) => unknown } };
        const calendar = runtime.jQuery?.('#service-full-calendar');
        return !!calendar?.fullCalendar && !!calendar.fullCalendar('getView');
      } catch { return false; }
    }, undefined, { timeout: timeouts.actionMs });
  } catch { await throwIfManual(page); throw new SiteInspectionRequiredError('Verified calendar/FullCalendar did not initialize. Run Mac inspect and review diagnostics.'); }
  const initial = await currentCalendarState(page);
  if (initial.view !== 'agendaDay') {
    const button = page.locator(SELECTORS.dayView);
    if (await button.count() !== 1) throw new SiteInspectionRequiredError('Observed day-view selector is unavailable.');
    // The observed toolbar handler calls calendar.changeView(view_name).
    // Its HTML button lacks type="button", so invoke that identical public
    // calendar operation directly rather than also triggering form submission.
    await page.evaluate(() => {
      const runtime = window as unknown as { jQuery: (selector: string) => { fullCalendar: (operation: string, value: string) => unknown } };
      runtime.jQuery('#service-full-calendar').fullCalendar('changeView', 'agendaDay');
    });
    await page.waitForFunction(() => {
      try {
        const runtime = window as unknown as { jQuery?: (selector: string) => { fullCalendar: (operation: string) => { name?: string } } };
        return runtime.jQuery?.('#service-full-calendar').fullCalendar('getView').name === 'agendaDay';
      } catch { return false; }
    }, undefined, { timeout: timeouts.actionMs });
  }
  const list = page.locator(SELECTORS.dateList);
  if (await list.count() !== 1) throw new SiteInspectionRequiredError('The observed mainForm date dropdown is absent or ambiguous.');
  const slashDate = targetDate.replaceAll('-', '/');
  try {
    // getView changes before the toolbar's onViewRender regenerates options.
    await page.waitForFunction(({ selector, date }) => {
      const list = document.querySelector<HTMLSelectElement>(selector);
      return !!list && Array.from(list.options).some((option) => option.value === date);
    }, { selector: SELECTORS.dateList, date: slashDate }, { timeout: timeouts.actionMs });
  } catch {
    await throwIfManual(page);
    throw new SiteInspectionRequiredError('The target date is absent from the observed official date dropdown. No guessed navigation or selector is used.');
  }
  const current = await currentCalendarState(page);
  const result = await triggerRead(page, targetDate, timeouts, log, async () => {
    if (current.date === targetDate) await refetch(page);
    else await list.selectOption(slashDate, { timeout: timeouts.actionMs });
  });
  log('target-calendar-ready', { targetDate, view: 'agendaDay', eventCount: result.clientEvents.length, domEventCount: result.domEvents.length });
  return result;
}

export async function probeAvailability(page: Page, targetDate: string, slot: string, timeouts: SiteTimeouts, log: SiteLog): Promise<SlotObservation> {
  await throwIfManual(page);
  let state: { view: string | null; date: string | null };
  try { state = await currentCalendarState(page); }
  catch { state = { view: null, date: null }; }
  const data = state.view === 'agendaDay' && state.date === targetDate
    ? await triggerRead(page, targetDate, timeouts, log, () => refetch(page))
    : await openCalendar(page, targetDate, timeouts, log);
  const observation = parseAvailability(data.payload, targetDate, slot);
  log('availability-detected', { slot, status: observation.status, reason: observation.reason, responseMs: data.responseMs });
  return observation;
}

export interface ReservationResult { status: 'customer-form-ready' | 'sold-out' | 'deadline-reached'; plan: ReservationPlan }

/** One official link invocation, with one exact one-shot network capability. Never retried. */
export async function performReservation(page: Page, event: SiteEvent, guard: SafetyGuard, timeouts: SiteTimeouts, log: SiteLog, options: { deadlineAtMs?: number; signal?: AbortSignal; resumeAfterSoldOut?: boolean } = {}): Promise<ReservationResult> {
  guard.assertCanReserve();
  await throwIfManual(page);
  const plan = createActionPlan(event);
  const runtime = await page.evaluate((keys) => {
    const site = window as unknown as {
      jQuery?: (selector: string) => { fullCalendar: (operation: string) => unknown };
      App?: { Module?: { Front?: { Order?: {
        link?: unknown;
        TEMPORARY_HOLD_RESULT_FAILURE?: unknown;
        TEMPORARY_HOLD_RESULT_SUCCESS?: unknown;
        isTemporaryHoldReservationOptionAvailable?: () => boolean;
        makeOrderUrl?: (...parameters: string[]) => string;
      } } } };
    };
    const order = site.App?.Module?.Front?.Order;
    const events = site.jQuery?.('#service-full-calendar').fullCalendar('clientEvents');
    return {
      hasLink: typeof order?.link === 'function',
      hasHold: order?.isTemporaryHoldReservationOptionAvailable?.() === true,
      rejectionContractConfirmed: order?.TEMPORARY_HOLD_RESULT_FAILURE === '0' && order?.TEMPORARY_HOLD_RESULT_SUCCESS === '1',
      events: Array.isArray(events) ? events.map((value: Record<string, unknown>) => Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]))) : [],
    };
  }, [...eventKeys]);
  const start = dateTime(event.service_start_datetime);
  if (!start) throw new SafetyError('Target action datetime was not validated.');
  const current = parseAvailability({ results: runtime.events }, start.date, start.time);
  if (!runtime.hasLink || !runtime.hasHold || current.status !== 'available' || !current.event
      || createActionPlan(current.event).hold.body !== plan.hold.body) {
    throw new SiteInspectionRequiredError('The current official event or hold API differs from the verified plan; no reservation was dispatched.');
  }
  const officialUrl = await page.evaluate((parameters) => {
    const site = window as unknown as { App: { Module: { Front: { Order: { makeOrderUrl: (...args: string[]) => string } } } } };
    return site.App.Module.Front.Order.makeOrderUrl(...parameters);
  }, [event.service_cd, event.session_cd, event.service_start_datetime, event.service_end_datetime]);
  const official = new URL(officialUrl, page.url());
  const expected = new URL(plan.customerNavigation.url);
  official.searchParams.sort(); expected.searchParams.sort();
  if (official.href !== expected.href) throw new SiteInspectionRequiredError('Official customer URL differs from the verified exact request.');
  if (options.signal?.aborted || (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)) {
    return { status: 'deadline-reached', plan };
  }
  guard.armReservation(plan);
  const started = performance.now();
  log('slot-selection', { slot: start.time, slotKey: plan.slotKey });
  const holdWaiting = page.waitForResponse((response) => new URL(response.url()).pathname === HOLD_PATH && response.request().method() === 'POST', { timeout: timeouts.navigationMs });
  void holdWaiting.catch(() => undefined);
  try {
    await page.evaluate((parameters) => {
      const site = window as unknown as { App: { Module: { Front: { Order: { link: (...args: string[]) => void } } } } };
      site.App.Module.Front.Order.link(...parameters);
    }, [event.service_cd, event.session_cd, event.service_start_datetime, event.service_end_datetime]);
    const response = await holdWaiting;
    let result: unknown;
    let proof: 'browser-response' | 'network-guard' = 'browser-response';
    try {
      const body = record(await boundedJson(response, timeouts.actionMs));
      result = record(body?.data)?.result;
    } catch {
      // Official JS navigates 10 ms after success. Chromium can evict the old
      // page's response body first; the guard parsed that exact response before
      // fulfilling it and authorizing customer navigation.
      if (!guard.state.holdConfirmed && !guard.confirmedHoldRejection) throw new AmbiguousReservationError('The hold response could not be verified; reservation will not be retried.');
      result = guard.state.holdConfirmed ? '1' : '0';
      proof = 'network-guard';
    }
    log('hold-response', { slot: start.time, status: response.status(), result: typeof result === 'string' && /^[0189]$/u.test(result) ? result : 'unknown', proof, durationMs: performance.now() - started });
    if (response.status() >= 200 && response.status() < 300 && result === '0' && guard.confirmedHoldRejection) {
      // A false success flag alone is not proof. Require the exact rejected
      // response, the original calendar page, and a new explicitly full event.
      if (!runtime.rejectionContractConfirmed) throw new SiteInspectionRequiredError('The current official hold-result contract is unconfirmed; inspect the page manually.');
      if (options.signal?.aborted || (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs)) return { status: 'deadline-reached', plan };
      if (page.url() !== CALENDAR_URL) throw new SiteInspectionRequiredError('A rejected hold left the verified calendar; inspect the page manually.');
      const latest = await probeAvailability(page, start.date, start.time, timeouts, log);
      if (latest.status !== 'unavailable' || !latest.event || latest.event.is_full !== true
          || describeActionPlan(latest.event).hold.body !== plan.hold.body) {
        throw new SiteInspectionRequiredError('Hold explicitly rejected, but the same event was not freshly confirmed sold out; inspect the page manually.');
      }
      if (options.resumeAfterSoldOut) guard.resetRejectedReservation(plan);
      log('hold-rejected-sold-out', { slot: start.time, slotKey: plan.slotKey });
      return { status: 'sold-out', plan };
    }
    if (response.status() < 200 || response.status() >= 300 || result !== '1' || !guard.state.holdConfirmed) {
      throw new AmbiguousReservationError('The one-shot hold did not produce explicit success; automation stops without retrying reservation.');
    }
    await page.waitForURL((url) => url.origin === EIPRO_ORIGIN && url.pathname === CUSTOMER_PATH, { waitUntil: 'domcontentloaded', timeout: timeouts.customerFormMs });
    const deadline = performance.now() + timeouts.customerFormMs;
    while (performance.now() < deadline) {
      await throwIfManual(page);
      if (await isCustomerFormReady(page)) {
        log('customer-form-ready', { slot: start.time, durationMs: performance.now() - started });
        return { status: 'customer-form-ready', plan };
      }
      await page.waitForTimeout(250);
    }
    throw new AmbiguousReservationError('A hold succeeded but a recognizable customer form did not become ready. Keep the browser open for manual inspection.');
  } catch (error) {
    if (!guard.state.holdDispatched) guard.disarmReservation();
    if (error instanceof SiteInspectionRequiredError && guard.confirmedHoldRejection) throw error;
    if (error instanceof ManualInterventionError || error instanceof AmbiguousReservationError) throw error;
    throw new AmbiguousReservationError('Reservation outcome is uncertain after the official action; keep the browser open and do not retry the hold.');
  }
}
