import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, type CustomerConfig } from '../src/config.js';
import { TEST_TARGET } from './fixtures/config.js';
import type { AutofillResult } from '../src/autofill.js';
import { assertLiveReadiness, mappingSignature, recordVerifiedForm } from '../src/readiness.js';
import { AUTOFILL_POLICY_VERSION } from '../src/observed-form.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const customer: CustomerConfig = { representativeName: 'Local fixture', fields: { representativeName: 'Local fixture', email: 'fixture@example.invalid' }, mappings: [{ key: 'representativeName', selector: 'input#fixture-name' }, { key: 'email', selector: 'input#fixture-email' }] };
const result: AutofillResult = { status: 'manual-required', customerFieldsVerified: true, schema: { ready: true, controls: [] }, filledKeys: ['representativeName', 'email'], missingMappingKeys: [], missingRequiredControls: [], manualControls: [], errors: [] };
async function receipt() { const directory = await mkdtemp(join(tmpdir(), 'takachiho-ready-')); directories.push(directory); return join(directory, 'receipt.json'); }
describe('real-form readiness evidence', () => {
  it('invalidates version 1 receipts even when their signature and time appear current', async () => {
    const path = await receipt();
    await writeFile(path, JSON.stringify({ version: 1, entries: [{ signature: mappingSignature(customer), verifiedAt: new Date().toISOString() }] }));
    const config = parseConfig({ ...TEST_TARGET, customers: { '10:00': customer, '10:30': customer } });
    await expect(assertLiveReadiness(config, path)).rejects.toThrow('full-rehearsal');
    await recordVerifiedForm(customer, result, path);
    const saved = JSON.parse(await readFile(path, 'utf8')) as { version: number };
    expect(saved.version).toBe(AUTOFILL_POLICY_VERSION);
    expect(JSON.stringify(saved)).not.toContain('fixture@example.invalid');
    await expect(assertLiveReadiness(config, path)).resolves.toBeUndefined();
  });
  it('never records an unverified fill or permits live without receipt', async () => {
    const path = await receipt();
    await recordVerifiedForm(customer, { ...result, customerFieldsVerified: false }, path);
    const config = parseConfig({ ...TEST_TARGET, customers: { '10:00': customer, '10:30': customer } });
    await expect(assertLiveReadiness(config, path)).rejects.toThrow('full-rehearsal');
  });
  it('permits two distinct values using verified same mappings, leaving legal actions manual', async () => {
    const path = await receipt();
    await recordVerifiedForm(customer, result, path);
    const other = { ...customer, representativeName: 'Second fixture', fields: { ...customer.fields, representativeName: 'Second fixture' } };
    expect(mappingSignature(other)).toBe(mappingSignature(customer));
    await expect(assertLiveReadiness(parseConfig({ ...TEST_TARGET, customers: { '10:00': customer, '10:30': other } }), path)).resolves.toBeUndefined();
  });
  it('refuses changed definitions and stale verification', async () => {
    const path = await receipt();
    await recordVerifiedForm(customer, result, path);
    const config = parseConfig({ ...TEST_TARGET, customers: { '10:00': customer, '10:30': customer } });
    await expect(assertLiveReadiness(config, path, Date.now() + 8 * 86_400_000)).rejects.toThrow('full-rehearsal');
    const changed = { ...customer, mappings: [{ key: 'representativeName', selector: 'input#different' }] };
    await expect(assertLiveReadiness(parseConfig({ ...TEST_TARGET, customers: { '10:00': changed, '10:30': customer } }), path)).rejects.toThrow('full-rehearsal');
  });
  it('requires current verified mappings for every configured arbitrary slot', async () => {
    const path = await receipt();
    const other = { ...customer, representativeName: 'Second fixture', fields: { ...customer.fields, representativeName: 'Second fixture' } };
    const config = parseConfig({ targetDate: '2026-11-03', releaseAt: '2026-10-20T08:00:00+08:00', slots: ['09:15', '11:45'],
      customers: { '09:15': customer, '11:45': other } });
    await expect(assertLiveReadiness(config, path)).rejects.toThrow('[09:15] Run full-rehearsal');
    await recordVerifiedForm(customer, result, path);
    await expect(assertLiveReadiness(config, path)).resolves.toBeUndefined();
    config.customers['11:45']!.mappings = [{ key: 'email', selector: '#changed-email' }];
    await expect(assertLiveReadiness(config, path)).rejects.toThrow('[11:45] Run full-rehearsal');
    await expect(assertLiveReadiness(parseConfig({ ...TEST_TARGET, slots: ['09:15'], customers: {} }), path)).rejects.toThrow('[09:15] Live');
  });
});
