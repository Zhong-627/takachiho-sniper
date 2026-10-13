import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig, type AppConfig } from './config.js';
import { startReservationRun, type ReservationRun } from './reservation-runner.js';
import { WORKER_LOCK_NAME, WORKER_SOCKET_NAME, type WorkerMetadata } from './worker-client.js';

export class WorkerAlreadyRunningError extends Error {
  constructor() { super('An existing reservation worker lock prevents a duplicate run. Inspect or close the existing run on the Mac.'); this.name = 'WorkerAlreadyRunningError'; }
}

export interface WorkerService {
  metadata: WorkerMetadata;
  run: ReservationRun;
  close(): Promise<void>;
}
interface WorkerOptions {
  controlDir: string;
  manualCustomerForm: boolean;
  runId?: string;
  createRun?: typeof startReservationRun;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > 1024) throw new Error('Invalid worker command.');
    chunks.push(bytes);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid worker command.');
  return parsed as Record<string, unknown>;
}

/** The worker owns the lock for its entire browser lifetime, including stopped automation. */
export async function startReservationWorker(config: AppConfig, options: WorkerOptions): Promise<WorkerService> {
  if (options.runId !== undefined && !z.string().uuid().safeParse(options.runId).success) throw new Error('Worker run identifier is invalid.');
  const controlDir = resolve(options.controlDir);
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(controlDir);
  if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())) throw new Error('Worker control directory is unavailable.');
  await chmod(controlDir, 0o700);
  const lockPath = join(controlDir, WORKER_LOCK_NAME);
  const metadata: WorkerMetadata = { pid: process.pid, token: randomBytes(32).toString('hex'), runId: options.runId ?? randomUUID(), socketPath: join(controlDir, WORKER_SOCKET_NAME) };
  // AF_UNIX paths on macOS are limited to 104 bytes including the terminating NUL.
  if (Buffer.byteLength(metadata.socketPath) >= 104) throw new Error('Worker control directory path is too long.');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new WorkerAlreadyRunningError(); }
  const removeOwnedLock = async (): Promise<void> => {
    try {
      const current: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
      if (current && typeof current === 'object' && 'token' in current && current.token === metadata.token) await unlink(lockPath);
    } catch { /* An uncertain lock must never be silently reclaimed. */ }
  };
  let run: ReservationRun;
  try {
    await lock.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
    await lock.close();
    // Leftover sockets cannot be assumed to belong to this newly acquired lock.
    try { await lstat(metadata.socketPath); throw new WorkerAlreadyRunningError(); }
    catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    run = await (options.createRun ?? startReservationRun)(config, { manualCustomerForm: options.manualCustomerForm, runId: metadata.runId });
  } catch (error) {
    await lock.close().catch(() => undefined);
    await removeOwnedLock();
    throw error;
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  // Serialize commands so close never races a guard handoff.
  let commands: Promise<void> = Promise.resolve();
  const server = createServer((request, response) => {
    const reply = (code: number, body: unknown): void => {
      response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    const authorization = request.headers.authorization;
    const expected = `Bearer ${metadata.token}`;
    if (typeof authorization !== 'string' || Buffer.byteLength(authorization) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) { request.resume(); reply(401, { error: 'Unauthorized.' }); return; }
    if (request.method === 'GET' && request.url === '/status') { reply(200, run.status()); return; }
    if (request.method !== 'POST' || !['/stop', '/handoff', '/close'].includes(request.url ?? '')) { request.resume(); reply(404, { error: 'Unknown worker command.' }); return; }
    const route = request.url;
    const operation = async (): Promise<void> => {
      try {
        if (request.headers['content-type'] !== 'application/json') throw new Error('Invalid worker command.');
        const body = await readBody(request);
        const keys = Object.keys(body);
        if (body.runId !== metadata.runId || keys.some((key) => key !== 'runId' && !(route === '/handoff' && key === 'slot'))
          || (route === '/handoff' && typeof body.slot !== 'string') || closed) { reply(409, { error: 'Command does not match the current run.' }); return; }
        if (route === '/stop') run.stop();
        else if (route === '/handoff') await run.handoff(body.slot as string);
        else await close();
        reply(200, run.status());
      } catch { reply(409, { error: 'Worker command did not complete; inspect the Mac.' }); }
    };
    commands = commands.then(operation, operation);
  });
  server.requestTimeout = 155_000;
  server.headersTimeout = 10_000;
  const stop = (): void => run.stop();
  const close = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (closing) return closing;
    closing = (async () => {
      await run.close();
      if (!run.status().closed) throw new Error('Worker browser shutdown was not confirmed.');
      closed = true;
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      // Stop accepting new clients, but allow the explicit close response to finish.
      server.close();
      await unlink(metadata.socketPath).catch(() => undefined);
      await removeOwnedLock();
    })().finally(() => { closing = undefined; });
    return closing;
  };
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(metadata.socketPath, () => { server.off('error', reject); resolveListen(); });
    });
    await chmod(metadata.socketPath, 0o600);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch {
    // A run may already own a hold. Preserve all browsers and the exclusive lock.
    run.stop();
    server.close();
    throw new Error('Worker control connection failed; existing browsers are preserved and the run remains locked.');
  }
  return { metadata, run, close };
}

async function main(): Promise<void> {
  const parsed = parseArgs({ args: process.argv.slice(2), strict: true, options: {
    config: { type: 'string' }, 'control-dir': { type: 'string' }, 'run-id': { type: 'string' }, 'manual-customer-form': { type: 'boolean', default: false },
  } });
  if (!parsed.values.config || !parsed.values['control-dir']) throw new Error('Worker requires a local snapshot and control directory.');
  const config = await loadConfig(parsed.values.config);
  const service = await startReservationWorker(config, { controlDir: parsed.values['control-dir'], manualCustomerForm: parsed.values['manual-customer-form'], runId: parsed.values['run-id'] });
  // Discard controller-created snapshots only. A direct local CLI invocation must
  // never delete its source configuration file.
  const snapshotPath = resolve(parsed.values.config);
  if (dirname(snapshotPath) === resolve(parsed.values['control-dir']) && /^run-[a-f0-9-]+\.json$/u.test(basename(snapshotPath))) {
    await unlink(snapshotPath).catch(() => undefined);
  }
  void service.run.wait();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error('Reservation worker could not start; inspect local settings and existing browser state.'); process.exitCode = 1; });
}
