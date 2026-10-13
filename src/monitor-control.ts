import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertLiveMonitoringWindow, loadConfig, parseConfig, slotSchema, validateModeConfig, type AppConfig } from './config.js';
import { assertLiveReadiness } from './readiness.js';
import type { MonitorSnapshot } from './monitor-state.js';
import type { WorkerStatus } from './reservation-runner.js';
import { readWorkerStatus, sendWorkerCommand } from './worker-client.js';
import { hasLegacyReservationProcess } from './monitor-process.js';
import { boardingDateAllowed, boardingDateRange, boardingSlotAllowed, type BoardingDateRange } from './monitor-targets.js';

const settingsSchema = z.object({
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  releaseAt: z.string().datetime({ offset: true }),
  monitorFrom: z.string().datetime({ offset: true }),
  monitorUntil: z.string().datetime({ offset: true }),
  baseDelayMs: z.number().int().min(750).max(60_000),
  manualCustomerForm: z.boolean(),
  slots: z.array(z.object({ slot: slotSchema, customerProfile: slotSchema }).strict()).min(1).max(2),
}).strict();

export type ControlSettings = z.infer<typeof settingsSchema>;
export interface ControlSnapshot {
  enabled: boolean;
  demo: boolean;
  busy: boolean;
  settings: ControlSettings | null;
  profiles: { id: string; label: string }[];
  worker: WorkerStatus | null;
  externalRun: boolean;
  error: string | null;
  targetDateRange?: BoardingDateRange;
}
export class ControlFailure extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export interface MonitorControl {
  snapshot(): Promise<ControlSnapshot>;
  save(value: unknown): Promise<ControlSnapshot>;
  start(confirmed: unknown, expectedSettings?: unknown): Promise<ControlSnapshot>;
  command(command: 'stop' | 'handoff' | 'close', runId: unknown, slot?: unknown): Promise<ControlSnapshot>;
}

export interface ControlRuntime {
  status(): Promise<WorkerStatus | null>;
  command(command: 'stop' | 'handoff' | 'close', runId: string, slot?: string): Promise<WorkerStatus>;
  launch(path: string, manualCustomerForm: boolean, runId: string): Promise<void>;
  preflight(config: AppConfig, manualCustomerForm: boolean): Promise<void>;
  wait(milliseconds: number): Promise<void>;
  externalProcessActive(): Promise<boolean>;
}

export interface MonitorControlOptions {
  configPath?: string;
  directory?: string;
  artifactsDir?: string;
  snapshot: () => MonitorSnapshot;
  runtime?: Partial<ControlRuntime>;
}

function defaultSettings(config: AppConfig): ControlSettings {
  return {
    targetDate: config.targetDate, releaseAt: config.releaseAt,
    monitorFrom: config.monitorFrom ?? config.releaseAt,
    monitorUntil: config.monitorUntil ?? new Date(Date.parse(config.releaseAt) + 2 * 60 * 60_000).toISOString(),
    baseDelayMs: config.polling.baseDelayMs, manualCustomerForm: false,
    slots: config.slots.map((slot) => ({ slot, customerProfile: slot })),
  };
}

/** Read legacy settings unchanged; enforce current target choices only on save/start. */
function assertBoardingTargets(settings: ControlSettings): void {
  const range = boardingDateRange();
  if (!boardingDateAllowed(settings.targetDate, range)) {
    throw new ControlFailure(`乘船日期只能選擇日本當天至目前開放預約的日期（${range.min} 至 ${range.max}）。`, 400);
  }
  if (settings.slots.some(({ slot }) => !boardingSlotAllowed(slot))) {
    throw new ControlFailure('乘船時間只能選擇 08:00 至 16:00，每 30 分鐘一個時段（日本時間）。', 400);
  }
}

