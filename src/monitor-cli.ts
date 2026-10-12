import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactsMonitor } from './monitor-source.js';
import { createMonitorServer } from './monitor-server.js';
import { demoMonitorSnapshot } from './monitor-demo.js';
import { enableMonitorFunnel } from './monitor-funnel.js';
import { monitorServiceStatus, startMonitorService, stopMonitorService, type MonitorServiceStatus } from './monitor-service.js';
import { DEFAULT_AUTH_FILE, DEFAULT_FUNNEL_PORT, DEFAULT_MONITOR_PORT, readMonitorCredential, setupMonitorCredential } from './monitor-settings.js';

const help = `高千穗搶位進度 PWA（只讀）
npm run monitor:setup                 建立本機登入密碼，不會輸出密碼
npm run monitor                       啟動監控服務（本機 4174，HTTPS Funnel 登入）
npm run monitor:start                 啟用 macOS 背景服務，登入後自動啟動
npm run monitor:stop                  停止背景服務，並停用登入後自動啟動
npm run monitor:status                查看背景服務與本機連線狀態
npm run monitor:funnel                將監控服務連到 Funnel 8443，保留其他服務
npm run monitor:demo -- --local-http   在本機查看演示資料（不會搶位）
選項：--port N、--https-port 443|8443|10000、--artifacts-dir PATH、--auth-file PATH
setup 可加 --reset-password；serve 可加 --demo。
--local-http 只允許本機 HTTP 登入，不能用來發布 Funnel。
監控不讀取個資設定、不控制 Chrome、不建立預約。`;

export interface MonitorOptions {
  command: 'serve' | 'setup' | 'funnel' | 'service-start' | 'service-stop' | 'service-status'; port: number; httpsPort: number;
  artifactsDir: string; authFile: string; demo: boolean; localHttp: boolean; resetPassword: boolean; help: boolean;
}

export function parseMonitorOptions(args: readonly string[]): MonitorOptions {
  const command = args[0] && !args[0].startsWith('--') ? args[0] : 'serve';
  if (!['serve', 'setup', 'funnel', 'service-start', 'service-stop', 'service-status'].includes(command)) throw new Error('未知監控命令。使用 --help 查看用法。');
  const options: MonitorOptions = { command: command as MonitorOptions['command'], port: DEFAULT_MONITOR_PORT,
    httpsPort: DEFAULT_FUNNEL_PORT, artifactsDir: 'artifacts', authFile: DEFAULT_AUTH_FILE,
    demo: false, localHttp: false, resetPassword: false, help: false };
  for (let i = command === args[0] ? 1 : 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--demo') options.demo = true;
    else if (flag === '--local-http') options.localHttp = true;
    else if (flag === '--reset-password') options.resetPassword = true;
    else if (flag === '--help') options.help = true;
    else if (['--port', '--https-port', '--artifacts-dir', '--auth-file'].includes(flag ?? '')) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`缺少 ${flag} 的值。`);
      if (flag === '--port' || flag === '--https-port') {
        if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('port 必須為 1–65535 的整數。');
        if (flag === '--port') options.port = Number(value);
        else options.httpsPort = Number(value);
      } else if (flag === '--artifacts-dir') options.artifactsDir = value;
      else options.authFile = value;
    } else throw new Error(`未知監控選項：${flag}。`);
  }
  if (![443, 8443, 10000].includes(options.httpsPort)) throw new Error('Funnel HTTPS port 必須為 443、8443 或 10000。');
  if (options.resetPassword && options.command !== 'setup') throw new Error('--reset-password 僅能用於 setup。');
  if (options.command !== 'serve' && (options.demo || options.localHttp)) throw new Error('--demo／--local-http 僅能用於 serve。');
  return options;
}

function printServiceStatus(status: MonitorServiceStatus): void {
  console.log(`背景監控：${status.loaded ? status.state : '已停止'}${status.pid ? `（PID ${status.pid}）` : ''}`);
  console.log(`登入後自動啟動：${status.installed && status.enabled ? '已啟用' : '未啟用'}`);
  console.log(`本機監控服務：${status.healthy ? '正常' : '尚未回應'}`);
  console.log(`服務記錄：${status.logFile}`);
}

async function main(): Promise<void> {
  const options = parseMonitorOptions(process.argv.slice(2));
  if (options.help) { console.log(help); return; }
  if (options.command === 'setup') {
    const result = await setupMonitorCredential(options.authFile, options.resetPassword);
    console.log(result.created ? '監控登入設定已建立。' : '沿用現有監控登入設定。');
    console.log(`請在本機開啟密碼檔：${result.passwordFile}`);
    console.log('密碼不會傳到網址或寫入 Git。重設密碼後請重新啟動監控服務。');
    return;
  }
  if (options.command === 'funnel') {
    // A configured credential is required before making any public route.
    await readMonitorCredential(options.authFile);
    console.log(`手機網址：${await enableMonitorFunnel(options.port, options.httpsPort)}`);
    return;
  }
  if (options.command.startsWith('service-')) {
    const serviceOptions = {
      repositoryDir: fileURLToPath(new URL('..', import.meta.url)),
      authFile: resolve(options.authFile), artifactsDir: resolve(options.artifactsDir), port: options.port,
    };
    if (options.command === 'service-start') {
      await readMonitorCredential(options.authFile);
      const status = await startMonitorService(serviceOptions);
      printServiceStatus(status);
      if (!status.healthy) {
        console.error('監控背景服務已設定，但本機尚未回應；請查看服務記錄或執行 npm run monitor:status。');
        process.exitCode = 1;
      }
    } else if (options.command === 'service-stop') {
      printServiceStatus(await stopMonitorService(serviceOptions));
      console.log('監控背景服務已停止；搶位程式與 Funnel 設定不受影響。');
    } else printServiceStatus(await monitorServiceStatus(serviceOptions));
    return;
  }
  const credential = await readMonitorCredential(options.authFile);
  const started = Date.now();
  const source = new ArtifactsMonitor(resolve(options.artifactsDir));
  if (!options.demo) await source.refresh();
  const server = createMonitorServer({ credential, secureCookies: !options.localHttp,
    snapshot: () => options.demo ? demoMonitorSnapshot(started) : source.snapshot() });
  let refreshing = false;
  const refresh = setInterval(() => {
    if (refreshing || options.demo) return;
    refreshing = true;
    void source.refresh().catch(() => undefined).finally(() => { refreshing = false; });
  }, 1000);
  refresh.unref();
  const stop = (): void => {
    clearInterval(refresh);
    server.close(() => { console.log('監控服務已停止，搶位程式不受影響。'); });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.once('error', () => {
    clearInterval(refresh);
    console.error('監控服務無法啟動，請確認本機 port 未被使用。');
    process.exitCode = 1;
  });
  server.listen(options.port, '127.0.0.1', () => {
    console.log(`監控服務：http://127.0.0.1:${options.port}`);
    if (options.demo) console.log('演示模式：畫面為模擬資料，沒有啟動搶位。');
    console.log(options.localHttp ? '僅允許本機 HTTP 查看；此模式不能經由 Funnel 使用。'
      : '請執行 npm run monitor:funnel，再從手機 HTTPS 網址登入。');
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    // Only our own user-facing errors; external exceptions can contain paths.
    console.error(/^(?:監控|未知監控|缺少 --|port |Funnel |--|無法讀取 Tailscale|Tailscale 回傳|指定本機|尚未確認 Funnel)/u.test(message)
      ? message : '監控設定失敗。請確認本機檔案權限、服務與 Tailscale 狀態。');
    process.exitCode = 1;
  });
}
