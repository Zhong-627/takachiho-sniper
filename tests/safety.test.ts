import { describe, expect, it } from 'vitest';
import { assertSideEffectsAuthorized, isRejectedHoldResponse, isSuccessfulHoldResponse, SafetyGuard, type GuardOptions, type ReadRequestRule, type RequestSnapshot, type ReservationPlan } from '../src/safety.js';
import { CUSTOMER_PATH, EIPRO_ORIGIN, EIPRO_READ_RULES, HOLD_PATH } from '../src/site-rules.js';

const origin = 'https://example.test';
const rules: ReadRequestRule[] = [
  { pathname: '/calendar', method: 'GET' },
  { pathname: '/calendar/search', method: 'POST', form: { date: { kind: 'date' }, action: { kind: 'constant', value: 'availability' } } },
];
const options = (overrides: Partial<GuardOptions> = {}): GuardOptions => ({ mode: 'rehearsal', confirmed: false, origin, readRules: rules, holdPath: '/hold', customerPath: '/orders', ...overrides });
const get = (path: string): RequestSnapshot => ({ url: origin + path, method: 'GET', body: null });
const post = (path: string, body: string): RequestSnapshot => ({ url: origin + path, method: 'POST', body, contentType: 'application/x-www-form-urlencoded; charset=UTF-8' });
const plan: ReservationPlan = { slotKey: '10:00', hold: post('/hold', 'slot=10%3A00&date=2026-10-26'), customerNavigation: get('/orders?slot=10%3A00&date=2026-10-26') };

describe('explicit side-effect authorization', () => {
  it.each(['inspect', 'rehearsal'] as const)('refuses %s even with confirmation', mode => {
    expect(() => assertSideEffectsAuthorized(mode, true)).toThrow('--confirm-reservation-side-effects');
    expect(() => new SafetyGuard(options({ mode, confirmed: true })).armReservation(plan)).toThrow();
  });

  it.each(['full-rehearsal', 'live'] as const)('requires explicit confirmation in %s', mode => {
    expect(() => assertSideEffectsAuthorized(mode, false)).toThrow();
    expect(() => assertSideEffectsAuthorized(mode, true)).not.toThrow();
  });
});

describe('immutable fail-closed read allowlist', () => {
  it('allows exact verified reads and rejects unknown URLs, methods, origins and GET query keys', () => {
    const guard = new SafetyGuard(options());
    expect(guard.evaluate(get('/calendar')).allowed).toBe(true);
    for (const request of [get('/hold'), get('/orders'), get('/unknown'), get('/calendar?hold=true'), post('/calendar', ''), { ...get('/calendar'), url: 'https://evil.test/calendar' }, { ...get('/calendar'), url: 'https://user:pass@example.test/calendar' }, { ...get('/calendar'), method: 'HEAD' }]) {
      expect(guard.evaluate(request).allowed).toBe(false);
    }
  });

  it('validates POST schema, including duplicates, impossible dates, content type and extra fields', () => {
    const guard = new SafetyGuard(options());
    expect(guard.evaluate(post('/calendar/search', 'date=2026-10-26&action=availability')).allowed).toBe(true);
    for (const body of ['date=2026-10-26', 'date=2026-10-26&action=hold', 'date=2026-10-26&action=availability&slot=10', 'date=2026-10-26&date=2026-10-26&action=availability', 'date=2026-02-30&action=availability']) {
      expect(guard.evaluate(post('/calendar/search', body)).allowed).toBe(false);
    }
    expect(guard.evaluate({ ...post('/calendar/search', 'date=2026-10-26&action=availability'), contentType: 'text/plain' }).allowed).toBe(false);
  });

  it('snapshots caller-owned rules so later mutation cannot grant access', () => {
    const mutable: ReadRequestRule[] = [...rules];
    const guard = new SafetyGuard(options({ readRules: mutable }));
    mutable.push({ pathname: '/hold', method: 'GET' });
    expect(guard.evaluate(get('/hold')).allowed).toBe(false);
  });

  it('refuses reservation endpoints masquerading as reads', () => {
    expect(() => new SafetyGuard(options({ readRules: [{ pathname: '/hold', method: 'GET' }] }))).toThrow();
    expect(() => new SafetyGuard(options({ readRules: [{ pathname: '/calendar/search', method: 'POST' }] }))).toThrow();
  });

  it('continues enforcement when logging throws and redacts potentially personal query/body values', () => {
    const events: string[] = [];
    const guard = new SafetyGuard(options({ onDecision: event => { events.push(JSON.stringify(event)); throw new Error('logger broken'); } }));
    expect(guard.evaluate(post('/unknown?email=private%40example.test', 'secret=password')).allowed).toBe(false);
    expect(events.join()).not.toContain('private');
    expect(events.join()).not.toContain('password');
  });
});

