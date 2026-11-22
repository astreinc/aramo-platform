// The signing page state machine (handoff §4.4; directive §6, §9). Pure and synchronous.
//
//   - Values are LOCAL until Finish: the server has no un-fill, so tapping a filled field
//     clears it on the device only, and Finish submits the final values with the existing
//     fill-then-complete calls. A failed submit keeps every value (offline included).
//   - Every engine field type is completed as received (FIELD-PARITY-1 P1-2: the catalog's
//     `engine_passthrough` projection — SIGNATURE, INITIALS, SIGN_DATE, SIGNER_NAME, TEXT,
//     CHECKBOX, ACKNOWLEDGEMENT and the M-A12 profile types). PAYMENT is paid, not filled.
//   - Only the signer's own fields are returned by /v1/sign/signing/document, so only they
//     render or can be tapped (other signers' values are never shown, C-2).
//   - M-A6 §2: a check box toggles 'true' / 'false' (unchecking is sent as 'false'); a
//     SELECT_ONE group keeps at most one box checked; Finish mirrors the server's
//     completion rules (required box checked; a required group has min_selected boxes,
//     exactly one for SELECT_ONE). A SIGNER_PROFILE name is filled by the server: it is
//     shown read-only and never sent. Any other name is typed by the signer — it is
//     never prefilled from the signed-in account.
//   - M-A12 W1-C.4: FIRST_NAME, LAST_NAME, EMAIL, COMPANY and TITLE are text fields the
//     signer fills; when the signer is signed in, their own Sign profile pre-fills the
//     text sheet (TapContext.prefill) and the signer may edit it before saving.

import {
  CHECK_FIELD_TYPES,
  PROFILE_TEXT_FIELD_TYPES,
  checkboxGroupOf,
  fieldTypesFor,
  signDatePreview,
  signerFieldUnits,
  type FieldTypeOn,
  type SignerFieldLike,
  type SignerFieldUnit,
} from '@aramo/sign-client';

import { SIGN_DATE_PREVIEW_NOTE } from './signDate';

export const FIELD_TYPES: readonly FieldTypeOn<'engine_passthrough'>[] = fieldTypesFor('engine_passthrough');

/** M-A12 W1-C.4 — the profile auto-fill types (text-valued; the catalog's prefill types). */
export const PROFILE_TEXT_TYPES: ReadonlySet<string> = new Set(PROFILE_TEXT_FIELD_TYPES);
export type FieldType = FieldTypeOn<'engine_passthrough'>;

/** One field of POST /v1/sign/signing/document. */
export interface SigningField {
  readonly field_id: string;
  readonly document_id: string;
  readonly field_type: string;
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly required: boolean;
  readonly filled?: boolean;
  readonly value?: string | null;
  /** M-A6 §2.4 — field configuration (absent from older servers). */
  readonly label?: string | null;
  readonly group_key?: string | null;
  readonly group_rule?: string | null;
  readonly min_selected?: number | null;
  readonly name_mode?: string | null;
  /** M-A6 §2.2 — the server fills this field (a SIGNER_PROFILE name). */
  readonly server_filled?: boolean;
}

export interface SigningDocument {
  readonly document_id: string;
  readonly title: string;
  readonly ordinal: number;
}

export type SignatureMethod = 'TYPED' | 'DRAWN';

export interface FieldValue {
  /** What the fill call sends: PNG data URL, ISO date, text, or 'true' / 'false'. */
  readonly value: string;
  readonly method?: SignatureMethod;
  /** M-A13 #1 — what the page shows when it differs from the value (a TYPED mark's script image). */
  readonly display?: string;
  /** Already stored server-side from an earlier visit (no need to resubmit unchanged). */
  readonly fromServer?: boolean;
}

export interface AdoptedMark {
  /** The PNG shown on the page and saved as the default (the script rendering for TYPED). */
  readonly dataUrl: string;
  readonly method: SignatureMethod;
  /** M-A13 #1 (R-1a) — what the fill call sends: the typed text for TYPED, the PNG for DRAWN. */
  readonly value: string;
}

