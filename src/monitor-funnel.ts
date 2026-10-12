import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

interface FunnelStatus {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

export function parseFunnelStatus(raw: string): FunnelStatus {
  let status: unknown;
  try { status = JSON.parse(raw) as unknown; }
  catch { throw new Error('無法讀取 Tailscale 設定，請確認 Tailscale 已啟動並登入。'); }
  if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('Tailscale 回傳無效設定。');
  return status as FunnelStatus;
}

/** Never replace a port that already serves another app, or reset global settings. */
export function assertFunnelPortAvailable(status: FunnelStatus, httpsPort: number, localPort: number): void {
  const portInUse = status.TCP?.[String(httpsPort)] !== undefined
    || Object.keys(status.Web ?? {}).some((name) => name.endsWith(`:${httpsPort}`));
  if (!portInUse) return;
  const entries = Object.entries(status.Web ?? {}).filter(([name]) => name.endsWith(`:${httpsPort}`));
  const target = `http://127.0.0.1:${localPort}`;
  if (entries.length === 1) {
    const handlers = entries[0]![1].Handlers;
    if (handlers && Object.keys(handlers).length === 1 && handlers['/']?.Proxy === target) return;
  }
  throw new Error(`Funnel ${httpsPort} 已被其他服務使用；請指定另一個 --https-port（443、8443 或 10000）。`);
}

export function monitorFunnelUrl(status: FunnelStatus, httpsPort: number, localPort: number): string | undefined {
  for (const [name, entry] of Object.entries(status.Web ?? {})) {
    if (name.endsWith(`:${httpsPort}`) && status.AllowFunnel?.[name] === true
      && entry.Handlers?.['/']?.Proxy === `http://127.0.0.1:${localPort}`) {
      const url = new URL(`https://${name}`);
      if (/^[a-z\d.-]+\.ts\.net$/u.test(url.hostname)) return `${url.origin}/`;
    }
  }
  return undefined;
}

async function status(): Promise<FunnelStatus> {
  const result = await execute('tailscale', ['funnel', 'status', '--json'], { timeout: 15_000, maxBuffer: 64 * 1024 });
  return parseFunnelStatus(result.stdout);
}

export async function enableMonitorFunnel(localPort: number, httpsPort: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${localPort}/api/session`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok || response.headers.get('x-takachiho-monitor') !== '1') {
    await response.body?.cancel();
    throw new Error('指定本機 port 沒有監控服務。請先啟動 npm run monitor，再設定 Funnel。');
  }
  const transport = response.headers.get('x-takachiho-monitor-transport');
  await response.body?.cancel();
  if (transport !== 'https') throw new Error('監控服務採本機 HTTP 模式，請移除 --local-http 後重新啟動再發布 Funnel。');
  assertFunnelPortAvailable(await status(), httpsPort, localPort);
  await execute('tailscale', ['funnel', '--bg', '--yes', `--https=${httpsPort}`, `http://127.0.0.1:${localPort}`], {
    timeout: 30_000, maxBuffer: 64 * 1024,
  });
  const url = monitorFunnelUrl(await status(), httpsPort, localPort);
  if (!url) throw new Error('尚未確認 Funnel 已啟用，請在終端執行 tailscale funnel status。');
  return url;
}