describe('one-shot reservation capability', () => {
  it('requires exact hold and explicit successful response; blocks premature customer navigation, payment and repeated holds', () => {
    const guard = new SafetyGuard(options({ mode: 'live', confirmed: true }));
    expect(guard.evaluate(plan.hold).allowed).toBe(false);
    guard.armReservation(plan);
    expect(guard.evaluate(plan.customerNavigation).allowed).toBe(false);
    expect(guard.evaluate(post('/hold', 'slot=10%3A30&date=2026-10-26')).allowed).toBe(false);
    expect(guard.evaluate({ ...plan.hold, contentType: 'application/json' }).allowed).toBe(false);
    expect(guard.evaluate(plan.hold).kind).toBe('hold');
    expect(guard.evaluate(plan.hold).allowed).toBe(false);
    expect(() => guard.assertCanReserve()).toThrow('already dispatched');
    expect(() => guard.armReservation(plan)).toThrow();
    expect(guard.evaluate(plan.customerNavigation).allowed).toBe(false);
    expect(guard.evaluate(post('/orders', 'card=123')).allowed).toBe(false);
    expect(guard.state).toEqual({ holdDispatched: true, holdConfirmed: false, customerDispatched: false, handedOff: false });
  });

  it('consumes hold permission before response, preventing retry after a timeout/error', () => {
    const guard = new SafetyGuard(options({ mode: 'full-rehearsal', confirmed: true }));
    guard.armReservation(plan);
    expect(guard.evaluate(plan.hold).allowed).toBe(true);
    guard.disarmReservation();
    expect(() => guard.armReservation(plan)).toThrow();
  });

  it('cannot use an allowed redirect to dispatch an armed reservation', () => {
    const guard = new SafetyGuard(options({ mode: 'live', confirmed: true }));
    guard.armReservation(plan);
    expect(guard.evaluate(plan.hold, true).allowed).toBe(false);
    expect(guard.state.holdDispatched).toBe(false);
  });

  it('maintains independent capabilities for 10:00 and 10:30 contexts', () => {
    const first = new SafetyGuard(options({ mode: 'live', confirmed: true }));
    const second = new SafetyGuard(options({ mode: 'live', confirmed: true }));
    const secondPlan: ReservationPlan = { slotKey: '10:30', hold: post('/hold', 'slot=10%3A30&date=2026-10-26'), customerNavigation: get('/orders?slot=10%3A30&date=2026-10-26') };
    first.armReservation(plan);
    second.armReservation(secondPlan);
    expect(first.evaluate(plan.hold).allowed).toBe(true);
    expect(second.evaluate(secondPlan.hold).allowed).toBe(true);
    expect(second.evaluate(secondPlan.customerNavigation).allowed).toBe(false);
  });

  it('requires official string result=1 and successful HTTP status, never unknown/numeric/rejected outcomes', () => {
    expect(isSuccessfulHoldResponse(200, { data: { result: '1' } })).toBe(true);
    for (const payload of [undefined, null, {}, { result: '1' }, { data: { result: 1 } }, { data: { result: '9' } }, { data: { result: '0' } }]) expect(isSuccessfulHoldResponse(200, payload)).toBe(false);
    for (const status of [199, 302, 429, 500]) expect(isSuccessfulHoldResponse(status, { data: { result: '1' } })).toBe(false);
  });

  it('requires a successful HTTP response with explicit string zero to prove rejection', () => {
    expect(isRejectedHoldResponse(200, { data: { result: '0' } })).toBe(true);
    for (const payload of [undefined, null, {}, { data: {} }, { data: { result: 0 } }, { data: { result: '1' } }, { data: { result: '8' } }, { data: { result: '9' } }]) {
      expect(isRejectedHoldResponse(200, payload)).toBe(false);
    }
    for (const status of [199, 302, 429, 500]) expect(isRejectedHoldResponse(status, { data: { result: '0' } })).toBe(false);
  });

  it('cannot reset a dispatched hold merely because success has not been confirmed', () => {
    const guard = new SafetyGuard(options({ mode: 'live', confirmed: true }));
    expect(() => guard.resetRejectedReservation(plan)).toThrow('explicitly rejected');
    guard.armReservation(plan);
    guard.evaluate(plan.hold);
    expect(guard.confirmedHoldRejection).toBe(false);
    expect(() => guard.resetRejectedReservation(plan)).toThrow('explicitly rejected');
    expect(() => guard.assertCanReserve()).toThrow('already dispatched');
  });
});