/** The field value an adopted mark fills: send `value`, show the PNG. */
export function markValue(mark: AdoptedMark): FieldValue {
  return mark.value === mark.dataUrl
    ? { value: mark.value, method: mark.method }
    : { value: mark.value, method: mark.method, display: mark.dataUrl };
}

export interface SigningState {
  /**
   * C0-2 — the envelope's stamped SIGN_DATE format (signer view date_format; null = the
   * server default). Only the on-screen preview uses it: the server stamps the stored value.
   */
  readonly dateFormat?: string | null;
  readonly fields: readonly SigningField[];
  readonly values: Readonly<Record<string, FieldValue>>;
  readonly currentId: string | null;
  readonly adopted: { readonly SIGNATURE?: AdoptedMark; readonly INITIALS?: AdoptedMark };
}

/** What a tap asks the UI to do next. */
export type TapEffect =
  | { readonly kind: 'none' }
  | { readonly kind: 'adopt'; readonly fieldId: string; readonly target: 'SIGNATURE' | 'INITIALS' }
  | { readonly kind: 'text'; readonly fieldId: string; readonly initial: string };

export const FIELD_LABEL: Record<FieldType, string> = {
  SIGNATURE: 'Signature',
  INITIALS: 'Initials',
  SIGN_DATE: 'Date signed',
  SIGNER_NAME: 'Name',
  TEXT: 'Text',
  CHECKBOX: 'Checkbox',
  ACKNOWLEDGEMENT: 'Acknowledgement',
  FIRST_NAME: 'First name',
  LAST_NAME: 'Last name',
  EMAIL: 'Email',
  COMPANY: 'Company',
  TITLE: 'Title',
  // FIELD-PARITY-1 P3 — the new catalog types (labels only; the signer UI for them is a later slice).
  DATE: 'Date',
  DROPDOWN: 'Dropdown',
  RADIO: 'Radio button',
  NUMBER: 'Number',
  MULTILINE_TEXT: 'Multi-line text',
};

export const ACK_TEXT = '✓ I acknowledge and agree';

export function fieldLabel(type: string): string {
  return (FIELD_LABEL as Record<string, string>)[type] ?? 'Field';
}

/** Reading order: document ordinal, page, top to bottom (PDF y is bottom-up), left to right. */
export function orderFields(
  fields: readonly SigningField[],
  documents: readonly SigningDocument[] = [],
): SigningField[] {
  const ord = new Map(documents.map((d) => [d.document_id, d.ordinal]));
  return [...fields].sort(
    (a, b) =>
      (ord.get(a.document_id) ?? 0) - (ord.get(b.document_id) ?? 0) ||
      a.page_number - b.page_number ||
      b.y + (b.height ?? 0) - (a.y + (a.height ?? 0)) ||
      a.x - b.x,
  );
}

export function initialState(
  fields: readonly SigningField[],
  documents: readonly SigningDocument[] = [],
  dateFormat: string | null = null,
): SigningState {
  const ordered = orderFields(fields, documents);
  const values: Record<string, FieldValue> = {};
  for (const f of ordered) {
    if (f.filled && typeof f.value === 'string' && f.value.length > 0)
      values[f.field_id] = { value: f.value, fromServer: true };
  }
  return { dateFormat, fields: ordered, values, currentId: null, adopted: {} };
}

const CHECK_TYPES: ReadonlySet<string> = CHECK_FIELD_TYPES;

/** M-A6 §2.2 — a name the server fills (shown read-only, never sent). */
export function isServerFilled(f: SigningField): boolean {
  return (
    f.server_filled === true || (f.field_type === 'SIGNER_NAME' && f.name_mode === 'SIGNER_PROFILE')
  );
}

