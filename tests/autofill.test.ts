import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { autofillCustomer, discoverCustomerForm } from '../src/autofill.js';
import type { CustomerConfig } from '../src/config.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
});
beforeEach(async () => { page = await browser.newPage(); });
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); });

const form = `<h1>Customer Information</h1><form>
  <label for="customer-name">氏名</label><input id="customer-name" name="customerName" required>
  <label for="customer-email">メール</label><input id="customer-email" name="email" type="email" required>
  <label for="customer-kana">フリガナ</label><input id="customer-kana" name="kana">
  <label for="persons">乗船人数</label><select id="persons" name="personCount" required><option value="">選択</option><option value="1">1</option><option value="2">2</option><option value="3" disabled>3</option></select>
  <button type="submit">Confirm reservation</button>
</form>`;

function customer(overrides: Partial<CustomerConfig> = {}): CustomerConfig {
  return {
    representativeName: 'Example Person',
    fields: { representativeName: 'Example Person', email: 'person@example.invalid', kana: 'サンプル', persons: '2' },
    mappings: [
      { key: 'representativeName', selector: '#customer-name' },
      { key: 'email', selector: '#customer-email' },
      { key: 'kana', selector: '#customer-kana' },
      { key: 'persons', selector: '#persons', kind: 'select' },
    ],
    ...overrides,
  };
}

