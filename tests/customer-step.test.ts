import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, validateModeConfig, type CustomerConfig } from '../src/config.js';
import { prepareCustomerForm } from '../src/customer-step.js';
import { assertLiveReadiness } from '../src/readiness.js';
import { TEST_TARGET } from './fixtures/config.js';

let browser: Browser;
let page: Page;
let directory: string;
let receiptPath: string;
const customer: CustomerConfig = {
  representativeName: 'Fixture Person',
  fields: { representativeName: 'Fixture Person', email: 'fixture@example.invalid' },
  mappings: [{ key: 'representativeName', selector: '#fixture-name' }, { key: 'email', selector: '#fixture-email' }],
};
const form = `<h1>Customer Information</h1><form>
  <label for="fixture-name">Name</label><input id="fixture-name" required>
  <label for="fixture-email">Email</label><input id="fixture-email" type="email" required>
  <label for="fixture-card">Credit card</label><input id="fixture-card" autocomplete="cc-number" required>
  <label><input id="fixture-agree" type="checkbox" name="agreeTerms" required>規約に同意</label>
  <button type="submit">Confirm payment</button></form>`;

beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }); });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'takachiho-customer-step-'));
  receiptPath = join(directory, 'receipt.json');
  page = await browser.newPage();
  await page.setContent(form);
});
afterEach(async () => { await page?.close(); await rm(directory, { recursive: true, force: true }); });
afterAll(async () => { await browser?.close(); });

describe('customer page step, offline fixtures and temporary evidence only', () => {
  it('allows startup without history, checks the current DOM, fills and records only verified customer fields', async () => {
    const config = parseConfig({ ...TEST_TARGET, slots: ['10:00'], customers: { '10:00': customer } });
    validateModeConfig(config, 'live', true);
    expect((await assertLiveReadiness(config, receiptPath)).formVerification[0]?.status).toBe('pending');
    await page.locator('form').evaluate((element) => element.addEventListener('submit', (event) => {
      event.preventDefault(); document.body.setAttribute('data-submitted', 'yes');
    }));
    const step = await prepareCustomerForm(page, customer, { receiptPath });
    expect(step.status).toBe('customer-form-ready');
    expect(step.result.customerFieldsVerified).toBe(true);
    expect(step.verificationRecordFailed).toBe(false);
    expect((await assertLiveReadiness(config, receiptPath)).formVerification[0]?.status).toBe('recent');
    expect(await page.locator('#fixture-card').inputValue()).toBe('');
    expect(await page.locator('#fixture-agree').isChecked()).toBe(false);
    expect(await page.locator('body').getAttribute('data-submitted')).toBeNull();
    expect(await readFile(receiptPath, 'utf8')).not.toContain('fixture@example.invalid');
  });
  it('manual mode inspects the page without filling any field or writing a receipt', async () => {
    const step = await prepareCustomerForm(page, customer, { manualCustomerForm: true, receiptPath });
    expect(step.status).toBe('manual');
    expect(step.result.status).toBe('manual-required');
    expect(step.reason).toContain('manual customer entry requested');
    expect(step.result.schema.ready).toBe(true);
    expect(step.result.filledKeys).toEqual([]);
    expect(await page.locator('#fixture-name').inputValue()).toBe('');
    expect(await page.locator('#fixture-email').inputValue()).toBe('');
    await expect(readFile(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('requests handoff without any writes when the page adds an unmapped required customer field', async () => {
    await page.locator('form').evaluate((element) => {
      const input = document.createElement('input'); input.name = 'customerAddress'; input.required = true; element.append(input);
    });
    const step = await prepareCustomerForm(page, customer, { receiptPath });
    expect(step.status).toBe('manual');
    expect(step.reason).toContain('handoff');
    expect(step.result.filledKeys).toEqual([]);
    expect(await page.locator('#fixture-name').inputValue()).toBe('');
    await expect(readFile(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not record invalid HTML values and leaves the page for manual correction', async () => {
    const invalid = { ...customer, fields: { ...customer.fields, email: 'invalid-email' } };
    const step = await prepareCustomerForm(page, invalid, { receiptPath });
    expect(step.status).toBe('manual');
    expect(step.result.customerFieldsVerified).toBe(false);
    expect(await page.locator('#fixture-card').inputValue()).toBe('');
    await expect(readFile(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('a failure to save optional historical evidence does not discard a successfully filled page', async () => {
    const step = await prepareCustomerForm(page, customer, { receiptPath: directory });
    expect(step.status).toBe('customer-form-ready');
    expect(step.result.customerFieldsVerified).toBe(true);
    expect(step.verificationRecordFailed).toBe(true);
    expect(await page.locator('#fixture-name').inputValue()).toBe(customer.representativeName);
  });
  it('unexpected browser errors become a sanitized manual outcome', async () => {
    await page.close();
    const step = await prepareCustomerForm(page, customer, { receiptPath });
    expect(step.status).toBe('manual');
    expect(step.result.customerFieldsVerified).toBe(false);
    expect(JSON.stringify(step)).not.toContain(customer.representativeName);
    expect(JSON.stringify(step)).not.toContain(customer.fields.email);
    await expect(readFile(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
