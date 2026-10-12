import type { Browser, BrowserContext, BrowserContextOptions, Request, Route } from 'playwright';

export type RunMode = 'inspect' | 'rehearsal' | 'full-rehearsal' | 'live';

export class SafetyError extends Error {
  override name = 'SafetyError';
}

export function assertSideEffectsAuthorized(mode: RunMode, confirmed: boolean): void {
  if ((mode !== 'full-rehearsal' && mode !== 'live') || confirmed !== true) {
    throw new SafetyError('Reservation actions require full-rehearsal/live and --confirm-reservation-side-effects.');
  }
}

/** Fields are validated independently; missing, extra and duplicate fields are rejected. */
export type FieldRule = (
  | { readonly kind: 'constant'; readonly value: string }
  | { readonly kind: 'one-of'; readonly values: readonly string[] }
  | { readonly kind: 'integer'; readonly min: number; readonly max: number }
  | { readonly kind: 'date'; readonly separator?: '-' | '/' }
  | { readonly kind: 'opaque-token'; readonly minLength: number; readonly maxLength: number }
) & { readonly repeat?: { readonly min: number; readonly max: number } };

export interface ReadRequestRule {
  readonly pathname: string;
  readonly method: 'GET' | 'POST';
  readonly query?: Readonly<Record<string, FieldRule>>;
  readonly form?: Readonly<Record<string, FieldRule>>;
}

export interface RequestSnapshot {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
  readonly contentType?: string;
}

/** Exact requests, captured from verified site code, rather than patterns or prefix allowlists. */
export interface ReservationPlan {
  readonly slotKey: string;
  readonly hold: RequestSnapshot;
  readonly customerNavigation: RequestSnapshot;
}

export interface GuardOptions {
  readonly mode: RunMode;
  readonly confirmed: boolean;
  readonly origin: string;
  readonly readRules: readonly ReadRequestRule[];
  readonly holdPath: string;
  readonly customerPath: string;
  readonly requestTimeoutMs?: number;
  readonly onDecision?: (event: GuardEvent) => void;
}

export type DecisionKind = 'read' | 'hold' | 'customer-navigation' | 'blocked';

export interface GuardDecision {
  readonly allowed: boolean;
  readonly kind: DecisionKind;
  readonly reason: string;
  readonly slotKey?: string;
}

export interface GuardEvent extends GuardDecision {
  readonly method: string;
  /** No body, cookie, authorization header, or customer query values are logged. */
  readonly url: string;
  readonly redirect?: boolean;
}

/** Unknown, rejected and redirected hold outcomes cannot authorize a customer flow. */
export function isSuccessfulHoldResponse(status: number, payload: unknown): boolean {
  if (!Number.isInteger(status) || status < 200 || status >= 300 || typeof payload !== 'object' || payload === null || !('data' in payload)) return false;
  const data = payload.data;
  return typeof data === 'object' && data !== null && 'result' in data && data.result === '1';
}

/** Official TEMPORARY_HOLD_RESULT_FAILURE is the string '0'; missing data is unknown. */
export function isRejectedHoldResponse(status: number, payload: unknown): boolean {
  if (!Number.isInteger(status) || status < 200 || status >= 300 || typeof payload !== 'object' || payload === null || !('data' in payload)) return false;
  const data = payload.data;
  return typeof data === 'object' && data !== null && 'result' in data && data.result === '0';
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.searchParams.sort();
  return url.href;
}

