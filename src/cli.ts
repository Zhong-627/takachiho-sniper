import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseCli } from './cli-options.js';
import { loadConfig, monitoringStartMs, parseConfig, ReservationTargetsChangedError, validateModeConfig, type AppConfig } from './config.js';
import { assertLiveReadiness } from './readiness.js';
import { startRun, printFormReadiness, type ReservationRun } from './reservation-runner.js';
import { startReservationWorker, type WorkerService } from './reservation-worker.js';
import { formatReleaseTimes } from './time.js';

const help = `高千穗峽預約工具（Node.js 22+ / macOS Apple Silicon）
npm run inspect -- --config config/config.local.json
npm run rehearsal -- --attempts 3
npm run full-rehearsal -- --slot HH:mm --date YYYY-MM-DD --confirm-reservation-side-effects
npm run live -- --confirm-reservation-side-effects
npm run live -- --manual-customer-form --confirm-reservation-side-effects
npm run doctor
安全模式可加 --headless --close。個資與觀察到的表單 mappings 只存本機。
日期、開賣時間、1–2 個時段及各船個資由 local config 指定。時段使用日本當地 HH:mm。
live 從 monitorFrom（未填則 releaseAt）監控至 monitorUntil；不受 maxAttempts 限制。
缺少近期表單紀錄仍可啟動；自動填表前核對當次表單，異常時保留船位交由人工。
--manual-customer-form 僅供 live／doctor 使用，客戶資料全部由人工填寫，停用 f。
瀏覽器保留時：f [HH:mm] 重新載入個資並填寫目前已 hold 的表單；handoff [HH:mm] 交由人工；q 關閉。
程式不送出客戶表單、不付款、不處理 CAPTCHA / OTP / 3D Secure。`;

async function operatorConsole(run: ReservationRun, getConfig: () => Promise<AppConfig>, manualCustomerForm: boolean): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  // A PWA operator can close this shared live run while the CLI is idle at readline.
  const observeExternalClose = setInterval(() => { if (run.status().closed) terminal.close(); }, 250);
  observeExternalClose.unref();
  terminal.on('SIGINT', () => run.stop());
  console.log('瀏覽器保留中。輸入 f、handoff [時段] 或 q。Ctrl+C 只停止自動化；q 才關閉瀏覽器。');
  try {
    for await (const line of terminal) {
      const [command, slot] = line.trim().split(/\s+/u);
      if (command === 'q') { await run.close(); return; }
      try {
        if (command === 'f') {
          if (manualCustomerForm) { console.log('人工填表模式不執行 f。取得船位後輸入 handoff [時段]，在瀏覽器自行填寫。'); continue; }
          await run.refill(await getConfig(), slot);
        } else if (command === 'handoff') {
          const targets = run.status().slots.filter((session) => !slot || session.slot === slot);
          for (const target of targets) {
            if (!target.canHandoff) { console.log(`[${target.slot}] 尚在執行、已交接或未開放接手；未解除保護。`); continue; }
            await run.handoff(target.slot);
          }
        } else if (command) console.log('可用命令：f [時段]、handoff [時段]、q。');
      } catch (error) {
        console.log(error instanceof ReservationTargetsChangedError ? error.message : '操作未完成；請檢查本機設定或瀏覽器狀態。個資不會印出。');
      }
    }
    // EOF has no interactive operator. Explicitly close the CLI's own browser sessions.
    await run.close();
  } finally { clearInterval(observeExternalClose); terminal.close(); }
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
    console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, targetDate: config.targetDate, release: formatReleaseTimes(Date.parse(config.releaseAt)), monitorFrom: formatReleaseTimes(monitoringStartMs(config)), monitorUntil: config.monitorUntil ? formatReleaseTimes(Date.parse(config.monitorUntil)) : undefined, baseDelayMs: config.polling.baseDelayMs, slots: config.slots, channel: config.browser.channel }, null, 2));
    try {
      validateModeConfig(config, 'live', true, undefined, options.manualCustomerForm);
      const readiness = await assertLiveReadiness(config, undefined, undefined, options.manualCustomerForm);
      console.log('搶位設定檢查通過。');
      printFormReadiness(readiness);
    }
    catch (error) { console.log(error instanceof Error ? error.message : 'Live 尚未準備完成。'); process.exitCode = 2; }
    return;
  }
  const mode = options.mode;
  validateModeConfig(config, mode, options.confirmed, options.slot, options.manualCustomerForm);
  if (sideEffects && !process.stdin.isTTY) throw new Error('Reservation modes require an interactive terminal for operator takeover.');
  let service: WorkerService | undefined;
  let run: ReservationRun;
  if (mode === 'live') {
    service = await startReservationWorker(config, { controlDir: resolve('.local/control'), manualCustomerForm: options.manualCustomerForm });
    run = service.run;
  } else {
    run = await startRun(config, { mode, confirmed: options.confirmed, manualCustomerForm: options.manualCustomerForm, slot: options.slot, attempts: options.attempts });
  }
  const stop = (): void => run.stop();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    if (config.browser.headless || options.close || !process.stdin.isTTY) {
      await run.wait();
      await run.close();
    } else {
      await operatorConsole(run, readLocalConfig, options.manualCustomerForm);
    }
    if ((await run.wait()).some((result) => result.status === 'rejected')) process.exitCode = 2;
  } finally {
    await service?.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
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
