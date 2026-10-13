import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { launchSlotBrowser } from './browser.js';
import { assertLiveMonitoringWindow, assertReservationTargetsUnchanged, monitoringStartMs, parseConfig, validateModeConfig, type AppConfig, type RunMode } from './config.js';
import { createDiagnostics, type Diagnostics } from './diagnostics.js';
import { prepareCustomerForm } from './customer-step.js';
import { assertLiveReadiness, type LiveReadiness } from './readiness.js';
import { createGuardedContext, type SafetyGuard } from './safety.js';
import { pollSlot, runIndependentSlots, type ReservationActionResult, type SlotOutcome } from './scheduler.js';
import { describeActionPlan, openCalendar, performReservation, probeAvailability, ManualInterventionError, SiteInspectionRequiredError, type SiteEvent } from './site.js';
import { retryDelayMs, RetryableProbeError } from './retry.js';
import { CUSTOMER_PATH, EIPRO_ORIGIN, EIPRO_READ_RULES, HOLD_PATH } from './site-rules.js';
import { cancellableSleep, formatReleaseTimes, throwIfAborted, waitUntilRelease } from './time.js';

interface Session {
  slot: string;
  active: boolean;
  handedOff: boolean;
  autofillEligible?: boolean;
  browser?: Browser;
  context?: BrowserContext;
  guard?: SafetyGuard;
  page?: Page;
}

export function personalSecrets(config: AppConfig): string[] {
  return Object.values(config.customers).flatMap((customer) => customer ? [customer.representativeName,
    ...Object.entries(customer.fields).filter(([key, value]) => value.length > 0 && !(/^\d{1,3}$/u.test(value) && /(?:count|people|person|adult|child|age|sex|gender)/iu.test(key))).map(([, value]) => value),
  ] : []).filter(Boolean);
}

export function printFormReadiness(readiness: LiveReadiness): void {
  for (const entry of readiness.formVerification) {
    console.log(`[${entry.slot}] ${entry.status === 'manual' ? '客戶資料採人工填寫；取得船位後輸入 handoff。'
      : entry.status === 'recent' ? '已有近期表單驗證紀錄；自動填表仍須核對當次表單。'
        : '自動填表待當次表單確認：缺少近期相符紀錄，不阻止搶位。'}`);
  }
}

async function fillSession(session: Session, config: AppConfig, diagnostics: Diagnostics, manualCustomerForm: boolean, prepareForm: typeof prepareCustomerForm = prepareCustomerForm): Promise<ReservationActionResult> {
  if (!session.page || !session.guard || session.handedOff || !session.autofillEligible) return { status: 'manual', reason: 'Held customer page is not eligible for automated entry.' };
  const customer = config.customers[session.slot];
  if (!customer) return { status: 'manual', reason: 'Local customer configuration is missing.' };
  const step = await prepareForm(session.page, customer, { manualCustomerForm });
  const result = step.result;
  diagnostics.event('customer_form_mode', { mode: manualCustomerForm ? 'manual' : 'auto' }, session.slot);
  diagnostics.event('autofill_result', { status: result.status, customerFieldsVerified: result.customerFieldsVerified, filledKeys: result.filledKeys, missingMappingKeys: result.missingMappingKeys, missingRequiredControls: result.missingRequiredControls, manualControls: result.manualControls, errors: result.errors }, session.slot);
  await diagnostics.writeJson(`form-${session.slot.replace(':', '')}.json`, {
    ...result.schema,
    controls: result.schema.controls.map((control) => ({
      ...control,
      // Inspected option definitions, never entered input values.
      options: control.category === 'customer' ? control.options.map((option) => ({ optionValue: option.value, label: option.label, disabled: option.disabled })) : [],
    })),
  });
  if (step.verificationRecordFailed) diagnostics.event('form_verification_record_failed', { reason: 'Optional local evidence could not be saved; the held customer page is preserved.' }, session.slot);
  await diagnostics.snapshot(session.page, manualCustomerForm ? 'customer-manual' : 'customer-autofill', session.slot);
  console.log(`[${session.slot}] ${result.customerFieldsVerified ? '客戶欄位填寫與 HTML 檢查通過；請人工完成後續操作。'
    : `客戶資料需要人工處理（${result.status}）；已保留頁面，輸入 handoff ${session.slot} 接手。`}`);
  if (!manualCustomerForm && result.status === 'mapping-required') console.log('可依 form 診斷修正本機 mappings，儲存後輸入 f 在同一頁重新檢查；不會再次 hold。');
  return { status: step.status, reason: step.reason };
}

