/** Public DOM contract observed on one authorized customer page, 2026-10-08.
 * These are observed names, not generic selectors or server-validation claims.
 * Changes to customer validation must invalidate receipts from older policies.
 */
export const AUTOFILL_POLICY_VERSION = 2;
export const OBSERVED_FORM_PROFILE = 'takachiho-20261008';

export const OBSERVED_CUSTOMER_FIELDS = [
  { key: 'familyName', name: 'data[Customer][l_name]', tag: 'input', type: 'text', label: '代表者氏名：姓' },
  { key: 'givenName', name: 'data[Customer][f_name]', tag: 'input', type: 'text', label: '代表者氏名：名' },
  { key: 'familyNameKana', name: 'data[Customer][l_name_kana]', tag: 'input', type: 'text', label: '代表者フリガナ：セイ' },
  { key: 'givenNameKana', name: 'data[Customer][f_name_kana]', tag: 'input', type: 'text', label: '代表者フリガナ：メイ' },
  { key: 'email', name: 'data[Customer][mail]', tag: 'input', type: 'email', label: 'メールアドレス（Gmail推奨）' },
  { key: 'mobilePhone', name: 'data[Customer][mobile_tel]', tag: 'input', type: 'tel', label: '連絡先電話番号' },
  { key: 'address', name: 'data[CustomerQuestionAnswer][4][answer]', tag: 'input', type: 'text', label: '「都道府県、自宅住所」（Country of Citizenship）' },
  { key: 'birthDate', name: 'data[Customer][birth_date]', tag: 'input', type: 'text', label: '代表者生年月日' },
  { key: 'passengerComposition', name: 'data[CustomerQuestionAnswer][6][answer]', tag: 'select', type: 'select', label: 'ご利用人数' },
] as const;

export function observedSelector(field: typeof OBSERVED_CUSTOMER_FIELDS[number]): string {
  return `${field.tag}[name=${JSON.stringify(field.name)}]`;
}
