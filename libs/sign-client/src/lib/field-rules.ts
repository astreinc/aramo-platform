// M-A6 §2 — the Name and Checkbox rules, pure (no I/O), shared by signer
// completion (EsignService.completeSigner) and covered directly by unit tests.
// Client Rule Consolidation C2-4 — the one copy: libs/sign (server) and both Sign
// clients import it from @aramo/sign-client.
import { FIELD_CATALOG, PROFILE_TEXT_FIELD_TYPES, fieldTypesFor, type ProfileTextFieldType } from '@aramo/sign-fields';

export const SIGNER_NAME_MODES = ['SIGNER_PROFILE', 'SIGNER_ENTERED'] as const;
export type SignerNameMode = (typeof SIGNER_NAME_MODES)[number];
export const CHECKBOX_GROUP_RULES = ['SELECT_ONE', 'SELECT_ANY'] as const;
export type CheckboxGroupRule = (typeof CHECKBOX_GROUP_RULES)[number];

// Check-box field types: a value is 'true' (checked) or 'false' (unchecked).
// FIELD-PARITY-1 P1-2 — the Sign types whose catalog value kind is boolean.
export const CHECK_FIELD_TYPES: ReadonlySet<string> = new Set(fieldTypesFor('sign_store').filter((t) => FIELD_CATALOG[t].value_kind === 'boolean'));

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
// FIELD-PARITY-1 P1-2 — the catalog's signer_profile prefill types (@aramo/sign-fields).
export { PROFILE_TEXT_FIELD_TYPES, type ProfileTextFieldType };
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

// Client Rule Consolidation C3 (audit row 38) — the required-before-Finish rule as units, ONE
// copy for the server's completion check and both signer screens (progress, "next required",
// Finish). A unit is one thing the signer must do: pay, check a required box, fill a required
// field, or satisfy a check-box group (a group counts once and is required when any of its
// boxes is; SELECT_ONE never allows more than one checked box, required or not).
export interface SignerFieldLike {
  readonly field_type: string;
  readonly required: boolean;
  readonly group_key?: string | null;
  readonly group_rule?: string | null;
  readonly min_selected?: number | null;
  readonly name_mode?: string | null;
  /** The signer view's flag for a value the server fills (never the signer's to fill). */
  readonly server_filled?: boolean | null;
}

export interface SignerFieldUnit<T> {
  readonly fields: readonly T[];
  readonly done: boolean;
  /** The completion refusal this unit raises while it is not done. */
  readonly reason: FieldRuleViolation['reason'];
  readonly group_key?: string;
}

/** A check box that belongs to a group (a non-empty group_key). */
export function checkboxGroupOf(f: Pick<SignerFieldLike, 'field_type' | 'group_key'>): string | null {
  return f.field_type === 'CHECKBOX' && typeof f.group_key === 'string' && f.group_key.length > 0 ? f.group_key : null;
}

/**
 * Every unit, in field order then group order. `filled(f)`: the field has a value;
 * `checked(f)`: a check box holds 'true'.
 */
export function signerFieldUnits<T extends SignerFieldLike>(
  fields: readonly T[],
  state: { readonly filled: (f: T) => boolean; readonly checked: (f: T) => boolean },
): SignerFieldUnit<T>[] {
  const units: SignerFieldUnit<T>[] = [];
  const groups = new Map<string, T[]>();
  for (const f of fields) {
    // Sign 1.14 — a PAYMENT is always a unit (the signer pays; the server then fills it), even
    // though the signer view marks it server_filled.
    if (isPaymentField(f)) {
      units.push({ fields: [f], done: state.filled(f), reason: 'payment_required' });
      continue;
    }
    if (f.server_filled === true || isServerFilledName(f)) continue;
    const g = checkboxGroupOf(f);
    if (g !== null) {
      groups.set(g, [...(groups.get(g) ?? []), f]);
      continue;
    }
    if (!f.required) continue;
    if (CHECK_FIELD_TYPES.has(f.field_type)) units.push({ fields: [f], done: state.checked(f), reason: 'checkbox_required_unchecked' });
    else units.push({ fields: [f], done: state.filled(f), reason: 'required_field_unfilled' });
  }
  for (const [group_key, boxes] of groups) {
    const checked = boxes.filter((b) => state.checked(b)).length;
    const one = (boxes[0]?.group_rule ?? 'SELECT_ANY') === 'SELECT_ONE';
    if (one && checked > 1) {
      units.push({ fields: boxes, done: false, reason: 'checkbox_group_select_one', group_key });
      continue;
    }
    if (!boxes.some((b) => b.required)) continue;
    const min = one ? 1 : boxes.reduce((m, b) => Math.max(m, b.min_selected ?? 1), 1);
    units.push({ fields: boxes, done: checked >= min, reason: one ? 'checkbox_group_select_one' : 'checkbox_group_min_selected', group_key });
  }
  return units;
}

// The first rule a signer's fields break at completion, or null (the server's check).
//   - a server-filled name is never the signer's to fill (skipped here);
//   - Sign 1.14: a PAYMENT field is always required and is filled only by a
//     succeeded payment (payment required before the signer can complete);
//   - a required ungrouped check box must be checked ('true');
//   - any other required field must be filled;
//   - SELECT_ONE: at most one box checked, exactly one when the group is required;
//   - a required group needs at least min_selected boxes checked (default 1).
// A group is required when any of its boxes is required.
export function evaluateSignerFieldRules(fields: readonly FieldRuleRow[]): FieldRuleViolation | null {
  const open = signerFieldUnits(fields, { filled: (f) => f.filled_at !== null, checked: isChecked }).find((u) => !u.done);
  if (open === undefined) return null;
  if (open.group_key !== undefined) return { reason: open.reason, group_key: open.group_key };
  return { reason: open.reason, field_id: (open.fields[0] as FieldRuleRow).id };
}
