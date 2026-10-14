import { createECDH, createHash, ECDH, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import webPush, { type PushSubscription, type RequestOptions } from 'web-push';
import { MONITOR_STALE_AFTER_MS, type MonitorSlot, type MonitorSnapshot } from './monitor-state.js';
import { parseRetryAfter } from './retry.js';
import { formatZonedTime } from './time.js';

const MAX_SUBSCRIPTIONS = 16;
const MAX_DELIVERIES = 256;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2048;
const NOTIFICATION_TTL_SECONDS = 120;
const MAX_ATTEMPTS = 3;
const REMINDER_INTERVAL_MS = 3000;
const REMINDER_TTL_SECONDS = 3;
const DEFAULT_SUBJECT = 'https://github.com/Zhong-627/takachiho-sniper';
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com',
  'notify.windows.com', 'wns.windows.com'];

export class MonitorPushError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface MonitorPush {
  readonly publicKey: string;
  status(): MonitorPushStatus;
  subscribe(subscription: unknown): Promise<void>;
  unsubscribe(endpoint: unknown): Promise<void>;
  test(endpoint: unknown): Promise<void>;
  stop(reminderIds: unknown): Promise<void>;
  close(): Promise<void>;
  /** Notification errors are isolated from reservation automation. */
  observe(snapshot: MonitorSnapshot): Promise<void>;
}

export interface MonitorReminder {
  id: string;
  runId: string;
  slot: string;
  targetDate: string | null;
  startedAt: number;
}

export interface MonitorPushStatus {
  available: boolean;
  publicKey: string;
  reminders: MonitorReminder[];
}

export interface MonitorPushOptions {
  directory: string;
  subject?: string;
  send?: (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>;
  /** Disable the autonomous reminder timer for deterministic unit tests. */
  schedule?: boolean;
}

interface VapidKeys { publicKey: string; privateKey: string }
interface Subscription extends PushSubscription { expirationTime: number | null; nextAllowedAt: number }
interface Recipient { id: string; failures: number; nextAttemptAt: number }
interface Delivery {
  id: string;
  at: number;
  baseline: boolean;
  payload: string;
  recipients: Recipient[];
  reminder: MonitorReminder | null;
  stoppedAt: number | null;
  sequence: number;
}
interface SummaryRecipient extends Recipient { attempts: number; delivered: boolean }
interface DeadlineSummary {
  id: string;
  runId: string;
  at: number;
  payload: string;
  recipients: SummaryRecipient[];
}
interface PushState { version: 3; subscriptions: Subscription[]; deliveries: Delivery[]; summaries: DeadlineSummary[] }

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function endpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new MonitorPushError(400, '通知訂閱網址無效。');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443'
      || url.pathname === '/' || !PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      throw new Error('Invalid push service');
    }
    return url.href;
  } catch { throw new MonitorPushError(400, '通知訂閱網址無效。'); }
}

function key(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) throw new Error('Invalid key');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== value.replace(/=+$/u, '')) throw new Error('Invalid key');
  if (bytes === 65) {
    if (decoded[0] !== 4) throw new Error('Invalid public key');
    ECDH.convertKey(decoded, 'prime256v1', undefined, undefined, 'uncompressed');
  }
  return decoded.toString('base64url');
}

