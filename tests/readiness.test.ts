import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, type CustomerConfig } from '../src/config.js';
import type { AutofillResult } from '../src/autofill.js';
import { assertLiveReadiness, mappingSignature, recordVerifiedForm } from '../src/readiness.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const customer: CustomerConfig = { representativeName: 'Local fixture', fields: { representativeName: 'Local fixture', email: 'fixture@example.invalid' }, mappings: [{ key: 'representativeName', selector: 'input#fixture-name' }, { key: 'email', selector: 'input#fixture-email' }] };
const result: AutofillResult = { status: 'manual-required', customerFieldsVerified: true, schema: { ready: true, controls: [] }, filledKeys: ['representativeName', 'email'], missingMappingKeys: [], missingRequiredControls: [], manualControls: [], errors: [] };
async function receipt() { const directory = await mkdtemp(join(tmpdir(), 'takachiho-ready-')); directories.push(directory); return join(directory, 'receipt.json'); }
describe('real-form readiness evidence', () => {
  it('never records an unverified fill or permits live without receipt', async () => {
    const path = await receipt();
    await recordVerifiedForm(customer, { ...result, customerFieldsVerified: false }, path);
    const config = parseConfig({ customers: { '10:00': customer, '10:30': customer } });
    await expect(assertLiveReadiness(config, path)).rejects.toThrow('full-rehearsal');
  });
  it('permits two distinct values using verified same mappings, leaving legal actions manual', async () => {
    const path = await receipt();
    await recordVerifiedForm(customer, result, path);
    const other = { ...customer, representativeName: 'Second fixture', fields: { ...customer.fields, representativeName: 'Second fixture' } };
    expect(mappingSignature(other)).toBe(mappingSignature(customer));
    await expect(assertLiveReadiness(parseConfig({ customers: { '10:00': customer, '10:30': other } }), path)).resolves.toBeUndefined();
  });
  it('refuses changed definitions and stale verification', async () => {
    const path = await receipt();
    await recordVerifiedForm(customer, result, path);
    const config = parseConfig({ customers: { '10:00': customer, '10:30': customer } });
    await expect(assertLiveReadiness(config, path, Date.now() + 8 * 86_400_000)).rejects.toThrow('full-rehearsal');
    const changed = { ...customer, mappings: [{ key: 'representativeName', selector: 'input#different' }] };
    await expect(assertLiveReadiness(parseConfig({ customers: { '10:00': changed, '10:30': customer } }), path)).rejects.toThrow('full-rehearsal');
  });
});