describe('offline actual-DOM customer form inspection and autofill', () => {
  it('discovers visible actual selectors without including entered values', async () => {
    await page.setContent(`${form}<input name="token" type="hidden" value="CONFIDENTIAL_TOKEN">`);
    await page.locator('#customer-name').fill('CONFIDENTIAL_PERSON');
    const schema = await discoverCustomerForm(page);
    expect(schema.ready).toBe(true);
    expect(schema.controls.map((control) => control.selector)).toContain('input#customer-name');
    expect(JSON.stringify(schema)).not.toContain('CONFIDENTIAL_PERSON');
    expect(JSON.stringify(schema)).not.toContain('CONFIDENTIAL_TOKEN');
    expect(schema.controls.find((control) => control.id === 'persons')?.options).toEqual([
      { value: '', label: '選択', disabled: false }, { value: '1', label: '1', disabled: false },
      { value: '2', label: '2', disabled: false }, { value: '3', label: '3', disabled: true },
    ]);
  });

  it('fills and checks values and required HTML validity without submitting', async () => {
    await page.setContent(form);
    await page.locator('form').evaluate((element) => element.addEventListener('submit', (event) => { event.preventDefault(); document.body.setAttribute('data-submitted', 'yes'); }));
    const result = await autofillCustomer(page, customer());
    expect(result.status).toBe('verified');
    expect(result.customerFieldsVerified).toBe(true);
    expect(result.filledKeys).toEqual(['representativeName', 'email', 'kana', 'persons']);
    expect(await page.locator('#customer-name').inputValue()).toBe('Example Person');
    expect(await page.locator('#persons').inputValue()).toBe('2');
    expect(await page.locator('body').getAttribute('data-submitted')).toBeNull();
    expect(JSON.stringify(result)).not.toContain('person@example.invalid');
    expect(JSON.stringify(result)).not.toContain('Example Person');
  });

  it('requests real mappings when none are configured', async () => {
    await page.setContent(form);
    const result = await autofillCustomer(page, customer({ fields: {}, mappings: [] }));
    expect(result.status).toBe('mapping-required');
    expect(result.customerFieldsVerified).toBe(false);
    expect(result.missingRequiredControls.length).toBe(3);
    expect(await page.locator('#customer-name').inputValue()).toBe('');
  });

  it('blocks payment and security mappings before any field is filled', async () => {
    await page.setContent(`${form}<label for="card-name">Credit card holder name</label><input id="card-name" name="cardHolderName">`);
    const config = customer();
    config.fields.paymentName = 'CONFIDENTIAL_CARD_NAME';
    config.mappings.push({ key: 'paymentName', selector: '#card-name' });
    const result = await autofillCustomer(page, config);
    expect(result.status).toBe('invalid');
    expect(result.filledKeys).toEqual([]);
    expect(await page.locator('#customer-name').inputValue()).toBe('');
    expect(await page.locator('#card-name').inputValue()).toBe('');
    expect(JSON.stringify(result)).not.toContain('CONFIDENTIAL_CARD_NAME');
  });

  it('leaves legal final confirmation and unknown required fields for manual handling', async () => {
    await page.setContent(`${form}<label><input id="agreement" name="agreeTerms" type="checkbox" required>規約に同意</label><label for="unknown">Special official choice</label><input id="unknown" name="customOfficialField" required>`);
    const result = await autofillCustomer(page, customer());
    expect(result.status).toBe('manual-required');
    expect(result.customerFieldsVerified).toBe(false);
    expect(result.manualControls).toContainEqual({ selector: 'input#agreement', label: '規約に同意', required: true });
    expect(await page.locator('#agreement').isChecked()).toBe(false);
    expect(result.missingRequiredControls).toContainEqual(expect.objectContaining({ selector: 'input#unknown' }));
    expect(result.filledKeys).toEqual([]);
    expect(await page.locator('#customer-name').inputValue()).toBe('');
  });

  it('allows verified customer fields while keeping required legal consent manual', async () => {
    await page.setContent(`${form}<label><input id="agreement" name="agreeTerms" type="checkbox" required>規約に同意</label>`);
    const result = await autofillCustomer(page, customer());
    expect(result.status).toBe('manual-required');
    expect(result.customerFieldsVerified).toBe(true);
    expect(await page.locator('#agreement').isChecked()).toBe(false);
  });

  it('does not confuse duplicate names with a different security control', async () => {
    await page.setContent(`${form}<label><input name="shared">Customer name</label><label><input name="shared">Credit card name</label>`);
    const config = customer();
    config.fields.other = 'CONFIDENTIAL';
    config.mappings.push({ key: 'other', selector: 'input[name="shared"] >> nth=1' });
    const result = await autofillCustomer(page, config);
    expect(result.status).toBe('invalid');
    expect(result.filledKeys).toEqual([]);
  });

  it('rejects nonunique and non-control selectors', async () => {
    await page.setContent(form);
    const config = customer();
    config.mappings[0]!.selector = 'input';
    expect((await autofillCustomer(page, config)).status).toBe('invalid');
    config.mappings[0]!.selector = 'button';
    expect((await autofillCustomer(page, config)).status).toBe('invalid');
  });

  it('rejects disabled select options and invalid HTML values', async () => {
    await page.setContent(form);
    const disabled = customer();
    disabled.fields.persons = '3';
    expect((await autofillCustomer(page, disabled)).status).toBe('invalid');
    expect(await page.locator('#customer-name').inputValue()).toBe('');
    const invalidEmail = customer();
    invalidEmail.fields.email = 'not-an-email';
    const result = await autofillCustomer(page, invalidEmail);
    expect(result.status).toBe('invalid');
    expect(result.errors.some((error) => error.reason.includes('HTML validation'))).toBe(true);
    expect(await page.locator('#persons').inputValue()).toBe('');
  });
  it('stops further entry if a new unsupported required control appears while filling', async () => {
    await page.setContent(form);
    await page.locator('#customer-name').evaluate((element) => element.addEventListener('input', () => {
      const input = document.createElement('input'); input.name = 'customOfficialField'; input.required = true;
      document.querySelector('form')!.append(input);
    }, { once: true }));
    const result = await autofillCustomer(page, customer());
    expect(result.status).toBe('invalid');
    expect(result.customerFieldsVerified).toBe(false);
    expect(result.filledKeys).toEqual(['representativeName']);
    expect(await page.locator('#customer-email').inputValue()).toBe('');
  });

  it('does not recognize calendar controls as a customer form', async () => {
    await page.setContent('<h1>予約カレンダー</h1><input id="calendar-month" name="month">');
    expect((await discoverCustomerForm(page)).ready).toBe(false);
    expect((await autofillCustomer(page, customer())).status).toBe('invalid');
  });
});
