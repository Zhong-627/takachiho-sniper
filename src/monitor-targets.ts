const DAY_MS = 86_400_000;
const JAPAN_OFFSET_MS = 9 * 3_600_000;

export interface BoardingDateRange { min: string; max: string }

/** Latest day opened at 09:00 Japan, using calendar days rather than device time. */
export function boardingDateRange(nowMs = Date.now()): BoardingDateRange {
  const japanNow = new Date(nowMs + JAPAN_OFFSET_MS);
  const min = japanNow.toISOString().slice(0, 10);
  const openedDaysAhead = japanNow.getUTCHours() >= 9 ? 14 : 13;
  const max = new Date(Date.parse(`${min}T00:00:00Z`) + openedDaysAhead * DAY_MS).toISOString().slice(0, 10);
  return { min, max };
}

export const BOARDING_SLOTS: readonly string[] = Array.from({ length: 17 }, (_, index) => {
  const minutes = 8 * 60 + index * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
});
const boardingSlots = new Set(BOARDING_SLOTS);

export function boardingSlotAllowed(value: string): boolean {
  return boardingSlots.has(value);
}

export function boardingDateAllowed(value: string, range = boardingDateRange()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value < range.min || value > range.max) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
