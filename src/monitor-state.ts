export type MonitorPhase = 'waiting' | 'warming' | 'monitoring' | 'retrying' | 'reserving' | 'held' | 'manual' | 'ambiguous' | 'failed' | 'stopped' | 'deadline' | 'handed-off';
export type MonitorAvailability = 'available' | 'unavailable' | 'unknown' | 'limited' | 'manual';

export interface MonitorSlot {
  slot: string;
  phase: MonitorPhase;
  attempts: number;
  availability: MonitorAvailability | null;
  responseMs: number | null;
  nextRetryAt: number | null;
  updatedAt: number | null;
}

export interface MonitorSnapshot {
  schemaVersion: 1;
  serverTime: number;
  connection: 'waiting' | 'live' | 'stale' | 'ended';
  updatedAt: number | null;
  heartbeatAt: number | null;
  run: {
    id: string;
    targetDate: string | null;
    startedAt: number;
    releaseAt: number | null;
    monitorFrom: number | null;
    monitorUntil: number | null;
    mode: 'live';
  } | null;
  slots: MonitorSlot[];
  recentEvents: { at: number; slot: string | null; label: string }[];
}

export const MONITOR_STALE_AFTER_MS = 35_000;
const TERMINAL_PHASES = new Set<MonitorPhase>(['held', 'manual', 'ambiguous', 'failed', 'stopped', 'deadline', 'handed-off']);
const AVAILABILITY = new Set<MonitorAvailability>(['available', 'unavailable', 'unknown', 'limited', 'manual']);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function epoch(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : null;
}

function isoEpoch(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value)
    || date(value.slice(0, 10)) === null) return null;
  return epoch(Date.parse(value));
}

function date(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value ? value : null;
}

function slotName(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}

function duration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000 ? Math.round(value) : null;
}

/** Deliberately projects a tiny allowlist; diagnostic text and nested data never escape. */
export class MonitorState {
  private run: MonitorSnapshot['run'] = null;
  private readonly slots = new Map<string, MonitorSlot>();
  private readonly requestStartedAt = new Map<string, number>();
  private readonly history: MonitorSnapshot['recentEvents'] = [];
  private firstStartedAt: number | null = null;
  private updatedAt: number | null = null;
  private heartbeatAt: number | null = null;
  private ended = false;
  private stopped = false;
  private readonly id: string;

  constructor(runId: string) {
    this.id = /^[A-Za-z0-9_-]{1,80}$/u.test(runId) ? runId : 'live-run';
  }

  private note(at: number, label: string, slot: string | null = null): void {
    this.updatedAt = at;
    this.history.push({ at, slot, label });
    if (this.history.length > 20) this.history.shift();
  }

  private finishActive(at: number): void {
    for (const slot of this.slots.values()) {
      if (!TERMINAL_PHASES.has(slot.phase)) {
        slot.phase = 'stopped';
        slot.updatedAt = at;
        slot.nextRetryAt = null;
      }
    }
  }

