import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MonitorState, type MonitorSnapshot } from './monitor-state.js';

const CHUNK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const DISCOVERY_INTERVAL_MS = 2_000;

/** Accept only directories produced by createDiagnostics for the live command. */
function isLiveRun(name: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-live-[a-f\d]{8}$/u.exec(name);
  if (!match) return false;
  const timestamp = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
  const at = Date.parse(timestamp);
  return Number.isFinite(at) && new Date(at).toISOString() === timestamp;
}

/** Independent, bounded JSONL tailer. It never reads customer config or browser artifacts. */
export class ArtifactsMonitor {
  private readonly artifactsDir: string;
  private state = new MonitorState('live-run');
  private activeRun: string | null = null;
  private fileIdentity: string | null = null;
  private fileModifiedAt: number | null = null;
  private offset = 0;
  private carry: Buffer = Buffer.alloc(0);
  private discardLongLine = false;
  private nextDiscoveryAt = 0;
  private refreshing: Promise<void> | null = null;

  constructor(artifactsDir: string) {
    this.artifactsDir = resolve(artifactsDir);
  }

  private resetFile(): void {
    this.offset = 0;
    this.carry = Buffer.alloc(0);
    this.discardLongLine = false;
    this.fileIdentity = null;
    this.fileModifiedAt = null;
    const id = this.activeRun ? createHash('sha256').update(this.activeRun).digest('hex').slice(0, 16) : 'live-run';
    this.state = new MonitorState(id);
  }

  private async discover(): Promise<void> {
    const now = Date.now();
    if (now < this.nextDiscoveryAt) return;
    this.nextDiscoveryAt = now + DISCOVERY_INTERVAL_MS;
    try {
      const entries = await readdir(this.artifactsDir, { withFileTypes: true });
      const latest = entries.filter((entry) => entry.isDirectory() && isLiveRun(entry.name))
        .map((entry) => entry.name).sort().at(-1);
      if (latest && latest !== this.activeRun) {
        this.activeRun = latest;
        this.resetFile();
      }
    } catch {
      // Missing artifacts, temporary filesystem errors and permissions never
      // disturb automation; an existing snapshot naturally becomes stale.
    }
  }

  private consume(input: Buffer): void {
    let bytes = input;
    if (this.discardLongLine) {
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      this.discardLongLine = false;
      bytes = bytes.subarray(newline + 1);
    }
    const combined = this.carry.length ? Buffer.concat([this.carry, bytes]) : bytes;
    let start = 0;
    for (let newline = combined.indexOf(10, start); newline >= 0; newline = combined.indexOf(10, start)) {
      if (newline - start <= MAX_LINE_BYTES) {
        try { this.state.ingest(JSON.parse(combined.subarray(start, newline).toString('utf8')) as unknown); }
        catch { /* Ignore malformed or incomplete diagnostic records. */ }
      }
      start = newline + 1;
    }
    const remaining = combined.subarray(start);
    this.discardLongLine = remaining.length > MAX_LINE_BYTES;
    this.carry = this.discardLongLine ? Buffer.alloc(0) : Buffer.from(remaining);
  }

  private async readUpdates(): Promise<void> {
    if (!this.activeRun) return;
    const file = await open(join(this.artifactsDir, this.activeRun, 'events.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return;
      const identity = `${stat.dev}:${stat.ino}`;
      if ((this.fileIdentity !== null && this.fileIdentity !== identity) || stat.size < this.offset
        || (stat.size === this.offset && this.fileModifiedAt !== null && stat.mtimeMs !== this.fileModifiedAt)) this.resetFile();
      this.fileIdentity = identity;
      this.fileModifiedAt = stat.mtimeMs;
      const available = Math.min(MAX_READ_BYTES, Math.max(0, stat.size - this.offset));
      const buffer = Buffer.alloc(CHUNK_BYTES);
      for (let read = 0; read < available;) {
        const result = await file.read(buffer, 0, Math.min(CHUNK_BYTES, available - read), this.offset);
        if (!result.bytesRead) break;
        this.offset += result.bytesRead;
        read += result.bytesRead;
        this.consume(buffer.subarray(0, result.bytesRead));
      }
    } finally { await file.close(); }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const work = (async () => {
      try { await this.discover(); await this.readUpdates(); }
      catch { /* Keep serving the last safe snapshot through I/O failures. */ }
    })();
    this.refreshing = work;
    try { await work; }
    finally { this.refreshing = null; }
  }

  snapshot(now = Date.now()): MonitorSnapshot {
    return this.state.snapshot(now);
  }
}
