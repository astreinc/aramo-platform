import { CHECK_FIELD_TYPES, PAYMENT_FIELD_TYPE, checkboxGroupOf, signerFieldUnits, type SignerFieldLike } from '@aramo/sign-client';

import type { SignField } from './sign-api.js';

// M-A6 §2 — the Name and Checkbox rules on the signer page. They mirror the
// server's completion rules (EsignService.completeSigner), so Finish is offered
// only when the server will accept it; the server stays the authority.

// A field restored from an earlier visit without its value.
export const FILLED_MARK = '✓';

export const isBox = (f: Pick<SignField, 'field_type'>): boolean => CHECK_FIELD_TYPES.has(f.field_type);

// A SIGNER_NAME the server fills from the signer profile: shown read-only and
// never sent by this page. A legacy name field (name_mode null) is typed.
export const isServerName = (f: Pick<SignField, 'field_type' | 'name_mode' | 'server_filled'>): boolean =>
  f.field_type === 'SIGNER_NAME' && (f.server_filled === true || f.name_mode === 'SIGNER_PROFILE');

export const isChecked = (v: string | undefined): boolean => v === 'true' || v === FILLED_MARK;

// Sign 1.14 — a PAYMENT field: paid on Stripe's hosted page, filled by the server.
export const isPayment = (f: Pick<SignField, 'field_type'>): boolean => f.field_type === PAYMENT_FIELD_TYPE;

// "$25.00" for a USD amount in cents.
export function formatAmount(amount_minor: number, currency: string): string {
  const v = (amount_minor / 100).toFixed(2);
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`;
}

const groupOf = (f: Pick<SignField, 'field_type' | 'group_key'>): string | null => checkboxGroupOf(f);

// The other boxes a SELECT_ONE group unchecks when `f` is checked.
export function selectOneSiblings(fields: readonly SignField[], f: SignField): SignField[] {
  const g = groupOf(f);
  if (g === null || f.group_rule !== 'SELECT_ONE') return [];
  return fields.filter((o) => o.field_id !== f.field_id && groupOf(o) === g);
}

export interface Requirement {
  readonly key: string;
  readonly done: boolean;
  readonly message: string;
}

// Each thing the signer must do before Finish: a required field to fill, a required box to
// check, a payment, or a group rule to satisfy. Client Rule Consolidation C3 (audit row 38) —
// the rule itself is @aramo/sign-client's signerFieldUnits (the server's completion check and
// the Aramo Sign app use the same function); only the words are this page's.
export function requirements(fields: readonly SignField[], filled: Readonly<Record<string, string>>): Requirement[] {
  const units = signerFieldUnits(fields as readonly (SignField & SignerFieldLike)[], {
    filled: (f) => filled[f.field_id] !== undefined,
    checked: (f) => isChecked(filled[f.field_id]),
  });
  return units.map((u) => {
    const first = u.fields[0] as SignField;
    if (u.group_key !== undefined) {
      const checked = u.fields.filter((b) => isChecked(filled[b.field_id])).length;
      const min = Math.max(1, ...u.fields.map((b) => b.min_selected ?? 1));
      const message =
        u.reason === 'checkbox_group_select_one'
          ? checked > 1
            ? 'Choose only one option in each “select one” group.'
            : 'Choose one option in each required group.'
          : `Check at least ${min} option${min === 1 ? '' : 's'} in each required group.`;
      return { key: `group:${u.group_key}`, done: u.done, message };
    }
    if (u.reason === 'payment_required') return { key: first.field_id, done: u.done, message: 'A payment is required before you can finish.' };
    if (u.reason === 'checkbox_required_unchecked') return { key: first.field_id, done: u.done, message: `Check the required box${first.label ? ` “${first.label}”` : ''}.` };
    return { key: first.field_id, done: u.done, message: 'Some required fields still need your input.' };
  });
}

// The first unmet requirement's message, or null when Finish may proceed.
export function completionProblem(fields: readonly SignField[], filled: Readonly<Record<string, string>>): string | null {
  return requirements(fields, filled).find((r) => !r.done)?.message ?? null;
}

// The server's 409 SIGNATURE_FIELD_INCOMPLETE reasons, in plain language.
export function incompleteMessage(reason: string | undefined): string {
  if (reason === 'checkbox_required_unchecked') return 'A required box still needs to be checked.';
  if (reason === 'checkbox_group_select_one') return 'Choose exactly one option in each “select one” group.';
  if (reason === 'checkbox_group_min_selected') return 'Check enough options in each required group.';
  if (reason === 'payment_required') return 'A payment is required before you can finish.';
  return 'Some required fields still need your input.';
}
