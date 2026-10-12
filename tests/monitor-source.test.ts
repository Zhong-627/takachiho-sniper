import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactsMonitor } from '../src/monitor-source.js';

const START = Date.parse('2026-10-12T00:00:00.000Z');
const LIVE = '2026-10-12T00-00-00-000Z-live-abcdef12';
const NEXT = '2026-10-12T01-00-00-000Z-live-abcdef34';
const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'takachiho-monitor-'));
  temporary.push(root);
  return root;
}

function line(event: string, data: Record<string, unknown> = {}, slot?: string, at = START, mode = 'live'): string {
  return `${JSON.stringify({ mode, epochMs: at, event, data, ...(slot ? { slot } : {}) })}\n`;
}

const metadata = (): string => line('run_started', { slots: ['10:00', '10:30'], targetDate: '2026-10-26' });

async function run(root: string, name = LIVE, contents = metadata()): Promise<string> {
  const path = join(root, name);
  await mkdir(path);
  const events = join(path, 'events.jsonl');
  await writeFile(events, contents);
  return events;
}

describe('incremental artifact monitor', () => {
  it('handles an absent artifacts folder and only discovers live diagnostic directories', async () => {
    const root = await directory();
    const missing = new ArtifactsMonitor(join(root, 'absent'));
    await missing.refresh();
    expect(missing.snapshot(START)).toMatchObject({ connection: 'waiting', run: null });
    await run(root, '2026-10-12T03-00-00-000Z-rehearsal-abcdef12', line('run_started', { slots: ['11:00'] }, undefined, START, 'rehearsal'));
    await run(root, '2026-10-12T04-00-00-000Z-full-rehearsal-abcdef12');
    await run(root, 'newest-unrelated-live-private');
    await run(root, '2026-02-30T05-00-00-000Z-live-abcdef12');
    await run(root);
    const monitor = new ArtifactsMonitor(root);
    await monitor.refresh();
    expect(monitor.snapshot(START)).toMatchObject({ connection: 'live', run: { targetDate: '2026-10-26' }, slots: [{ slot: '10:00' }, { slot: '10:30' }] });
    expect(JSON.stringify(monitor.snapshot(START))).not.toContain(root);
    expect(monitor.snapshot(START).run!.id).toMatch(/^[a-f\d]{16}$/u);
  });

  it('consumes complete lines once, carries partial lines and skips malformed records', async () => {
    const root = await directory();
    const events = await run(root);
    const monitor = new ArtifactsMonitor(root);
    await monitor.refresh();
    const error = line('availability_request_error', { error: '秘密個資', attempt: 1 }, '10:00', START + 100);
    const bytes = Buffer.from(error);
    // Split a UTF-8 character as well as a JSON record across refreshes.
    const splitAt = bytes.indexOf(Buffer.from('秘密')) + 1;
    await appendFile(events, bytes.subarray(0, splitAt));
    await monitor.refresh();
    expect(monitor.snapshot(START + 100).slots[0]!.phase).toBe('waiting');
    await appendFile(events, Buffer.concat([bytes.subarray(splitAt), Buffer.from('bad JSON\n'), Buffer.from(line('availability_retry_scheduled', { attempt: 1, delayMs: 500 }, '10:00', START + 110))]));
    await monitor.refresh();
    expect(monitor.snapshot(START + 120).slots[0]).toMatchObject({ phase: 'retrying', attempts: 1, nextRetryAt: START + 610 });
    const count = monitor.snapshot(START + 120).recentEvents.length;
    await monitor.refresh();
    await monitor.refresh();
    expect(monitor.snapshot(START + 120).recentEvents).toHaveLength(count);
    expect(JSON.stringify(monitor.snapshot(START + 120))).not.toContain('秘密');
  });

  it('resets on file truncation and rotation without retaining the previous outcome', async () => {
    const root = await directory();
    const events = await run(root, LIVE, metadata() + line('human_handoff', {}, '10:00', START + 100));
    const monitor = new ArtifactsMonitor(root);
    await monitor.refresh();
    expect(monitor.snapshot(START + 100).slots[0]!.phase).toBe('handed-off');
    await writeFile(events, metadata());
    await monitor.refresh();
    expect(monitor.snapshot(START + 100).slots[0]!.phase).toBe('waiting');
    await rename(events, `${events}.old`);
    await writeFile(events, metadata() + line('monitoring_deadline_reached', { attempts: 12 }, '10:30', START + 100));
    await monitor.refresh();
    expect(monitor.snapshot(START + 100).slots.map((slot) => slot.phase)).toEqual(['waiting', 'deadline']);
  });

  it('periodically switches to the latest live run and ignores newer safe runs', async () => {
    let now = START;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const root = await directory();
    await run(root, LIVE, metadata() + line('human_handoff', {}, '10:00', START));
    const monitor = new ArtifactsMonitor(root);
    await monitor.refresh();
    const firstId = monitor.snapshot().run!.id;
    await run(root, NEXT, metadata() + line('availability_request_started', { attempt: 2 }, '10:00', START + 100));
    await run(root, '2026-10-12T05-00-00-000Z-inspect-abcdef12');
    now += 2_001;
    await monitor.refresh();
    expect(monitor.snapshot().run!.id).not.toBe(firstId);
    expect(monitor.snapshot().slots[0]).toMatchObject({ phase: 'monitoring', attempts: 2 });
  });

  it('skips oversized lines, limits work per refresh and recovers at the next newline', async () => {
    const root = await directory();
    const events = await run(root);
    const monitor = new ArtifactsMonitor(root);
    await monitor.refresh();
    await appendFile(events, 'x'.repeat(1_100_000));
    await monitor.refresh();
    await appendFile(events, `\n${line('manual_intervention_required', { reason: 'PRIVATE' }, '10:00', START + 100)}`);
    await monitor.refresh();
    expect(monitor.snapshot(START + 100).slots[0]!.phase).toBe('manual');
    expect(JSON.stringify(monitor.snapshot(START + 100))).not.toContain('PRIVATE');
  });

  it('rejects non-live records even inside a live-named directory and keeps stale state through I/O failures', async () => {
    const root = await directory();
    const events = await run(root, LIVE, metadata() + line('monitor_heartbeat', { automationActive: true }, undefined, START + 1_000));
    const monitor = new ArtifactsMonitor(root);
    await monitor.refresh();
    await appendFile(events, line('human_handoff', {}, '10:00', START + 2_000, 'rehearsal'));
    await Promise.all([monitor.refresh(), monitor.refresh()]);
    expect(monitor.snapshot(START + 3_000).slots[0]!.phase).toBe('waiting');
    await rm(events);
    await monitor.refresh();
    expect(monitor.snapshot(START + 36_001)).toMatchObject({ connection: 'stale', heartbeatAt: START + 1_000, run: { targetDate: '2026-10-26' } });
  });

  it('does not follow diagnostic-file symlinks into other local files', async () => {
    const root = await directory();
    const events = await run(root);
    const unrelated = join(root, 'unrelated.jsonl');
    await writeFile(unrelated, metadata() + line('human_handoff', {}, '10:00', START));
    await rm(events);
    await symlink(unrelated, events);
    const monitor = new ArtifactsMonitor(root);
    await monitor.refresh();
    expect(monitor.snapshot(START)).toMatchObject({ connection: 'waiting', run: null, slots: [] });
  });
});
