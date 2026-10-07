import { describe, expect, it } from 'vitest';
import { createActionPlan, describeActionPlan, parseAvailability, type SiteEvent } from '../src/site.js';

const TARGET_DATE = '2026-10-26';

/** Synthetic schema fixture; identifiers do not describe a real reservation. */
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    service_cd: 'service-fixture-123',
    session_cd: 'session-fixture-456',
    service_start_datetime: '2026/10/26 10:00:00',
    service_end_datetime: '2026/10/26 10:30:00',
    order_remain_amount: '15',
    ordable: true,
    reserve_possible: true,
    is_reserve_started: true,
    is_reserve_dead: false,
    is_full: false,
    enabled_flg: true,
    is_accept: true,
    calendar_select_action_type: '1',
    ...overrides,
  };
}

function payload(events: unknown[], errors: unknown[] = []): unknown {
  return { results: events, errors };
}

function availableEvent(): SiteEvent {
  const result = parseAvailability(payload([event()]), TARGET_DATE, '10:00');
  if (result.status !== 'available' || !result.event) throw new Error('Synthetic fixture must be available');
  return result.event;
}

describe('official availability schema', () => {
  it('accepts an exact target event with affirmative official availability flags', () => {
    const result = parseAvailability(payload([event()]), TARGET_DATE, '10:00');
    expect(result.status).toBe('available');
    expect(result.event).toMatchObject({
      service_cd: 'service-fixture-123',
      session_cd: 'session-fixture-456',
      service_start_datetime: '2026/10/26 10:00:00',
      service_end_datetime: '2026/10/26 10:30:00',
    });
  });

  it('selects 10:00 and 10:30 independently from the same calendar response', () => {
    const first = event();
    const second = event({
      session_cd: 'session-fixture-1030',
      service_start_datetime: '2026/10/26 10:30:00',
      service_end_datetime: '2026/10/26 11:00:00',
    });
    const data = payload([second, first]);
    expect(parseAvailability(data, TARGET_DATE, '10:00').event?.session_cd).toBe('session-fixture-456');
    expect(parseAvailability(data, TARGET_DATE, '10:30').event?.session_cd).toBe('session-fixture-1030');
  });

  it('does not infer availability from a positive remaining count before release', () => {
    const result = parseAvailability(payload([event({
      order_remain_amount: '15',
      ordable: false,
      reserve_possible: false,
      is_reserve_started: false,
    })]), TARGET_DATE, '10:00');
    expect(result.status).toBe('unavailable');
    expect(result.event).toMatchObject({ service_cd: 'service-fixture-123' });
  });

  it.each([
    ['ordable', false],
    ['reserve_possible', false],
    ['is_reserve_started', false],
    ['enabled_flg', false],
    ['is_accept', false],
    ['is_reserve_dead', true],
    ['is_full', true],
  ])('reports unavailable when official flag %s blocks reservations', (name, value) => {
    const result = parseAvailability(payload([event({ [name]: value })]), TARGET_DATE, '10:00');
    expect(result.status).toBe('unavailable');
    expect(result.event).toMatchObject({ service_cd: 'service-fixture-123' });
  });

  it.each(['ordable', 'reserve_possible', 'is_reserve_started', 'enabled_flg', 'is_accept', 'is_reserve_dead', 'is_full'])('requires an actual boolean for %s instead of truthiness', (name) => {
      for (const value of ['true', 'false', '1', '0', 1, 0, null, undefined]) {
        const result = parseAvailability(payload([event({ [name]: value })]), TARGET_DATE, '10:00');
        expect(result.status, `${name}=${String(value)}`).toBe('unknown');
        expect(result.event).toBeUndefined();
      }
  });

  it('does not let an unavailable 10:00 change an available 10:30 result', () => {
    const data = payload([
      event({ is_full: true }),
      event({ session_cd: 'session-fixture-1030', service_start_datetime: '2026/10/26 10:30:00', service_end_datetime: '2026/10/26 11:00:00' }),
    ]);
    expect(parseAvailability(data, TARGET_DATE, '10:00').status).toBe('unavailable');
    expect(parseAvailability(data, TARGET_DATE, '10:30').status).toBe('available');
  });

  it.each(['0', 'many', '', 'Infinity', '-1', null, undefined])('uses remaining %s only as diagnostics and requires official booleans', (remaining) => {
    const data = event({ order_remain_amount: remaining });
    expect(parseAvailability(payload([data]), TARGET_DATE, '10:00').status).toBe('available');
    expect(parseAvailability(payload([{ ...data, reserve_possible: undefined }]), TARGET_DATE, '10:00').status).toBe('unknown');
  });

  it.each([null, undefined, 'HTML maintenance page', {}, [], { results: null }, { results: {} }, { data: { results: [event()] } }])('reports unknown for an unverified response shape', (data) => {
      const result = parseAvailability(data, TARGET_DATE, '10:00');
      expect(result.status).toBe('unknown');
      expect(result.event).toBeUndefined();
      expect(result.reason).toEqual(expect.any(String));
  });

  it('reports unknown when the target is absent instead of treating another date as success', () => {
    expect(parseAvailability(payload([]), TARGET_DATE, '10:00').status).toBe('unknown');
    expect(parseAvailability(payload([event({ service_start_datetime: '2026/10/25 10:00:00', service_end_datetime: '2026/10/25 10:30:00' })]), TARGET_DATE, '10:00').status).toBe('unknown');
    expect(parseAvailability(payload([event({ service_start_datetime: '2026/10/26 11:00:00', service_end_datetime: '2026/10/26 11:30:00' })]), TARGET_DATE, '10:00').status).toBe('unknown');
  });

  it('reports unknown if official API errors accompany apparently available results', () => {
    expect(parseAvailability(payload([event()], ['search temporarily unavailable']), TARGET_DATE, '10:00').status).toBe('unknown');
  });

  it('rejects ambiguous duplicate target events', () => {
    const duplicate = event({ session_cd: 'session-fixture-another' });
    const result = parseAvailability(payload([event(), duplicate]), TARGET_DATE, '10:00');
    expect(result.status).toBe('unknown');
    expect(result.event).toBeUndefined();
  });

  it.each(['service_cd', 'session_cd', 'service_start_datetime', 'service_end_datetime', 'calendar_select_action_type'])('fails closed when required official field %s is absent', (name) => {
      const result = parseAvailability(payload([event({ [name]: undefined })]), TARGET_DATE, '10:00');
      expect(result.status).not.toBe('available');
      expect(result.event).toBeUndefined();
  });

  it.each([
    { service_start_datetime: '2026-10-26T10:00:00+09:00' },
    { service_start_datetime: '2026/10/26 10:00:59' },
    { service_end_datetime: '2026/10/26 09:30:00' },
    { service_end_datetime: '2026/10/26 10:00:00' },
    { service_end_datetime: 'invalid' },
    { calendar_select_action_type: '2' },
    { calendar_select_action_type: 1 },
    { min_service_end_datetime: '2026/10/26 10:30:00', max_service_end_datetime: '2026/10/26 11:00:00' },
  ])('rejects unverified or flexible datetime / action data', (overrides) => {
    expect(parseAvailability(payload([event(overrides)]), TARGET_DATE, '10:00').status).not.toBe('available');
  });
});

