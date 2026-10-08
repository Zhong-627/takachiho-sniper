import { existsSync } from 'node:fs';
import { chromium, type APIResponse, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { autofillCustomer } from '../src/autofill.js';
import { parseConfig, validateModeConfig } from '../src/config.js';
import { runIndependentSlots } from '../src/scheduler.js';
import { SafetyGuard, type GuardDecision, type RunMode } from '../src/safety.js';
import { CUSTOMER_PATH, EIPRO_ORIGIN, EIPRO_READ_RULES, HOLD_PATH } from '../src/site-rules.js';
import {
  CALENDAR_URL, SEARCH_PATH, ManualInterventionError, detectManualSignal,
  openCalendar, parseAvailability, performReservation, probeAvailability, SiteInspectionRequiredError, type SiteEvent,
} from '../src/site.js';

const targetDate = '2026-10-26';
const timeouts = { navigationMs: 5000, actionMs: 3000, customerFormMs: 5000 };
const fixtureEvents: SiteEvent[] = ['10:00', '10:30'].map((slot, index) => ({
  service_cd: 'service-fixture-123',
  session_cd: `session-fixture-${index}`,
  service_start_datetime: `2026/10/26 ${slot}:00`,
  service_end_datetime: `2026/10/26 ${index === 0 ? '10:30' : '11:00'}:00`,
  order_remain_amount: '15', calendar_select_action_type: '1',
  ordable: true, reserve_possible: true, is_reserve_started: true,
  is_reserve_dead: false, is_full: false, enabled_flg: true, is_accept: true,
}));

// This is an explicit synthetic UI fixture, not a claim about unobserved customer DOM.
const customerHtml = `<!doctype html><title>Fixture customer</title><h1>Customer Information</h1>
  <form id="fixture-customer">
    <label for="fixture-name">Name</label><input id="fixture-name" name="name" required>
    <label for="fixture-email">Email</label><input id="fixture-email" name="email" type="email" required>
    <label for="fixture-card">Credit card</label><input id="fixture-card" autocomplete="cc-number" required>
    <label for="fixture-otp">OTP</label><input id="fixture-otp" autocomplete="one-time-code">
    <button type="submit">Confirm payment</button>
  </form>`;

function calendarHtml(state: Pick<Fixture, 'initialCaptcha' | 'skipRender' | 'renderDelayMs' | 'navigationDelayMs' | 'initialViewErrors' | 'backgroundClassName' | 'events'>): string {
  return `<!doctype html><title>Fixture calendar</title>
    ${state.initialCaptcha ? '<div class="captcha-challenge">Synthetic challenge</div>' : ''}
    <form id="mainForm">
    <div class="fullcalendar_control_bar" data-target_selector="#service-full-calendar.fullcalendar_fixture" style="width:100%;height:0;overflow:visible">
      <button data-target_view_name="agendaDay" id="day" style="float:left">Day</button>
      <select class="fullcalendar_control_date_list" id="date" style="float:left">
        <option value="2026/10/07">2026/10/07</option>${[...new Set(state.events.map((event) => event.service_start_datetime.slice(0, 10)))].map((date) => `<option value="${date}">${date}</option>`).join('')}
      </select>
    </div>
    <div id="service-full-calendar" class="fullcalendar_fixture" style="min-height:200px"></div>
    </form>
    <script>
      let view = 'month', date = '2026-10-07', events = [];
      let initialViewErrors = ${JSON.stringify(state.initialViewErrors)};
      async function readCalendar() {
        const body = new URLSearchParams({
          'data[conds][ServiceView][max_session_dateOver]': date.replaceAll('-', '/'),
          'data[conds][ServiceView][min_session_dateUnder]': date.replaceAll('-', '/'),
          action_token: 'synthetic-fixture-token-000000', root_action: 'index',
          'data[ServiceView][id]': '', 'data[ServiceView][cd]': '',
          calendar_view_name: view, calendar_type: view === 'agendaDay' ? 'day' : 'month',
        });
        const response = await fetch('${SEARCH_PATH}', {method: 'POST', body});
        const payload = await response.json();
        if (${JSON.stringify(state.skipRender)}) return;
        await new Promise(resolve => setTimeout(resolve, ${JSON.stringify(state.renderDelayMs)}));
        events = payload.results || [];
        const backgroundClassName = ${JSON.stringify(state.backgroundClassName)};
        if (backgroundClassName !== null) events.push({
          className: backgroundClassName, rendering: 'background',
          start: '2026-10-26', end: '2026-10-27',
        });
        document.querySelector('#service-full-calendar').innerHTML = events.map(event =>
          '<div class="' + (event.rendering === 'background' ? 'fc-bgevent' : 'fc-event') + '">' + (event.service_start_datetime || '') +
          '<input class="service_unit_service_start_datetime" value="' + event.service_start_datetime + '">' +
          '<input class="service_unit_service_end_datetime" value="' + event.service_end_datetime + '">' +
          '<input class="service_unit_service_cd" value="' + event.service_cd + '">' +
          '<input class="service_unit_service_session_cd" value="' + event.session_cd + '"></div>'
        ).join('');
      }
      window.jQuery = () => ({fullCalendar(operation, value) {
        if (operation === 'getView') {
          if (initialViewErrors > 0) { initialViewErrors--; throw new Error('Synthetic plugin initialization is pending'); }
          return {name: view};
        }
        if (operation === 'getDate') return {format: () => date};
        if (operation === 'clientEvents') return events;
        if (operation === 'changeView') view = value;
        if (operation === 'refetchEvents') void readCalendar().catch(() => {});
      }});
      document.querySelector('#day').onclick = () => { view = 'agendaDay'; };
      document.querySelector('#date').onchange = event => {
        date = event.target.value.replaceAll('/', '-');
        void readCalendar().catch(() => {});
      };
      const order = {
        isTemporaryHoldReservationOptionAvailable: () => true,
        makeOrderUrl(service, session, start, end) {
          const params = new URLSearchParams({service_cd: service, service_session_cd: session,
            service_start_datetime: start, service_end_datetime: end});
          return '${CUSTOMER_PATH}?' + params.toString();
        },
        link(service, session, start, end) {
          const body = new URLSearchParams({'data[service_cd]': service, 'data[service_session_cd]': session,
            'data[service_start_datetime]': start, 'data[service_end_datetime]': end});
          void fetch('${HOLD_PATH}', {method: 'POST', body}).then(response => response.json()).then(payload => {
            if (payload.data.result === '1') setTimeout(() => {
              location.href = order.makeOrderUrl(service, session, start, end);
            }, ${JSON.stringify(state.navigationDelayMs)});
          }).catch(() => {});
        },
      };
      window.App = {Module: {Front: {Order: order}}};
    </script>`;
}

interface Fixture {
  events: SiteEvent[];
  context: BrowserContext;
  page: Page;
  guard: SafetyGuard;
  requests: Array<{ pathname: string; method: string; decision: GuardDecision }>;
  searchStatus: number;
  holdResult: string;
  initialCaptcha: boolean;
  skipRender: boolean;
  renderDelayMs: number;
  navigationDelayMs: number;
  initialViewErrors: number;
  backgroundClassName: string | string[] | null;
}

async function fixture(browser: Browser, mode: RunMode): Promise<Fixture> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let latestDecision: GuardDecision | undefined;
  const guard = new SafetyGuard({
    mode, confirmed: mode === 'full-rehearsal' || mode === 'live',
    origin: EIPRO_ORIGIN, readRules: EIPRO_READ_RULES, holdPath: HOLD_PATH, customerPath: CUSTOMER_PATH,
    onDecision: (decision) => { latestDecision = decision; },
  });
  const state: Fixture = {
    events: fixtureEvents,
    context, page: await context.newPage(), guard, requests: [], searchStatus: 200, holdResult: '1',
    initialCaptcha: false, skipRender: false, renderDelayMs: 100,
    navigationDelayMs: 10,
    initialViewErrors: 0,
    backgroundClassName: null,
  };
  // All transport responses are synthetic. The real guard checks every request/hold result;
  // its Route.fetch dependency is replaced below and can never reach an external server.
  await context.route('**/*', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    let captured = false;
    const capture = (): void => {
      if (captured) return;
      if (!latestDecision) throw new Error('The real guard must evaluate each fixture request');
      state.requests.push({ pathname, method: request.method(), decision: latestDecision });
      captured = true;
    };
    const proxy = {
      request: () => request,
      abort: async () => { capture(); await route.abort('blockedbyclient'); },
      fetch: async () => {
        capture();
        const status = pathname === SEARCH_PATH ? state.searchStatus : 200;
        const payload = pathname === SEARCH_PATH ? { results: state.events, errors: [] } : { data: { result: state.holdResult } };
        const body = pathname === new URL(CALENDAR_URL).pathname ? calendarHtml(state)
          : pathname === CUSTOMER_PATH ? customerHtml : JSON.stringify(payload);
        const headers = { 'content-type': pathname === SEARCH_PATH || pathname === HOLD_PATH ? 'application/json' : 'text/html', 'retry-after': '2' };
        return { status: () => status, headers: () => headers, json: async () => payload,
          body: async () => Buffer.from(body), dispose: async () => undefined } as unknown as APIResponse;
      },
      fulfill: async (options: { response: APIResponse }) => {
        await route.fulfill({ status: options.response.status(), headers: options.response.headers(), body: await options.response.body() });
      },
    } as unknown as Route;
    await guard.routeHandler(proxy);
  });
  return state;
}

