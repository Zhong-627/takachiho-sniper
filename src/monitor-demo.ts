import type { MonitorSnapshot } from './monitor-state.js';

/** Synthetic UI rehearsal only: no browser, calendar requests or booking actions. */
export function demoMonitorSnapshot(startedAt: number, now = Date.now()): MonitorSnapshot {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const step = Math.floor(seconds / 12) % 5;
  const phases = ['monitoring', 'retrying', 'reserving', 'held', 'handed-off'] as const;
  return {
    schemaVersion: 1, serverTime: now, connection: 'live', updatedAt: now, heartbeatAt: now,
    run: { id: 'demo', mode: 'live', targetDate: '2026-10-26', startedAt, releaseAt: startedAt,
      monitorFrom: startedAt - 120_000, monitorUntil: startedAt + 7_200_000 },
    slots: [
      { slot: '11:00', phase: phases[step]!, attempts: 8 + seconds, availability: step >= 2 ? 'available' : 'unavailable',
        responseMs: 382, nextRetryAt: step === 1 ? now + (12 - seconds % 12) * 1000 : null, updatedAt: now },
      { slot: '11:30', phase: 'monitoring', attempts: 5 + seconds, availability: 'unavailable', responseMs: 514,
        nextRetryAt: now + 1200, updatedAt: now },
    ],
    recentEvents: [
      { at: now, slot: '11:00', label: ['確認餘位', '等待下次重試', '開始暫留船位', '已暫留，待人工確認付款', '已交由人工操作'][step]! },
      { at: now - 1500, slot: '11:30', label: '目前沒有可預約位置' },
      { at: startedAt, slot: null, label: '演示資料：沒有執行搶位' },
    ],
  };
}