export interface WorkerSlotStatus {
  slot: string;
  active: boolean;
  handedOff: boolean;
  canHandoff: boolean;
  holdConfirmed: boolean;
}
export interface WorkerStatus {
  runId: string;
  targetDate: string;
  slots: WorkerSlotStatus[];
  automationStopped: boolean;
  closed: boolean;
}
export interface ReservationRun {
  status(): WorkerStatus;
  stop(): void;
  handoff(slot: string): Promise<void>;
  close(): Promise<void>;
  wait(): Promise<PromiseSettledResult<SlotOutcome>[]>;
  refill(config: AppConfig, slot?: string): Promise<void>;
}

/** Injectable browser/site operations keep lifecycle tests away from official reservations. */
export const reservationRuntime = {
  launchSlotBrowser, createGuardedContext, createDiagnostics, assertLiveReadiness,
  openCalendar, probeAvailability, performReservation, waitUntilRelease, prepareCustomerForm,
};
export type ReservationRuntime = typeof reservationRuntime;
export interface RunOptions {
  mode: RunMode;
  confirmed: boolean;
  manualCustomerForm: boolean;
  slot?: string;
  attempts?: number;
  runtime?: ReservationRuntime;
  runId?: string;
}

export async function startReservationRun(config: AppConfig, options: { manualCustomerForm: boolean; runtime?: ReservationRuntime; runId?: string }): Promise<ReservationRun> {
  return startRun(config, { ...options, mode: 'live', confirmed: true });
}