const executable = process.env.PLAYWRIGHT_TEST_EXECUTABLE_PATH
  ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH
  ?? [chromium.executablePath(), '/usr/bin/chromium'].find((candidate) => existsSync(candidate));

describe.runIf(executable !== undefined)('offline browser adapter fixtures', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: executable, headless: true }); }, 20_000);
  afterAll(async () => { await browser?.close(); });

  it('opens the observed day/date controls and independently detects both slots', async () => {
    const state = await fixture(browser, 'inspect');
    try {
      const snapshot = await openCalendar(state.page, targetDate, timeouts, vi.fn());
      expect(snapshot.httpStatus).toBe(200);
      expect(parseAvailability(snapshot.payload, targetDate, '10:00').status).toBe('available');
      expect(parseAvailability(snapshot.payload, targetDate, '10:30').status).toBe('available');
      expect((await probeAvailability(state.page, targetDate, '10:30', timeouts, vi.fn())).status).toBe('available');
      expect(state.requests.filter((request) => request.pathname === SEARCH_PATH)).toHaveLength(2);
      expect(state.requests.some((request) => request.pathname === HOLD_PATH)).toBe(false);
    } finally { await state.context.close(); }
  });

  it('blocks a reservation even if rehearsal accidentally invokes the official link', async () => {
    const state = await fixture(browser, 'rehearsal');
    try {
      await openCalendar(state.page, targetDate, timeouts, vi.fn());
      const waiting = state.page.waitForRequest((request) => new URL(request.url()).pathname === HOLD_PATH);
      await state.page.evaluate((event) => {
        const site = window as unknown as { App: { Module: { Front: { Order: { link: (...args: string[]) => void } } } } };
        site.App.Module.Front.Order.link(event.service_cd, event.session_cd, event.service_start_datetime, event.service_end_datetime);
      }, fixtureEvents[0]!);
      await waiting;
      await expect.poll(() => state.requests.filter((request) => request.pathname === HOLD_PATH).length).toBe(1);
      await expect(performReservation(state.page, fixtureEvents[0]!, state.guard, timeouts, vi.fn())).rejects.toThrow(/require/u);
      expect(state.requests.filter((request) => request.pathname === HOLD_PATH)).toMatchObject([{ decision: { allowed: false, kind: 'blocked' } }]);
      expect(state.guard.state).toMatchObject({ holdDispatched: false, customerDispatched: false });
    } finally { await state.context.close(); }
  });

  it('runs one protected hold to customer autofill and leaves card/OTP untouched', async () => {
    const state = await fixture(browser, 'full-rehearsal');
    try {
      await openCalendar(state.page, targetDate, timeouts, vi.fn());
      const log = vi.fn();
      const result = await performReservation(state.page, fixtureEvents[0]!, state.guard, timeouts, log);
      expect(result.plan.slotKey).toBe('2026-10-26 10:00');
      expect(log).toHaveBeenCalledWith('customer-form-ready', expect.objectContaining({ slot: '10:00' }));
      expect(state.guard.state).toMatchObject({ holdDispatched: true, customerDispatched: true });
      const filled = await autofillCustomer(state.page, {
        representativeName: 'Synthetic Fixture',
        fields: { name: 'Synthetic Fixture', email: 'fixture@example.invalid' },
        mappings: [{ key: 'name', selector: 'input#fixture-name' }, { key: 'email', selector: 'input#fixture-email' }],
      });
      expect(filled.customerFieldsVerified).toBe(true);
      expect(filled.status).toBe('manual-required');
      expect(await state.page.locator('#fixture-card').inputValue()).toBe('');
      expect(await state.page.locator('#fixture-otp').inputValue()).toBe('');
      expect(state.requests.filter((request) => request.pathname === HOLD_PATH && request.decision.allowed)).toHaveLength(1);
      expect(state.requests.filter((request) => request.pathname === CUSTOMER_PATH && request.method !== 'GET')).toHaveLength(0);
      await expect(performReservation(state.page, fixtureEvents[0]!, state.guard, timeouts, vi.fn())).rejects.toThrow(/already dispatched/u);
    } finally { await state.context.close(); }
  });

  it('uses a different configured date and two arbitrary slots with their own customer data', async () => {
    const config = parseConfig({ targetDate: '2026-11-03', releaseAt: '2026-10-20T08:00:00+08:00', slots: ['09:15', '11:45'],
      customers: Object.fromEntries(['09:15', '11:45'].map((slot, index) => [slot, {
        representativeName: `Synthetic Person ${index}`,
        fields: { representativeName: `Synthetic Person ${index}`, email: `fixture-${index}@example.invalid` },
        mappings: [{ key: 'representativeName', selector: 'input#fixture-name' }, { key: 'email', selector: 'input#fixture-email' }],
      }])),
    });
    validateModeConfig(config, 'live', true);
    const events = config.slots.map((slot, index): SiteEvent => ({ ...fixtureEvents[index]!,
      service_start_datetime: `${config.targetDate.replaceAll('-', '/')} ${slot}:00`,
      service_end_datetime: `${config.targetDate.replaceAll('-', '/')} ${index === 0 ? '09:45' : '12:15'}:00`,
    }));
    const results = await runIndependentSlots(config.slots, async (slot) => {
      const state = await fixture(browser, 'live');
      state.events = events;
      try {
        await openCalendar(state.page, config.targetDate, config.timeouts, vi.fn());
        const observation = await probeAvailability(state.page, config.targetDate, slot, config.timeouts, vi.fn());
        expect(observation.status).toBe('available');
        const result = await performReservation(state.page, observation.event!, state.guard, config.timeouts, vi.fn());
        expect(result.plan.slotKey).toBe(`${config.targetDate} ${slot}`);
        const customer = config.customers[slot]!;
        expect((await autofillCustomer(state.page, customer)).customerFieldsVerified).toBe(true);
        expect(await state.page.locator('#fixture-name').inputValue()).toBe(customer.representativeName);
        expect(await state.page.locator('#fixture-email').inputValue()).toBe(customer.fields.email);
        expect(await state.page.locator('#fixture-card').inputValue()).toBe('');
        expect(await state.page.locator('#fixture-otp').inputValue()).toBe('');
        expect(state.requests.filter((request) => request.pathname === HOLD_PATH && request.decision.allowed)).toHaveLength(1);
        expect(state.requests.filter((request) => request.pathname === CUSTOMER_PATH && request.method !== 'GET')).toHaveLength(0);
        await expect(performReservation(state.page, observation.event!, state.guard, config.timeouts, vi.fn())).rejects.toThrow(/already dispatched/u);
        return slot;
      } finally { await state.context.close(); }
    });
    expect(results).toEqual(config.slots.map((slot) => ({ status: 'fulfilled', value: slot })));
  });

  it('propagates server Retry-After on HTTP 429 without reservation requests', async () => {
    const state = await fixture(browser, 'inspect');
    try {
      await openCalendar(state.page, targetDate, timeouts, vi.fn());
      state.searchStatus = 429;
      await expect(probeAvailability(state.page, targetDate, '10:00', timeouts, vi.fn())).rejects.toMatchObject({ name: 'RetryableProbeError', retryAfterMs: 2000 });
      expect(state.requests.some((request) => request.pathname === HOLD_PATH)).toBe(false);
    } finally { await state.context.close(); }
  });

  it('stops after an ambiguous hold outcome and cannot dispatch another hold', async () => {
    const state = await fixture(browser, 'live');
    try {
      await openCalendar(state.page, targetDate, timeouts, vi.fn());
      state.holdResult = '0';
      await expect(performReservation(state.page, fixtureEvents[0]!, state.guard, timeouts, vi.fn())).rejects.toMatchObject({ name: 'AmbiguousReservationError' });
      await expect(performReservation(state.page, fixtureEvents[0]!, state.guard, timeouts, vi.fn())).rejects.toThrow(/already dispatched/u);
      expect(state.requests.filter((request) => request.pathname === HOLD_PATH && request.decision.allowed)).toHaveLength(1);
      expect(state.guard.state.customerDispatched).toBe(false);
    } finally { await state.context.close(); }
  });

  it('detects a visible CAPTCHA and stops the read loop for manual takeover', async () => {
    const state = await fixture(browser, 'inspect');
    try {
      await openCalendar(state.page, targetDate, timeouts, vi.fn());
      await state.page.evaluate(() => {
        const challenge = document.createElement('div');
        challenge.className = 'captcha-challenge';
        challenge.textContent = 'Synthetic challenge';
        document.body.appendChild(challenge);
      });
      expect((await detectManualSignal(state.page))?.kind).toBe('captcha');
      await expect(probeAvailability(state.page, targetDate, '10:00', timeouts, vi.fn())).rejects.toBeInstanceOf(ManualInterventionError);
      expect(state.requests.filter((request) => request.pathname === SEARCH_PATH)).toHaveLength(1);
    } finally { await state.context.close(); }
  });

  it('stops at an initial CAPTCHA without searching or sending a hold', async () => {
    const state = await fixture(browser, 'inspect');
    state.initialCaptcha = true;
    try {
      await expect(openCalendar(state.page, targetDate, timeouts, vi.fn())).rejects.toBeInstanceOf(ManualInterventionError);
      expect(state.requests.map((request) => request.pathname)).toEqual([new URL(CALENDAR_URL).pathname]);
    } finally { await state.context.close(); }
  });

  it('rejects a search response whose official callback never updates client events', async () => {
    const state = await fixture(browser, 'rehearsal');
    state.skipRender = true;
    try {
      await expect(openCalendar(state.page, targetDate, { ...timeouts, actionMs: 150 }, vi.fn())).rejects.toBeInstanceOf(SiteInspectionRequiredError);
      expect(state.requests.filter((request) => request.pathname === SEARCH_PATH)).toHaveLength(1);
      expect(state.requests.some((request) => request.pathname === HOLD_PATH)).toBe(false);
    } finally { await state.context.close(); }
  });

  it('retains explicitly confirmed guard proof across immediate customer navigation', async () => {
    const state = await fixture(browser, 'live');
    state.navigationDelayMs = 0;
    try {
      await openCalendar(state.page, targetDate, timeouts, vi.fn());
      const result = await performReservation(state.page, fixtureEvents[1]!, state.guard, timeouts, vi.fn());
      expect(result.status).toBe('customer-form-ready');
      expect(state.guard.state).toMatchObject({ holdConfirmed: true, customerDispatched: true });
      expect(new URL(state.page.url()).pathname).toBe(CUSTOMER_PATH);
    } finally { await state.context.close(); }
  });

  it('uses visible floated toolbar controls when the wrapper itself has zero height', async () => {
    const state = await fixture(browser, 'inspect');
    try {
      const snapshot = await openCalendar(state.page, targetDate, timeouts, vi.fn());
      expect((await state.page.locator('.fullcalendar_control_bar').boundingBox())?.height).toBe(0);
      expect((await state.page.locator('[data-target_view_name="agendaDay"]').boundingBox())?.height).toBeGreaterThan(0);
      expect(parseAvailability(snapshot.payload, targetDate, '10:00').status).toBe('available');
      expect(state.requests.some((request) => request.pathname === HOLD_PATH)).toBe(false);
    } finally { await state.context.close(); }
  });

  it('waits through bounded early FullCalendar getView initialization errors', async () => {
    const state = await fixture(browser, 'inspect');
    state.initialViewErrors = 2;
    try {
      const snapshot = await openCalendar(state.page, targetDate, timeouts, vi.fn());
      expect(parseAvailability(snapshot.payload, targetDate, '10:30').status).toBe('available');
      expect(state.requests.some((request) => request.pathname === HOLD_PATH)).toBe(false);
    } finally { await state.context.close(); }
  });

  it('selects the date after official binding rewrites the toolbar target selector', async () => {
    const state = await fixture(browser, 'inspect');
    try {
      const snapshot = await openCalendar(state.page, targetDate, timeouts, vi.fn());
      expect(await state.page.locator('#mainForm .fullcalendar_control_bar').getAttribute('data-target_selector')).toBe('#service-full-calendar.fullcalendar_fixture');
      expect(await state.page.locator('#mainForm .fullcalendar_control_date_list').inputValue()).toBe('2026/10/26');
      expect(parseAvailability(snapshot.payload, targetDate, '10:30').status).toBe('available');
      expect(state.requests.filter((request) => request.pathname === SEARCH_PATH)).toHaveLength(1);
      expect(state.requests.some((request) => request.pathname === HOLD_PATH)).toBe(false);
    } finally { await state.context.close(); }
  });

  it.each([
    { className: 'fc-holiday' },
    { className: 'fixture-style fc-holiday' },
    { className: ['fc-holiday'] },
    { className: ['fixture-style', 'fc-holiday'] },
  ])('ignores only the verified fc-holiday background source in callback synchronization ($className)', async ({ className }) => {
    const state = await fixture(browser, 'inspect');
    state.backgroundClassName = className;
    try {
      const snapshot = await openCalendar(state.page, targetDate, timeouts, vi.fn());
      expect(parseAvailability(snapshot.payload, targetDate, '10:00').status).toBe('available');
      expect(parseAvailability(snapshot.payload, targetDate, '10:30').status).toBe('available');
      expect(state.requests.filter((request) => request.pathname === SEARCH_PATH)).toHaveLength(1);
      expect(state.requests.some((request) => request.pathname === HOLD_PATH)).toBe(false);
    } finally { await state.context.close(); }
  });

  it.each(['unverified-background', 'fc-holiday-lookalike'])('fails closed for the unknown background source %s', async (className) => {
    const state = await fixture(browser, 'rehearsal');
    state.backgroundClassName = className;
    try {
      await expect(openCalendar(state.page, targetDate, { ...timeouts, actionMs: 350 }, vi.fn())).rejects.toBeInstanceOf(SiteInspectionRequiredError);
      expect(state.requests.some((request) => request.pathname === HOLD_PATH)).toBe(false);
    } finally { await state.context.close(); }
  });
});
