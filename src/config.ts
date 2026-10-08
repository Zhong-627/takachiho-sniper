import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { OBSERVED_CUSTOMER_FIELDS, observedSelector } from './observed-form.js';

export type RunMode = 'inspect' | 'rehearsal' | 'full-rehearsal' | 'live';
export const DEFAULT_CONFIG_PATH = 'config/config.local.json';
/** Boarding times are local Japanese HH:mm, not the Mac's timezone. */
export const slotSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, 'Expected a Japan-local HH:mm slot');

const validDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

export const customerConfigSchema = z.object({
  // This is an operator assertion about the person represented by this boat.
  // It is checked before side effects, and is never included in diagnostics.
  representativeName: z.string().trim().max(200).default(''),
  fields: z.record(z.string().min(1), z.string().max(2000)).default({}),
  mappings: z.array(z.object({
    key: z.string().min(1).max(100),
    selector: z.string().trim().min(1).max(1000),
    kind: z.enum(['fill', 'select', 'check']).optional(),
  }).strict()).max(100).default([]),
}).strict().superRefine((customer, context) => {
  const keys = customer.mappings.map((mapping) => mapping.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', message: 'Customer mappings must have unique keys', path: ['mappings'] });
  }
  const selectors = customer.mappings.map((mapping) => mapping.selector);
  if (new Set(selectors).size !== selectors.length) {
    context.addIssue({ code: 'custom', message: 'Customer mappings must have unique selectors', path: ['mappings'] });
  }
});

export const configSchema = z.object({
  targetDate: z.string().refine(validDate, 'Expected a valid YYYY-MM-DD calendar date'),
  releaseAt: z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)), 'Expected a valid release instant with UTC offset'),
  slots: z.array(slotSchema).min(1).max(2),
  browser: z.object({
    channel: z.enum(['chrome', 'chromium']).default('chromium'),
    executablePath: z.string().trim().min(1).optional(),
    headless: z.boolean().default(false),
  }).strict().default({ channel: 'chromium', headless: false }),
  polling: z.object({
    maxAttempts: z.number().int().min(1).max(1000).default(80),
    baseDelayMs: z.number().int().min(750).max(60_000).default(1250),
    maxDelayMs: z.number().int().min(750).max(300_000).default(20_000),
  }).strict().default({ maxAttempts: 80, baseDelayMs: 1250, maxDelayMs: 20_000 }),
  timeouts: z.object({
    navigationMs: z.number().int().min(1000).max(120_000).default(30_000),
    actionMs: z.number().int().min(500).max(60_000).default(10_000),
    customerFormMs: z.number().int().min(1000).max(120_000).default(30_000),
  }).strict().default({ navigationMs: 30_000, actionMs: 10_000, customerFormMs: 30_000 }),
  warmupSeconds: z.number().int().min(10).max(3600).default(120),
  artifactsDir: z.string().trim().min(1).default('artifacts'),
  customers: z.record(slotSchema, customerConfigSchema).default({}),
}).strict().superRefine((config, context) => {
  if (new Set(config.slots).size !== config.slots.length) {
    context.addIssue({ code: 'custom', message: 'Slots must be independent unique targets', path: ['slots'] });
  }
  if (config.polling.maxDelayMs < config.polling.baseDelayMs) {
    context.addIssue({ code: 'custom', message: 'maxDelayMs must be at least baseDelayMs', path: ['polling', 'maxDelayMs'] });
  }
});

export type CustomerConfig = z.infer<typeof customerConfigSchema>;
export type AppConfig = z.infer<typeof configSchema>;

/** Error messages contain paths and rules, never local customer values. */
export function parseConfig(value: unknown): AppConfig {
  const result = configSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.map((part, index) => issue.path[0] === 'customers' && index === 1 && !slotSchema.safeParse(part).success ? '<invalid-slot>' : String(part));
      return `${path.join('.') || 'config'}: ${issue.message}`;
    });
    throw new Error(`Invalid local config:\n${issues.join('\n')}`);
  }
  return result.data;
}

