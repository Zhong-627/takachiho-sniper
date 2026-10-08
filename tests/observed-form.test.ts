import { readFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { autofillCustomer, discoverCustomerForm } from '../src/autofill.js';
import { parseConfig, validateModeConfig, type CustomerConfig } from '../src/config.js';
import { TEST_TARGET } from './fixtures/config.js';
import { OBSERVED_CUSTOMER_FIELDS, OBSERVED_FORM_PROFILE, observedSelector } from '../src/observed-form.js';

let browser: Browser;
let page: Page;
let fixture: string;
let example: CustomerConfig;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
  fixture = await readFile(new URL('./fixtures/customer-form-20261008.html', import.meta.url), 'utf8');
  const config = parseConfig(JSON.parse(await readFile(new URL('../config/config.example.json', import.meta.url), 'utf8')));
  example = config.customers['10:00']!;
});
beforeEach(async () => { page = await browser.newPage(); await page.setContent(fixture); });
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); });

function customer(): CustomerConfig {
  return {
    representativeName: 'Fixture Example',
    fields: {
      familyName: 'Fixture', givenName: 'Example', familyNameKana: 'サンプル', givenNameKana: 'テスト',
      email: 'fixture@example.invalid', mobilePhone: '000-0000-0000', address: 'Offline fixture address',
      birthDate: '2000/01/01', passengerComposition: '大人２名、未就学児２名',
    },
    mappings: example.mappings.map((mapping) => ({ ...mapping })),
  };
}

