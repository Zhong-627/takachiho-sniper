import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config.js';
import type { ReservationRun, WorkerStatus } from '../src/reservation-runner.js';
import { startReservationWorker, type WorkerService } from '../src/reservation-worker.js';
import { readWorkerMetadata, readWorkerStatus, sendWorkerCommand, WorkerUnavailableError, WORKER_LOCK_NAME } from '../src/worker-client.js';

const directories: string[] = [];
const services: WorkerService[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  for (const child of children.splice(0)) { child.kill('SIGKILL'); await once(child, 'exit'); }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function directory() {
  // Short enough for macOS's Unix-domain socket path limit.
  const value = await mkdtemp('/tmp/takachiho-worker-');
  directories.push(value);
  return value;
}
function config() { return parseConfig({ targetDate: '2030-10-26', releaseAt: '2030-10-12T09:00:00+09:00', slots: ['10:00'] }); }
function fakeRun(runId: string): ReservationRun {
  const state: WorkerStatus = { runId, targetDate: '2030-10-26', automationStopped: false, closed: false,
    slots: [{ slot: '10:00', active: false, handedOff: false, canHandoff: true, holdConfirmed: true }] };
  return { status: () => structuredClone(state), wait: async () => [], refill: vi.fn(async () => undefined),
    stop: vi.fn(() => { state.automationStopped = true; }),
    handoff: vi.fn(async (slot) => {
      if (slot !== state.slots[0]!.slot || !state.slots[0]!.canHandoff) throw new Error('A private value must not escape.');
      state.slots[0]!.handedOff = true; state.slots[0]!.canHandoff = false;
    }),
    close: vi.fn(async () => { state.automationStopped = true; state.closed = true; state.slots[0]!.canHandoff = false; }),
  };
}
async function service(controlDir: string) {
  const value = await startReservationWorker(config(), { controlDir, manualCustomerForm: true,
    createRun: async (_config, options) => fakeRun(options.runId!) });
  services.push(value);
  return value;
}
function rawRequest(socketPath: string, token: string, path: string, body?: unknown): Promise<{ code: number; body: string }> {
  return new Promise((resolveRequest, reject) => {
    const contents = body ? JSON.stringify(body) : undefined;
    const outgoing = request({ socketPath, path, method: body ? 'POST' : 'GET', headers: {
      authorization: `Bearer ${token}`, ...(contents ? { 'content-type': 'application/json' } : {}),
    } }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += String(chunk); });
      response.on('end', () => resolveRequest({ code: response.statusCode!, body: data }));
    });
    outgoing.on('error', reject); outgoing.end(contents);
  });
}