describe('official reservation action plan', () => {
  it('previews actual unavailable target identifiers in rehearsal without authorizing execution', () => {
    const result = parseAvailability(payload([event({ ordable: false, reserve_possible: false, is_reserve_started: false })]), TARGET_DATE, '10:00');
    expect(result.status).toBe('unavailable');
    if (!result.event) throw new Error('A confirmed unavailable event must remain available for read-only diagnostics');
    const preview = describeActionPlan(result.event);
    expect(preview.slotKey).toBe('2026-10-26 10:00');
    expect(new URLSearchParams(preview.hold.body ?? '').get('data[service_session_cd]')).toBe('session-fixture-456');
    expect(() => createActionPlan(result.event!)).toThrow();
  });

  it('does not construct a preview from unknown or incomplete identifiers', () => {
    expect(() => describeActionPlan({ ...availableEvent(), session_cd: '' })).toThrow();
    expect(() => describeActionPlan({ ...availableEvent(), reserve_possible: undefined } as unknown as SiteEvent)).toThrow();
  });

  it('uses verified official hold fields and maps session_cd to service_session_cd', () => {
    const plan = createActionPlan(availableEvent());
    const holdUrl = new URL(plan.hold.url, 'https://eipro.jp');
    expect(holdUrl.origin).toBe('https://eipro.jp');
    expect(holdUrl.pathname).toBe('/takachiho1/apiServices/api/hold_slot');
    expect(plan.hold.method).toBe('POST');
    expect(plan.hold.contentType).toMatch(/^application\/x-www-form-urlencoded/u);
    const body = new URLSearchParams(plan.hold.body ?? '');
    expect(Object.fromEntries(body)).toEqual({
      'data[service_cd]': 'service-fixture-123',
      'data[service_session_cd]': 'session-fixture-456',
      'data[service_start_datetime]': '2026/10/26 10:00:00',
      'data[service_end_datetime]': '2026/10/26 10:30:00',
    });
    expect(body.has('data[session_cd]')).toBe(false);
  });

  it('shows the customer GET action with unwrapped query keys', () => {
    const plan = createActionPlan(availableEvent());
    const customerUrl = new URL(plan.customerNavigation.url, 'https://eipro.jp');
    expect(customerUrl.origin).toBe('https://eipro.jp');
    expect(customerUrl.pathname).toBe('/takachiho1/orders/add');
    expect(plan.customerNavigation.method).toBe('GET');
    expect(plan.customerNavigation.body).toBeNull();
    expect(Object.fromEntries(customerUrl.searchParams)).toEqual({
      service_cd: 'service-fixture-123',
      service_session_cd: 'session-fixture-456',
      service_start_datetime: '2026/10/26 10:00:00',
      service_end_datetime: '2026/10/26 10:30:00',
    });
  });

  it('revalidates availability before constructing a side-effect action', () => {
    const parsed = availableEvent();
    expect(() => createActionPlan({ ...parsed, ordable: false })).toThrow();
    expect(() => createActionPlan({ ...parsed, is_full: true })).toThrow();
    expect(() => createActionPlan({ ...parsed, service_cd: '' })).toThrow();
  });
});
