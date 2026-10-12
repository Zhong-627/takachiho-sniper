import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MONITOR_SERVICE_LABEL, monitorServiceDefinition, monitorServicePlist, monitorServiceStatus,
  startMonitorService, stopMonitorService, type MonitorServiceOptions, type MonitorServiceRuntime } from '../src/monitor-service.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'takachiho-monitor-service-'));
  temporary.push(directory);
  const options: MonitorServiceOptions = {
    repositoryDir: join(directory, 'repo'), authFile: '.local/monitor-auth.json', artifactsDir: 'artifacts',
    port: 4174, nodePath: '/opt/example/node',
  };
  const homeDir = join(directory, 'home');
  const definition = monitorServiceDefinition(options, homeDir);
  let loaded = false;
  let disabled = false;
  let foreign = false;
  const execute = vi.fn(async (args: readonly string[]): Promise<{ stdout: string }> => {
    if (args[0] === 'print') {
      if (!loaded) throw Object.assign(new Error('PRIVATE launchctl failure'), { code: 113 });
      return { stdout: `gui/501/${MONITOR_SERVICE_LABEL} = {\n path = ${foreign ? '/foreign.plist' : definition.plistFile}\n working directory = ${options.repositoryDir}\n state = running\n pid = 1234\n}\n` };
    }
    if (args[0] === 'print-disabled') return { stdout: `disabled services = {\n "${MONITOR_SERVICE_LABEL}" => ${disabled}\n}` };
    if (args[0] === 'bootstrap') loaded = true;
    if (args[0] === 'bootout') loaded = false;
    if (args[0] === 'disable') disabled = true;
    if (args[0] === 'enable') disabled = false;
    return { stdout: '' };
  });
  const overrides: Partial<MonitorServiceRuntime> = {
    platform: 'darwin', uid: 501, homeDir, execute,
    probe: vi.fn(async () => true), wait: vi.fn(async () => undefined),
  };
  const install = async (contents = monitorServicePlist(definition)) => {
    await mkdir(dirname(definition.plistFile), { recursive: true });
    await writeFile(definition.plistFile, contents);
  };
  return { options, definition, overrides, execute, install,
    setLoaded: (value: boolean) => { loaded = value; }, setForeign: () => { foreign = true; },
  };
}

