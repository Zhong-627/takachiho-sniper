import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { Browser, BrowserContext, Page } from 'playwright';
import { autofillCustomer } from './autofill.js';
import { launchSlotBrowser } from './browser.js';
import { parseCli } from './cli-options.js';
import { assertReservationTargetsUnchanged, loadConfig, parseConfig, ReservationTargetsChangedError, validateModeConfig, type AppConfig, type RunMode } from './config.js';
import { createDiagnostics, type Diagnostics } from './diagnostics.js';
import { assertLiveReadiness, recordVerifiedForm } from './readiness.js';
import { createGuardedContext, type SafetyGuard } from './safety.js';
import { pollSlot, runIndependentSlots } from './scheduler.js';
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

const help = `高千穗峽預約工具（Node.js 22+ / macOS Apple Silicon）
npm run inspect -- --config config/config.local.json
npm run rehearsal -- --attempts 3
npm run full-rehearsal -- --slot HH:mm --date YYYY-MM-DD --confirm-reservation-side-effects
npm run live -- --confirm-reservation-side-effects
npm run doctor
安全模式可加 --headless --close。個資與觀察到的表單 mappings 只存本機。
日期、開賣時間、1–2 個時段及各船個資由 local config 指定。時段使用日本當地 HH:mm。
瀏覽器保留時：f [HH:mm] 重新載入個資並填寫目前已 hold 的表單；handoff [HH:mm] 交由人工；q 關閉。
程式不送出客戶表單、不付款、不處理 CAPTCHA / OTP / 3D Secure。`;

function personalSecrets(config: AppConfig): string[] {
  return Object.values(config.customers).flatMap((customer) => customer ? [customer.representativeName,
    ...Object.entries(customer.fields).filter(([key, value]) => value.length > 0 && !(/^\d{1,3}$/u.test(value) && /(?:count|people|person|adult|child|age|sex|gender)/iu.test(key))).map(([, value]) => value),
  ] : []).filter(Boolean);
}

async function fillSession(session: Session, config: AppConfig, diagnostics: Diagnostics, mode: RunMode): Promise<void> {
  if (!session.page || !session.guard || session.handedOff || !session.autofillEligible) return;
  const customer = config.customers[session.slot];
  if (!customer) return;
  const result = await autofillCustomer(session.page, customer);
  diagnostics.event('autofill_result', { status: result.status, customerFieldsVerified: result.customerFieldsVerified, filledKeys: result.filledKeys, missingMappingKeys: result.missingMappingKeys, missingRequiredControls: result.missingRequiredControls, manualControls: result.manualControls, errors: result.errors }, session.slot);
  await diagnostics.writeJson(`form-${session.slot.replace(':', '')}.json`, {
    ...result.schema,
    controls: result.schema.controls.map((control) => ({
      ...control,
      // Inspected option definitions, never entered input values.
      options: control.category === 'customer' ? control.options.map((option) => ({ optionValue: option.value, label: option.label, disabled: option.disabled })) : [],
    })),
  });
  if (mode === 'full-rehearsal') await recordVerifiedForm(customer, result);
  await diagnostics.snapshot(session.page, 'customer-autofill', session.slot);
  console.log(`[${session.slot}] Autofill: ${result.status}。瀏覽器已保留；查看 form 診斷並完成必要人工操作。`);
  if (result.status === 'mapping-required') console.log('請在本機 config 加入 form 診斷中實際觀察到的 mappings，儲存後在此終端輸入 f；不會再次 hold。');
}

