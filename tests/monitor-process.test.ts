import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasLegacyReservationProcess } from '../src/monitor-process.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture(processes: string, owned = true) {
  const directory = await mkdtemp(join(tmpdir(), 'takachiho-monitor-process-'));
  directories.push(directory);
  const repository = join(directory, 'repo');
  const other = join(directory, 'other');
  await Promise.all([mkdir(repository), mkdir(other)]);
  const execute = vi.fn(async (command: string, args: readonly string[]): Promise<{ stdout: string }> => {
    if (command === '/bin/ps') return { stdout: processes };
    if (command === '/usr/sbin/lsof') return { stdout: `p${args[2]}\nfcwd\nn${owned ? repository : other}\n` };
    throw new Error('Unexpected executable');
  });
  return { repository, other, execute, runtime: { platform: 'darwin', execute } };
}

describe('legacy reservation process guard', () => {
  it.each([
    '12 node node dist/cli.js live --confirm-reservation-side-effects',
    '12 /opt/homebrew/bin/node /opt/homebrew/bin/node ./dist/cli.js live',
    '12 node22 node22 dist/reservation-worker.js --config PRIVATE_CONFIG',
  ])('recognizes a direct project reservation entrypoint: %s', async (processes) => {
    const test = await fixture(processes);
    expect(await hasLegacyReservationProcess(test.repository, test.runtime)).toBe(true);
    expect(test.execute.mock.calls).toEqual([
      ['/bin/ps', ['-axo', 'pid=,comm=,args=']],
      ['/usr/sbin/lsof', ['-a', '-p', '12', '-d', 'cwd', '-Fn']],
    ]);
  });

  it('recognizes absolute entrypoints and canonicalizes symlinked repository directories', async () => {
    const test = await fixture('');
    const alias = `${test.repository}-alias`;
    await symlink(test.repository, alias);
    test.execute.mockImplementation(async (command, args) => ({ stdout: command === '/bin/ps'
      ? `12 node node ${alias}/dist/cli.js live\n`
      : `p${args[2]}\nfcwd\nn${await realpath(test.repository)}\n` }));
    expect(await hasLegacyReservationProcess(alias, test.runtime)).toBe(true);
    test.execute.mockImplementation(async (command, args) => ({ stdout: command === '/bin/ps'
      ? `12 node node ${test.repository}/dist/reservation-worker.js --run-id PRIVATE\n`
      : `p${args[2]}\nfcwd\nn${test.repository}\n` }));
    expect(await hasLegacyReservationProcess(test.repository, test.runtime)).toBe(true);
  });

  it('ignores another repository even when the entrypoint uses a relative path', async () => {
    const test = await fixture('12 node node dist/cli.js live', false);
    expect(await hasLegacyReservationProcess(test.repository, test.runtime)).toBe(false);
  });

  it('ignores shell text, node expressions, monitor processes and non-live CLI modes', async () => {
    const test = await fixture([
      '12 grep grep dist/cli.js live',
      '13 zsh zsh -c node dist/cli.js live',
      '14 node node -e "console.log(\'dist/cli.js live\')"',
      '15 node node dist/monitor-cli.js serve',
      '16 node node dist/cli.js inspect',
      '17 node node dist/cli.js live-other',
      '18 node node ./helper.js dist/cli.js live',
      '19 node node /another/repo/dist/cli.js live',
      '20 notnode notnode dist/cli.js live',
    ].join('\n'));
    expect(await hasLegacyReservationProcess(test.repository, test.runtime)).toBe(false);
    expect(test.execute).toHaveBeenCalledOnce();
  });

  it('continues checking candidates after finding an unrelated working directory', async () => {
    const test = await fixture('12 node node dist/cli.js live\n13 node node dist/cli.js live');
    test.execute.mockImplementation(async (command, args) => ({ stdout: command === '/bin/ps'
      ? '12 node node dist/cli.js live\n13 node node dist/cli.js live'
      : `p${args[2]}\nfcwd\nn${args[2] === '12' ? test.other : test.repository}\n` }));
    expect(await hasLegacyReservationProcess(test.repository, test.runtime)).toBe(true);
    expect(test.execute).toHaveBeenCalledTimes(3);
  });

  it.each(['ps', 'lsof', 'malformed', 'missing-cwd', 'invalid-pid'])('fails closed with sanitized errors for %s uncertainty', async (failure) => {
    const test = await fixture('12 node node dist/cli.js live');
    test.execute.mockImplementation(async (command) => {
      if (failure === 'ps' || (failure === 'lsof' && command === '/usr/sbin/lsof')) throw new Error('PRIVATE process arguments and paths');
      if (command === '/bin/ps') return { stdout: `${failure === 'invalid-pid' ? '9007199254740992' : '12'} node node dist/cli.js live` };
      if (failure === 'malformed') return { stdout: 'p13\nfcwd\nn/PRIVATE_PATH\n' };
      return { stdout: 'p12\nfcwd\nn/PRIVATE_MISSING_DIRECTORY\n' };
    });
    await expect(hasLegacyReservationProcess(test.repository, test.runtime)).rejects.toThrow('無法確認');
    await expect(hasLegacyReservationProcess(test.repository, test.runtime)).rejects.not.toThrow('PRIVATE');
  });

  it('does not guess that an unsupported platform has no reservation process', async () => {
    const test = await fixture('');
    await expect(hasLegacyReservationProcess(test.repository, { ...test.runtime, platform: 'unsupported' })).rejects.toThrow('無法確認');
    expect(test.execute).not.toHaveBeenCalled();
  });
});
