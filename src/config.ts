import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

export type RunMode = 'inspect' | 'rehearsal' | 'full-rehearsal' | 'live';
export const DEFAULT_CONFIG_PATH = 'config/config.local.json';
export const TARGET_SLOTS = ['10:00', '10:30'] as const;

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
  targetDate: z.string().refine(validDate, 'Expected a valid YYYY-MM-DD calendar date').default('2026-10-26'),
  releaseAt: z.string().datetime({ offset: true }).default('2026-10-12T09:00:00+09:00'),
  slots: z.array(z.enum(TARGET_SLOTS)).min(1).max(2).default([...TARGET_SLOTS]),
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
  customers: z.partialRecord(z.enum(TARGET_SLOTS), customerConfigSchema).default({}),
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
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`);
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
  if (mode === 'full-rehearsal' && (!selectedSlot || !config.slots.includes(selectedSlot as typeof TARGET_SLOTS[number]))) {
    throw new Error('full-rehearsal requires --slot with one configured target slot.');
  }
  if (mode === 'live' && (config.slots.length !== 2 || !TARGET_SLOTS.every((slot) => config.slots.includes(slot)))) {
    throw new Error('live requires both independent target slots: 10:00 and 10:30.');
  }
  if (mode === 'live' && (config.targetDate !== '2026-10-26'
      || new Date(config.releaseAt).getTime() !== new Date('2026-10-12T09:00:00+09:00').getTime())) {
    throw new Error('live is pinned to 2026-10-26 and release instant 2026-10-12 09:00 Asia/Tokyo.');
  }
  const slots = mode === 'full-rehearsal' ? [selectedSlot as typeof TARGET_SLOTS[number]] : config.slots;
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
      if (customer.fields.representativeName !== customer.representativeName
          || !customer.mappings.some((mapping) => mapping.key === 'representativeName' && (!mapping.kind || mapping.kind === 'fill'))) {
        throw new Error('Configured autofill requires a representativeName mapping whose field value equals that slot representativeName.');
      }
    }
    if (mode === 'live' && customer.mappings.some((mapping) => !customer.fields[mapping.key])) {
      throw new Error('live requires a nonempty local value for every customer mapping.');
    }
  }
}
