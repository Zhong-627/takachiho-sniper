import type { Page } from 'playwright';
import { autofillCustomer, discoverCustomerForm, type AutofillResult } from './autofill.js';
import type { CustomerConfig } from './config.js';
import { recordVerifiedForm } from './readiness.js';

export interface CustomerStepResult {
  status: 'customer-form-ready' | 'manual';
  reason?: string;
  result: AutofillResult;
  verificationRecordFailed: boolean;
}

/** Run only on the held customer page. Never selects a slot or submits a form. */
export async function prepareCustomerForm(page: Page, customer: CustomerConfig, options: { manualCustomerForm?: boolean; receiptPath?: string } = {}): Promise<CustomerStepResult> {
  let result: AutofillResult;
  try {
    if (options.manualCustomerForm) {
      const schema = await discoverCustomerForm(page);
      result = { status: 'manual-required', customerFieldsVerified: false, schema, filledKeys: [], missingMappingKeys: [],
        missingRequiredControls: [], errors: [],
        manualControls: schema.controls.map((control) => ({ selector: control.selector, label: control.label, required: control.required })),
      };
    } else result = await autofillCustomer(page, customer);
  } catch {
    // Browser errors can include entered values; use only a static diagnostic.
    result = { status: 'invalid', customerFieldsVerified: false, schema: { ready: false, controls: [] }, filledKeys: [],
      missingMappingKeys: [], missingRequiredControls: [], manualControls: [],
      errors: [{ key: '', reason: 'Customer form inspection or entry stopped. Manual review is required.' }],
    };
  }
  let verificationRecordFailed = false;
  if (result.customerFieldsVerified) {
    try { await recordVerifiedForm(customer, result, options.receiptPath); }
    catch { verificationRecordFailed = true; }
  }
  return { result, verificationRecordFailed,
    status: result.customerFieldsVerified ? 'customer-form-ready' : 'manual',
    reason: result.customerFieldsVerified ? undefined : options.manualCustomerForm
      ? 'Customer page held; manual customer entry requested.'
      : 'Customer fields could not all be verified. Keep the held page and use handoff for manual entry.',
  };
}
