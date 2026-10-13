import { request } from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { WorkerStatus } from './reservation-runner.js';

export const WORKER_LOCK_NAME = 'reservation-worker.lock';
export const WORKER_SOCKET_NAME = 'worker.sock';
const metadataSchema = z.object({
  pid: z.number().int().positive(), token: z.string().regex(/^[a-f0-9]{64}$/u),
  runId: z.string().uuid(), socketPath: z.string().min(1),
}).strict();
const statusSchema = z.object({
  runId: z.string().uuid(), targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  slots: z.array(z.object({
    slot: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u), active: z.boolean(),
    handedOff: z.boolean(), canHandoff: z.boolean(), holdConfirmed: z.boolean(),
  }).strict()).min(1).max(2),
  automationStopped: z.boolean(), closed: z.boolean(),
}).strict();
export type WorkerMetadata = z.infer<typeof metadataSchema>;
export type WorkerCommand = 'stop' | 'handoff' | 'close';

/** Public errors never include socket tokens, local paths, personal config, or browser values. */
export class WorkerUnavailableError extends Error {
  constructor() { super('Reservation worker status is uncertain; keep the existing run locked and inspect the Mac.'); this.name = 'WorkerUnavailableError'; }
}

export async function readWorkerMetadata(controlDir: string): Promise<WorkerMetadata | null> {
  const directory = resolve(controlDir);
  const path = join(directory, WORKER_LOCK_NAME);
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new WorkerUnavailableError();
    const parsed = metadataSchema.safeParse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if (!parsed.success || parsed.data.socketPath !== join(directory, WORKER_SOCKET_NAME)) throw new WorkerUnavailableError();
    return parsed.data;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw new WorkerUnavailableError();
  }
}

async function workerRequest(metadata: WorkerMetadata, command?: WorkerCommand, runId?: string, slot?: string): Promise<WorkerStatus> {
  const contents = command ? JSON.stringify({ runId, ...(slot ? { slot } : {}) }) : undefined;
  return new Promise((resolveRequest, reject) => {
    const outgoing = request({
      socketPath: metadata.socketPath, method: command ? 'POST' : 'GET', path: command ? `/${command}` : '/status',
      headers: { authorization: `Bearer ${metadata.token}`, ...(contents ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(contents) } : {}) },
    }, (response) => {
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8192) { response.destroy(); reject(new WorkerUnavailableError()); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new WorkerUnavailableError();
          const parsed = statusSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          if (!parsed.success || parsed.data.runId !== metadata.runId || (runId && parsed.data.runId !== runId)) throw new WorkerUnavailableError();
          resolveRequest(parsed.data);
        } catch { reject(new WorkerUnavailableError()); }
      });
      response.on('error', () => reject(new WorkerUnavailableError()));
    });
    outgoing.setTimeout(command === 'close' ? 150_000 : 10_000, () => { outgoing.destroy(); reject(new WorkerUnavailableError()); });
    outgoing.on('error', () => reject(new WorkerUnavailableError()));
    outgoing.end(contents);
  });
}

/** null means no lock; a dead/unreachable/malformed lock is an error, never permission to restart. */
export async function readWorkerStatus(controlDir: string): Promise<WorkerStatus | null> {
  const metadata = await readWorkerMetadata(controlDir);
  return metadata ? workerRequest(metadata) : null;
}

export async function sendWorkerCommand(controlDir: string, command: WorkerCommand, runId: string, slot?: string): Promise<WorkerStatus> {
  const metadata = await readWorkerMetadata(controlDir);
  if (!metadata || metadata.runId !== runId || !['stop', 'handoff', 'close'].includes(command)) throw new WorkerUnavailableError();
  return workerRequest(metadata, command, runId, slot);
}
