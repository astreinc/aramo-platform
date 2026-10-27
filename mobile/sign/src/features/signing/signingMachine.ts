// The signing page state machine (handoff §4.4; directive §6, §9). Pure and synchronous.
//
//   - Values are LOCAL until Finish: the server has no un-fill, so tapping a filled field
//     clears it on the device only, and Finish submits the final values with the existing
//     fill-then-complete calls. A failed submit keeps every value (offline included).
//   - All 7 engine field types are completed as received: SIGNATURE, INITIALS, SIGN_DATE,
//     SIGNER_NAME, TEXT, CHECKBOX, ACKNOWLEDGEMENT.
//   - Only the signer's own fields are returned by /v1/sign/signing/document, so only they
//     render or can be tapped (other signers' values are never shown, C-2).
//   - M-A6 §2: a check box toggles 'true' / 'false' (unchecking is sent as 'false'); a
//     SELECT_ONE group keeps at most one box checked; Finish mirrors the server's
//     completion rules (required box checked; a required group has min_selected boxes,
//     exactly one for SELECT_ONE). A SIGNER_PROFILE name is filled by the server: it is
//     shown read-only and never sent. Any other name is typed by the signer — it is
//     never prefilled from the signed-in account.

export const FIELD_TYPES = [
  'SIGNATURE',
  'INITIALS',
  'SIGN_DATE',
  'SIGNER_NAME',
  'TEXT',
  'CHECKBOX',
  'ACKNOWLEDGEMENT',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

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
  /** Already stored server-side from an earlier visit (no need to resubmit unchanged). */
  readonly fromServer?: boolean;
}

export interface AdoptedMark {
  readonly dataUrl: string;
  readonly method: SignatureMethod;
}

export interface SigningState {
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
): SigningState {
  const ordered = orderFields(fields, documents);
  const values: Record<string, FieldValue> = {};
  for (const f of ordered) {
    if (f.filled && typeof f.value === 'string' && f.value.length > 0)
      values[f.field_id] = { value: f.value, fromServer: true };
  }
  return { fields: ordered, values, currentId: null, adopted: {} };
}

const CHECK_TYPES: ReadonlySet<string> = new Set(['CHECKBOX', 'ACKNOWLEDGEMENT']);

/** M-A6 §2.2 — a name the server fills (shown read-only, never sent). */
export function isServerFilled(f: SigningField): boolean {
  return (
    f.server_filled === true || (f.field_type === 'SIGNER_NAME' && f.name_mode === 'SIGNER_PROFILE')
  );
}

/** A check box that belongs to a group. */
function groupOf(f: SigningField): string | null {
  return f.field_type === 'CHECKBOX' && typeof f.group_key === 'string' && f.group_key
    ? f.group_key
    : null;
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
 * The units Finish needs, mirroring the server's completion rules (M-A6 §2.3): each
 * required ungrouped field the signer fills, and each required check-box group (a group
 * is required when any of its boxes is). A server-filled name is never a unit.
 */
interface RequiredUnit {
  readonly fields: readonly SigningField[];
  readonly done: boolean;
}

function requiredUnits(s: SigningState): RequiredUnit[] {
  const units: RequiredUnit[] = [];
  const groups = new Map<string, SigningField[]>();
  for (const f of s.fields) {
    if (isServerFilled(f)) continue;
    const g = groupOf(f);
    if (g !== null) {
      groups.set(g, [...(groups.get(g) ?? []), f]);
      continue;
    }
    if (f.required) units.push({ fields: [f], done: isFilled(s, f.field_id) });
  }
  for (const boxes of groups.values()) {
    const checked = boxes.filter((b) => isChecked(s, b.field_id)).length;
    const one = boxes[0]?.group_rule === 'SELECT_ONE';
    // SELECT_ONE never allows more than one checked box, required or not.
    if (one && checked > 1) {
      units.push({ fields: boxes, done: false });
      continue;
    }
    if (!boxes.some((b) => b.required)) continue;
    const min = one ? 1 : Math.max(1, ...boxes.map((b) => b.min_selected ?? 1));
    units.push({ fields: boxes, done: checked >= min });
  }
  return units;
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

export function localIsoDate(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 24, 2026" for a YYYY-MM-DD value (the server time is authoritative at completion). */
export function displayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1] ?? ''} ${Number(m[3])}, ${m[1]}`;
}

/** What a filled field shows on the page. */
export function displayOf(
  f: SigningField,
  v: FieldValue | undefined,
): { kind: 'image' | 'text' | 'mark'; text: string } | null {
  if (!v) return null;
  if (v.value.startsWith('data:image/')) return { kind: 'image', text: v.value };
  switch (f.field_type) {
    case 'CHECKBOX':
      return v.value === 'true' ? { kind: 'mark', text: '✓' } : null;
    case 'ACKNOWLEDGEMENT':
      return v.value === 'true' ? { kind: 'mark', text: ACK_TEXT } : null;
    case 'SIGN_DATE':
      return { kind: 'text', text: displayDate(v.value) };
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
  const filled = isFilled(s, fieldId);
  if (filled) return { state: withValue(s, fieldId, null), effect: { kind: 'none' } };
  switch (f.field_type) {
    case 'SIGNATURE':
    case 'INITIALS': {
      const mark = s.adopted[f.field_type];
      if (!mark)
        return { state: focused, effect: { kind: 'adopt', fieldId, target: f.field_type } };
      return {
        state: withValue(s, fieldId, { value: mark.dataUrl, method: mark.method }),
        effect: { kind: 'none' },
      };
    }
    case 'SIGN_DATE':
      return {
        state: withValue(s, fieldId, { value: localIsoDate(ctx.today) }),
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
  return fieldId ? withValue(next, fieldId, { value: mark.dataUrl, method: mark.method }) : next;
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
