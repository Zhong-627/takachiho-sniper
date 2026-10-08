import type { Page } from 'playwright';
import type { CustomerConfig } from './config.js';
import { OBSERVED_CUSTOMER_FIELDS, OBSERVED_FORM_PROFILE } from './observed-form.js';

export interface FormControl {
  domIndex: number;
  selector: string | null;
  tag: string;
  type: string;
  id: string;
  name: string;
  label: string;
  labelSource: 'native' | 'aria' | 'placeholder' | 'visible-row' | 'observed-name' | 'none';
  contextLabel: string;
  observedFieldKey: string | null;
  autocomplete: string;
  /** Effective local requirement; htmlRequired preserves the raw DOM fact. */
  required: boolean;
  htmlRequired: boolean;
  requiredSources: string[];
  disabled: boolean;
  readOnly: boolean;
  title: string;
  inputmode: string;
  maxlength: string | null;
  minlength: string | null;
  pattern: string | null;
  min: string | null;
  max: string | null;
  step: string | null;
  options: Array<{ value: string; label: string; disabled: boolean }>;
  category: 'customer' | 'manual' | 'unsupported';
}

export interface CustomerFormSchema {
  ready: boolean;
  controls: FormControl[];
  observedProfile?: string | null;
  missingObservedFields?: Array<{ key: string; selector: string; label: string }>;
}

export interface AutofillResult {
  status: 'verified' | 'mapping-required' | 'manual-required' | 'invalid';
  /** Legal/payment/security steps may remain manual while customer fields pass. */
  customerFieldsVerified: boolean;
  schema: CustomerFormSchema;
  /** Field keys only: customer values and entered values must never be logged. */
  filledKeys: string[];
  missingMappingKeys: string[];
  missingRequiredControls: Array<{ selector: string | null; label: string; reason: string }>;
  manualControls: Array<{ selector: string | null; label: string; required: boolean }>;
  errors: Array<{ key: string; reason: string }>;
}

// These classify inspected DOM metadata, never serve as guessed selectors.
const SECURITY_FIELD = /(?:credit|payment|billing|card[-_ ]?(?:number|holder|name|expiry|exp)|(?:^|\W)card(?:\W|$)|cc[-_ ]|cvc|cvv|captcha|recaptcha|hcaptcha|one[-_ ]?time|otp|password|passcode|(?:^|\W)pin(?:\W|$)|3d[-_ ]?secure|security|verification|expiry|expiration|iban|bank|account[-_ ]?(?:number|no)|認証|クレジット|カード|決済|支払|暗証|セキュリティ|銀行|口座)/iu;
const FINAL_CONFIRMATION = /(?:agree|consent|terms|privacy|confirm[-_ ]?(?:booking|reservation|payment)|同意|承諾|規約|禁止事項|注意事項|最終確認|予約確定|決済確定)/iu;
const CUSTOMER_FIELD = /(?:name|surname|given|family|first|last|representative|email|e[-_ ]?mail|phone|mobile|telephone|(?:^|\W)tel(?:\W|$)|person|guest|participant|passenger|count|address|postal|zip|gender|birth|age|boat|adult|child|sex|prefecture|country|city|hotel|nationality|氏名|フリガナ|ふりがな|カナ|姓名|お名前|名[前称]?|メール|電話|人数|住所|郵便|生年月日|誕生|乗船|大人|子[供ども]|児童|幼児|都道府県|ホテル|国籍|代表)/iu;

function classify(control: Omit<FormControl, 'category'>): FormControl['category'] {
  const metadata = `${control.label} ${control.contextLabel} ${control.title} ${control.id} ${control.name} ${control.autocomplete}`;
  if ((control.type === 'checkbox' && control.name === 'data[dummy]')
      || SECURITY_FIELD.test(metadata) || FINAL_CONFIRMATION.test(metadata)
      || /(?:password|hidden|submit|button|reset|file|image)/iu.test(control.type)) return 'manual';
  return control.observedFieldKey || CUSTOMER_FIELD.test(metadata) || ['email', 'tel'].includes(control.type) ? 'customer' : 'unsupported';
}

