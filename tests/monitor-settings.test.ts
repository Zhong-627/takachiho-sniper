import { scryptSync } from 'node:crypto';
import { chmod, link, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMonitorOptions } from '../src/monitor-cli.js';
import { assertFunnelPortAvailable, monitorFunnelUrl, parseFunnelStatus } from '../src/monitor-funnel.js';
import { monitorPasswordFile, readMonitorCredential, setupMonitorCredential } from '../src/monitor-settings.js';

const temporary: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link), chmod: vi.fn(actual.chmod) };
});

afterEach(async () => {
  vi.mocked(rename).mockReset();
  vi.mocked(link).mockReset();
  vi.mocked(chmod).mockReset();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'takachiho-monitor-auth-'));
  temporary.push(dir);
  return dir;
}

describe('monitor setup', () => {
  it('creates private random credentials, preserves them on rerun and explicitly rotates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'takachiho-monitor-auth-'));
    temporary.push(dir);
    const path = join(dir, 'monitor-auth.json');
    const result = await setupMonitorCredential(path);
    expect(result).toEqual({ created: true, passwordFile: join(dir, 'monitor-password.txt') });
    const password = (await readFile(result.passwordFile, 'utf8')).trim();
    const credential = await readMonitorCredential(path);
    expect(password).toHaveLength(24);
    expect(scryptSync(password, credential.salt, 64).toString('hex')).toBe(credential.passwordHash);
    expect(await readFile(path, 'utf8')).not.toContain(password);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(result.passwordFile)).mode & 0o777).toBe(0o600);
    expect((await setupMonitorCredential(path)).created).toBe(false);
    expect(await readMonitorCredential(path)).toEqual(credential);
    await setupMonitorCredential(path, true);
    expect(await readMonitorCredential(path)).not.toEqual(credential);
    expect((await readFile(result.passwordFile, 'utf8')).trim()).not.toBe(password);
  });

  it('fails closed for absent or malformed credentials, without exposing raw contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'takachiho-monitor-invalid-'));
    temporary.push(dir);
    const path = join(dir, 'monitor-auth.json');
    await expect(readMonitorCredential(path)).rejects.toThrow('monitor:setup');
    await writeFile(path, '{"password":"private"}');
    await expect(readMonitorCredential(path)).rejects.toThrow('無效');
    await expect(setupMonitorCredential(path)).rejects.toThrow('無效');
    expect(monitorPasswordFile(path)).toBe(join(dir, 'monitor-password.txt'));
  });

  it('restores the original working password if the later credential commit fails', async () => {
    const dir = await directory();
    const path = join(dir, 'monitor-auth.json');
    const { passwordFile } = await setupMonitorCredential(path);
    const oldPassword = await readFile(passwordFile, 'utf8');
    const oldAuth = await readFile(path, 'utf8');
    const actualRename = vi.mocked(rename).getMockImplementation()!;
    vi.mocked(rename).mockImplementationOnce(actualRename).mockRejectedValueOnce(new Error('PRIVATE PATH OR SECRET'));
    const failure = await setupMonitorCredential(path, true).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('原設定已保留');
    expect((failure as Error).message).not.toContain('PRIVATE');
    expect(await readFile(passwordFile, 'utf8')).toBe(oldPassword);
    expect(await readFile(path, 'utf8')).toBe(oldAuth);
    const credential = await readMonitorCredential(path);
    expect(scryptSync(oldPassword.trim(), credential.salt, 64).toString('hex')).toBe(credential.passwordHash);
    expect((await stat(passwordFile)).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).sort()).toEqual(['monitor-auth.json', 'monitor-password.txt']);
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it('keeps both existing files intact when private staging fails before commit', async () => {
    const dir = await directory();
    const path = join(dir, 'monitor-auth.json');
    const { passwordFile } = await setupMonitorCredential(path);
    const oldPassword = await readFile(passwordFile, 'utf8');
    const oldAuth = await readFile(path, 'utf8');
    vi.mocked(chmod).mockRejectedValueOnce(new Error('PRIVATE filesystem detail'));
    await expect(setupMonitorCredential(path, true)).rejects.toThrow('原設定已保留');
    expect(await readFile(passwordFile, 'utf8')).toBe(oldPassword);
    expect(await readFile(path, 'utf8')).toBe(oldAuth);
    expect(rename).not.toHaveBeenCalled();
    expect((await readdir(dir)).sort()).toEqual(['monitor-auth.json', 'monitor-password.txt']);
  });

  it('removes a new password when first-time hash installation fails and can retry cleanly', async () => {
    const dir = await directory();
    const path = join(dir, 'monitor-auth.json');
    const actualLink = vi.mocked(link).getMockImplementation()!;
    vi.mocked(link).mockImplementationOnce(actualLink).mockRejectedValueOnce(new Error('PRIVATE filesystem detail'));
    await expect(setupMonitorCredential(path)).rejects.toThrow('原設定已保留');
    expect(await readdir(dir)).toEqual([]);
    expect((await setupMonitorCredential(path)).created).toBe(true);
    await expect(readMonitorCredential(path)).resolves.toHaveProperty('passwordHash');
  });

  it('preserves an existing hash and gives explicit recovery when its password file is missing', async () => {
    const dir = await directory();
    const path = join(dir, 'monitor-auth.json');
    const { passwordFile } = await setupMonitorCredential(path);
    const oldAuth = await readFile(path, 'utf8');
    await rm(passwordFile);
    await expect(setupMonitorCredential(path)).rejects.toThrow('--reset-password');
    expect(await readFile(path, 'utf8')).toBe(oldAuth);
    expect(await readdir(dir)).toEqual(['monitor-auth.json']);
    await setupMonitorCredential(path, true);
    const credential = await readMonitorCredential(path);
    const password = (await readFile(passwordFile, 'utf8')).trim();
    expect(scryptSync(password, credential.salt, 64).toString('hex')).toBe(credential.passwordHash);
  });

  it('never overwrites an orphaned password file during ordinary setup', async () => {
    const dir = await directory();
    const path = join(dir, 'monitor-auth.json');
    const passwordFile = monitorPasswordFile(path);
    await writeFile(passwordFile, 'old private password\n', { mode: 0o600 });
    await expect(setupMonitorCredential(path)).rejects.toThrow('--reset-password');
    expect(await readFile(passwordFile, 'utf8')).toBe('old private password\n');
    expect(await readdir(dir)).toEqual(['monitor-password.txt']);
  });

  it('rejects overlapping resets rather than interleaving password and hash pairs', async () => {
    const dir = await directory();
    const path = join(dir, 'monitor-auth.json');
    const { passwordFile } = await setupMonitorCredential(path);
    const results = await Promise.allSettled([setupMonitorCredential(path, true), setupMonitorCredential(path, true)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const credential = await readMonitorCredential(path);
    const password = (await readFile(passwordFile, 'utf8')).trim();
    expect(scryptSync(password, credential.salt, 64).toString('hex')).toBe(credential.passwordHash);
    expect((await readdir(dir)).sort()).toEqual(['monitor-auth.json', 'monitor-password.txt']);
  });
});

describe('monitor CLI', () => {
  it('has separate safe defaults and validates transport/reset options', () => {
    expect(parseMonitorOptions([])).toMatchObject({ command: 'serve', port: 4174, httpsPort: 8443, localHttp: false, demo: false });
    expect(parseMonitorOptions(['serve', '--demo', '--local-http', '--port', '4184'])).toMatchObject({ demo: true, localHttp: true, port: 4184 });
    expect(() => parseMonitorOptions(['funnel', '--local-http'])).toThrow();
    expect(() => parseMonitorOptions(['serve', '--reset-password'])).toThrow();
    for (const value of ['-1', '0', '65536', '42.5', 'NaN']) expect(() => parseMonitorOptions(['--port', value])).toThrow();
    expect(() => parseMonitorOptions(['funnel', '--https-port', '3000'])).toThrow();
    expect(() => parseMonitorOptions(['serve', '--auth-file'])).toThrow();
    for (const command of ['service-start', 'service-stop', 'service-status']) {
      expect(parseMonitorOptions([command])).toMatchObject({ command, port: 4174, localHttp: false });
      expect(() => parseMonitorOptions([command, '--local-http'])).toThrow();
      expect(() => parseMonitorOptions([command, '--demo'])).toThrow();
      expect(() => parseMonitorOptions([command, '--reset-password'])).toThrow();
    }
  });
});

describe('Funnel routing', () => {
  const existing = { TCP: { '443': { HTTPS: true } }, Web: { 'device.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4173' } } } }, AllowFunnel: { 'device.example.ts.net:443': true } };
  it('preserves existing services and accepts only our exact route for reuse', () => {
    expect(() => assertFunnelPortAvailable(existing, 8443, 4174)).not.toThrow();
    expect(() => assertFunnelPortAvailable(existing, 443, 4174)).toThrow('其他服務');
    expect(() => assertFunnelPortAvailable(existing, 443, 4173)).not.toThrow();
    const multiple = structuredClone(existing);
    Object.assign(multiple.Web['device.example.ts.net:443'].Handlers, { '/other': { Proxy: 'http://127.0.0.1:4174' } });
    expect(() => assertFunnelPortAvailable(multiple, 443, 4173)).toThrow();
  });
  it('returns only the confirmed public app URL', () => {
    expect(monitorFunnelUrl(existing, 8443, 4174)).toBeUndefined();
    expect(monitorFunnelUrl(existing, 443, 4173)).toBe('https://device.example.ts.net/');
    expect(monitorFunnelUrl({ ...existing, AllowFunnel: {} }, 443, 4173)).toBeUndefined();
    expect(() => parseFunnelStatus('Failed to load preferences')).toThrow('無法讀取');
    expect(parseFunnelStatus('{}')).toEqual({});
  });
});
