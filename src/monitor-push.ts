import { createECDH, createHash, ECDH, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import webPush, { type PushSubscription, type RequestOptions } from 'web-push';
import { MONITOR_STALE_AFTER_MS, type MonitorSnapshot } from './monitor-state.js';

const MAX_SUBSCRIPTIONS = 16;
const MAX_DELIVERIES = 256;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2048;
const NOTIFICATION_TTL_SECONDS = 120;
const MAX_ATTEMPTS = 3;
const DEFAULT_SUBJECT = 'https://github.com/Zhong-627/takachiho-sniper';
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com',
  'notify.windows.com', 'wns.windows.com'];

export class MonitorPushError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface MonitorPush {
  readonly publicKey: string;
  status(): { available: boolean; publicKey: string };
  subscribe(subscription: unknown): Promise<void>;
  unsubscribe(endpoint: unknown): Promise<void>;
  test(endpoint: unknown): Promise<void>;
  /** Notification errors are isolated from reservation automation. */
  observe(snapshot: MonitorSnapshot): Promise<void>;
}

export interface MonitorPushOptions {
  directory: string;
  subject?: string;
  send?: (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>;
}

interface VapidKeys { publicKey: string; privateKey: string }
interface Subscription extends PushSubscription { expirationTime: number | null }
interface Recipient { id: string; attempts: number; delivered: boolean; nextAttemptAt: number }
interface Delivery {
  id: string;
  at: number;
  baseline: boolean;
  payload: string;
  recipients: Recipient[];
}
interface PushState { version: 1; subscriptions: Subscription[]; deliveries: Delivery[] }

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
    return { endpoint: endpoint(data.endpoint), expirationTime,
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
  if (value === null) return { version: 1, subscriptions: [], deliveries: [] };
  const data = object(value);
  if (!data || data.version !== 1 || !Array.isArray(data.subscriptions) || data.subscriptions.length > MAX_SUBSCRIPTIONS
    || !Array.isArray(data.deliveries) || data.deliveries.length > MAX_DELIVERIES) throw new Error('Invalid push state');
  const subscriptions = data.subscriptions.map(subscription);
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
        || typeof recipient.attempts !== 'number' || !Number.isInteger(recipient.attempts) || recipient.attempts < 0
        || recipient.attempts > MAX_ATTEMPTS || typeof recipient.delivered !== 'boolean' || !epoch(recipient.nextAttemptAt)) {
        throw new Error('Invalid recipient');
      }
      return { id: recipient.id, attempts: recipient.attempts, delivered: recipient.delivered, nextAttemptAt: recipient.nextAttemptAt };
    });
    if (new Set(recipients.map((item) => item.id)).size !== recipients.length) throw new Error('Duplicate recipient');
    return { id: delivery.id, at: delivery.at, baseline: delivery.baseline, payload: delivery.payload, recipients };
  });
  if (new Set(deliveries.map((item) => item.id)).size !== deliveries.length) throw new Error('Duplicate delivery');
  return { version: 1, subscriptions, deliveries };
}

function payload(title: string, body: string, tag: string): string {
  const value = JSON.stringify({ title, body, url: '/', tag });
  if (Buffer.byteLength(value) > MAX_PAYLOAD_BYTES) throw new Error('Notification too large');
  return value;
}

/** Private subscriptions, stable VAPID keys and recipient-level delivery records
 * survive monitor restarts. Only approved browser push providers are contacted. */