/** A check box that belongs to a group. */
function groupOf(f: SigningField): string | null {
  return checkboxGroupOf(f);
}

/** True when a check box holds 'true'. */
export function isChecked(s: SigningState, id: string): boolean {
  return s.values[id]?.value === 'true';
}

/** The field shows a value (an unchecked box shows as empty). */
export function isFilled(s: SigningState, id: string): boolean {
  const v = s.values[id];
  if (v === undefined) return false;
  const f = s.fields.find((x) => x.field_id === id);
  return f !== undefined && CHECK_TYPES.has(f.field_type) ? v.value === 'true' : true;
}

/**
 * The units Finish needs. Client Rule Consolidation C3 (audit row 38) — the rule is
 * @aramo/sign-client's signerFieldUnits, the same function the server's completion check uses
 * (a group counts once; a server-filled name is never a unit; a PAYMENT is always one).
 */
function requiredUnits(s: SigningState): readonly SignerFieldUnit<SigningField>[] {
  return signerFieldUnits(s.fields as readonly (SigningField & SignerFieldLike)[], {
    filled: (f) => isFilled(s, f.field_id),
    checked: (f) => isChecked(s, f.field_id),
  });
}

/** One representative field per required unit (a group counts once). */
export function requiredFields(s: SigningState): SigningField[] {
  return requiredUnits(s).flatMap((u) => (u.fields[0] ? [u.fields[0]] : []));
}

export function requiredDone(s: SigningState): number {
  return requiredUnits(s).filter((u) => u.done).length;
}

export function requiredRemaining(s: SigningState): number {
  const units = requiredUnits(s);
  return units.length - units.filter((u) => u.done).length;
}

export function canFinish(s: SigningState): boolean {
  return requiredRemaining(s) === 0;
}

/** The next empty required field after `afterId` (wrapping), else the first empty one. */
export function nextEmptyRequired(
  s: SigningState,
  afterId: string | null = null,
): SigningField | null {
  const open = new Set(
    requiredUnits(s)
      .filter((u) => !u.done)
      .flatMap((u) => u.fields.map((f) => f.field_id)),
  );
  const empty = (f: SigningField) => open.has(f.field_id) && !isChecked(s, f.field_id);
  const start = afterId ? s.fields.findIndex((f) => f.field_id === afterId) : -1;
  for (let i = 1; i <= s.fields.length; i += 1) {
    const f = s.fields[(start + i + s.fields.length) % s.fields.length];
    if (f && empty(f)) return f;
  }
  return null;
}

/** Bottom bar button: Start → Next field → Finish (handoff §4.4). */
export function primaryAction(s: SigningState): 'start' | 'next' | 'finish' {
  if (canFinish(s)) return 'finish';
  return s.currentId === null ? 'start' : 'next';
}

// C0-2 — the SIGN_DATE preview is today in the envelope's format (signDatePreview); the
// server stamps the stored value at completion. The value is shown exactly as formatted.

/** What a filled field shows on the page. */
export function displayOf(
  f: SigningField,
  v: FieldValue | undefined,
): { kind: 'image' | 'text' | 'mark' | 'script'; text: string } | null {
  if (!v) return null;
  if (v.display?.startsWith('data:image/')) return { kind: 'image', text: v.display };
  if (v.value.startsWith('data:image/')) return { kind: 'image', text: v.value };
  switch (f.field_type) {
    case 'SIGNATURE':
    case 'INITIALS':
      // M-A13 #1 — a typed mark (e.g. stored on an earlier visit) shows in the script face.
      return { kind: 'script', text: v.value };
    case 'CHECKBOX':
      return v.value === 'true' ? { kind: 'mark', text: '✓' } : null;
    case 'ACKNOWLEDGEMENT':
      return v.value === 'true' ? { kind: 'mark', text: ACK_TEXT } : null;
    case 'SIGN_DATE':
      return { kind: 'text', text: v.value };
    default:
      return { kind: 'text', text: v.value };
  }
}

