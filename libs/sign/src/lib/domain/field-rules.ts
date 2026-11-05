// M-A6 §2 — the Name and Checkbox rules, pure (no I/O), shared by signer
// completion (EsignService.completeSigner) and covered directly by unit tests.

export const SIGNER_NAME_MODES = ['SIGNER_PROFILE', 'SIGNER_ENTERED'] as const;
export type SignerNameMode = (typeof SIGNER_NAME_MODES)[number];
export const CHECKBOX_GROUP_RULES = ['SELECT_ONE', 'SELECT_ANY'] as const;
export type CheckboxGroupRule = (typeof CHECKBOX_GROUP_RULES)[number];

// Check-box field types: a value is 'true' (checked) or 'false' (unchecked).
export const CHECK_FIELD_TYPES: ReadonlySet<string> = new Set(['CHECKBOX', 'ACKNOWLEDGEMENT']);

export interface FieldRuleRow {
  id: string;
  field_type: string;
  required: boolean;
  value: string | null;
  filled_at: Date | null;
  group_key?: string | null;
  group_rule?: string | null;
  min_selected?: number | null;
  name_mode?: string | null;
}

// Sign 1.14 — a PAYMENT field is filled by the server when its payment succeeds
// (the receipt line the executed PDF prints); a signer never fills it.
export const PAYMENT_FIELD_TYPE = 'PAYMENT';

// Aramo Sign Mobile M-A12 W1-C.4 — profile auto-fill field types. Text-valued: the
// sender places them, the signer fills them (the app prefills from the signer's own
// Sign profile and the signer may edit). The executed PDF prints the value as text.
export const PROFILE_TEXT_FIELD_TYPES = ['FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE'] as const;
export type ProfileTextFieldType = (typeof PROFILE_TEXT_FIELD_TYPES)[number];
const PROFILE_TEXT_SET: ReadonlySet<string> = new Set(PROFILE_TEXT_FIELD_TYPES);

export function isProfileTextField(f: Pick<FieldRuleRow, 'field_type'>): boolean {
  return PROFILE_TEXT_SET.has(f.field_type);
}

// The value rule for a profile text field (M-A12): at most 200 characters, and an EMAIL
// field holds one email address. Returns the refusal reason, or null when it is valid.
export const PROFILE_TEXT_MAX = 200;
const FIELD_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function profileTextValueRefusal(field_type: string, value: string): 'profile_field_value_invalid' | 'email_field_value_invalid' | null {
  if (!PROFILE_TEXT_SET.has(field_type)) return null;
  const v = value.trim();
  if (v.length > PROFILE_TEXT_MAX) return 'profile_field_value_invalid';
  if (field_type === 'EMAIL' && v.length > 0 && (v.length > 254 || !FIELD_EMAIL_RE.test(v))) return 'email_field_value_invalid';
  return null;
}

export function isPaymentField(f: Pick<FieldRuleRow, 'field_type'>): boolean {
  return f.field_type === PAYMENT_FIELD_TYPE;
}

export interface FieldRuleViolation {
  reason: 'required_field_unfilled' | 'checkbox_required_unchecked' | 'checkbox_group_select_one' | 'checkbox_group_min_selected' | 'payment_required';
  field_id?: string;
  group_key?: string;
}

// A SIGNER_NAME field whose value the server fills (never a client). NULL
// name_mode is a legacy engine field (S2S / Sign API), which the signer types.
export function isServerFilledName(f: Pick<FieldRuleRow, 'field_type' | 'name_mode'>): boolean {
  return f.field_type === 'SIGNER_NAME' && f.name_mode === 'SIGNER_PROFILE';
}

const isChecked = (f: FieldRuleRow): boolean => f.filled_at !== null && f.value === 'true';

// The first rule a signer's fields break at completion, or null.
//   - a server-filled name is never the signer's to fill (skipped here);
//   - Sign 1.14: a PAYMENT field is always required and is filled only by a
//     succeeded payment (payment required before the signer can complete);
//   - a required ungrouped check box must be checked ('true');
//   - any other required field must be filled;
//   - SELECT_ONE: at most one box checked, exactly one when the group is required;
//   - a required group needs at least min_selected boxes checked (default 1).
// A group is required when any of its boxes is required.
export function evaluateSignerFieldRules(fields: readonly FieldRuleRow[]): FieldRuleViolation | null {
  const groups = new Map<string, FieldRuleRow[]>();
  for (const f of fields) {
    if (isServerFilledName(f)) continue;
    if (isPaymentField(f)) {
      if (f.filled_at === null) return { reason: 'payment_required', field_id: f.id };
      continue;
    }
    if (f.field_type === 'CHECKBOX' && f.group_key !== undefined && f.group_key !== null) {
      const g = groups.get(f.group_key) ?? [];
      g.push(f);
      groups.set(f.group_key, g);
      continue;
    }
    if (!f.required) continue;
    if (CHECK_FIELD_TYPES.has(f.field_type)) {
      if (!isChecked(f)) return { reason: 'checkbox_required_unchecked', field_id: f.id };
    } else if (f.filled_at === null) {
      return { reason: 'required_field_unfilled', field_id: f.id };
    }
  }
  for (const [group_key, boxes] of groups) {
    const checked = boxes.filter(isChecked).length;
    const rule = boxes[0]?.group_rule ?? 'SELECT_ANY';
    const required = boxes.some((b) => b.required);
    if (rule === 'SELECT_ONE' && checked > 1) return { reason: 'checkbox_group_select_one', group_key };
    const min = rule === 'SELECT_ONE' ? 1 : boxes.reduce((m, b) => Math.max(m, b.min_selected ?? 1), 1);
    if (required && checked < min) return { reason: rule === 'SELECT_ONE' ? 'checkbox_group_select_one' : 'checkbox_group_min_selected', group_key };
  }
  return null;
}