describe('2026-10-08 observed customer form, offline reconstructed fixture only', () => {
  it('recognizes nine controls with raw HTML required=false and explicit local requirements', async () => {
    const schema = await discoverCustomerForm(page);
    expect(schema.ready).toBe(true);
    expect(schema.observedProfile).toBe(OBSERVED_FORM_PROFILE);
    expect(schema.missingObservedFields).toEqual([]);
    const customers = schema.controls.filter((control) => control.category === 'customer');
    expect(customers).toHaveLength(9);
    for (const field of OBSERVED_CUSTOMER_FIELDS) {
      const control = customers.find((item) => item.observedFieldKey === field.key)!;
      expect(control.selector).toBe(observedSelector(field));
      expect(control.label).not.toBe('');
      expect(control.htmlRequired).toBe(false);
      expect(control.required).toBe(true);
      expect(control.requiredSources).toContain('observed-instructions');
    }
    const birth = customers.find((control) => control.observedFieldKey === 'birthDate')!;
    expect(birth.type).toBe('text');
    expect(birth.inputmode).toBe('numeric');
    expect(birth.pattern).toBeNull();
    expect(JSON.stringify(schema)).not.toContain('CONFIDENTIAL_FIXTURE_TOKEN');
  });

  it('fills the blank example mappings while leaving terms, payment, OTP and submit untouched', async () => {
    await page.locator('form').evaluate((form) => form.addEventListener('submit', (event) => {
      event.preventDefault(); document.body.setAttribute('data-submitted', 'yes');
    }));
    const result = await autofillCustomer(page, customer());
    expect(result.customerFieldsVerified).toBe(true);
    expect(result.status).toBe('manual-required');
    expect(result.filledKeys).toHaveLength(9);
    expect(await page.locator(observedSelector(OBSERVED_CUSTOMER_FIELDS[8])).inputValue()).toBe('大人２名、未就学児２名');
    for (let i = 0; i < 3; i++) expect(await page.locator(`#manual-consent-${i}`).isChecked()).toBe(false);
    expect(await page.locator('#fixture-credit-card').inputValue()).toBe('');
    expect(await page.locator('#fixture-otp').inputValue()).toBe('');
    expect(await page.locator('body').getAttribute('data-submitted')).toBeNull();
    expect(JSON.stringify(result)).not.toContain('fixture@example.invalid');
    expect(JSON.stringify(result)).not.toContain('Offline fixture address');
  });

  it.each(['address', 'passengerComposition'])('refuses verification if %s has no mapping despite no HTML required', async (key) => {
    const config = customer();
    delete config.fields[key];
    config.mappings = config.mappings.filter((mapping) => mapping.key !== key);
    const result = await autofillCustomer(page, config);
    expect(result.customerFieldsVerified).toBe(false);
    expect(result.status).toBe('mapping-required');
    expect(result.missingRequiredControls.some((control) => control.reason.includes('mapping'))).toBe(true);
  });

  it.each(OBSERVED_CUSTOMER_FIELDS.map((field) => field.key))('requires a nonblank %s value under observed instructions', async (key) => {
    const config = customer();
    config.fields[key] = '   ';
    const result = await autofillCustomer(page, config);
    expect(result.customerFieldsVerified).toBe(false);
    expect(result.missingMappingKeys).toContain(key);
  });

  it.each(['absent', 'wrong-type', 'readonly', 'duplicate'])('stops before any fill when the observed address control is %s', async (change) => {
    const selector = observedSelector(OBSERVED_CUSTOMER_FIELDS[6]);
    await page.locator(selector).evaluate((element, kind) => {
      if (kind === 'absent') element.remove();
      else if (kind === 'wrong-type') element.setAttribute('type', 'email');
      else if (kind === 'readonly') element.setAttribute('readonly', '');
      else element.after(element.cloneNode());
    }, change);
    const result = await autofillCustomer(page, customer());
    expect(result.status).toBe('invalid');
    expect(result.customerFieldsVerified).toBe(false);
    expect(result.filledKeys).toEqual([]);
    expect(await page.locator(observedSelector(OBSERVED_CUSTOMER_FIELDS[0])).inputValue()).toBe('');
  });

  it('does not let an observed name override an explicit payment label', async () => {
    await page.locator(observedSelector(OBSERVED_CUSTOMER_FIELDS[6])).evaluate((element) => {
      element.id = 'changed-purpose';
      const label = document.createElement('label');
      label.htmlFor = element.id; label.textContent = 'Credit card holder name';
      element.before(label);
    });
    const result = await autofillCustomer(page, customer());
    expect(result.status).toBe('invalid');
    expect(result.filledKeys).toEqual([]);
    expect(result.schema.controls.find((control) => control.id === 'changed-purpose')?.category).toBe('manual');
  });

  it.each([0, 1, 2])('rejects consent checkbox %i mappings before any customer fill', async (index) => {
    const config = customer(); config.fields.consent = 'true';
    config.mappings.push({ key: 'consent', selector: `#manual-consent-${index}`, kind: 'check' });
    const result = await autofillCustomer(page, config);
    expect(result.status).toBe('invalid');
    expect(result.filledKeys).toEqual([]);
    expect(await page.locator(`#manual-consent-${index}`).isChecked()).toBe(false);
  });

  it('keeps the observed dummy checkbox manual even if its visible text changes', async () => {
    await page.locator('#manual-consent-2').evaluate((element) => {
      const parent = element.parentElement!;
      for (const node of Array.from(parent.childNodes)) if (node.nodeType === Node.TEXT_NODE) node.textContent = '乗船人数';
    });
    const schema = await discoverCustomerForm(page);
    expect(schema.controls.find((control) => control.id === 'manual-consent-2')?.category).toBe('manual');
  });

  it('uses the exact Japanese option value and rejects an invented translation', async () => {
    const schema = await discoverCustomerForm(page);
    const passengers = schema.controls.find((control) => control.observedFieldKey === 'passengerComposition')!;
    expect(passengers.options).toHaveLength(16);
    expect(passengers.options.every((option) => option.value === option.label && !option.disabled)).toBe(true);
    expect(passengers.options.some((option) => option.value === '大人１名、未就学児1名')).toBe(true);
    const config = customer(); config.fields.passengerComposition = '2 adults and 2 children';
    expect((await autofillCustomer(page, config)).status).toBe('invalid');
    expect(await page.locator(observedSelector(OBSERVED_CUSTOMER_FIELDS[0])).inputValue()).toBe('');
  });

  it('exports DOM limits and still rejects invalid HTML without pretending to validate the server', async () => {
    await page.locator(observedSelector(OBSERVED_CUSTOMER_FIELDS[8])).evaluate((element) => element.setAttribute('aria-required', 'true'));
    await page.locator(observedSelector(OBSERVED_CUSTOMER_FIELDS[6])).evaluate((element) => {
      element.setAttribute('maxlength', '200'); element.setAttribute('minlength', '3'); element.setAttribute('pattern', '[A-Z]+');
    });
    const schema = await discoverCustomerForm(page);
    const address = schema.controls.find((control) => control.observedFieldKey === 'address')!;
    expect(address.maxlength).toBe('200'); expect(address.minlength).toBe('3'); expect(address.pattern).toBe('[A-Z]+');
    const result = await autofillCustomer(page, customer());
    expect(result.customerFieldsVerified).toBe(false);
    expect(result.errors.some((error) => error.reason.includes('HTML validation'))).toBe(true);
  });

  it('accepts observed split names only when they identify the asserted representative', () => {
    const first = customer(); const second = customer();
    second.fields.givenName = 'Second'; second.representativeName = 'Fixture Second';
    const config = parseConfig({ ...TEST_TARGET, customers: { '10:00': first, '10:30': second } });
    expect(() => validateModeConfig(config, 'live', true)).not.toThrow();
    config.customers['10:30']!.fields.givenName = 'Example';
    expect(() => validateModeConfig(config, 'live', true)).toThrow('same representative');
    config.customers['10:30']!.fields.representativeName = 'Fixture Second';
    config.customers['10:30']!.mappings.push({ key: 'representativeName', selector: '#unrelated-full-name' });
    expect(() => validateModeConfig(config, 'live', true)).toThrow('same representative');
    delete config.customers['10:30']!.fields.representativeName;
    config.customers['10:30']!.mappings = config.customers['10:30']!.mappings.filter((mapping) => mapping.key !== 'representativeName');
    config.customers['10:30']!.fields.givenName = 'Second';
    config.customers['10:30']!.mappings.find((mapping) => mapping.key === 'givenName')!.selector = '#unobserved';
    expect(() => validateModeConfig(config, 'live', true)).toThrow('same representative');
  });
});