/** VoiceOver / TalkBack: "{Type}, for {signer}, {required|optional}, {empty|filled}" (§7). */
export function fieldAnnouncement(s: SigningState, f: SigningField, signerName: string): string {
  const who = signerName.trim() ? signerName.trim() : 'you';
  const label = f.field_type === 'CHECKBOX' && f.label ? ` "${f.label}"` : '';
  const state = CHECK_TYPES.has(f.field_type)
    ? isChecked(s, f.field_id)
      ? 'checked'
      : 'not checked'
    : isServerFilled(f)
      ? 'filled for you'
      : isFilled(s, f.field_id)
        ? 'filled'
        : 'empty';
  return `${fieldLabel(f.field_type)}${label}, for ${who}, ${f.required ? 'required' : 'optional'}, ${state}`;
}

/** The empty-field caption (handoff §4.4 "The user's fields"). */
export function emptyCaption(f: SigningField): string {
  if (f.field_type === 'ACKNOWLEDGEMENT') return 'Tap to acknowledge';
  // C0-2 — the date is the server's, filled in at signing.
  if (f.field_type === 'SIGN_DATE')
    return `${fieldLabel(f.field_type)} · ${f.required ? '' : 'optional · '}${SIGN_DATE_PREVIEW_NOTE}`;
  if (f.field_type === 'CHECKBOX' && f.label) return f.required ? f.label : `${f.label} · optional`;
  return f.required ? fieldLabel(f.field_type) : `${fieldLabel(f.field_type)} · optional`;
}

function withValue(s: SigningState, id: string, v: FieldValue | null): SigningState {
  const values = { ...s.values };
  if (v === null) delete values[id];
  else values[id] = v;
  const next: SigningState = { ...s, values };
  // After a fill, the current field moves to the next empty required field.
  if (v !== null) return { ...next, currentId: nextEmptyRequired(next, id)?.field_id ?? null };
  return { ...next, currentId: id };
}

export interface TapContext {
  readonly signerName: string;
  readonly today?: Date;
  /**
   * M-A12 W1-C.4 — the signer's own profile value for a profile field type, or null.
   * Offered only to a signed-in signer; never another person's data.
   */
  readonly prefill?: (fieldType: string) => string | null;
}

/**
 * Tap on one of the signer's own fields. Returns the new state and what the UI must open.
 * Tapping a filled field clears it (local only); TEXT always opens the text sheet.
 */
export function tapField(
  s: SigningState,
  fieldId: string,
  ctx: TapContext,
): { state: SigningState; effect: TapEffect } {
  const f = s.fields.find((x) => x.field_id === fieldId);
  if (!f) return { state: s, effect: { kind: 'none' } };
  const focused = { ...s, currentId: fieldId };
  // M-A6 §2.2 — the server fills this name; the signer cannot change it.
  if (isServerFilled(f)) return { state: focused, effect: { kind: 'none' } };
  // M-A6 §2.3 — a check box toggles; unchecking is sent as 'false'.
  if (CHECK_TYPES.has(f.field_type)) return { state: toggleCheck(s, f), effect: { kind: 'none' } };
  // A name the signer types (never prefilled from the signed-in account).
  if (f.field_type === 'TEXT' || f.field_type === 'SIGNER_NAME') {
    return {
      state: focused,
      effect: { kind: 'text', fieldId, initial: s.values[fieldId]?.value ?? '' },
    };
  }
  if (PROFILE_TEXT_TYPES.has(f.field_type)) {
    const current = s.values[fieldId]?.value;
    return {
      state: focused,
      effect: {
        kind: 'text',
        fieldId,
        initial: current ?? ctx.prefill?.(f.field_type) ?? '',
      },
    };
  }
  const filled = isFilled(s, fieldId);
  if (filled) return { state: withValue(s, fieldId, null), effect: { kind: 'none' } };
  switch (f.field_type) {
    case 'SIGNATURE':
    case 'INITIALS': {
      const mark = s.adopted[f.field_type];
      if (!mark)
        return { state: focused, effect: { kind: 'adopt', fieldId, target: f.field_type } };
      return {
        state: withValue(s, fieldId, markValue(mark)),
        effect: { kind: 'none' },
      };
    }
    case 'SIGN_DATE':
      return {
        state: withValue(s, fieldId, { value: signDatePreview(s.dateFormat, ctx.today) }),
        effect: { kind: 'none' },
      };
    default:
      return { state: focused, effect: { kind: 'text', fieldId, initial: '' } };
  }
}