/** Discover only controls visible now. Never extracts input values or full HTML. */
export async function discoverCustomerForm(page: Page): Promise<CustomerFormSchema> {
  const inspected = await page.evaluate((observedFields) => {
    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    };
    const allControls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'));
    const heading = Array.from(document.querySelectorAll('h1,h2,h3,legend'))
      .filter(visible).map((element) => element.textContent ?? '').join(' ');
    const officialCustomerPage = location.origin === 'https://eipro.jp' && location.pathname === '/takachiho1/orders/add';
    const observedProfile = (officialCustomerPage || /予約入力/u.test(heading))
      && observedFields.some((field) => allControls.some((element) => element.name === field.name));
    // Read only short label nodes. Never read a whole form/container, scripts,
    // options, or customer text from neighbouring input values.
    const rowLabel = (element: Element): string => {
      for (let parent = element.parentElement, depth = 0; parent && depth < 9; parent = parent.parentElement, depth++) {
        if (/^(?:FORM|BODY|HTML)$/u.test(parent.tagName)) break;
        const previous = parent.previousElementSibling;
        if (previous?.matches('.s-12.l-3, dt, legend') && visible(previous)
            && !previous.querySelector('input,select,textarea,script,style')) {
          return previous.textContent?.trim().slice(0, 500) ?? '';
        }
      }
      return '';
    };
    const controls = allControls
      .filter((element) => visible(element) && element.type !== 'hidden')
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        const labelledBy = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean).join(' ');
        const nativeLabel = Array.from(element.labels ?? []).map((item) => item.textContent?.trim() ?? '').join(' ').trim();
        const ariaLabel = element.getAttribute('aria-label') || labelledBy;
        const placeholder = element.getAttribute('placeholder') ?? '';
        const nearbyLabel = rowLabel(element);
        const type = element instanceof HTMLInputElement ? element.type : tag;
        const observed = observedProfile ? observedFields.find((field) => field.name === element.name && field.tag === tag && field.type === type) : undefined;
        const label = nativeLabel || ariaLabel || placeholder || nearbyLabel || observed?.label || '';
        const labelSource = nativeLabel ? 'native' as const : ariaLabel ? 'aria' as const
          : placeholder ? 'placeholder' as const : nearbyLabel ? 'visible-row' as const
            : observed ? 'observed-name' as const : 'none' as const;
        const requiredSources = [
          ...(element.required ? ['html'] : []),
          ...(element.getAttribute('aria-required') === 'true' ? ['aria'] : []),
          ...(/^[＊*]/u.test(nearbyLabel) ? ['visible-marker'] : []),
          // The page asks for all customer information. Kana has no star: its
          // nonempty requirement is conservative local policy, not proof of a
          // server-side constraint. Missing fields must never produce a receipt.
          ...(observed ? ['observed-instructions'] : []),
        ];
        const idSelector = element.id ? `${tag}#${CSS.escape(element.id)}` : null;
        const nameSelector = element.name ? `${tag}[name=${JSON.stringify(element.name)}]` : null;
        const selector = [idSelector, nameSelector].find((candidate) => candidate && document.querySelectorAll(candidate).length === 1) ?? null;
        return {
          domIndex: allControls.indexOf(element), selector, tag, type,
          id: element.id, name: element.name, label, labelSource, contextLabel: nearbyLabel, observedFieldKey: observed?.key ?? null,
          autocomplete: element.getAttribute('autocomplete') ?? '',
          required: requiredSources.length > 0, htmlRequired: element.required, requiredSources, disabled: element.disabled,
          readOnly: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.readOnly : false,
          title: element.getAttribute('title') ?? '', inputmode: element.getAttribute('inputmode') ?? '',
          maxlength: element.getAttribute('maxlength'), minlength: element.getAttribute('minlength'),
          pattern: element.getAttribute('pattern'), min: element.getAttribute('min'),
          max: element.getAttribute('max'), step: element.getAttribute('step'),
          options: element instanceof HTMLSelectElement
            ? Array.from(element.options).map((option) => ({ value: option.value, label: option.label, disabled: option.disabled })) : [],
        };
      });
    return { controls, observedProfile, customerHeading: /(?:customer information|customer details|お客様情報|予約者情報|利用者情報|申込者情報|代表者情報|連絡先)/iu.test(heading) };
  }, [...OBSERVED_CUSTOMER_FIELDS]);
  const controls: FormControl[] = inspected.controls.map((control) => ({ ...control, category: classify(control) }));
  const personal = controls.filter((control) => control.category === 'customer' && !control.disabled);
  const hasName = personal.some((control) => /(?:name|氏名|名前|フリガナ|ふりがな|代表)/iu.test(`${control.label} ${control.name} ${control.id} ${control.autocomplete}`));
  const hasContact = personal.some((control) => /(?:email|mail|tel|phone|メール|電話)/iu.test(`${control.label} ${control.name} ${control.id} ${control.autocomplete}`));
  const missingObservedFields = inspected.observedProfile ? OBSERVED_CUSTOMER_FIELDS.filter((field) => {
    const matches = controls.filter((control) => control.observedFieldKey === field.key);
    return matches.length !== 1 || matches[0]?.category !== 'customer' || matches[0].disabled || matches[0].readOnly || !matches[0].selector;
  }).map((field) => ({ key: field.key, selector: `${field.tag}[name=${JSON.stringify(field.name)}]`, label: field.label })) : [];
  return { ready: (hasName && hasContact) || (inspected.customerHeading && personal.length > 0), controls,
    observedProfile: inspected.observedProfile ? OBSERVED_FORM_PROFILE : null, missingObservedFields };
}