export async function loadConfig(path = DEFAULT_CONFIG_PATH): Promise<AppConfig> {
  let contents: string;
  try {
    contents = await readFile(resolve(path), 'utf8');
  } catch {
    throw new Error('Cannot read local config. Copy config/config.example.json to config/config.local.json, then edit it locally.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(contents) as unknown;
  } catch {
    throw new Error('Local config must be valid JSON. Customer values are omitted from this error.');
  }
  return parseConfig(decoded);
}

export function validateModeConfig(
  config: AppConfig,
  mode: RunMode,
  confirmed: boolean,
  selectedSlot?: string,
): void {
  if (mode === 'inspect' || mode === 'rehearsal') return;
  if (!confirmed) throw new Error(`${mode} requires --confirm-reservation-side-effects.`);
  if (config.browser.headless) throw new Error('Reservation modes require a visible browser for manual payment and security challenges.');
  if (mode === 'full-rehearsal' && (!selectedSlot || !config.slots.includes(selectedSlot))) {
    throw new Error('full-rehearsal requires --slot with one configured target slot.');
  }
  const slots = mode === 'full-rehearsal' ? [selectedSlot!] : config.slots;
  const representatives = slots.map((slot) => config.customers[slot]?.representativeName.trim() ?? '');
  if (representatives.some((name) => !name || /^REPLACE|^TODO|^YOUR[_ ]/iu.test(name))) {
    throw new Error('Each reservation slot requires an actual representativeName in local customer config.');
  }
  const normalized = representatives.map((name) => name.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('en-US'));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Each boat requires a different representative. Configure distinct representativeName values per slot.');
  }
  for (const slot of slots) {
    const customer = config.customers[slot];
    if (!customer) continue;
    if (mode === 'live' || customer.mappings.length > 0) {
      const fullNameMatches = customer.fields.representativeName === customer.representativeName
        && customer.mappings.some((mapping) => mapping.key === 'representativeName' && (!mapping.kind || mapping.kind === 'fill'));
      const splitNameMatches = ['familyName', 'givenName'].every((key) => {
        const field = OBSERVED_CUSTOMER_FIELDS.find((item) => item.key === key);
        return field && customer.fields[key]?.trim() && customer.mappings.some((mapping) =>
          mapping.key === key && mapping.selector === observedSelector(field) && (!mapping.kind || mapping.kind === 'fill'));
      });
      const normalizedName = (value: string): string => value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('en-US');
      const splitValues = [customer.fields.familyName ?? '', customer.fields.givenName ?? ''];
      const splitIdentityMatches = splitNameMatches && [splitValues.join(''), [...splitValues].reverse().join('')]
        .some((name) => normalizedName(name) === normalizedName(customer.representativeName));
      const hasSplitMapping = customer.mappings.some((mapping) => ['familyName', 'givenName'].includes(mapping.key));
      if ((hasSplitMapping && !splitIdentityMatches) || (!fullNameMatches && !splitIdentityMatches)) {
        throw new Error('Configured autofill requires a representativeName mapping whose field value equals that slot representativeName, or observed familyName/givenName mappings identifying the same representative.');
      }
    }
    if (mode === 'live' && customer.mappings.some((mapping) => !customer.fields[mapping.key])) {
      throw new Error('live requires a nonempty local value for every customer mapping.');
    }
  }
}

export class ReservationTargetsChangedError extends Error {
  constructor() {
    super('預約目標已變更：同一份已保留表單只接受個資／mappings 更新。請先確認既有 hold 狀態，再另行啟動新目標。');
    this.name = 'ReservationTargetsChangedError';
  }
}

/** Reloading customer values must not retarget an already running reservation. */
export function assertReservationTargetsUnchanged(original: AppConfig, updated: AppConfig): void {
  if (original.targetDate !== updated.targetDate || Date.parse(original.releaseAt) !== Date.parse(updated.releaseAt)
      || original.slots.length !== updated.slots.length || original.slots.some((slot) => !updated.slots.includes(slot))) {
    throw new ReservationTargetsChangedError();
  }
}