function subscription(value: unknown): Subscription {
  try {
    const data = object(value);
    const keys = object(data?.keys);
    if (!data || !keys) throw new Error('Invalid subscription');
    const expirationTime = data.expirationTime ?? null;
    if (expirationTime !== null && (typeof expirationTime !== 'number' || !Number.isSafeInteger(expirationTime)
      || expirationTime < 0 || expirationTime > 8_640_000_000_000_000)) throw new Error('Invalid expiry');
    return { endpoint: endpoint(data.endpoint), expirationTime, nextAllowedAt: 0,
      keys: { p256dh: key(keys.p256dh, 65), auth: key(keys.auth, 16) } };
  } catch { throw new MonitorPushError(400, '通知訂閱資料無效。'); }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function missing(error: unknown): boolean { return object(error)?.code === 'ENOENT'; }
function statusCode(error: unknown): number | null {
  const code = object(error)?.statusCode;
  return typeof code === 'number' && Number.isInteger(code) ? code : null;
}
function epoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function validSubject(value: string): string {
  try {
    const url = new URL(value);
    if (value.length > 512 || url.hash || url.username || url.password
      || url.protocol !== 'https:' && url.protocol !== 'mailto:'
      || url.protocol === 'https:' && (!url.hostname.includes('.') || url.hostname.endsWith('.localhost'))
      || url.protocol === 'mailto:' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(url.pathname)) throw new Error('Invalid subject');
    return value;
  } catch { throw new Error('監控通知聯絡網址無效，請設定有效的 HTTPS 或 mailto 網址。'); }
}

async function readPrivate(path: string): Promise<unknown | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Invalid private file');
    const value: unknown = JSON.parse(await file.readFile('utf8'));
    await file.chmod(0o600);
    return value;
  } catch (error) { if (missing(error)) return null; throw error; }
  finally { await file?.close(); }
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  const stage = `${path}.${randomUUID()}.new`;
  try {
    // Never follow an existing symlink, even though atomic replacement would
    // normally replace the link itself rather than write through it.
    try { if (!(await lstat(path)).isFile()) throw new Error('Invalid private path'); }
    catch (error) { if (!missing(error)) throw error; }
    const contents = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(contents) > MAX_FILE_BYTES) throw new Error('State too large');
    await writeFile(stage, contents, { flag: 'wx', mode: 0o600 });
    await rename(stage, path);
  } finally { await rm(stage, { force: true }); }
}

function parseKeys(value: unknown): VapidKeys {
  const data = object(value);
  const publicKey = key(data?.publicKey, 65);
  const privateKey = key(data?.privateKey, 32);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  if (ecdh.getPublicKey().toString('base64url') !== publicKey) throw new Error('Invalid VAPID pair');
  return { publicKey, privateKey };
}

