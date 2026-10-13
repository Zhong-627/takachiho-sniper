import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const INSPECTION_ERROR = '搶位程序是否仍在執行無法確認，請到 Mac 檢查原終端與瀏覽器。';

export interface MonitorProcessRuntime {
  platform?: string;
  execute(command: string, args: readonly string[]): Promise<{ stdout: string }>;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Only a direct Node entrypoint counts; text inside shell commands or node -e does not. */
function reservationEntrypoint(args: string, repositoryPaths: readonly string[]): boolean {
  const script = (name: string): string => [
    `(?:\\./)?dist/${name}\\.js`,
    ...repositoryPaths.map((path) => escapePattern(join(path, 'dist', `${name}.js`))),
  ].join('|');
  const executable = `(?:node|node22|\\S+/(?:node|node22)|${escapePattern(process.execPath)})`;
  return new RegExp(`^${executable}\\s+(?:(?:${script('cli')})\\s+live(?:\\s|$)|(?:${script('reservation-worker')})(?:\\s|$))`, 'u').test(args);
}

/** Check an old log against live project processes without exposing their arguments. */
export async function hasLegacyReservationProcess(repositoryDir: string, runtime?: MonitorProcessRuntime): Promise<boolean> {
  try {
    if ((runtime?.platform ?? process.platform) !== 'darwin') throw new Error('Unsupported process inspection');
    const execute = runtime?.execute ?? (async (command: string, args: readonly string[]) =>
      executeFile(command, [...args], { timeout: 5000, maxBuffer: 1024 * 1024 }));
    const repository = await realpath(resolve(repositoryDir));
    const paths = [...new Set([resolve(repositoryDir), repository])];
    const processes = await execute('/bin/ps', ['-axo', 'pid=,comm=,args=']);
    for (const line of processes.stdout.split(/\r?\n/u)) {
      const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/u.exec(line);
      if (!match) continue;
      const command = match[2]!;
      if (!['node', 'node22'].includes(basename(command)) && command !== process.execPath) continue;
      if (!reservationEntrypoint(match[3]!, paths)) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process identifier');
      const result = await execute('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
      const fields = result.stdout.trim().split(/\r?\n/u);
      if (fields.length !== 3 || fields[0] !== `p${pid}` || fields[1] !== 'fcwd' || !fields[2]?.startsWith('n/')) {
        throw new Error('Process working directory is uncertain');
      }
      if (await realpath(fields[2].slice(1)) === repository) return true;
    }
    return false;
  } catch {
    // Errors from ps/lsof may contain private process arguments and local paths.
    throw new Error(INSPECTION_ERROR);
  }
}