function validField(value: string, rule: FieldRule): boolean {
  switch (rule.kind) {
    case 'constant': return value === rule.value;
    case 'one-of': return rule.values.includes(value);
    case 'integer': return /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= rule.min && Number(value) <= rule.max;
    case 'date': {
      const separator = rule.separator ?? '-';
      if (separator === '-' ? !/^\d{4}-\d{2}-\d{2}$/.test(value) : !/^\d{4}\/\d{2}\/\d{2}$/.test(value)) return false;
      const isoValue = value.replaceAll('/', '-');
      const parsed = new Date(`${isoValue}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === isoValue;
    }
    case 'opaque-token': return value.length >= rule.minLength && value.length <= rule.maxLength && /^[A-Za-z0-9_-]+$/.test(value);
  }
}

function matchesFields(params: URLSearchParams, rules: Readonly<Record<string, FieldRule>> = {}): boolean {
  const entries = [...params.entries()];
  const names = Object.keys(rules);
  if (entries.some(([key]) => !names.includes(key))) return false;
  return names.every(name => {
    const values = params.getAll(name);
    const rule = rules[name];
    if (!rule) return false;
    const min = rule.repeat?.min ?? 1;
    const max = rule.repeat?.max ?? 1;
    return values.length >= min && values.length <= max && values.every(value => validField(value, rule));
  });
}

function formContentType(value: string | undefined): boolean {
  return value?.split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

function exactRequestMatches(request: RequestSnapshot, expected: RequestSnapshot): boolean {
  if (request.method !== expected.method || normalizedUrl(request.url) !== normalizedUrl(expected.url)) return false;
  if (expected.contentType !== undefined && request.contentType?.split(';')[0]?.trim().toLowerCase() !== expected.contentType.split(';')[0]?.trim().toLowerCase()) return false;
  if (request.body === expected.body) return true;
  if (!formContentType(request.contentType) || !formContentType(expected.contentType) || request.body === null || expected.body === null) return false;
  const actual = new URLSearchParams(request.body);
  const wanted = new URLSearchParams(expected.body);
  actual.sort();
  wanted.sort();
  return actual.toString() === wanted.toString();
}

function redactedUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}`;
  } catch {
    return '[invalid URL]';
  }
}

/** One guard per slot/context; only an explicitly rejected hold can be reset. */
export class SafetyGuard {
  private readonly options: GuardOptions;
  private plan: ReservationPlan | undefined;
  private holdDispatched = false;
  private holdConfirmed = false;
  private holdRejected = false;
  private customerDispatched = false;
  private handedOff = false;

  constructor(options: GuardOptions) {
    if (!['inspect', 'rehearsal', 'full-rehearsal', 'live'].includes(options.mode)) throw new SafetyError('Unknown mode.');
    const origin = new URL(options.origin);
    if (origin.origin !== options.origin || !['https:', 'http:'].includes(origin.protocol)) throw new SafetyError('Guard requires an exact HTTP(S) origin.');
    if (!options.holdPath.startsWith('/') || !options.customerPath.startsWith('/') || options.holdPath === options.customerPath) throw new SafetyError('Invalid reservation endpoint definitions.');
    const copy = structuredClone({ ...options, onDecision: undefined });
    this.options = Object.freeze({ ...copy, onDecision: options.onDecision });
    for (const rule of this.options.readRules) {
      if (!rule.pathname.startsWith('/') || rule.pathname.includes('?') || rule.pathname === options.holdPath || rule.pathname === options.customerPath) throw new SafetyError('Read rules cannot include reservation endpoints.');
      if (rule.method === 'GET' && rule.form !== undefined) throw new SafetyError('GET read rules cannot define a form body.');
      if (rule.method === 'POST' && rule.form === undefined) throw new SafetyError('Read POST requires an explicit verified form schema.');
    }
  }

  assertCanReserve(): void {
    assertSideEffectsAuthorized(this.options.mode, this.options.confirmed);
    if (this.handedOff) throw new SafetyError('Automation has ended after human handoff.');
    if (this.holdDispatched) throw new SafetyError('A hold was already dispatched; do not retry an ambiguous reservation action.');
  }

  armReservation(plan: ReservationPlan): void {
    this.assertCanReserve();
    if (this.plan) throw new SafetyError('A reservation capability is already armed.');
    const hold = new URL(plan.hold.url);
    const customer = new URL(plan.customerNavigation.url);
    if (!plan.slotKey || hold.origin !== this.options.origin || hold.pathname !== this.options.holdPath || plan.hold.method !== 'POST' || plan.hold.body === null) throw new SafetyError('Hold must be an exact verified same-origin POST.');
    if (customer.origin !== this.options.origin || customer.pathname !== this.options.customerPath || plan.customerNavigation.method !== 'GET' || plan.customerNavigation.body !== null) throw new SafetyError('Customer navigation must be an exact verified same-origin GET.');
    this.plan = structuredClone(plan);
  }

  disarmReservation(): void {
    this.plan = undefined;
  }

  get confirmedHoldRejection(): boolean {
    return this.holdDispatched && this.holdRejected && !this.holdConfirmed && !this.customerDispatched && !this.handedOff;
  }

  /** Caller must also verify fresh sold-out data for this exact event before resetting. */
  resetRejectedReservation(plan: ReservationPlan): void {
    if (this.options.mode !== 'live' || !this.confirmedHoldRejection || !this.plan || this.plan.slotKey !== plan.slotKey
        || !exactRequestMatches(plan.hold, this.plan.hold)) {
      throw new SafetyError('Only the exact explicitly rejected hold can return to monitoring.');
    }
    this.plan = undefined;
    this.holdDispatched = false;
    this.holdRejected = false;
  }

  get state(): Readonly<{ holdDispatched: boolean; holdConfirmed: boolean; customerDispatched: boolean; handedOff: boolean }> {
    return { holdDispatched: this.holdDispatched, holdConfirmed: this.holdConfirmed, customerDispatched: this.customerDispatched, handedOff: this.handedOff };
  }

  /** Pure decision path is shared by browser routing and tests. Allowed side effects consume capability. */
  evaluate(request: RequestSnapshot, redirect = false): GuardDecision {
    let decision: GuardDecision = { allowed: false, kind: 'blocked', reason: 'Request is outside the immutable verified read allowlist.' };
    try {
      const url = new URL(request.url);
      if (this.handedOff) {
        decision = { allowed: false, kind: 'blocked', reason: 'Automation has ended; guard must be removed by explicit human handoff.' };
      } else if (url.origin !== this.options.origin || url.username || url.password) {
        decision = { allowed: false, kind: 'blocked', reason: 'Unverified origin or embedded credentials.' };
      } else if (this.isRead(request, url)) {
        decision = { allowed: true, kind: 'read', reason: 'Verified read request.' };
      } else if (!redirect && this.plan && this.options.confirmed && ['full-rehearsal', 'live'].includes(this.options.mode)) {
        if (!this.holdDispatched && exactRequestMatches(request, this.plan.hold)) {
          this.holdDispatched = true;
          decision = { allowed: true, kind: 'hold', reason: 'Consumed one-shot hold capability.', slotKey: this.plan.slotKey };
        } else if (this.holdConfirmed && !this.customerDispatched && exactRequestMatches(request, this.plan.customerNavigation)) {
          this.customerDispatched = true;
          decision = { allowed: true, kind: 'customer-navigation', reason: 'Consumed one-shot customer-navigation capability.', slotKey: this.plan.slotKey };
        }
      }
    } catch {
      decision = { allowed: false, kind: 'blocked', reason: 'Malformed request.' };
    }
    this.emit({ ...decision, method: request.method, url: redactedUrl(request.url), ...(redirect ? { redirect: true } : {}) });
    return decision;
  }

  private isRead(request: RequestSnapshot, url: URL): boolean {
    return this.options.readRules.some(rule => {
      if (rule.pathname !== url.pathname || rule.method !== request.method || !matchesFields(url.searchParams, rule.query)) return false;
      if (rule.method === 'GET') return request.body === null;
      return formContentType(request.contentType) && request.body !== null && matchesFields(new URLSearchParams(request.body), rule.form);
    });
  }

  private emit(event: GuardEvent): void {
    try { this.options.onDecision?.(event); } catch { /* Diagnostics must never disable network enforcement. */ }
  }

  /** Keep interception installed through autofill; only the terminal user takeover removes it. */
  async handoffToHuman(context: BrowserContext): Promise<void> {
    assertSideEffectsAuthorized(this.options.mode, this.options.confirmed);
    this.handedOff = true;
    await context.unrouteAll({ behavior: 'wait' });
  }

  readonly routeHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    const snapshot = snapshotRequest(request);
    const decision = this.evaluate(snapshot);
    if (!decision.allowed) {
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    try {
      // Browser routing is not guaranteed to see later redirect hops. Fetch and check
      // each hop ourselves; fulfilling only the final response prevents unsafe redirects.
      let current = snapshot;
      for (let hop = 0; hop <= 8; hop += 1) {
        const response = await route.fetch({
          url: current.url,
          method: current.method,
          postData: current.body ?? '',
          maxRedirects: 0,
          maxRetries: 0,
          timeout: this.options.requestTimeoutMs ?? 20_000,
        });
        const status = response.status();
        const location = response.headers()['location'];
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          const nextUrl = new URL(location, current.url).href;
          const rewriteToGet = status === 303 || ((status === 301 || status === 302) && current.method === 'POST');
          const next: RequestSnapshot = { url: nextUrl, method: rewriteToGet ? 'GET' : current.method, body: rewriteToGet ? null : current.body, contentType: current.contentType };
          const nextDecision = this.evaluate(next, true);
          await response.dispose();
          if (!nextDecision.allowed) throw new SafetyError('Blocked an unverified redirect before dispatch.');
          current = next;
          continue;
        }
        if (decision.kind === 'hold' && hop === 0) {
          let payload: unknown;
          try { payload = await response.json(); } catch { /* Unknown is never success. */ }
          this.holdConfirmed = isSuccessfulHoldResponse(status, payload);
          this.holdRejected = isRejectedHoldResponse(status, payload);
          this.emit({ allowed: this.holdConfirmed, kind: 'hold', reason: this.holdConfirmed ? 'Official hold explicitly confirmed success.' : this.holdRejected ? 'Official hold explicitly rejected; customer navigation remains blocked.' : 'Official hold outcome unconfirmed; customer navigation remains blocked.', method: snapshot.method, url: redactedUrl(snapshot.url), ...(decision.slotKey ? { slotKey: decision.slotKey } : {}) });
        }
        await route.fulfill({ response });
        await response.dispose();
        return;
      }
      throw new SafetyError('Redirect limit exceeded.');
    } catch (error) {
      this.emit({ allowed: false, kind: 'blocked', reason: error instanceof SafetyError ? error.message : `Guarded network dispatch failed (${error instanceof Error ? error.name : 'unknown error'}); no automatic action retry.`, method: snapshot.method, url: redactedUrl(snapshot.url) });
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  };
}

function snapshotRequest(request: Request): RequestSnapshot {
  return { url: request.url(), method: request.method(), body: request.postData(), contentType: request.headers()['content-type'] };
}

export async function installSafetyGuard(context: BrowserContext, options: GuardOptions): Promise<SafetyGuard> {
  const guard = new SafetyGuard(options);
  await context.route('**/*', guard.routeHandler);
  await context.routeWebSocket('**/*', socket => {
    if (guard.state.handedOff) socket.connectToServer();
    else socket.close({ code: 1008, reason: 'Unverified websocket blocked by safety guard.' });
  });
  return guard;
}

/** Use this factory so service workers cannot escape BrowserContext routing. */
export async function createGuardedContext(browser: Browser, contextOptions: BrowserContextOptions, options: GuardOptions): Promise<{ context: BrowserContext; guard: SafetyGuard }> {
  const context = await browser.newContext({ ...contextOptions, serviceWorkers: 'block' });
  try {
    const guard = await installSafetyGuard(context, options);
    return { context, guard };
  } catch (error) {
    await context.close();
    throw error;
  }
}