function parseState(value: unknown): PushState {
  if (value === null) return { version: 3, subscriptions: [], deliveries: [], summaries: [] };
  const data = object(value);
  if (!data || ![1, 2, 3].includes(data.version as number) || !Array.isArray(data.subscriptions) || data.subscriptions.length > MAX_SUBSCRIPTIONS
    || !Array.isArray(data.deliveries) || data.deliveries.length > MAX_DELIVERIES) throw new Error('Invalid push state');
  const subscriptions = data.subscriptions.map((value): Subscription => {
    const item = subscription(value);
    const nextAllowedAt = object(value)?.nextAllowedAt ?? 0;
    if (!epoch(nextAllowedAt)) throw new Error('Invalid subscription backoff');
    return { ...item, nextAllowedAt };
  });
  if (new Set(subscriptions.map((item) => item.endpoint)).size !== subscriptions.length) throw new Error('Duplicate subscription');
  const deliveries = data.deliveries.map((item): Delivery => {
    const delivery = object(item);
    if (!delivery || typeof delivery.id !== 'string' || !/^[a-f\d]{64}$/u.test(delivery.id) || !epoch(delivery.at)
      || typeof delivery.baseline !== 'boolean' || typeof delivery.payload !== 'string'
      || Buffer.byteLength(delivery.payload) > MAX_PAYLOAD_BYTES || !Array.isArray(delivery.recipients)
      || delivery.recipients.length > MAX_SUBSCRIPTIONS) throw new Error('Invalid delivery');
    const recipients = delivery.recipients.map((item): Recipient => {
      const recipient = object(item);
      if (!recipient || typeof recipient.id !== 'string' || !/^[a-f\d]{64}$/u.test(recipient.id)
        || !epoch(recipient.nextAttemptAt)
        || (data.version === 1 ? typeof recipient.attempts !== 'number' || !Number.isInteger(recipient.attempts)
          || recipient.attempts < 0 || recipient.attempts > MAX_ATTEMPTS || typeof recipient.delivered !== 'boolean'
          : typeof recipient.failures !== 'number' || !Number.isInteger(recipient.failures) || recipient.failures < 0 || recipient.failures > 16)) {
        throw new Error('Invalid recipient');
      }
      return { id: recipient.id, failures: data.version === 1 ? 0 : recipient.failures as number, nextAttemptAt: recipient.nextAttemptAt };
    });
    if (new Set(recipients.map((item) => item.id)).size !== recipients.length) throw new Error('Duplicate recipient');
    // Old single-shot deliveries must never become a new repeating alarm on upgrade.
    if (data.version === 1) return { id: delivery.id, at: delivery.at, baseline: true, payload: '', recipients: [],
      reminder: null, stoppedAt: delivery.at, sequence: 0 };
    const reminder = object(delivery.reminder);
    if (!epoch(delivery.sequence) || (delivery.stoppedAt !== null && !epoch(delivery.stoppedAt))
      || (delivery.reminder !== null && (!reminder || reminder.id !== delivery.id
        || typeof reminder.runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(reminder.runId)
        || typeof reminder.slot !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(reminder.slot)
        || hash(`${reminder.runId}/${reminder.slot}`) !== delivery.id
        || (reminder.targetDate !== null && (typeof reminder.targetDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(reminder.targetDate)))
        || reminder.startedAt !== delivery.at))
      || (delivery.baseline ? delivery.reminder !== null : !reminder)) throw new Error('Invalid reminder');
    return { id: delivery.id, at: delivery.at, baseline: delivery.baseline, payload: delivery.payload, recipients,
      reminder: reminder as unknown as MonitorReminder | null, stoppedAt: delivery.stoppedAt as number | null, sequence: delivery.sequence };
  });
  if (new Set(deliveries.map((item) => item.id)).size !== deliveries.length) throw new Error('Duplicate delivery');
  const rawSummaries = data.version === 3 ? data.summaries : [];
  if (!Array.isArray(rawSummaries) || rawSummaries.length > MAX_DELIVERIES) throw new Error('Invalid summaries');
  const summaries = rawSummaries.map((value): DeadlineSummary => {
    const summary = object(value);
    if (!summary || typeof summary.runId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(summary.runId)
      || summary.id !== hash(`${summary.runId}/deadline`) || !epoch(summary.at)
      || typeof summary.payload !== 'string' || Buffer.byteLength(summary.payload) > MAX_PAYLOAD_BYTES
      || !Array.isArray(summary.recipients) || summary.recipients.length > MAX_SUBSCRIPTIONS) throw new Error('Invalid summary');
    const recipients = summary.recipients.map((value): SummaryRecipient => {
      const item = object(value);
      if (!item || typeof item.id !== 'string' || !/^[a-f\d]{64}$/u.test(item.id) || !epoch(item.nextAttemptAt)
        || !Number.isInteger(item.failures) || (item.failures as number) < 0 || (item.failures as number) > 16
        || !Number.isInteger(item.attempts) || (item.attempts as number) < 0 || (item.attempts as number) > MAX_ATTEMPTS
        || typeof item.delivered !== 'boolean') throw new Error('Invalid summary recipient');
      return { id: item.id, nextAttemptAt: item.nextAttemptAt, failures: item.failures as number,
        attempts: item.attempts as number, delivered: item.delivered };
    });
    if (new Set(recipients.map((item) => item.id)).size !== recipients.length) throw new Error('Duplicate summary recipient');
    return { id: summary.id as string, runId: summary.runId, at: summary.at, payload: summary.payload, recipients };
  });
  if (new Set(summaries.map((item) => item.id)).size !== summaries.length) throw new Error('Duplicate summary');
  return { version: 3, subscriptions, deliveries, summaries };
}

function payload(title: string, body: string, tag: string): string {
  const value = JSON.stringify({ title, body, url: '/', tag });
  if (Buffer.byteLength(value) > MAX_PAYLOAD_BYTES) throw new Error('Notification too large');
  return value;
}

const FINAL_PHASES = new Set(['held', 'manual', 'ambiguous', 'failed', 'stopped', 'deadline', 'handed-off']);
function summaryResult(slot: MonitorSlot): string {
  if (slot.holdConfirmed) {
    if (slot.phase === 'manual') return '已暫留，需人工處理及確認付款';
    if (slot.phase === 'ambiguous' || slot.phase === 'failed') return '曾確認暫留，後續結果請到 Mac 確認';
    if (slot.phase === 'handed-off') return '曾確認暫留，已交由人工確認付款';
    return '已暫留，待人工確認付款';
  }
  switch (slot.phase) {
    case 'deadline': return '監控截止，未取得船位';
    case 'manual': return '需人工處理，尚未確認暫留';
    case 'ambiguous': return '暫留結果不明，請到 Mac 確認';
    case 'failed': return '執行失敗，請到 Mac 確認';
    case 'handed-off': return '已交由人工處理';
    case 'held': return '暫留證據待確認，請到 Mac 確認';
    default: return '已停止查詢';
  }
}

