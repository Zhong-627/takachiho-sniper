import { randomBytes, scrypt } from 'node:crypto';
import { chmod, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { MonitorCredential } from './monitor-server.js';

export const DEFAULT_MONITOR_PORT = 4174;
export const DEFAULT_FUNNEL_PORT = 8443;
export const DEFAULT_AUTH_FILE = '.local/monitor-auth.json';

export function monitorPasswordFile(authFile: string): string {
  return join(dirname(authFile), `${basename(authFile, '.json').replace(/-auth$/u, '')}-password.txt`);
}

export async function readMonitorCredential(path = DEFAULT_AUTH_FILE): Promise<MonitorCredential> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch { throw new Error('監控登入設定不存在或無法讀取，請先執行 npm run monitor:setup。'); }
  if (!value || typeof value !== 'object') throw new Error('監控登入設定無效，請重新執行 monitor:setup -- --reset-password。');
  const credential = value as Record<string, unknown>;
  if (typeof credential.salt !== 'string' || !/^[a-f\d]{32,128}$/u.test(credential.salt)
    || typeof credential.passwordHash !== 'string' || !/^[a-f\d]{128}$/u.test(credential.passwordHash)) {
    throw new Error('監控登入設定無效，請重新執行 monitor:setup -- --reset-password。');
  }
  return { salt: credential.salt, passwordHash: credential.passwordHash };
}

function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

async function readExisting(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) { if (missing(error)) return null; throw error; }
}

/** Passwords stay in private ignored files, never terminal output or URL arguments. */
export async function setupMonitorCredential(authFile = DEFAULT_AUTH_FILE, reset = false): Promise<{created: boolean; passwordFile: string}> {
  const path = resolve(authFile);
  const passwordFile = monitorPasswordFile(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.setup-lock`;
  try { await writeFile(lock, '', { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error('監控登入設定無法更新，可能正由另一個設定程序使用；請確認本機權限後重試。'); }
  const temporary: string[] = [];
  let keepBackups = false;
  try {
    const previousAuth = await readExisting(path);
    if (!reset && previousAuth !== null) {
      await readMonitorCredential(path);
      const existingPassword = await readExisting(passwordFile);
      if (!existingPassword?.length) throw new Error('監控密碼檔不存在或為空；登入設定已保留，請執行 npm run monitor:setup -- --reset-password。');
      return { created: false, passwordFile };
    }
    const previousPassword = await readExisting(passwordFile);
    if (!reset && previousPassword !== null) throw new Error('監控密碼檔已存在；現有檔案已保留，請執行 npm run monitor:setup -- --reset-password。');
    const salt = randomBytes(32).toString('hex');
    const password = randomBytes(18).toString('base64url');
    const passwordHash = await new Promise<string>((done, reject) => {
      scrypt(password, salt, 64, (error, key) => error ? reject(error) : done(key.toString('hex')));
    });
    const suffix = randomBytes(16).toString('hex');
    const stage = async (destination: string, contents: string | Buffer, kind: 'new' | 'previous'): Promise<string> => {
      const staged = `${destination}.${suffix}.${kind}`;
      temporary.push(staged);
      await writeFile(staged, contents, { flag: 'wx', mode: 0o600 });
      await chmod(staged, 0o600);
      return staged;
    };
    let passwordCommitted = false;
    let previousPasswordFile: string | null = null;
    try {
      // Finish writing both replacements and a rollback copy before changing
      // either destination. Their permissions already apply after commit.
      const stagedAuth = await stage(path, `${JSON.stringify({ salt, passwordHash }, null, 2)}\n`, 'new');
      const stagedPassword = await stage(passwordFile, `${password}\n`, 'new');
      if (reset && previousPassword !== null) previousPasswordFile = await stage(passwordFile, previousPassword, 'previous');
      if (reset) {
        await rename(stagedPassword, passwordFile);
        passwordCommitted = true;
        await rename(stagedAuth, path);
      } else {
        // Hard links install an entire file exclusively; an intervening file
        // creation cannot silently overwrite someone else's configuration.
        await link(stagedPassword, passwordFile);
        passwordCommitted = true;
        await link(stagedAuth, path);
      }
    } catch {
      if (passwordCommitted) {
        try {
          if (previousPasswordFile) await rename(previousPasswordFile, passwordFile);
          else await rm(passwordFile, { force: true });
        } catch {
          keepBackups = true;
          throw new Error('監控登入設定更新失敗，舊密碼備份保留在同一資料夾；請確認權限後執行 monitor:setup -- --reset-password。');
        }
      }
      throw new Error('監控登入設定更新失敗，原設定已保留；請確認本機權限後重試。');
    }
    return { created: true, passwordFile };
  } finally {
    if (!keepBackups) await Promise.all(temporary.map((file) => rm(file, { force: true }).catch(() => undefined)));
    await rm(lock, { force: true }).catch(() => undefined);
  }
}