async function operatorConsole(sessions: Map<string, Session>, getConfig: () => Promise<AppConfig>, diagnostics: Diagnostics, mode: RunMode, abort: AbortController): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  console.log('瀏覽器保留中。輸入 f、handoff [時段] 或 q。Ctrl+C 只停止自動化；q 才關閉瀏覽器。');
  try {
    for await (const line of terminal) {
      const [command, slot] = line.trim().split(/\s+/u);
      const targets = [...sessions.values()].filter((session) => !slot || session.slot === slot);
      if (command === 'q') {
        abort.abort();
        await Promise.allSettled([...sessions.values()].map((session) => session.browser?.close()));
        return;
      }
      try {
        if (command === 'f') {
          const config = await getConfig();
          await Promise.allSettled(targets.filter((session) => !session.active && !session.handedOff).map((session) => fillSession(session, config, diagnostics, mode)));
        } else if (command === 'handoff') {
          if (mode === 'inspect' || mode === 'rehearsal') throw new Error('安全模式會持續阻擋 reservation 操作。');
          for (const session of targets) {
            if (session.active || session.handedOff || !session.guard || !session.context) { console.log(`[${session.slot}] 尚在執行或已交接；未解除保護。`); continue; }
            await session.guard.handoffToHuman(session.context);
            session.handedOff = true;
            diagnostics.event('human_handoff', {}, session.slot);
            console.log(`[${session.slot}] 已停止所有自動化並交由人工操作。請自行完成最後確認、信用卡及 3D Secure。`);
          }
        } else if (command) console.log('可用命令：f [時段]、handoff [時段]、q。');
      } catch (error) {
        console.log(error instanceof ReservationTargetsChangedError ? error.message : '操作未完成；請檢查本機設定或瀏覽器狀態。個資不會印出。');
      }
    }
    // EOF has no interactive operator. Shut down safely; holds expire server-side.
    abort.abort();
    await Promise.allSettled([...sessions.values()].map((session) => session.browser?.close()));
  } finally { terminal.close(); }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  const sideEffects = options.mode === 'live' || options.mode === 'full-rehearsal';
  const readLocalConfig = async (): Promise<AppConfig> => {
    const path = existsSync(options.config) ? options.config : !sideEffects && options.config === 'config/config.local.json' ? 'config/config.example.json' : options.config;
    const base = await loadConfig(path);
    return parseConfig({ ...base, ...(options.date ? { targetDate: options.date } : {}), browser: { ...base.browser, ...(options.headless ? { headless: true } : {}) } });
  };
  const config = await readLocalConfig();
  if (options.mode === 'doctor') {
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, targetDate: config.targetDate, release: formatReleaseTimes(Date.parse(config.releaseAt)), slots: config.slots, channel: config.browser.channel }, null, 2));
    try { validateModeConfig(config, 'live', true); await assertLiveReadiness(config); console.log('Live 本機設定及近期表單驗證紀錄檢查通過。仍需 Mac 真實網站演練。'); }
    catch (error) { console.log(error instanceof Error ? error.message : 'Live 尚未準備完成。'); process.exitCode = 2; }
    return;
  }
  const mode = options.mode;
  validateModeConfig(config, mode, options.confirmed, options.slot);
  if (sideEffects && !process.stdin.isTTY) throw new Error('Reservation modes require an interactive terminal for operator takeover.');
  if (mode === 'live') {
    await assertLiveReadiness(config);
    if (Date.now() > Date.parse(config.releaseAt) + 20 * 60_000) throw new Error('The live release window has elapsed. Use inspect/rehearsal for diagnostics.');
  }
  const secrets = personalSecrets(config);
  const diagnostics = await createDiagnostics(config.artifactsDir, mode, secrets);
  const abort = new AbortController();
  const slots = mode === 'full-rehearsal' ? [options.slot as string] : config.slots;
  const sessions = new Map(slots.map((slot) => [slot, { slot, active: true, handedOff: false } as Session]));
  diagnostics.event('run_started', { mode, targetDate: config.targetDate, slots, release: formatReleaseTimes(Date.parse(config.releaseAt)), platform: process.platform, arch: process.arch, node: process.version });
  console.log(`模式 ${mode}；日期 ${config.targetDate}；時段 ${slots.join(' / ')}；診斷 ${diagnostics.dir}`);
  const stop = (): void => { abort.abort(); console.log('已要求停止自動化，瀏覽器保留中。輸入 q 關閉。'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const heartbeat = setInterval(() => console.log(`等待／執行中：${formatReleaseTimes(Date.now()).taipei}`), 30_000);
  heartbeat.unref();
  const worker = async (slot: string) => {
    const session = sessions.get(slot)!;
    const log = (event: string, data: Record<string, unknown> = {}): void => diagnostics.event(event, { ...data, ...(event === 'slot-selection' ? { timeSinceReleaseMs: Date.now() - Date.parse(config.releaseAt) } : {}) }, slot);
    try {
      throwIfAborted(abort.signal);
      session.browser = await launchSlotBrowser(config);
      throwIfAborted(abort.signal);
      const guarded = await createGuardedContext(session.browser, { locale: 'ja-JP', timezoneId: 'Asia/Tokyo', viewport: { width: 1440, height: 1100 }, acceptDownloads: false }, {
        mode, confirmed: options.confirmed, origin: EIPRO_ORIGIN, readRules: EIPRO_READ_RULES, holdPath: HOLD_PATH, customerPath: CUSTOMER_PATH, requestTimeoutMs: config.timeouts.navigationMs,
        onDecision: (decision) => log('safety_decision', { ...decision }),
      });
      session.context = guarded.context; session.guard = guarded.guard;
      session.page = await session.context.newPage();
      session.page.setDefaultTimeout(config.timeouts.actionMs);
      diagnostics.attach(session.page, slot);
      for (let attempt = 1; ; attempt += 1) {
        try {
          const snapshot = await openCalendar(session.page, config.targetDate, config.timeouts, log);
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
      if (mode !== 'live' || Date.now() < Date.parse(config.releaseAt) - 5000) {
        await diagnostics.snapshot(session.page, 'calendar-warmup', slot);
      } else log('warmup_screenshot_skipped', { reason: 'Keep the imminent release action free of screenshot work.' });
      if (mode === 'live') {
        const warmupAt = Date.parse(config.releaseAt) - config.warmupSeconds * 1000;
        if (Date.now() < warmupAt) {
          await waitUntilRelease(warmupAt, { signal: abort.signal, onEvent: log });
          await openCalendar(session.page, config.targetDate, config.timeouts, log);
          log('session_warmed');
        }
        await waitUntilRelease(config.releaseAt, { signal: abort.signal, onEvent: log });
      }
      let currentEvent: SiteEvent | undefined;
      const outcome = await pollSlot({
        slot, signal: abort.signal, onEvent: log, retry: config.polling,
        maxAttempts: options.attempts ?? (mode === 'inspect' ? 1 : mode === 'live' ? config.polling.maxAttempts : 3),
        probe: async () => {
          let observation;
          try { observation = await probeAvailability(session.page!, config.targetDate, slot, config.timeouts, log); }
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
            await performReservation(session.page!, currentEvent, session.guard!, config.timeouts, log);
            session.autofillEligible = true;
            await fillSession(session, config, diagnostics, mode);
            return { status: 'customer-form-ready' as const };
          } catch (error) {
            if (error instanceof ManualInterventionError || error instanceof SiteInspectionRequiredError) return { status: 'manual' as const, reason: error.message };
            throw error;
          }
        },
      });
      log('slot_outcome', { ...outcome });
      await diagnostics.snapshot(session.page, 'slot-finished', slot);
      console.log(`[${slot}] ${outcome.status} (${outcome.attempts} 次讀取)。`);
      return outcome;
    } catch (error) {
      log('slot_error', { message: error instanceof ManualInterventionError || error instanceof SiteInspectionRequiredError ? error.message : 'Slot stopped after browser/navigation/config error. See sanitized network diagnostics.' });
      if (session.page) await diagnostics.snapshot(session.page, 'error', slot);
      console.log(`[${slot}] 已停止，請查看 diagnostics。另一時段會繼續。`);
      throw new Error(`Slot ${slot} stopped; browser kept for manual inspection.`);
    } finally { session.active = false; }
  };
  const work = runIndependentSlots(slots, worker).then(async (results) => {
    await diagnostics.writeJson('slot-outcomes.json', results);
    if (results.some((result) => result.status === 'rejected')) process.exitCode = 2;
    clearInterval(heartbeat);
    console.log('所有時段自動化已結束。');
    return results;
  });
  try {
    if (config.browser.headless || options.close || !process.stdin.isTTY) {
      await work;
      await Promise.allSettled([...sessions.values()].map((session) => session.browser?.close()));
    } else {
      await operatorConsole(sessions, async () => {
        const updated = await readLocalConfig();
        if (sideEffects) assertReservationTargetsUnchanged(config, updated);
        validateModeConfig(updated, mode, options.confirmed, options.slot);
        diagnostics.addSecrets(personalSecrets(updated));
        return updated;
      }, diagnostics, mode, abort);
      await work;
      await Promise.allSettled([...sessions.values()].map((session) => session.browser?.close()));
    }
  } finally {
    clearInterval(heartbeat);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await diagnostics.close();
  }
}

main().catch((error: unknown) => {
  // Config and browser exceptions may contain local path/entered values; no raw
  // Playwright exception is printed. Preflight remains reviewable through doctor.
  const message = error instanceof Error ? error.message : '';
  if (/^(?:Use |Slot must |full-rehearsal requires |live requires |Reservation modes require |Live target |The live release |Each |Invalid local config:|Cannot read local config\.|Local config must |\[(?:[01]\d|2[0-3]):[0-5]\d\] (?:Live|Run full-rehearsal))/u.test(message)) console.error(message);
  else console.error('執行未開始或已中止。請確認 CLI 旗標、設定、Chrome 安裝與 doctor；若有 artifacts 請查看診斷。');
  process.exitCode = 1;
});