/** Shared CLI and controller implementation; only callers decide how operators give commands. */
export async function startRun(input: AppConfig, options: RunOptions): Promise<ReservationRun> {
  const config = parseConfig(input);
  const mode = options.mode;
  const sideEffects = mode === 'live' || mode === 'full-rehearsal';
  const runtime = options.runtime ?? reservationRuntime;
  validateModeConfig(config, mode, options.confirmed, options.slot, options.manualCustomerForm);
  let readiness: LiveReadiness | undefined;
  if (mode === 'live') {
    readiness = await runtime.assertLiveReadiness(config, undefined, undefined, options.manualCustomerForm);
    assertLiveMonitoringWindow(config);
  }
  const runId = options.runId ?? randomUUID();
  let closed = false;
  let closing = false;
  let closingPromise: Promise<void> | undefined;
  const busySlots = new Set<string>();
  const secrets = personalSecrets(config);
  const diagnostics = await runtime.createDiagnostics(config.artifactsDir, mode, secrets);
  const abort = new AbortController();
  const slots = mode === 'full-rehearsal' ? [options.slot as string] : config.slots;
  const sessions = new Map(slots.map((slot) => [slot, { slot, active: true, handedOff: false } as Session]));
  diagnostics.event('run_started', { mode, targetDate: config.targetDate, slots, releaseAt: config.releaseAt, monitorFromAt: new Date(monitoringStartMs(config)).toISOString(), release: formatReleaseTimes(Date.parse(config.releaseAt)), monitorFrom: formatReleaseTimes(monitoringStartMs(config)), monitorUntil: config.monitorUntil, platform: process.platform, arch: process.arch, node: process.version });
  console.log(`模式 ${mode}；日期 ${config.targetDate}；時段 ${slots.join(' / ')}；診斷 ${diagnostics.dir}`);
  if (mode === 'live') console.log(`開始查詢：${formatReleaseTimes(monitoringStartMs(config)).taipei}；監控截止：${formatReleaseTimes(Date.parse(config.monitorUntil!)).taipei}；正常查詢回應後等待約 ${config.polling.baseDelayMs} ms。`);
  if (readiness) { diagnostics.event('live_readiness', { ...readiness }); printFormReadiness(readiness); }
  const stop = (): void => { if (abort.signal.aborted) return; abort.abort(); diagnostics.event('automation_stopped'); console.log('已要求停止自動化，瀏覽器保留中。'); };
  const heartbeat = setInterval(() => console.log(`等待／執行中：${formatReleaseTimes(Date.now()).taipei}`), 30_000);
  heartbeat.unref();
  // This log-only heartbeat keeps the independent phone monitor honest even
  // during long waits or after a hold while the operator console stays open.
  const reportMonitorHeartbeat = (): void => diagnostics.event('monitor_heartbeat', {
    automationActive: !abort.signal.aborted && [...sessions.values()].some((session) => session.active),
  });
  if (mode === 'live') reportMonitorHeartbeat();
  const monitorHeartbeat = mode === 'live' ? setInterval(reportMonitorHeartbeat, 10_000) : undefined;
  monitorHeartbeat?.unref();
  const worker = async (slot: string) => {
    const session = sessions.get(slot)!;
    const log = (event: string, data: Record<string, unknown> = {}): void => diagnostics.event(event, { ...data, ...(event === 'slot-selection' ? { timeSinceReleaseMs: Date.now() - Date.parse(config.releaseAt) } : {}) }, slot);
    try {
      throwIfAborted(abort.signal);
      session.browser = await runtime.launchSlotBrowser(config);
      throwIfAborted(abort.signal);
      // Follow the visible window size so manual payment controls cannot be
      // clipped below a smaller Mac display by a fixed emulated viewport.
      const guarded = await runtime.createGuardedContext(session.browser, { locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: null, acceptDownloads: false }, {
        mode, confirmed: options.confirmed, origin: EIPRO_ORIGIN, readRules: EIPRO_READ_RULES, holdPath: HOLD_PATH, customerPath: CUSTOMER_PATH, requestTimeoutMs: config.timeouts.navigationMs,
        onDecision: (decision) => log('safety_decision', { ...decision }),
      });
      session.context = guarded.context; session.guard = guarded.guard;
      session.page = await session.context.newPage();
      session.page.setDefaultTimeout(config.timeouts.actionMs);
      diagnostics.attach(session.page, slot);
      for (let attempt = 1; ; attempt += 1) {
        try {
          const snapshot = await runtime.openCalendar(session.page, config.targetDate, config.timeouts, log);
          await diagnostics.writeJson(`calendar-${slot.replace(':', '')}.json`, { clientEvents: snapshot.clientEvents, domEvents: snapshot.domEvents, responseMs: snapshot.responseMs });
          break;
        }
        catch (error) {
          if (!(error instanceof RetryableProbeError) || attempt >= 3) throw error;
          const delayMs = retryDelayMs(attempt, config.polling, error.retryAfterMs);
          log('navigation_retry', { attempt, delayMs });
          await cancellableSleep(delayMs, abort.signal);
        }
      }
      if (mode !== 'live' || Date.now() < monitoringStartMs(config) - 5000) {
        await diagnostics.snapshot(session.page, 'calendar-warmup', slot);
      } else log('warmup_screenshot_skipped', { reason: 'Keep the imminent release action free of screenshot work.' });
      if (mode === 'live') {
        const warmupAt = monitoringStartMs(config) - config.warmupSeconds * 1000;
        if (Date.now() < warmupAt) {
          await runtime.waitUntilRelease(warmupAt, { signal: abort.signal, onEvent: log });
          await runtime.openCalendar(session.page, config.targetDate, config.timeouts, log);
          log('session_warmed');
        }
        await runtime.waitUntilRelease(monitoringStartMs(config), { signal: abort.signal, onEvent: log });
      }
      let currentEvent: SiteEvent | undefined;
      const outcome = await pollSlot({
        slot, signal: abort.signal, onEvent: log, retry: config.polling,
        ...(mode === 'live' ? { deadlineAtMs: Date.parse(config.monitorUntil!), releaseAtMs: Date.parse(config.releaseAt) }
          : { maxAttempts: options.attempts ?? (mode === 'inspect' ? 1 : 3) }),
        probe: async () => {
          let observation;
          try { observation = await runtime.probeAvailability(session.page!, config.targetDate, slot, config.timeouts, log); }
          catch (error) {
            if (error instanceof ManualInterventionError || error instanceof SiteInspectionRequiredError) return { status: 'manual' as const, reason: error.message };
            throw error;
          }
          currentEvent = observation.event;
          if (currentEvent) {
            const plan = describeActionPlan(currentEvent);
            log('reservation_action_plan', { available: observation.status === 'available', hold: { method: plan.hold.method, path: HOLD_PATH, slot }, plannedFields: { service_cd: currentEvent.service_cd, service_session_cd: currentEvent.session_cd, service_start_datetime: currentEvent.service_start_datetime, service_end_datetime: currentEvent.service_end_datetime }, customerNavigation: { method: 'GET', path: CUSTOMER_PATH }, sideEffectsEnabled: sideEffects });
            if (!sideEffects) console.log(`[${slot}] ${observation.status}；若官方開放，會選擇 ${currentEvent.service_start_datetime}，執行 hold → 客戶資料頁。本模式不執行 hold。`);
          }
          return observation;
        },
        act: async () => {
          if (mode === 'inspect' || mode === 'rehearsal') {
            log('safe_rehearsal_would_reserve', { slot });
            return { status: 'manual', reason: 'Safe mode: reservation action intentionally suppressed.' };
          }
          if (!currentEvent) throw new Error('No validated current target event.');
          try {
            const reservation = await runtime.performReservation(session.page!, currentEvent, session.guard!, config.timeouts, log,
              { ...(mode === 'live' ? { deadlineAtMs: Date.parse(config.monitorUntil!), resumeAfterSoldOut: true } : {}), signal: abort.signal });
            if (reservation.status === 'deadline-reached') return { status: 'deadline-reached', reason: 'Monitoring ended before dispatching a hold.' };
            if (reservation.status === 'sold-out') {
              if (mode !== 'live') return { status: 'failed', reason: 'Rehearsal hold rejected; target confirmed sold out.' };
              console.log(`[${slot}] 已確認暫留失敗且額滿，回到餘位監控。`);
              return { status: 'retry-monitoring', reason: 'Exact hold explicitly rejected and same event freshly confirmed sold out.' };
            }
            session.autofillEligible = true;
            return await fillSession(session, config, diagnostics, options.manualCustomerForm, runtime.prepareCustomerForm);
          } catch (error) {
            if (error instanceof ManualInterventionError || error instanceof SiteInspectionRequiredError) return { status: 'manual' as const, reason: error.message };
            throw error;
          }
        },
      });
      log('slot_outcome', { ...outcome });
      await diagnostics.snapshot(session.page, 'slot-finished', slot);
      console.log(outcome.status === 'deadline-reached' ? `[${slot}] 已到監控截止時間，停止查詢並保留頁面（${outcome.attempts} 次讀取）。`
        : `[${slot}] ${outcome.status} (${outcome.attempts} 次讀取)。`);
      return outcome;
    } catch (error) {
      log('slot_error', { message: error instanceof ManualInterventionError || error instanceof SiteInspectionRequiredError ? error.message : 'Slot stopped after browser/navigation/config error. See sanitized network diagnostics.' });
      if (session.page) await diagnostics.snapshot(session.page, 'error', slot);
      console.log(`[${slot}] 已停止，請查看 diagnostics。另一時段會繼續。`);
      throw new Error(`Slot ${slot} stopped; browser kept for manual inspection.`);
    } finally { session.active = false; }
  };
  const work = runIndependentSlots(slots, worker).then(async (results) => {
    diagnostics.event('automation_finished');
    await diagnostics.writeJson('slot-outcomes.json', results);
    clearInterval(heartbeat);
    console.log('所有時段自動化已結束。');
    return results;
  });
  const canHandoff = (session: Session): boolean => sideEffects && !closed && !closing && !session.active
    && !session.handedOff && !busySlots.has(session.slot) && Boolean(session.guard && session.context);
  const status = (): WorkerStatus => ({
    runId, targetDate: config.targetDate, automationStopped: abort.signal.aborted, closed,
    slots: [...sessions.values()].map((session) => ({
      slot: session.slot, active: session.active, handedOff: session.handedOff,
      canHandoff: canHandoff(session), holdConfirmed: session.guard?.state.holdConfirmed === true,
    })),
  });
  const handoff = async (slot: string): Promise<void> => {
    const session = sessions.get(slot);
    if (!session || !canHandoff(session)) throw new Error('This slot is running, unavailable, or already handed off.');
    busySlots.add(slot);
    try {
      await session.guard!.handoffToHuman(session.context!);
      session.handedOff = true;
      diagnostics.event('human_handoff', {}, slot);
      console.log(`[${slot}] 已交由 Mac 人工操作。請自行完成最後確認、信用卡及 3D Secure。`);
    } catch { throw new Error('Handoff did not complete; the browser is preserved.'); }
    finally { busySlots.delete(slot); }
  };
  const refill = async (updated: AppConfig, slot?: string): Promise<void> => {
    if (manualCustomerForm) throw new Error('Manual customer mode disables automated filling.');
    if (closed || closing) throw new Error('This run is closed.');
    if (sideEffects) assertReservationTargetsUnchanged(config, updated);
    validateModeConfig(updated, mode, options.confirmed, options.slot, options.manualCustomerForm);
    diagnostics.addSecrets(personalSecrets(updated));
    for (const session of sessions.values()) {
      if ((slot && session.slot !== slot) || session.active || session.handedOff || busySlots.has(session.slot)) continue;
      busySlots.add(session.slot);
      try { await fillSession(session, updated, diagnostics, false, runtime.prepareCustomerForm); }
      finally { busySlots.delete(session.slot); }
    }
  };
  const manualCustomerForm = options.manualCustomerForm;
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (closingPromise) return closingPromise;
    closing = true;
    stop();
    // Finish an already-dispatched hold before closing. stop() alone never closes any page.
    closingPromise = (async () => {
      await work;
      const results = await Promise.allSettled([...sessions.values()].map((session) => session.browser?.close()));
      if (results.some((result) => result.status === 'rejected')) throw new Error('Browser shutdown could not be confirmed; this run remains locked.');
      clearInterval(heartbeat);
      clearInterval(monitorHeartbeat);
      await diagnostics.close();
      closed = true;
    })().finally(() => { closing = false; closingPromise = undefined; });
    return closingPromise;
  };
  return { status, stop, handoff, close, wait: () => work, refill };
}
