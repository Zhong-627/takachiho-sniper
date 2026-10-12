import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { AppConfig, CustomerConfig } from './config.js';
import type { AutofillResult } from './autofill.js';
import { AUTOFILL_POLICY_VERSION } from './observed-form.js';

const RECEIPT_PATH = '.local/form-verification.json';
interface Receipt { version: 2; entries: Array<{ signature: string; verifiedAt: string }> }
const receiptWrites = new Map<string, Promise<void>>();
export interface LiveReadiness {
  customerFormMode: 'auto' | 'manual';
  formVerification: Array<{ slot: string; status: 'recent' | 'pending' | 'manual' }>;
}
/** Includes definitions and keys, never hashes or stores personal values. */
export function mappingSignature(customer: CustomerConfig): string {
  return createHash('sha256').update(JSON.stringify({
    policyVersion: AUTOFILL_POLICY_VERSION,
    mappings: [...customer.mappings].sort((a, b) => a.key.localeCompare(b.key)),
    keys: Object.keys(customer.fields).sort(),
  })).digest('hex');
}

async function readReceipt(path: string): Promise<Receipt> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof value === 'object' && value !== null && 'version' in value && value.version === AUTOFILL_POLICY_VERSION && 'entries' in value && Array.isArray(value.entries)) {
      const entries = value.entries.filter((entry): entry is Receipt['entries'][number] => typeof entry === 'object' && entry !== null && typeof entry.signature === 'string' && typeof entry.verifiedAt === 'string');
      return { version: AUTOFILL_POLICY_VERSION, entries };
    }
  } catch { /* First rehearsal has no receipt yet. */ }
  return { version: AUTOFILL_POLICY_VERSION, entries: [] };
}

export async function recordVerifiedForm(customer: CustomerConfig, result: AutofillResult, path = RECEIPT_PATH): Promise<void> {
  if (!result.customerFieldsVerified) return;
  const destination = resolve(path);
  // Live slots may finish together with different mappings. Preserve both entries.
  const pending = (receiptWrites.get(destination) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const receipt = await readReceipt(destination);
    const signature = mappingSignature(customer);
    receipt.entries = receipt.entries.filter((entry) => entry.signature !== signature);
    receipt.entries.push({ signature, verifiedAt: new Date().toISOString() });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  });
  receiptWrites.set(destination, pending);
  try { await pending; }
  finally { if (receiptWrites.get(destination) === pending) receiptWrites.delete(destination); }
}

/** Required local inputs still block startup; historical evidence is advisory. */
export async function assertLiveReadiness(config: AppConfig, path = RECEIPT_PATH, now = Date.now(), manualCustomerForm = false): Promise<LiveReadiness> {
  if (manualCustomerForm) return { customerFormMode: 'manual', formVerification: config.slots.map((slot) => ({ slot, status: 'manual' })) };
  const receipt = await readReceipt(path);
  const formVerification: LiveReadiness['formVerification'] = [];
  for (const slot of config.slots) {
    const customer = config.customers[slot];
    if (!customer || customer.mappings.length === 0 || Object.values(customer.fields).some((value) => !value.trim())
        || customer.mappings.some((mapping) => !customer.fields[mapping.key]?.trim())
        || Object.keys(customer.fields).some((key) => !customer.mappings.some((mapping) => mapping.key === key))) {
      throw new Error(`[${slot}] Live requires complete local customer fields and observed form mappings.`);
    }
    const signature = mappingSignature(customer);
    const verified = receipt.entries.some((entry) => entry.signature === signature && Number.isFinite(Date.parse(entry.verifiedAt)) && now - Date.parse(entry.verifiedAt) >= 0 && now - Date.parse(entry.verifiedAt) <= 7 * 86_400_000);
    formVerification.push({ slot, status: verified ? 'recent' : 'pending' });
  }
  return { customerFormMode: 'auto', formVerification };
}