describe('persistent monitor LaunchAgent', () => {
  it('writes a direct Node daemon with absolute escaped paths and secure transport', () => {
    const definition = monitorServiceDefinition({ repositoryDir: '/repo with <>&"\' chars', authFile: '.local/auth.json',
      artifactsDir: 'artifacts', port: 4174, nodePath: '/node with spaces/node' }, '/home with spaces');
    const plist = monitorServicePlist(definition);
    expect(definition.arguments).toEqual(['/node with spaces/node', '/repo with <>&"\' chars/dist/monitor-cli.js',
      'serve', '--port', '4174', '--auth-file', '/repo with <>&"\' chars/.local/auth.json',
      '--artifacts-dir', '/repo with <>&"\' chars/artifacts']);
    expect(plist).toContain('/repo with &lt;&gt;&amp;&quot;&apos; chars');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<key>ThrottleInterval</key><integer>10</integer>');
    expect(plist).not.toContain('--local-http');
    expect(plist).not.toContain('EnvironmentVariables');
    expect(plist).not.toContain('passwordHash');
    expect(plist).toContain(definition.ownershipMarker);
  });

  it('installs private files, starts independently and reuses the identical loaded job', async () => {
    const { options, definition, overrides, execute } = await fixture();
    const started = await startMonitorService(options, overrides);
    expect(started).toMatchObject({ installed: true, loaded: true, enabled: true, state: 'running', pid: 1234, healthy: true });
    expect(await readFile(definition.plistFile, 'utf8')).toBe(monitorServicePlist(definition));
    expect((await stat(definition.plistFile)).mode & 0o777).toBe(0o600);
    expect((await stat(definition.logFile)).mode & 0o777).toBe(0o600);
    expect(execute).toHaveBeenCalledWith(['bootstrap', 'gui/501', definition.plistFile]);
    execute.mockClear();
    await startMonitorService(options, overrides);
    expect(execute.mock.calls.some(([args]) => args[0] === 'bootstrap' || args[0] === 'bootout')).toBe(false);
    expect(execute).toHaveBeenCalledWith(['enable', `gui/501/${MONITOR_SERVICE_LABEL}`]);
  });

  it('updates only our changed daemon and restarts it, retaining existing logs', async () => {
    const { options, definition, overrides, execute } = await fixture();
    await startMonitorService(options, overrides);
    await writeFile(definition.logFile, 'existing log\n');
    execute.mockClear();
    await startMonitorService({ ...options, port: 4184 }, overrides);
    const operations = execute.mock.calls.map(([args]) => args[0]);
    expect(operations.indexOf('bootout')).toBeLessThan(operations.indexOf('bootstrap'));
    expect(await readFile(definition.plistFile, 'utf8')).toContain('<string>4184</string>');
    expect(await readFile(definition.logFile, 'utf8')).toBe('existing log\n');
  });

  it('stops only our label and keeps it disabled across logins until explicitly started', async () => {
    const { options, definition, overrides, execute } = await fixture();
    await startMonitorService(options, overrides);
    execute.mockClear();
    const stopped = await stopMonitorService(options, overrides);
    expect(stopped).toMatchObject({ installed: true, loaded: false, enabled: false, state: 'stopped', healthy: false });
    expect(execute).toHaveBeenCalledWith(['disable', `gui/501/${MONITOR_SERVICE_LABEL}`]);
    expect(execute).toHaveBeenCalledWith(['bootout', `gui/501/${MONITOR_SERVICE_LABEL}`]);
    expect(await readFile(definition.plistFile, 'utf8')).toBe(monitorServicePlist(definition));
    expect(await startMonitorService(options, overrides)).toMatchObject({ enabled: true, loaded: true });
  });

  it('refuses a foreign manifest or repository marker without changing files or launchd', async () => {
    const { options, definition, overrides, execute, install } = await fixture();
    const foreign = monitorServicePlist(monitorServiceDefinition({ ...options, repositoryDir: '/different-repo' }, overrides.homeDir));
    await install(foreign);
    await expect(startMonitorService(options, overrides)).rejects.toThrow('其他設定');
    await expect(stopMonitorService(options, overrides)).rejects.toThrow('其他設定');
    expect(await readFile(definition.plistFile, 'utf8')).toBe(foreign);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an already loaded foreign label, even when our manifest exists', async () => {
    const { options, overrides, execute, install, setLoaded, setForeign } = await fixture();
    await install();
    setLoaded(true);
    setForeign();
    await expect(startMonitorService(options, overrides)).rejects.toThrow('其他執行中的服務');
    await expect(stopMonitorService(options, overrides)).rejects.toThrow('其他執行中的服務');
    expect(execute.mock.calls.every(([args]) => args[0] === 'print')).toBe(true);
  });

  it('does not adopt a loaded label when the matching owned manifest is missing', async () => {
    const { options, overrides, execute, setLoaded } = await fixture();
    setLoaded(true);
    await expect(startMonitorService(options, overrides)).rejects.toThrow('其他執行中的服務');
    expect(execute.mock.calls.every(([args]) => args[0] === 'print')).toBe(true);
  });

  it('refuses plist symlinks so an unrelated target cannot be overwritten', async () => {
    const { options, definition, overrides, execute } = await fixture();
    await mkdir(dirname(definition.plistFile), { recursive: true });
    const target = join(dirname(definition.plistFile), 'foreign.plist');
    await writeFile(target, 'foreign private data');
    await symlink(target, definition.plistFile);
    await expect(startMonitorService(options, overrides)).rejects.toThrow('不是一般檔案');
    expect(await readFile(target, 'utf8')).toBe('foreign private data');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses log symlinks before touching the existing loaded job', async () => {
    const { options, definition, overrides, execute } = await fixture();
    await startMonitorService(options, overrides);
    const target = join(dirname(definition.logFile), 'foreign.log');
    await writeFile(target, 'private');
    await rm(definition.logFile);
    await symlink(target, definition.logFile);
    execute.mockClear();
    await expect(startMonitorService({ ...options, port: 4184 }, overrides)).rejects.toThrow('不是一般檔案');
    expect(await readFile(target, 'utf8')).toBe('private');
    expect(execute.mock.calls.every(([args]) => args[0] === 'print')).toBe(true);
  });

  it('waits briefly for the secure local health marker with a bounded retry count', async () => {
    const { options, overrides } = await fixture();
    overrides.probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await startMonitorService(options, overrides)).toMatchObject({ healthy: true });
    expect(overrides.probe).toHaveBeenCalledTimes(3);
    expect(overrides.wait).toHaveBeenCalledTimes(2);
    overrides.probe = vi.fn(async () => false);
    expect(await startMonitorService(options, overrides)).toMatchObject({ healthy: false });
    expect(overrides.probe).toHaveBeenCalledTimes(4);
  });

  it('reports an absent job without probing a different process on the port', async () => {
    const { options, overrides } = await fixture();
    expect(await monitorServiceStatus(options, overrides)).toMatchObject({ installed: false, loaded: false, healthy: false });
    expect(overrides.probe).not.toHaveBeenCalled();
    expect(await stopMonitorService(options, overrides)).toMatchObject({ installed: false, loaded: false });
  });

  it('fails clearly on unsupported platforms and sanitizes launchctl failures', async () => {
    const { options, overrides, execute } = await fixture();
    await expect(startMonitorService(options, { ...overrides, platform: 'linux' })).rejects.toThrow('只支援 macOS');
    expect(execute).not.toHaveBeenCalled();
    execute.mockRejectedValueOnce(new Error('PRIVATE ERROR OR SECRET'));
    const failure = await startMonitorService(options, overrides).catch((error: unknown) => error);
    expect((failure as Error).message).toContain('狀態無法讀取');
    expect((failure as Error).message).not.toContain('PRIVATE');
  });
});
