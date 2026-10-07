import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AppConfig, CustomerConfig } from './config.js';
import type { AutofillResult } from './autofill.js';

const RECEIPT_PATH = '.local/form-verification.json';
interface Receipt { version: 1; entries: Array<{ signature: string; verifiedAt: string }> }
/** Includes definitions and keys, never hashes or stores personal values. */
export function mappingSignature(customer: CustomerConfig): string {
  return createHash('sha256').update(JSON.stringify({
    mappings: [...customer.mappings].sort((a, b) => a.key.localeCompare(b.key)),
    keys: Object.keys(customer.fields).sort(),
  })).digest('hex');
}

async function readReceipt(path: string): Promise<Receipt> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof value === 'object' && value !== null && 'version' in value && value.version === 1 && 'entries' in value && Array.isArray(value.entries)) {
      const entries = value.entries.filter((entry): entry is Receipt['entries'][number] => typeof entry === 'object' && entry !== null && typeof entry.signature === 'string' && typeof entry.verifiedAt === 'string');
      return { version: 1, entries };
    }
  } catch { /* First rehearsal has no receipt yet. */ }
  return { version: 1, entries: [] };
}

export async function recordVerifiedForm(customer: CustomerConfig, result: AutofillResult, path = RECEIPT_PATH): Promise<void> {
  if (!result.customerFieldsVerified) return;
  const receipt = await readReceipt(path);
  const signature = mappingSignature(customer);
  receipt.entries = receipt.entries.filter((entry) => entry.signature !== signature);
  receipt.entries.push({ signature, verifiedAt: new Date().toISOString() });
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

export async function assertLiveReadiness(config: AppConfig, path = RECEIPT_PATH, now = Date.now()): Promise<void> {
  const receipt = await readReceipt(path);
  for (const slot of config.slots) {
    const customer = config.customers[slot];
    if (!customer || customer.mappings.length === 0 || Object.values(customer.fields).some((value) => !value.trim())) {
      throw new Error(`[${slot}] Live requires complete local customer fields and observed form mappings.`);
    }
    const signature = mappingSignature(customer);
    const verified = receipt.entries.some((entry) => entry.signature === signature && Number.isFinite(Date.parse(entry.verifiedAt)) && now - Date.parse(entry.verifiedAt) >= 0 && now - Date.parse(entry.verifiedAt) <= 7 * 86_400_000);
    if (!verified) throw new Error(`[${slot}] Run full-rehearsal and verify Autofill within 7 days before live. Mapping definitions must match the verified local receipt.`);
  }
}