/** Target selections contain no customer values; the original local config stays intact. */
export function applyControlSettings(base: AppConfig, input: unknown, artifactsDir?: string): { settings: ControlSettings; config: AppConfig } {
  const result = settingsSchema.safeParse(input);
  if (!result.success) throw new ControlFailure('日期、時段或查詢時間格式不正確。', 400);
  const settings = result.data;
  if (new Set(settings.slots.map((entry) => entry.slot)).size !== settings.slots.length) {
    throw new ControlFailure('請選擇不同的乘船時段。', 400);
  }
  if (new Set(settings.slots.map((entry) => entry.customerProfile)).size !== settings.slots.length) {
    throw new ControlFailure('兩艘船需要使用不同的本機乘客資料組。', 400);
  }
  for (const entry of settings.slots) {
    if (!Object.hasOwn(base.customers, entry.customerProfile)) {
      throw new ControlFailure('選取的本機乘客資料組不存在，請在 Mac 檢查設定。', 400);
    }
  }
  try {
    const config = parseConfig({
      ...base, targetDate: settings.targetDate, releaseAt: settings.releaseAt,
      monitorFrom: settings.monitorFrom, monitorUntil: settings.monitorUntil,
      slots: settings.slots.map((entry) => entry.slot),
      customers: Object.fromEntries(settings.slots.map((entry) => [entry.slot, base.customers[entry.customerProfile]])),
      polling: { ...base.polling, baseDelayMs: settings.baseDelayMs, maxDelayMs: Math.max(base.polling.maxDelayMs, settings.baseDelayMs) },
      ...(artifactsDir ? { artifactsDir: resolve(artifactsDir) } : {}),
    });
    return { settings, config };
  } catch {
    throw new ControlFailure('設定無效：請確認日期有效、開始查詢不晚於開賣、截止晚於開賣。', 400);
  }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.new`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export function createMonitorControl(options: MonitorControlOptions): MonitorControl {
  const directory = resolve(options.directory ?? '.local/control');
  const configPath = resolve(options.configPath ?? 'config/config.local.json');
  const settingsPath = join(directory, 'settings.json');
  const intentPath = join(directory, 'launch.json');
  const intentSchema = z.object({ runId: z.string().uuid(), snapshotPath: z.string(), createdAt: z.number().int().nonnegative(),
    targetDate: z.string(), slots: z.array(slotSchema).min(1).max(2) }).strict();
  type LaunchIntent = z.infer<typeof intentSchema>;
  const readIntent = async (): Promise<LaunchIntent | null> => {
    try {
      const info = await lstat(intentPath);
      if (!info.isFile() || info.size > 4096 || info.mode & 0o077) throw new Error('Invalid launch intent');
      const result = intentSchema.safeParse(JSON.parse(await readFile(intentPath, 'utf8')) as unknown);
      if (!result.success || result.data.snapshotPath !== join(directory, `run-${result.data.runId}.json`)) throw new Error('Invalid launch intent');
      return result.data;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw new ControlFailure('前次啟動紀錄無法確認，請到 Mac 檢查搶位程序。', 503);
    }
  };
  const removeIntent = async (runId: string): Promise<void> => {
    if ((await readIntent())?.runId === runId) await rm(intentPath);
  };
  const workerPath = fileURLToPath(new URL('./reservation-worker.js', import.meta.url));
  const runtime: ControlRuntime = {
    status: () => readWorkerStatus(directory),
    command: (command, runId, slot) => sendWorkerCommand(directory, command, runId, slot),
    launch: async (path, manualCustomerForm, runId) => {
      const args = [workerPath, '--config', path, '--control-dir', directory,
        '--run-id', runId,
        ...(manualCustomerForm ? ['--manual-customer-form'] : [])];
      const executable = process.platform === 'darwin' ? '/usr/bin/caffeinate' : process.execPath;
      const child = spawn(executable, process.platform === 'darwin' ? ['-dimsu', process.execPath, ...args] : args,
        { detached: true, stdio: 'ignore', cwd: process.cwd(), shell: false });
      await new Promise<void>((done, reject) => {
        child.once('error', () => reject(new ControlFailure('無法啟動搶位程序，請在 Mac 檢查 Node 與瀏覽器安裝。', 503)));
        child.once('spawn', done);
      });
      child.unref();
    },
    preflight: async (config, manualCustomerForm) => {
      validateModeConfig(config, 'live', true, undefined, manualCustomerForm);
      assertLiveMonitoringWindow(config);
      await assertLiveReadiness(config, undefined, undefined, manualCustomerForm);
    },
    wait: async (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    externalProcessActive: () => hasLegacyReservationProcess(fileURLToPath(new URL('..', import.meta.url))),
    ...options.runtime,
  };
  let busy = false;
  let lastError: string | null = null;
  let externalCheck: Promise<boolean> | undefined;
  let nextExternalCheckAt = 0;
  const externalProcessActive = (): Promise<boolean> => {
    if (!externalCheck || Date.now() >= nextExternalCheckAt) {
      nextExternalCheckAt = Date.now() + 2000;
      externalCheck = runtime.externalProcessActive();
    }
    return externalCheck;
  };

  const load = async (): Promise<{ settings: ControlSettings; config: AppConfig; profiles: ControlSnapshot['profiles'] }> => {
    const base = await loadConfig(configPath);
    let value: unknown = defaultSettings(base);
    try { value = JSON.parse(await readFile(settingsPath, 'utf8')) as unknown; }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw new ControlFailure('已儲存的控制台設定無法讀取，請在 Mac 檢查本機設定。', 503);
      }
    }
    const applied = applyControlSettings(base, value, options.artifactsDir);
    return { ...applied, profiles: Object.keys(base.customers).filter((key) => slotSchema.safeParse(key).success)
      .map((id, index) => ({ id, label: `船 ${index + 1} 的本機資料` })) };
  };

  const inspect = async (): Promise<ControlSnapshot> => {
    let worker: WorkerStatus | null = null;
    let workerError: string | null = null;
    try { worker = await runtime.status(); }
    catch { workerError = '搶位程序狀態無法確認，已鎖定控制；請到 Mac 檢查原瀏覽器與程序。'; }
    const observed = options.snapshot();
    let externalRun = !worker && !!observed.run && ['live', 'stale'].includes(observed.connection);
    // Logs survive a terminal exit, and older runs may have no diagnostics_closed.
    // During bounded replay, an expired run can still look like it was polling.
    // Release only non-held history after confirming that no project process
    // still exists. Unknown holds, dispatches, and managed locks stay protected.
    const finishedHistory = observed.connection === 'stale' && observed.run?.monitorUntil !== null
      && typeof observed.run?.monitorUntil === 'number' && observed.run.monitorUntil < Date.now()
      && observed.slots.length > 0 && observed.slots.every((slot) =>
        ['waiting', 'warming', 'monitoring', 'retrying', 'stopped', 'deadline'].includes(slot.phase)
          && slot.holdConfirmed === false && !slot.heldAt);
    if (externalRun && !workerError && finishedHistory) {
      try { externalRun = await externalProcessActive(); }
      catch { workerError = '無法確認原終端搶位程序是否仍在運作，請到 Mac 檢查。'; }
    }
    let launchError: string | null = null;
    try {
      const intent = await readIntent();
      if (intent && worker?.runId === intent.runId) {
        if (worker.targetDate !== intent.targetDate || worker.slots.map((entry) => entry.slot).join('/') !== intent.slots.join('/')) {
          workerError ??= '啟動目標與搶位程序不符，請到 Mac 確認原頁面。';
        } else await removeIntent(intent.runId);
      } else if (intent) {
        launchError = '前次啟動要求尚未確認，已鎖定重複啟動；請到 Mac 檢查程序。';
        if (!worker) workerError ??= launchError;
      }
    } catch { workerError ??= '前次啟動紀錄無法確認，請到 Mac 檢查搶位程序。'; }
    try {
      const { settings, profiles } = await load();
      return { enabled: !workerError, demo: false, busy, settings, profiles, worker,
        externalRun, error: workerError ?? launchError ?? lastError, targetDateRange: boardingDateRange() };
    } catch {
      return { enabled: !workerError && !!worker && !worker.closed, demo: false, busy, settings: null, profiles: [], worker,
        externalRun, error: workerError ?? '本機搶位設定無法使用，請在 Mac 檢查 config/config.local.json。', targetDateRange: boardingDateRange() };
    }
  };

  const mutate = async (operation: () => Promise<void>): Promise<ControlSnapshot> => {
    if (busy) throw new ControlFailure('另一項控制操作正在處理，請稍候。');
    busy = true;
    lastError = null;
    try { await operation(); }
    catch (error) {
      lastError = error instanceof ControlFailure ? error.message : '控制操作未完成，請到 Mac 檢查程序與瀏覽器狀態。';
      throw error instanceof ControlFailure ? error : new ControlFailure(lastError, 503);
    } finally { busy = false; }
    return inspect();
  };
  const assertIdle = async (): Promise<void> => {
    const state = await inspect();
    if (!state.enabled) throw new ControlFailure(state.error ?? '目前無法控制搶位程序。', 503);
    if (state.worker && !state.worker.closed) throw new ControlFailure('搶位程序與瀏覽器仍開啟；請先結束程式，再變更目標或重新啟動。');
    if (state.externalRun) throw new ControlFailure('偵測到原終端的搶位紀錄；請先在 Mac 原終端用 q 結束，再從控制台啟動。');
  };

  return {
    snapshot: inspect,
    save: (value) => mutate(async () => {
      await assertIdle();
      const base = await loadConfig(configPath);
      const { settings } = applyControlSettings(base, value, options.artifactsDir);
      assertBoardingTargets(settings);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writePrivate(settingsPath, settings);
    }),
    start: (confirmed, expectedSettings) => mutate(async () => {
      if (confirmed !== true) throw new ControlFailure('開始搶位會暫留官方船位，請使用「開始搶位」按鈕。', 400);
      await assertIdle();
      const { settings, config } = await load();
      if (expectedSettings !== undefined) {
        const expected = settingsSchema.safeParse(expectedSettings);
        if (!expected.success || JSON.stringify(expected.data) !== JSON.stringify(settings)) {
          throw new ControlFailure('搶位設定已被更新，請重新整理確認日期與時段後再啟動。');
        }
      }
      assertBoardingTargets(settings);
      try { await runtime.preflight(config, settings.manualCustomerForm); }
      catch { throw new ControlFailure('啟動檢查未通過：請確認監控截止尚未過期、各船代表人不同、個資與瀏覽器設定完整。', 400); }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const runId = randomUUID();
      const path = join(directory, `run-${runId}.json`);
      await writeFile(path, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: 'wx' });
      const intent: LaunchIntent = { runId, snapshotPath: path, targetDate: config.targetDate, slots: config.slots, createdAt: Date.now() };
      try { await writeFile(intentPath, `${JSON.stringify(intent)}\n`, { mode: 0o600, flag: 'wx' }); }
      catch { await rm(path, { force: true }); throw new ControlFailure('另一個啟動要求正在處理，請重新整理。'); }
      try {
        // Preflight and snapshot writes may cross Japan midnight; recheck before launch.
        assertBoardingTargets(settings);
        await runtime.launch(path, settings.manualCustomerForm, runId);
      }
      catch (error) { await removeIntent(runId); await rm(path, { force: true }); throw error; }
      for (let attempt = 0; attempt < 50; attempt += 1) {
        let worker: WorkerStatus | null = null;
        try {
          worker = await runtime.status();
        } catch { /* The worker may still be publishing its socket. Never relaunch. */ }
        if (worker) {
          if (worker.runId !== runId || worker.targetDate !== config.targetDate
            || worker.slots.map((entry) => entry.slot).join('/') !== config.slots.join('/')) {
            // A different worker does not prove our detached child has exited.
            // Keep the durable intent until this exact attempt can be verified.
            throw new ControlFailure('另一個搶位程序已啟動，本次啟動結果尚未確認；請到 Mac 檢查程序與目標。');
          }
          await removeIntent(runId);
          return;
        }
        await runtime.wait(100);
      }
      // The detached process might still own this attempt. Retain its private
      // snapshot and fail closed rather than automatically spawning another.
      throw new ControlFailure('已送出啟動要求，但搶位程序尚未確認回應；請稍候重新整理或到 Mac 檢查。', 503);
    }),
    command: (command, runId, slot) => mutate(async () => {
      if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(runId)) throw new ControlFailure('搶位執行識別無效，請重新整理。', 400);
      if (command === 'handoff' && !slotSchema.safeParse(slot).success) throw new ControlFailure('請選擇要交接的時段。', 400);
      const current = await runtime.status();
      if (!current || current.closed || current.runId !== runId) throw new ControlFailure('搶位程序已變更或結束，請重新整理後再操作。');
      if (command === 'handoff' && !current.slots.some((entry) => entry.slot === slot && entry.canHandoff)) {
        throw new ControlFailure('該時段仍在執行或已交接，暫時無法人工接手。');
      }
      await runtime.command(command, runId, typeof slot === 'string' ? slot : undefined);
    }),
  };
}

/** A functional control rehearsal without config reads, processes or site traffic. */
export function createDemoControl(): MonitorControl & { monitorSnapshot(): MonitorSnapshot } {
  let settings: ControlSettings = {
    targetDate: boardingDateRange().max, releaseAt: new Date(Date.now() + 120_000).toISOString(),
    monitorFrom: new Date(Date.now()).toISOString(), monitorUntil: new Date(Date.now() + 7_200_000).toISOString(),
    baseDelayMs: 750, manualCustomerForm: false,
    slots: [{ slot: '11:00', customerProfile: '11:00' }, { slot: '11:30', customerProfile: '11:30' }],
  };
  let worker: WorkerStatus | null = null;
  let startedAt = 0;
  const tick = (): void => {
    if (worker && !worker.automationStopped && Date.now() - startedAt > 5000) {
      worker.slots.forEach((slot) => { if (!slot.handedOff) { slot.active = false; slot.canHandoff = true; slot.holdConfirmed = true; } });
    }
  };
  const state = async (): Promise<ControlSnapshot> => {
    tick();
    return { enabled: true, demo: true, busy: false, settings: structuredClone(settings),
      profiles: [{ id: '11:00', label: '船 1 的演示資料' }, { id: '11:30', label: '船 2 的演示資料' }],
      worker: worker ? structuredClone(worker) : null, externalRun: false, error: null, targetDateRange: boardingDateRange() };
  };
  return {
    monitorSnapshot: () => {
      tick();
      const now = Date.now();
      return {
        schemaVersion: 1, serverTime: now, connection: worker ? 'live' : 'waiting', updatedAt: worker ? now : null,
        heartbeatAt: worker ? now : null,
        run: worker ? { id: 'demo', targetDate: worker.targetDate, mode: 'live', startedAt,
          releaseAt: Date.parse(settings.releaseAt), monitorFrom: Date.parse(settings.monitorFrom), monitorUntil: Date.parse(settings.monitorUntil) } : null,
        slots: worker?.slots.map((entry) => ({ slot: entry.slot,
          phase: entry.handedOff ? 'handed-off' : entry.holdConfirmed ? 'held' : entry.active ? 'monitoring' : 'stopped',
          attempts: Math.max(1, Math.floor((now - startedAt) / 1000)), availability: entry.holdConfirmed ? 'available' : 'unavailable',
          responseMs: 382, nextRetryAt: null, updatedAt: now, holdConfirmed: entry.holdConfirmed,
          heldAt: entry.holdConfirmed ? startedAt + 5000 : null,
        })) ?? [],
        recentEvents: [{ at: now, slot: null, label: '演示資料：沒有執行真實搶位' }],
      };
    },
    snapshot: state,
    save: async (value) => {
      if (worker) throw new ControlFailure('請先結束演示程式，再變更設定。');
      const parsed = settingsSchema.safeParse(value);
      if (!parsed.success || new Set(parsed.data.slots.map((entry) => entry.slot)).size !== parsed.data.slots.length
        || parsed.data.slots.some((entry) => !['11:00', '11:30'].includes(entry.customerProfile))
        || Date.parse(parsed.data.monitorFrom) > Date.parse(parsed.data.releaseAt)
        || Date.parse(parsed.data.monitorUntil) <= Date.parse(parsed.data.releaseAt)) throw new ControlFailure('演示設定格式不正確。', 400);
      assertBoardingTargets(parsed.data);
      settings = parsed.data;
      return state();
    },
    start: async (confirmed, expectedSettings) => {
      if (confirmed !== true || worker) throw new ControlFailure('演示程式已啟動或缺少開始要求。');
      if (expectedSettings !== undefined && JSON.stringify(settingsSchema.safeParse(expectedSettings).data) !== JSON.stringify(settings)) {
        throw new ControlFailure('演示設定已被更新，請重新整理。');
      }
      assertBoardingTargets(settings);
      startedAt = Date.now();
      worker = { runId: randomUUID(), targetDate: settings.targetDate,
        slots: settings.slots.map(({ slot }) => ({ slot, active: true, handedOff: false, canHandoff: false, holdConfirmed: false })),
        automationStopped: false, closed: false };
      return state();
    },
    command: async (command, runId, slot) => {
      if (!worker || worker.runId !== runId) throw new ControlFailure('演示程序已變更，請重新整理。');
      if (command === 'close') worker = null;
      else if (command === 'stop') { worker.automationStopped = true; worker.slots.forEach((entry) => { entry.active = false; entry.canHandoff = !entry.handedOff; }); }
      else {
        const target = worker.slots.find((entry) => entry.slot === slot);
        if (!target?.canHandoff) throw new ControlFailure('演示時段尚未就緒。');
        target.handedOff = true; target.canHandoff = false;
      }
      return state();
    },
  };
}
