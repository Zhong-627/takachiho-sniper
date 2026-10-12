import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const MONITOR_SERVICE_LABEL = 'com.takachiho.monitor';
const execute = promisify(execFile);

export interface MonitorServiceOptions {
  repositoryDir: string;
  authFile: string;
  artifactsDir: string;
  port: number;
  nodePath?: string;
}

export interface MonitorServiceRuntime {
  platform: string;
  homeDir: string;
  uid: number;
  execute: (args: readonly string[]) => Promise<{ stdout: string }>;
  probe: (port: number) => Promise<boolean>;
  wait: (milliseconds: number) => Promise<void>;
}

export interface MonitorServiceDefinition {
  repositoryDir: string;
  plistFile: string;
  logFile: string;
  arguments: string[];
  ownershipMarker: string;
}

export interface MonitorServiceStatus {
  installed: boolean;
  loaded: boolean;
  enabled: boolean;
  state: string;
  pid?: number;
  healthy: boolean;
  logFile: string;
}

async function localHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(1500) });
    const healthy = response.ok && response.headers.get('x-takachiho-monitor') === '1'
      && response.headers.get('x-takachiho-monitor-transport') === 'https';
    await response.body?.cancel();
    return healthy;
  } catch { return false; }
}

function runtime(overrides: Partial<MonitorServiceRuntime>): MonitorServiceRuntime {
  const result: MonitorServiceRuntime = {
    platform: process.platform,
    homeDir: homedir(),
    uid: process.getuid?.() ?? -1,
    execute: async (args) => execute('/bin/launchctl', [...args], { timeout: 15_000, maxBuffer: 64 * 1024 }),
    probe: localHealth,
    wait: async (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    ...overrides,
  };
  if (result.platform !== 'darwin' || !Number.isInteger(result.uid) || result.uid < 0) {
    throw new Error('監控背景服務目前只支援 macOS，其他系統請使用 npm run monitor。');
  }
  return result;
}

function xml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

export function monitorServiceDefinition(options: MonitorServiceOptions, homeDir = homedir()): MonitorServiceDefinition {
  const repositoryDir = resolve(options.repositoryDir);
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const label = MONITOR_SERVICE_LABEL;
  return {
    repositoryDir,
    plistFile: join(resolve(homeDir), 'Library', 'LaunchAgents', `${label}.plist`),
    logFile: join(repositoryDir, '.local', 'monitor-service.log'),
    arguments: [nodePath, join(repositoryDir, 'dist', 'monitor-cli.js'), 'serve', '--port', String(options.port),
      '--auth-file', resolve(repositoryDir, options.authFile), '--artifacts-dir', resolve(repositoryDir, options.artifactsDir)],
    ownershipMarker: `<!-- takachiho-monitor-service:v1:${Buffer.from(repositoryDir).toString('base64url')}:${label} -->`,
  };
}

/** launchd executes Node directly; no shell, npm parent, secrets or inherited session are needed. */
export function monitorServicePlist(definition: MonitorServiceDefinition): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${definition.ownershipMarker}
<plist version="1.0">
<dict>
  <key>Label</key><string>${MONITOR_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${definition.arguments.map((argument) => `<string>${xml(argument)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(definition.repositoryDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(definition.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(definition.logFile)}</string>
</dict>
</plist>
`;
}

function hasCode(error: unknown, code: string | number): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

async function existingManifest(definition: MonitorServiceDefinition): Promise<string | null> {
  try {
    // Refuse symlinks and special files so installation cannot overwrite an unrelated target.
    if (!(await lstat(definition.plistFile)).isFile()) throw new Error('監控背景服務設定路徑不是一般檔案，已保留現有設定。');
    const contents = await readFile(definition.plistFile, 'utf8');
    if (!contents.includes(definition.ownershipMarker)
      || !contents.includes(`<key>Label</key><string>${MONITOR_SERVICE_LABEL}</string>`)
      || !contents.includes(`<key>WorkingDirectory</key><string>${xml(definition.repositoryDir)}</string>`)) {
      throw new Error('監控背景服務名稱已被其他設定使用，已保留現有服務。');
    }
    return contents;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    if (error instanceof Error && error.message.startsWith('監控')) throw error;
    throw new Error('監控背景服務設定無法讀取，請確認本機檔案權限。');
  }
}

interface LoadedJob { state: string; pid?: number; path?: string; workingDirectory?: string }

async function jobStatus(environment: MonitorServiceRuntime): Promise<LoadedJob | null> {
  let stdout: string;
  try { ({ stdout } = await environment.execute(['print', `gui/${environment.uid}/${MONITOR_SERVICE_LABEL}`])); }
  catch (error) {
    if (hasCode(error, 113)) return null;
    throw new Error('監控背景服務狀態無法讀取，請在目前登入的 macOS 帳號執行。');
  }
  const pid = /^\s*pid = (\d+)\s*$/mu.exec(stdout)?.[1];
  return {
    state: /^\s*state = ([\w -]+)\s*$/mu.exec(stdout)?.[1]?.trim() ?? 'loaded',
    ...(pid ? { pid: Number(pid) } : {}),
    path: /^\s*path = (.+)$/mu.exec(stdout)?.[1]?.trim(),
    workingDirectory: /^\s*working directory = (.+)$/mu.exec(stdout)?.[1]?.trim(),
  };
}

function assertOwnedJob(job: LoadedJob | null, manifest: string | null, definition: MonitorServiceDefinition): void {
  if (job && (!manifest || job.path !== definition.plistFile || job.workingDirectory !== definition.repositoryDir)) {
    throw new Error('監控背景服務名稱已被其他執行中的服務使用，已保留現有服務。');
  }
}

async function launchctl(environment: MonitorServiceRuntime, args: readonly string[]): Promise<void> {
  try { await environment.execute(args); }
  catch { throw new Error('監控背景服務操作失敗，請確認目前登入帳號與 LaunchAgents 權限後重試。'); }
}

async function enabled(environment: MonitorServiceRuntime): Promise<boolean> {
  try {
    const { stdout } = await environment.execute(['print-disabled', `gui/${environment.uid}`]);
    return !new RegExp(`"${MONITOR_SERVICE_LABEL.replace(/\./gu, '\\.')}"\\s*=>\\s*true`, 'u').test(stdout);
  } catch { throw new Error('監控背景服務啟用狀態無法讀取，請在目前登入的 macOS 帳號執行。'); }
}

async function status(environment: MonitorServiceRuntime, options: MonitorServiceOptions,
  definition: MonitorServiceDefinition): Promise<MonitorServiceStatus> {
  const manifest = await existingManifest(definition);
  const job = await jobStatus(environment);
  assertOwnedJob(job, manifest, definition);
  return {
    installed: manifest !== null,
    loaded: job !== null,
    enabled: await enabled(environment),
    state: job?.state ?? 'stopped',
    ...(job?.pid ? { pid: job.pid } : {}),
    healthy: job !== null && await environment.probe(options.port),
    logFile: definition.logFile,
  };
}

export async function monitorServiceStatus(options: MonitorServiceOptions,
  overrides: Partial<MonitorServiceRuntime> = {}): Promise<MonitorServiceStatus> {
  const environment = runtime(overrides);
  return status(environment, options, monitorServiceDefinition(options, environment.homeDir));
}

export async function startMonitorService(options: MonitorServiceOptions,
  overrides: Partial<MonitorServiceRuntime> = {}): Promise<MonitorServiceStatus> {
  const environment = runtime(overrides);
  const definition = monitorServiceDefinition(options, environment.homeDir);
  const manifest = await existingManifest(definition);
  const job = await jobStatus(environment);
  assertOwnedJob(job, manifest, definition);
  const contents = monitorServicePlist(definition);
  const changed = contents !== manifest;
  try {
    await mkdir(dirname(definition.plistFile), { recursive: true });
    await mkdir(dirname(definition.logFile), { recursive: true, mode: 0o700 });
    try {
      if (!(await lstat(definition.logFile)).isFile()) throw new Error('監控背景服務記錄路徑不是一般檔案，已保留現有檔案。');
    } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    await writeFile(definition.logFile, '', { flag: 'a', mode: 0o600 });
    await chmod(definition.logFile, 0o600);
    if (changed) {
      if (manifest === null) await writeFile(definition.plistFile, contents, { flag: 'wx', mode: 0o600 });
      else {
        const staged = `${definition.plistFile}.${randomUUID()}.new`;
        try {
          await writeFile(staged, contents, { flag: 'wx', mode: 0o600 });
          // Recheck ownership after staging before replacing an existing configuration.
          await existingManifest(definition);
          await rename(staged, definition.plistFile);
        } finally { await rm(staged, { force: true }); }
      }
    }
    await chmod(definition.plistFile, 0o600);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('監控')) throw error;
    throw new Error('監控背景服務設定無法寫入，請確認 LaunchAgents 與本機記錄檔權限。');
  }
  if (changed && job) await launchctl(environment, ['bootout', `gui/${environment.uid}/${MONITOR_SERVICE_LABEL}`]);
  await launchctl(environment, ['enable', `gui/${environment.uid}/${MONITOR_SERVICE_LABEL}`]);
  if (changed || !job) await launchctl(environment, ['bootstrap', `gui/${environment.uid}`, definition.plistFile]);
  const result = await status(environment, options, definition);
  // bootstrap can return before Node is listening. Four bounded probes finish
  // within seven seconds even if every local request reaches its timeout.
  for (let attempt = 0; result.loaded && !result.healthy && attempt < 3; attempt += 1) {
    await environment.wait(250);
    result.healthy = await environment.probe(options.port);
  }
  return result;
}

/** Retain our manifest but disable the job so stop also persists across future logins. */
export async function stopMonitorService(options: MonitorServiceOptions,
  overrides: Partial<MonitorServiceRuntime> = {}): Promise<MonitorServiceStatus> {
  const environment = runtime(overrides);
  const definition = monitorServiceDefinition(options, environment.homeDir);
  const manifest = await existingManifest(definition);
  const job = await jobStatus(environment);
  assertOwnedJob(job, manifest, definition);
  if (manifest !== null) {
    await launchctl(environment, ['disable', `gui/${environment.uid}/${MONITOR_SERVICE_LABEL}`]);
    if (job) await launchctl(environment, ['bootout', `gui/${environment.uid}/${MONITOR_SERVICE_LABEL}`]);
  }
  return status(environment, options, definition);
}