describe('persistent local reservation worker', () => {
  it('binds metadata and runner to a supplied bootstrap UUID and rejects invalid IDs before startup', async () => {
    const controlDir = await directory();
    const runId = randomUUID();
    const createRun = vi.fn(async (_config, options: { runId?: string }) => fakeRun(options.runId!));
    await expect(startReservationWorker(config(), { controlDir, manualCustomerForm: true, runId: 'not-a-uuid', createRun })).rejects.toThrow('identifier');
    expect(createRun).not.toHaveBeenCalled();
    expect(await readWorkerMetadata(controlDir)).toBeNull();
    const value = await startReservationWorker(config(), { controlDir, manualCustomerForm: true, runId, createRun });
    services.push(value);
    expect(value.metadata.runId).toBe(runId);
    expect(value.run.status().runId).toBe(runId);
    expect((await readWorkerStatus(controlDir))?.runId).toBe(runId);
    expect(createRun).toHaveBeenCalledWith(config(), { manualCustomerForm: true, runId });
  });

  it('keeps the private lock across monitor reconnects and stopping, and removes it only on explicit close', async () => {
    const controlDir = await directory();
    const value = await service(controlDir);
    expect((await lstat(join(controlDir, WORKER_LOCK_NAME))).mode & 0o777).toBe(0o600);
    expect((await lstat(value.metadata.socketPath)).mode & 0o777).toBe(0o600);
    expect(await readWorkerMetadata(controlDir)).toEqual(value.metadata);
    expect((await readWorkerStatus(controlDir))?.runId).toBe(value.metadata.runId);
    const stopped = await sendWorkerCommand(controlDir, 'stop', value.metadata.runId);
    expect(stopped.automationStopped).toBe(true);
    expect(stopped.closed).toBe(false);
    expect(await readWorkerMetadata(controlDir)).toEqual(value.metadata);
    const handedOff = await sendWorkerCommand(controlDir, 'handoff', value.metadata.runId, '10:00');
    expect(handedOff.slots[0]?.handedOff).toBe(true);
    const closed = await sendWorkerCommand(controlDir, 'close', value.metadata.runId);
    expect(closed.closed).toBe(true);
    expect(await readWorkerMetadata(controlDir)).toBeNull();
    expect(await readWorkerStatus(controlDir)).toBeNull();
  });

  it('authenticates every route, rejects old run IDs and never returns raw operation errors', async () => {
    const value = await service(await directory());
    const unauthorized = await rawRequest(value.metadata.socketPath, 'wrong', '/status');
    expect(unauthorized.code).toBe(401);
    // Unicode headers with the same character count must not crash timingSafeEqual.
    expect((await rawRequest(value.metadata.socketPath, 'é'.repeat(64), '/status')).code).toBe(401);
    expect((await rawRequest(value.metadata.socketPath, value.metadata.token, '/stop', { runId: randomUUID() })).code).toBe(409);
    expect(value.run.stop).not.toHaveBeenCalled();
    const failed = await rawRequest(value.metadata.socketPath, value.metadata.token, '/handoff', { runId: value.metadata.runId, slot: '11:00' });
    expect(failed.code).toBe(409);
    expect(failed.body).not.toContain('private value');
    expect((await rawRequest(value.metadata.socketPath, value.metadata.token, '/exec', { runId: value.metadata.runId, command: 'anything' })).code).toBe(404);
    await expect(sendWorkerCommand(await directory(), 'stop', value.metadata.runId)).rejects.toBeInstanceOf(WorkerUnavailableError);
  });

  it('atomically prevents concurrent worker launches before either browser runtime starts twice', async () => {
    const controlDir = await directory();
    const createRun = vi.fn(async (_config, options: { runId?: string }) => fakeRun(options.runId!));
    const options = { controlDir, manualCustomerForm: true, createRun };
    const attempts = await Promise.allSettled([startReservationWorker(config(), options), startReservationWorker(config(), options)]);
    const fulfilled = attempts.filter((item) => item.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    services.push(fulfilled[0]!.value);
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(attempts.some((item) => item.status === 'rejected' && item.reason.name === 'WorkerAlreadyRunningError')).toBe(true);
  });

  it('honors a lock held by another process and refuses uncertain or stale recovery', async () => {
    const controlDir = await directory();
    const lockPath = join(controlDir, WORKER_LOCK_NAME);
    const child = spawn(process.execPath, ['-e', `const fs = require('node:fs'); const path = process.argv[1]; fs.writeFileSync(path, JSON.stringify({pid:process.pid,token:'a'.repeat(64),runId:'11111111-1111-4111-8111-111111111111',socketPath:process.argv[2]}), {flag:'wx',mode:0o600}); process.stdout.write('ready'); setInterval(() => {}, 1000);`, lockPath, join(controlDir, 'worker.sock')], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await once(child.stdout!, 'data');
    const createRun = vi.fn(async () => fakeRun(randomUUID()));
    await expect(startReservationWorker(config(), { controlDir, manualCustomerForm: true, createRun })).rejects.toThrow('duplicate');
    await expect(readWorkerStatus(controlDir)).rejects.toBeInstanceOf(WorkerUnavailableError);
    expect(createRun).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(lockPath, 'utf8')).pid).toBe(child.pid);
    child.kill('SIGKILL'); await once(child, 'exit'); children.splice(children.indexOf(child), 1);
    await expect(startReservationWorker(config(), { controlDir, manualCustomerForm: true, createRun })).rejects.toThrow('duplicate');
    expect(createRun).not.toHaveBeenCalled();
  });

  it('fails closed on unreadable or permissive metadata without exposing its contents', async () => {
    const controlDir = await directory();
    const lock = join(controlDir, WORKER_LOCK_NAME);
    await writeFile(lock, '{"private":"sensitive value"}', { mode: 0o600 });
    await expect(readWorkerMetadata(controlDir)).rejects.toThrow('uncertain');
    await chmod(lock, 0o644);
    await expect(readWorkerStatus(controlDir)).rejects.toThrow('uncertain');
  });

  it('cleans up its own preflight failure without touching an existing run', async () => {
    const controlDir = await directory();
    await expect(startReservationWorker(config(), { controlDir, manualCustomerForm: true,
      createRun: async () => { throw new Error('Validated preflight failed before browser launch.'); } })).rejects.toThrow('preflight');
    expect(await readWorkerMetadata(controlDir)).toBeNull();
  });
});