  ingest(value: unknown): void {
    const input = record(value);
    if (!input || input.mode !== 'live' || typeof input.event !== 'string') return;
    const at = epoch(input.epochMs);
    if (at === null) return;
    const data = record(input.data) ?? {};
    const event = input.event;
    if (event === 'run_started') {
      this.firstStartedAt ??= at;
      // createDiagnostics emits a preliminary event before CLI supplies targets.
      if (this.run || !Array.isArray(data.slots) || data.slots.length < 1 || data.slots.length > 2
        || !data.slots.every(slotName) || new Set(data.slots).size !== data.slots.length) return;
      this.run = {
        id: this.id, targetDate: date(data.targetDate), startedAt: this.firstStartedAt,
        releaseAt: isoEpoch(data.releaseAt) ?? isoEpoch(record(data.release)?.utc),
        monitorFrom: isoEpoch(data.monitorFromAt) ?? isoEpoch(record(data.monitorFrom)?.utc),
        monitorUntil: isoEpoch(data.monitorUntil), mode: 'live',
      };
      for (const slot of data.slots) this.slots.set(slot, {
        slot, phase: 'waiting', attempts: 0, availability: null, responseMs: null, nextRetryAt: null, updatedAt: at,
      });
      this.note(at, '搶位監控已開始');
      return;
    }
    if (!this.run || this.ended) return;
    if (event === 'monitor_heartbeat') {
      // Network activity and ordinary log writes do not establish process health.
      if (typeof data.automationActive === 'boolean') this.heartbeatAt = at;
      return;
    }
    if (event === 'automation_stopped' || event === 'automation_finished') {
      this.stopped = true;
      this.finishActive(at);
      this.note(at, event === 'automation_stopped' ? '自動化已停止' : '各時段自動化已結束');
      return;
    }
    if (event === 'diagnostics_closed') {
      this.ended = true;
      this.finishActive(at);
      this.note(at, '執行程序已結束');
      return;
    }
    if (!slotName(input.slot)) return;
    const slot = this.slots.get(input.slot);
    if (!slot) return;
    const attempt = count(data.attempt) ?? count(data.attempts);
    const update = (phase: MonitorPhase, label: string, options: { preserveTerminal?: boolean; retry?: boolean } = {}): void => {
      if (slot.phase === 'handed-off' || (options.preserveTerminal && TERMINAL_PHASES.has(slot.phase))) return;
      slot.phase = phase;
      slot.updatedAt = at;
      if (attempt !== null) slot.attempts = Math.max(slot.attempts, attempt);
      if (!options.retry) slot.nextRetryAt = null;
      this.note(at, label, slot.slot);
    };
    switch (event) {
      case 'navigation-start':
      case 'navigation-ready':
      case 'target-calendar-ready':
      case 'session_warmed':
        update('warming', '瀏覽器準備中', { preserveTerminal: true });
        break;
      case 'release_wait_armed':
        update('waiting', '等待開始查詢', { preserveTerminal: true });
        break;
      case 'release_reached':
      case 'slot_worker_started':
        update('monitoring', '開始查詢餘位', { preserveTerminal: true });
        break;
      case 'availability_request_started':
        if (TERMINAL_PHASES.has(slot.phase)) break;
        this.requestStartedAt.set(slot.slot, at);
        update('monitoring', '查詢餘位中');
        break;
      case 'availability-detected':
      case 'availability_detected': {
        if (TERMINAL_PHASES.has(slot.phase) || !AVAILABILITY.has(data.status as MonitorAvailability)) break;
        slot.availability = data.status as MonitorAvailability;
        const startedAt = this.requestStartedAt.get(slot.slot);
        slot.responseMs = duration(data.responseMs) ?? (startedAt === undefined ? slot.responseMs : duration(at - startedAt));
        update('monitoring', { available: '查到可用餘位', unavailable: '目前無餘位', unknown: '餘位尚未確認', limited: '查詢受限，等待重試', manual: '餘位查詢需人工處理' }[slot.availability]);
        break;
      }
      case 'calendar-response':
        if (!TERMINAL_PHASES.has(slot.phase)) {
          const elapsed = duration(data.responseMs);
          if (elapsed !== null) slot.responseMs = elapsed;
        }
        break;
      case 'availability_request_error':
        if (TERMINAL_PHASES.has(slot.phase)) break;
        slot.availability = 'unknown';
        update('retrying', '查詢未完成，等待重試');
        break;
      case 'navigation_retry':
      case 'availability_retry_scheduled': {
        if (TERMINAL_PHASES.has(slot.phase)) break;
        const delay = duration(data.delayMs);
        slot.nextRetryAt = delay === null ? null : epoch(at + delay);
        update('retrying', '等待下次查詢', { retry: true });
        break;
      }
      case 'reservation_action_started':
      case 'slot-selection':
        update('reserving', '正在嘗試暫留船位', { preserveTerminal: true });
        break;
      case 'hold-response':
        if (data.result === '1' && typeof data.status === 'number' && Number.isInteger(data.status) && data.status >= 200 && data.status < 300) update('held', '已暫留，待人工確認付款');
        break;
      case 'customer-form-ready':
      case 'customer_form_ready':
        update('held', '已暫留，待人工確認付款');
        break;
      case 'hold-rejected-sold-out':
      case 'reservation_returned_to_monitoring':
        if (slot.phase === 'handed-off') break;
        slot.availability = 'unavailable';
        update('monitoring', '暫留遭拒且已額滿，繼續查詢');
        break;
      case 'reservation_action_finished':
      case 'slot_outcome':
        switch (data.status) {
          case 'customer-form-ready': update('held', '已暫留，待人工確認付款'); break;
          case 'manual': update('manual', '需要人工接手'); break;
          case 'ambiguous': update('ambiguous', '暫留結果不明，需人工確認'); break;
          case 'failed': update('failed', '此時段自動化未完成'); break;
          case 'deadline-reached': update('deadline', '已到監控截止時間'); break;
          case 'exhausted': update('stopped', '此時段查詢已停止', { preserveTerminal: true }); break;
        }
        break;
      case 'reservation_action_ambiguous':
        update('ambiguous', '暫留結果不明，需人工確認');
        break;
      case 'manual_intervention_required':
        update('manual', '需要人工接手');
        break;
      case 'monitoring_deadline_reached':
        update('deadline', '已到監控截止時間', { preserveTerminal: true });
        break;
      case 'slot_polling_exhausted':
        update('stopped', '此時段查詢已停止', { preserveTerminal: true });
        break;
      case 'slot_error':
        update(this.stopped ? 'stopped' : 'failed', this.stopped ? '此時段自動化已停止' : '此時段執行發生問題', { preserveTerminal: true });
        break;
      case 'human_handoff':
        update('handed-off', '已交由人工操作');
        break;
      case 'autofill_result':
        if (data.customerFieldsVerified === true) update('held', '客戶欄位已檢查，待人工確認付款');
        else if (data.customerFieldsVerified === false) update('manual', '客戶資料需要人工處理');
        break;
    }
  }

  snapshot(now = Date.now()): MonitorSnapshot {
    const serverTime = epoch(now) ?? Date.now();
    const lastHealth = this.heartbeatAt ?? this.run?.startedAt ?? null;
    return {
      schemaVersion: 1, serverTime,
      connection: !this.run ? 'waiting' : this.ended ? 'ended' : lastHealth !== null && serverTime - lastHealth > MONITOR_STALE_AFTER_MS ? 'stale' : 'live',
      updatedAt: this.updatedAt, heartbeatAt: this.heartbeatAt,
      run: this.run ? { ...this.run } : null,
      slots: [...this.slots.values()].map((slot) => ({ ...slot })),
      recentEvents: this.history.map((event) => ({ ...event })),
    };
  }
}