export async function isCustomerFormReady(page: Page): Promise<boolean> {
  return (await discoverCustomerForm(page)).ready;
}

/**
 * Only call after the root SafetyGuard has explicitly authorized a reservation
 * mode. This function never submits, presses Enter, or clicks a payment control.
 * Any form selectors must come from the operator's locally inspected DOM.
 */
export async function autofillCustomer(page: Page, customer: CustomerConfig): Promise<AutofillResult> {
  const schema = await discoverCustomerForm(page);
  const result: AutofillResult = {
    status: 'mapping-required', customerFieldsVerified: false, schema, filledKeys: [], missingMappingKeys: [],
    missingRequiredControls: [], manualControls: [], errors: [],
  };
  if (!schema.ready) {
    result.status = 'invalid';
    result.errors.push({ key: '', reason: 'A visible customer information form has not been identified. Manual inspection is required.' });
    return result;
  }
  if (schema.missingObservedFields?.length) {
    result.status = 'invalid';
    result.missingRequiredControls.push(...schema.missingObservedFields.map((field) => ({
      selector: field.selector, label: field.label, reason: 'Observed required customer control is missing, changed, nonunique, or not editable.',
    })));
    return result;
  }

  // Validate every mapping before the first mutation, so a forbidden mapping
  // cannot produce a partly filled form before being noticed.
  const prepared: Array<{ key: string; selector: string; kind: 'fill' | 'select' | 'check'; value: string; control: FormControl }> = [];
  const matched = new Set<string>();
  const matchedIndices = new Set<number>();
  result.missingMappingKeys.push(...Object.keys(customer.fields).filter((key) => !customer.mappings.some((mapping) => mapping.key === key)));
  for (const mapping of customer.mappings) {
    const value = customer.fields[mapping.key];
    if (value === undefined || !value.trim()) {
      result.missingMappingKeys.push(mapping.key);
      continue;
    }
    let control: FormControl | undefined;
    try {
      const locator = page.locator(mapping.selector);
      if (await locator.count() !== 1 || !await locator.isVisible()) {
        result.errors.push({ key: mapping.key, reason: 'Selector must resolve to exactly one visible control.' });
        continue;
      }
      const actual = await locator.evaluate((element) => {
        if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) return null;
        return Array.from(document.querySelectorAll('input, select, textarea')).indexOf(element);
      });
      if (actual !== null) {
        control = schema.controls.find((candidate) => candidate.domIndex === actual);
      }
    } catch {
      result.errors.push({ key: mapping.key, reason: 'Selector is invalid or its control could not be inspected.' });
      continue;
    }
    if (!control || control.category !== 'customer' || control.disabled || control.readOnly) {
      result.errors.push({ key: mapping.key, reason: 'Only editable customer controls are eligible. Security, payment, consent, and unknown controls require manual entry.' });
      continue;
    }
    if (matchedIndices.has(control.domIndex)) {
      result.errors.push({ key: mapping.key, reason: 'Different mapping selectors resolve to the same control.' });
      continue;
    }
    const naturalKind = control.tag === 'select' ? 'select' : /^(?:checkbox|radio)$/u.test(control.type) ? 'check' : 'fill';
    const kind = mapping.kind ?? naturalKind;
    if (kind !== naturalKind || (kind === 'check' && !['true', 'false'].includes(value))) {
      result.errors.push({ key: mapping.key, reason: 'Mapping kind does not match the actual control; checks require a true/false string.' });
      continue;
    }
    if (kind === 'select' && !control.options.some((option) => option.value === value && !option.disabled)) {
      result.errors.push({ key: mapping.key, reason: 'Select value is not an enabled option in the inspected DOM.' });
      continue;
    }
    prepared.push({ key: mapping.key, selector: mapping.selector, kind, value, control });
    matchedIndices.add(control.domIndex);
    if (control.selector) matched.add(control.selector);
  }

  if (result.errors.length > 0) {
    result.status = 'invalid';
    return result;
  }

  for (const mapping of prepared) {
    try {
      const locator = page.locator(mapping.selector);
      const currentSchema = await discoverCustomerForm(page);
      const currentIndex = await locator.evaluate((element) => Array.from(document.querySelectorAll('input, select, textarea')).indexOf(element));
      const current = currentSchema.controls.find((control) => control.domIndex === currentIndex);
      if (currentSchema.missingObservedFields?.length || currentSchema.observedProfile !== schema.observedProfile
          || await locator.count() !== 1 || !current || current.category !== 'customer' || current.disabled || current.readOnly
          || current.id !== mapping.control.id || current.name !== mapping.control.name || current.type !== mapping.control.type
          || current.label !== mapping.control.label || current.contextLabel !== mapping.control.contextLabel
          || current.autocomplete !== mapping.control.autocomplete) {
        result.errors.push({ key: mapping.key, reason: 'Control changed after inspection; entry stopped for manual review.' });
        break;
      }
      if (mapping.kind === 'select') await locator.selectOption(mapping.value);
      else if (mapping.kind === 'check') await locator.setChecked(mapping.value === 'true');
      else await locator.fill(mapping.value);
      const verified = mapping.kind === 'check'
        ? await locator.isChecked() === (mapping.value === 'true')
        : await locator.inputValue() === mapping.value;
      if (!verified) result.errors.push({ key: mapping.key, reason: 'Autofill value did not match after entry.' });
      else {
        result.filledKeys.push(mapping.key);
        const htmlValid = await locator.evaluate((element) => (
          element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
        ) && element.validity.valid);
        if (!htmlValid) result.errors.push({ key: mapping.key, reason: 'Entered customer control failed HTML validation.' });
      }
    } catch {
      // Playwright errors can embed entered values. Keep only a static reason.
      result.errors.push({ key: mapping.key, reason: 'Autofill could not complete for this inspected control.' });
    }
  }

  let customerRequirementsSatisfied = true;
  for (const control of schema.controls) {
    if (control.category === 'manual') {
      result.manualControls.push({ selector: control.selector, label: control.label, required: control.required });
    }
    if (!control.required || control.disabled || control.readOnly) continue;
    if (control.category !== 'customer') {
      result.missingRequiredControls.push({ selector: control.selector, label: control.label, reason: 'Manual control; automation is prohibited or its purpose is unconfirmed.' });
      if (control.category === 'unsupported') customerRequirementsSatisfied = false;
      continue;
    }
    if (!control.selector) {
      customerRequirementsSatisfied = false;
      result.missingRequiredControls.push({ selector: null, label: control.label, reason: 'No unique stable selector was present in inspected DOM.' });
      continue;
    }
    if (!matched.has(control.selector)) {
      customerRequirementsSatisfied = false;
      result.missingRequiredControls.push({ selector: control.selector, label: control.label, reason: 'No local mapping with a value for this required customer control.' });
      continue;
    }
    try {
      const valid = await page.locator(control.selector).evaluate((element) => (
        element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
      ) && element.validity.valid && (/^(?:checkbox|radio)$/u.test(element.type)
        ? element instanceof HTMLInputElement && element.checked : element.value.trim().length > 0));
      if (!valid) {
        customerRequirementsSatisfied = false;
        result.missingRequiredControls.push({ selector: control.selector, label: control.label, reason: 'Required customer value is empty or HTML validation has not passed.' });
      }
    } catch {
      result.errors.push({ key: '', reason: 'Required control changed while checking HTML validation.' });
    }
  }

  result.customerFieldsVerified = customerRequirementsSatisfied && prepared.length > 0
    && result.filledKeys.length === prepared.length && result.errors.length === 0 && result.missingMappingKeys.length === 0;
  result.status = result.errors.length > 0 ? 'invalid'
    : result.missingMappingKeys.length > 0 || result.missingRequiredControls.some((control) => control.reason.includes('mapping') || control.reason.includes('selector')) || prepared.length === 0 ? 'mapping-required'
      : result.missingRequiredControls.length > 0 || result.manualControls.some((control) => control.required) ? 'manual-required'
        : 'verified';
  return result;
}