export async function createMonitorPush(options: MonitorPushOptions): Promise<MonitorPush> {
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
    if (existingState === null) await writePrivate(stateFile, state);
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
    state.deliveries.push(delivery);
    if (state.deliveries.length > MAX_DELIVERIES) state.deliveries.splice(0, state.deliveries.length - MAX_DELIVERIES);
  };

  const observeSnapshot = async (snapshot: MonitorSnapshot): Promise<void> => {
    const now = Date.now();
    const run = snapshot.run;
    const demo = (snapshot as MonitorSnapshot & { demo?: boolean }).demo === true;
    const validRun = run?.mode === 'live' && /^[A-Za-z0-9_-]{1,80}$/u.test(run.id);
    const holds = validRun && !demo ? snapshot.slots.filter((slot) => slot.holdConfirmed === true
      && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(slot.slot) && epoch(slot.heldAt)
      && slot.heldAt >= run.startedAt && slot.heldAt <= now + 5000) : [];
    const known = new Map(state.deliveries.map((item) => [item.id, item]));
    if (!initialized) {
      initialized = true;
      for (const slot of holds) {
        const id = hash(`${run!.id}/${slot.slot}`);
        if (!known.has(id)) recordDelivery({ id, at: slot.heldAt!, baseline: true, payload: '', recipients: [] });
      }
      if (holds.length) await persist();
      return;
    }
    const health = snapshot.heartbeatAt ?? run?.startedAt;
    if (!validRun || demo || snapshot.connection !== 'live' || !epoch(snapshot.serverTime)
      || now - snapshot.serverTime > MONITOR_STALE_AFTER_MS || snapshot.serverTime > now + 5000
      || !epoch(health) || now - health > MONITOR_STALE_AFTER_MS || health > now + 5000) return;
    removeExpired();
    for (const slot of holds) {
      if (now - slot.heldAt! > NOTIFICATION_TTL_SECONDS * 1000) continue;
      const id = hash(`${run!.id}/${slot.slot}`);
      let delivery = known.get(id);
      if (!delivery) {
        delivery = { id, at: slot.heldAt!, baseline: false,
          payload: payload('高千穗船位已暫留', `${run!.targetDate ?? ''} ${slot.slot} 已暫留，請到 Mac 接手確認付款`.trim(),
            `takachiho-${run!.id}-${slot.slot.replace(':', '')}`),
          recipients: state.subscriptions.map((item) => ({ id: hash(item.endpoint), attempts: 0, delivered: false, nextAttemptAt: now })) };
        recordDelivery(delivery);
        known.set(id, delivery);
        // Snapshot the intended recipients before any network request. New
        // subscriptions cannot turn an old hold into a new notification.
        await persist();
      }
      if (delivery.baseline) continue;
      for (const recipient of delivery.recipients) {
        const sendingAt = Date.now();
        if (sendingAt - delivery.at >= NOTIFICATION_TTL_SECONDS * 1000
          || sendingAt - health > MONITOR_STALE_AFTER_MS) break;
        if (recipient.delivered || recipient.attempts >= MAX_ATTEMPTS || recipient.nextAttemptAt > sendingAt) continue;
        const item = state.subscriptions.find((item) => hash(item.endpoint) === recipient.id);
        if (!item) { recipient.delivered = true; await persist(); continue; }
        recipient.attempts += 1;
        // Persist the attempt before sending; repeated crashes cannot create
        // an unbounded retry loop. The notification tag also coalesces repeats.
        await persist();
        try {
          await send(item, delivery.payload, { ...settings,
            TTL: Math.max(1, NOTIFICATION_TTL_SECONDS - Math.floor((Date.now() - delivery.at) / 1000)) });
          recipient.delivered = true;
        } catch (error) {
          if (statusCode(error) === 404 || statusCode(error) === 410) {
            state.subscriptions = state.subscriptions.filter((existing) => existing.endpoint !== item.endpoint);
            recipient.delivered = true;
          } else recipient.nextAttemptAt = Date.now() + 5000 * 2 ** (recipient.attempts - 1);
        }
        await persist();
      }
    }
  };
  let pendingSnapshot: MonitorSnapshot | null = null;
  let observation: Promise<void> | null = null;
  const observe = (snapshot: MonitorSnapshot): Promise<void> => {
    pendingSnapshot = snapshot;
    if (observation) return observation;
    observation = (async () => {
      // A slow provider must not enqueue one snapshot per heartbeat. Keep one
      // latest snapshot while a notification batch is being processed.
      while (pendingSnapshot) {
        const current = pendingSnapshot;
        pendingSnapshot = null;
        await serialized(() => observeSnapshot(current)).catch(() => undefined);
      }
    })().finally(() => { observation = null; });
    return observation;
  };

  return {
    publicKey: keys.publicKey,
    status: () => ({ available: true, publicKey: keys.publicKey }),
    subscribe: (value) => serialized(async () => {
      const item = subscription(value);
      if (item.expirationTime !== null && item.expirationTime <= Date.now()) throw new MonitorPushError(400, '通知訂閱已過期，請重新啟用通知。');
      removeExpired();
      const current = state.subscriptions.findIndex((existing) => existing.endpoint === item.endpoint);
      if (current === -1 && state.subscriptions.length >= MAX_SUBSCRIPTIONS) throw new MonitorPushError(429, '通知裝置已達上限，請先停用不用的裝置。');
      if (current === -1) state.subscriptions.push(item);
      else state.subscriptions[current] = item;
      await persist();
    }),
    unsubscribe: (value) => serialized(async () => {
      const target = endpoint(value);
      state.subscriptions = state.subscriptions.filter((item) => item.endpoint !== target);
      await persist();
    }),
    test: (value) => serialized(async () => {
      const target = endpoint(value);
      removeExpired();
      const item = state.subscriptions.find((item) => item.endpoint === target);
      if (!item) throw new MonitorPushError(404, '此裝置尚未啟用通知。');
      try {
        await send(item, payload('高千穗通知測試', '手機通知已啟用；搶到船位後會提醒你到 Mac 接手確認付款。', 'takachiho-test'), settings);
      } catch (error) {
        if (statusCode(error) === 404 || statusCode(error) === 410) {
          state.subscriptions = state.subscriptions.filter((existing) => existing.endpoint !== target);
          await persist();
          throw new MonitorPushError(410, '通知訂閱已失效，請重新啟用這台裝置的通知。');
        }
        throw new MonitorPushError(502, '測試通知未送出，請重新啟用通知後再試。');
      }
    }),
    observe,
  };
}