describe('actual observed eipro read rules', () => {
  const guard = () => new SafetyGuard({ mode: 'inspect', confirmed: false, origin: EIPRO_ORIGIN, readRules: EIPRO_READ_RULES, holdPath: HOLD_PATH, customerPath: CUSTOMER_PATH });

  it('accepts observed calendar schema while rejecting hold requests regardless of method', () => {
    const body = new URLSearchParams({
      'data[conds][ServiceView][max_session_dateOver]': '2026/10/26',
      'data[conds][ServiceView][min_session_dateUnder]': '2026/10/27',
      action_token: '01234567-89ab-cdef-0123-456789abcdef',
      root_action: 'index', 'data[ServiceView][id]': '', 'data[ServiceView][cd]': '',
      calendar_view_name: 'agendaDay', calendar_type: 'day',
    });
    expect(guard().evaluate({ url: EIPRO_ORIGIN + '/takachiho1/eventCalendars/search', method: 'POST', body: body.toString(), contentType: 'application/x-www-form-urlencoded' }).allowed).toBe(true);
    expect(guard().evaluate({ url: EIPRO_ORIGIN + HOLD_PATH, method: 'POST', body: 'slot=10' }).allowed).toBe(false);
    expect(guard().evaluate({ url: EIPRO_ORIGIN + HOLD_PATH, method: 'GET', body: null }).allowed).toBe(false);
  });

  it('only allows exact verified file-compress targets with bounded numeric cache', () => {
    const prefix = EIPRO_ORIGIN + '/common/library/file-compress/compress.php';
    const target = '/common/js/app.extra.pagetop-motion.js,/common/js/app.extra.ajax-paging.js,/common/js/app.extra.zip-address.js,/common/js/app.extra.ajax-resolve.js,/common/js/app.extra.multiple-input.js';
    expect(guard().evaluate({ url: prefix + '?' + new URLSearchParams({ target, cache: '1791331614' }).toString() + '&cache=1791331614', method: 'GET', body: null }).allowed).toBe(true);
    for (const suffix of ['?target=/takachiho1/apiServices/api/hold_slot&cache=1', '?' + new URLSearchParams({ target, cache: 'not-numeric' }).toString(), '?' + new URLSearchParams({ target, cache: '1', extra: 'hold' }).toString()]) {
      expect(guard().evaluate({ url: prefix + suffix, method: 'GET', body: null }).allowed).toBe(false);
    }
  });
});