/**
 * Check or uncheck a box. Checking a box of a SELECT_ONE group unchecks the others. A
 * box the server never stored goes back to empty when unchecked; one the server holds is
 * set to 'false' so the uncheck reaches the server.
 */
export function toggleCheck(s: SigningState, f: SigningField): SigningState {
  const off = (id: string): FieldValue | null =>
    s.values[id]?.fromServer || s.fields.find((x) => x.field_id === id)?.filled === true
      ? { value: 'false' }
      : null;
  if (isChecked(s, f.field_id)) return withValue(s, f.field_id, off(f.field_id));
  let next = s;
  const g = groupOf(f);
  if (g !== null && f.group_rule === 'SELECT_ONE') {
    for (const other of s.fields) {
      if (
        other.field_id !== f.field_id &&
        groupOf(other) === g &&
        isChecked(next, other.field_id)
      ) {
        const values = { ...next.values };
        const v = off(other.field_id);
        if (v === null) delete values[other.field_id];
        else values[other.field_id] = v;
        next = { ...next, values };
      }
    }
  }
  return withValue(next, f.field_id, { value: 'true' });
}

/** Save from the text sheet; saving empty clears the field. */
export function setText(s: SigningState, fieldId: string, text: string): SigningState {
  const t = text.trim();
  return withValue(s, fieldId, t ? { value: t } : null);
}

/** Adopted in the sheet: reused for the rest of the session, and fills the waiting field. */
export function adopt(
  s: SigningState,
  target: 'SIGNATURE' | 'INITIALS',
  mark: AdoptedMark,
  fieldId: string | null,
): SigningState {
  const next: SigningState = { ...s, adopted: { ...s.adopted, [target]: mark } };
  return fieldId ? withValue(next, fieldId, markValue(mark)) : next;
}

/** Start / Next field: focus the next empty required field. */
export function advance(s: SigningState): SigningState {
  const n = nextEmptyRequired(s, s.currentId);
  return n ? { ...s, currentId: n.field_id } : s;
}

/** Finish pressed: blocked (jump to the next required field) or ready to submit. */
export function attemptFinish(
  s: SigningState,
): { readonly blocked: true; readonly state: SigningState } | { readonly blocked: false } {
  if (canFinish(s)) return { blocked: false };
  const n = nextEmptyRequired(s, s.currentId);
  return { blocked: true, state: n ? { ...s, currentId: n.field_id } : s };
}

/** The fill calls Finish makes: every filled field, except unchanged server-held values. */
export function fillsToSubmit(
  s: SigningState,
): { fieldId: string; value: string; method?: SignatureMethod }[] {
  const out: { fieldId: string; value: string; method?: SignatureMethod }[] = [];
  for (const f of s.fields) {
    const v = s.values[f.field_id];
    if (!v || v.fromServer || isServerFilled(f)) continue;
    out.push(
      v.method
        ? { fieldId: f.field_id, value: v.value, method: v.method }
        : { fieldId: f.field_id, value: v.value },
    );
  }
  return out;
}

/** After a successful fill call, keep the value but mark it stored (retry won't resend). */
export function markStored(s: SigningState, fieldId: string): SigningState {
  const v = s.values[fieldId];
  if (!v) return s;
  return { ...s, values: { ...s.values, [fieldId]: { ...v, fromServer: true } } };
}