/** Private subscriptions, stable VAPID keys and recipient-level delivery records
 * survive monitor restarts. Only approved browser push providers are contacted. */
export async function createMonitorPush(options: MonitorPushOptions): Promise<MonitorPush> {
  const startedAt = Date.now();
  const directory = resolve(options.directory);
  const subject = validSubject(options.subject ?? DEFAULT_SUBJECT);
  const keysFile = join(directory, 'vapid.json');
  const stateFile = join(directory, 'subscriptions.json');
  let keys: VapidKeys;
  let state: PushState;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid push directory');
    await chmod(directory, 0o700);
    const existing = await readPrivate(keysFile);
    keys = existing === null ? webPush.generateVAPIDKeys() : parseKeys(existing);
    if (existing === null) await writeFile(keysFile, `${JSON.stringify(keys)}\n`, { flag: 'wx', mode: 0o600 });
    const existingState = await readPrivate(stateFile);
    state = parseState(existingState);
    if (existingState === null || object(existingState)?.version !== 3) await writePrivate(stateFile, state);
  } catch { throw new Error('監控通知設定無法讀寫，請確認本機通知資料夾與檔案權限。'); }
  const send = options.send ?? ((item, body, settings) => webPush.sendNotification(item, body, settings));
  const settings: RequestOptions = { vapidDetails: { subject, ...keys }, TTL: NOTIFICATION_TTL_SECONDS,
    urgency: 'high', contentEncoding: 'aes128gcm', timeout: 5000 };
  let initialized = false;
  let queue = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const persist = async (): Promise<void> => {
    try { await writePrivate(stateFile, state); }
    catch { throw new Error('監控通知設定無法儲存，請確認本機檔案權限。'); }
  };
  const removeExpired = (): void => {
    state.subscriptions = state.subscriptions.filter((item) => item.expirationTime === null || item.expirationTime > Date.now());
  };
  const recordDelivery = (delivery: Delivery): void => {
    while (state.deliveries.length >= MAX_DELIVERIES) {
      const removable = state.deliveries.findIndex((item) => item.baseline || item.stoppedAt !== null);
      if (removable === -1) throw new Error('請先停止舊提醒，再建立新的提醒。');
      state.deliveries.splice(removable, 1);
    }
    state.deliveries.push(delivery);
  };
  type SendJob = { subscription: Subscription; payload: string } & (
    { delivery: Delivery; recipient: Recipient; summary?: never }
    | { summary: DeadlineSummary; recipient: SummaryRecipient; delivery?: never }
  );
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let latestSnapshot: MonitorSnapshot | null = null;
  const active = (delivery: Delivery): boolean => !delivery.baseline && delivery.reminder !== null && delivery.stoppedAt === null;
  const pendingSummary = (summary: DeadlineSummary, recipient: SummaryRecipient): boolean => !recipient.delivered
    && recipient.attempts < MAX_ATTEMPTS && Date.now() < summary.at + NOTIFICATION_TTL_SECONDS * 1000;
  const armTimer = (): void => {
    clearTimeout(timer);
    timer = undefined;
    if (closed || options.schedule === false || !latestSnapshot) return;
    const recipients = [...state.deliveries.filter(active).flatMap((delivery) => delivery.recipients),
      ...state.summaries.flatMap((summary) => summary.recipients.filter((recipient) => pendingSummary(summary, recipient)))]
      .filter((recipient) => !inFlight.has(recipient.id) && state.subscriptions.some((item) => hash(item.endpoint) === recipient.id));
    if (!recipients.length) return;
    const next = Math.min(...recipients.map((recipient) => Math.max(recipient.nextAttemptAt,
      state.subscriptions.find((item) => hash(item.endpoint) === recipient.id)!.nextAllowedAt)));
    timer = setTimeout(() => { void observe(latestSnapshot!).catch(() => undefined); }, Math.min(2 ** 31 - 1, Math.max(50, next - Date.now())));
    timer.unref();
  };
  const observeSnapshot = async (snapshot: MonitorSnapshot): Promise<SendJob[]> => {
    if (closed) return [];
    const now = Date.now();
    const run = snapshot.run;
    const demo = (snapshot as MonitorSnapshot & { demo?: boolean }).demo === true;
    const validRun = run?.mode === 'live' && /^[A-Za-z0-9_-]{1,80}$/u.test(run.id);
    const holds = validRun && !demo ? snapshot.slots.filter((slot) => slot.holdConfirmed === true
      && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(slot.slot) && epoch(slot.heldAt)
      && slot.heldAt >= run.startedAt && slot.heldAt <= now + 5000) : [];
    const known = new Map(state.deliveries.map((item) => [item.id, item]));
    const firstObservation = !initialized;
    if (!initialized) {
      initialized = true;
      for (const slot of holds) {
        const id = hash(`${run!.id}/${slot.slot}`);
        if (!known.has(id)) recordDelivery({ id, at: slot.heldAt!, baseline: true, payload: '', recipients: [],
          reminder: null, stoppedAt: null, sequence: 0 });
      }
      if (holds.length) await persist();
    } else {
      const health = snapshot.heartbeatAt ?? run?.startedAt;
      const fresh = validRun && !demo && snapshot.connection === 'live' && epoch(snapshot.serverTime)
        && now - snapshot.serverTime <= MONITOR_STALE_AFTER_MS && snapshot.serverTime <= now + 5000
        && epoch(health) && now - health <= MONITOR_STALE_AFTER_MS && health <= now + 5000;
      if (fresh) for (const slot of holds) {
        if (now - slot.heldAt! > NOTIFICATION_TTL_SECONDS * 1000) continue;
        const id = hash(`${run!.id}/${slot.slot}`);
        if (known.has(id)) continue;
        const delivery: Delivery = { id, at: slot.heldAt!, baseline: false, stoppedAt: null, sequence: 0,
          reminder: { id, runId: run!.id, slot: slot.slot, targetDate: run!.targetDate, startedAt: slot.heldAt! },
          payload: payload('高千穗船位已暫留', `${run!.targetDate ?? ''} ${slot.slot} 已暫留，請到 Mac 接手確認付款`.trim(), `takachiho-${id}`),
          recipients: state.subscriptions.map((item) => ({ id: hash(item.endpoint), failures: 0, nextAttemptAt: now })) };
        recordDelivery(delivery);
        known.set(id, delivery);
        await persist();
      }
    }
    // A terminal-looking hold can still have autofill in flight. Only the
    // runner's all-workers-finished event establishes a complete summary.
    const finishedAt = snapshot.automationFinishedAt;
    const cutoff = run?.monitorUntil;
    const summaryReady = validRun && !demo && epoch(run.startedAt) && epoch(cutoff) && epoch(finishedAt)
      && finishedAt >= run.startedAt && finishedAt >= cutoff && finishedAt <= now + 5000
      && snapshot.automationStoppedAt == null && snapshot.slots.length >= 1 && snapshot.slots.length <= 2
      && snapshot.slots.every((slot) => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(slot.slot) && FINAL_PHASES.has(slot.phase))
      && new Set(snapshot.slots.map((slot) => slot.slot)).size === snapshot.slots.length
      && snapshot.slots.some((slot) => slot.phase === 'deadline' || (epoch(slot.deadlineReachedAt)
        && slot.deadlineReachedAt >= run.startedAt && slot.deadlineReachedAt <= finishedAt));
    if (summaryReady) {
      const id = hash(`${run.id}/deadline`);
      if (!state.summaries.some((item) => item.id === id)) {
        // Initial log replay may span many refreshes. A recent historical finish
        // is still history even if it first appears after the first snapshot.
        const fresh = !firstObservation && finishedAt >= startedAt && now - finishedAt <= NOTIFICATION_TTL_SECONDS * 1000
          && epoch(snapshot.serverTime) && now - snapshot.serverTime <= MONITOR_STALE_AFTER_MS && snapshot.serverTime <= now + 5000;
        const targetDate = run.targetDate && /^\d{4}-\d{2}-\d{2}$/u.test(run.targetDate) ? `${run.targetDate} ` : '';
        const body = `${targetDate}監控截止\n截止：${formatZonedTime(cutoff, 'Asia/Taipei').slice(0, 19)}（台灣時間）\n`
          + `乘船時段（日本時間）：\n${snapshot.slots.map((slot) => `${slot.slot} ${summaryResult(slot)}`).join('\n')}`;
        while (state.summaries.length >= MAX_DELIVERIES) {
          const removable = state.summaries.findIndex((item) => !item.recipients.some((recipient) => pendingSummary(item, recipient)));
          if (removable === -1) throw new Error('截止通知佇列已滿。');
          state.summaries.splice(removable, 1);
        }
        removeExpired();
        state.summaries.push({ id, runId: run.id, at: finishedAt,
          payload: fresh ? payload('高千穗監控已截止', body, `takachiho-deadline-${id}`) : '',
          recipients: fresh ? state.subscriptions.map((item) => ({ id: hash(item.endpoint), failures: 0,
            attempts: 0, delivered: false, nextAttemptAt: now })) : [] });
        await persist();
      }
    }
    removeExpired();
    const jobs: SendJob[] = [];
    const reserved = new Set<string>();
    // Give the one-time summary a turn before repeating hold alarms, so a hold
    // alarm for this same phone cannot indefinitely starve the final summary.
    for (const summary of state.summaries) for (const recipient of summary.recipients) {
      if (!pendingSummary(summary, recipient) || inFlight.has(recipient.id) || reserved.has(recipient.id)
        || recipient.nextAttemptAt > now) continue;
      const item = state.subscriptions.find((item) => hash(item.endpoint) === recipient.id);
      if (!item || item.nextAllowedAt > now) continue;
      reserved.add(recipient.id);
      recipient.attempts += 1;
      recipient.nextAttemptAt = now + 5000;
      jobs.push({ summary, recipient, subscription: item, payload: summary.payload });
    }
    for (const delivery of state.deliveries.filter(active)) {
      let changed = false;
      for (const recipient of delivery.recipients) {
        if (inFlight.has(recipient.id) || reserved.has(recipient.id) || recipient.nextAttemptAt > now) continue;
        const item = state.subscriptions.find((item) => hash(item.endpoint) === recipient.id);
        if (!item || item.nextAllowedAt > now) continue;
        reserved.add(recipient.id);
        if (!changed) { delivery.sequence += 1; changed = true; }
        recipient.nextAttemptAt = now + REMINDER_INTERVAL_MS;
        jobs.push({ delivery, recipient, subscription: item,
          payload: JSON.stringify({ ...JSON.parse(delivery.payload), tag: `takachiho-${delivery.id}-${delivery.sequence}` }) });
      }
    }
    // Reserve attempts before network work. Summary retries keep a stable tag
    // and topic, while repeating alarms deliberately use a fresh display tag.
    if (jobs.length) await persist();
    for (const job of jobs) inFlight.add(job.recipient.id);
    armTimer();
    return jobs;
  };
  const deliver = async (job: SendJob): Promise<void> => {
    const enabled = (): boolean => job.summary ? !job.recipient.delivered
      && Date.now() < job.summary.at + NOTIFICATION_TTL_SECONDS * 1000 : active(job.delivery);
    try {
      const registered = await serialized(async () => !closed && enabled()
        ? state.subscriptions.find((item) => item.endpoint === job.subscription.endpoint) : undefined);
      if (!registered) return;
      job.subscription = registered;
      let error: unknown;
      let failed = false;
      try {
        const ttl = job.summary ? Math.max(1, Math.ceil((job.summary.at + NOTIFICATION_TTL_SECONDS * 1000 - Date.now()) / 1000)) : REMINDER_TTL_SECONDS;
        await send(job.subscription, job.payload, { ...settings, TTL: ttl, topic: (job.summary ?? job.delivery).id.slice(0, 32) });
      } catch (cause) { failed = true; error = cause; }
      await serialized(async () => {
        // A graceful shutdown must persist a successful one-time send before
        // returning, even when close() began while the provider was responding.
        if (job.summary ? job.recipient.delivered : closed || !active(job.delivery)) return;
        if (!failed) {
          job.recipient.failures = 0;
          job.recipient.nextAttemptAt = Math.max(job.recipient.nextAttemptAt, Date.now());
          if (job.summary) job.recipient.delivered = true;
        } else if (statusCode(error) === 404 || statusCode(error) === 410) {
          state.subscriptions = state.subscriptions.filter((item) => item.endpoint !== job.subscription.endpoint);
        } else {
          job.recipient.failures = Math.min(16, job.recipient.failures + 1);
          const headers = object(object(error)?.headers);
          const value = headers?.['retry-after'] ?? headers?.['Retry-After'];
          const retryAfter = typeof value === 'string' ? parseRetryAfter(value) : undefined;
          const backoff = Math.min(60_000, 5000 * 2 ** (job.recipient.failures - 1));
          job.recipient.nextAttemptAt = Math.min(8_640_000_000_000_000, Math.ceil(Date.now() + Math.max(backoff, retryAfter ?? 0)));
          const current = state.subscriptions.find((item) => item.endpoint === job.subscription.endpoint);
          if (current) current.nextAllowedAt = job.recipient.nextAttemptAt;
        }
        await persist();
      });
    } finally { inFlight.delete(job.recipient.id); armTimer(); }
  };
  let pendingSnapshot: MonitorSnapshot | null = null;
  let observation: Promise<void> | null = null;
  const sending = new Set<Promise<void>>();
  const observe = (snapshot: MonitorSnapshot): Promise<void> => {
    latestSnapshot = snapshot;
    pendingSnapshot = snapshot;
    if (observation) return observation;
    observation = (async () => {
      // A slow provider must not enqueue one snapshot per heartbeat. Keep one
      // latest snapshot while a notification batch is being processed.
      const jobs: SendJob[] = [];
      while (pendingSnapshot) {
        const current = pendingSnapshot;
        pendingSnapshot = null;
        jobs.push(...await serialized(() => observeSnapshot(current)).catch(() => []));
      }
      // Release observation coalescing before network work, so a slow device
      // cannot delay other devices or the explicit stop command.
      observation = null;
      await Promise.all(jobs.map((job) => {
        const task = deliver(job).catch(() => undefined);
        sending.add(task);
        void task.finally(() => sending.delete(task));
        return task;
      }));
    })();
    return observation;
  };

  return {
    publicKey: keys.publicKey,
    status: () => ({ available: true, publicKey: keys.publicKey,
      reminders: state.deliveries.filter(active).map((item) => ({ ...item.reminder! })) }),
    stop: (value) => serialized(async () => {
      if (!Array.isArray(value) || !value.length || value.length > MAX_DELIVERIES
        || value.some((id) => typeof id !== 'string' || !/^[a-f\d]{64}$/u.test(id)) || new Set(value).size !== value.length) {
        throw new MonitorPushError(400, '提醒資料無效，請重新整理控制台。');
      }
      const deliveries = value.map((id) => state.deliveries.find((item) => item.id === id));
      if (deliveries.some((item) => !item?.reminder)) throw new MonitorPushError(404, '找不到這項提醒，請重新整理控制台。');
      for (const delivery of deliveries) delivery!.stoppedAt ??= Date.now();
      await persist();
      armTimer();
    }),
    close: async () => {
      closed = true;
      clearTimeout(timer);
      await observation;
      await Promise.all([...sending]);
      await queue;
    },
    subscribe: (value) => serialized(async () => {
      const item = subscription(value);
      if (item.expirationTime !== null && item.expirationTime <= Date.now()) throw new MonitorPushError(400, '通知訂閱已過期，請重新啟用通知。');
      removeExpired();
      const current = state.subscriptions.findIndex((existing) => existing.endpoint === item.endpoint);
      if (current === -1 && state.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new MonitorPushError(429, '通知裝置已達上限，請先停用不用的裝置。');
      if (current === -1) state.subscriptions.push(item);
      else state.subscriptions[current] = { ...item, nextAllowedAt: state.subscriptions[current]!.nextAllowedAt };
      await persist();
    }),
    unsubscribe: (value) => serialized(async () => {
      const target = endpoint(value);
      state.subscriptions = state.subscriptions.filter((item) => item.endpoint !== target);
      await persist();
    }),
    test: async (value) => {
      const item = await serialized(async () => {
        const target = endpoint(value);
        removeExpired();
        const item = state.subscriptions.find((item) => item.endpoint === target);
        if (!item) throw new MonitorPushError(404, '此裝置尚未啟用通知。');
        return item;
      });
      try {
        await send(item, payload('高千穗通知測試', '手機通知已啟用；船位暫留後會持續提醒，監控截止並確認所有結果後會通知一次完整摘要。', 'takachiho-test'), settings);
      } catch (error) {
        if (statusCode(error) === 404 || statusCode(error) === 410) {
          await serialized(async () => {
            state.subscriptions = state.subscriptions.filter((existing) => existing.endpoint !== item.endpoint);
            await persist();
          });
          throw new MonitorPushError(410, '通知訂閱已失效，請重新啟用這台裝置的通知。');
        }
        throw new MonitorPushError(502, '測試通知未送出，請重新啟用通知後再試。');
      }
    },
    observe,
  };
}
