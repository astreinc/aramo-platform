// The signing page state machine (handoff §4.4; directive §6, §9). Pure and synchronous.
//
//   - Values are LOCAL until Finish: the server has no un-fill, so tapping a filled field
//     clears it on the device only, and Finish submits the final values with the existing
//     fill-then-complete calls. A failed submit keeps every value (offline included).
//   - All 7 engine field types are completed as received: SIGNATURE, INITIALS, SIGN_DATE,
//     SIGNER_NAME, TEXT, CHECKBOX, ACKNOWLEDGEMENT.
//   - Only the signer's own fields are returned by /v1/sign/signing/document, so only they
//     render or can be tapped (other signers' values are never shown, C-2).

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
}

export interface SigningDocument {
  readonly document_id: string;
  readonly title: string;
  readonly ordinal: number;
}

export type SignatureMethod = 'TYPED' | 'DRAWN';

export interface FieldValue {
  /** What the fill call sends: PNG data URL, ISO date, text, or 'true'. */
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

export function isFilled(s: SigningState, id: string): boolean {
  return s.values[id] !== undefined;
}

export function requiredFields(s: SigningState): SigningField[] {
  return s.fields.filter((f) => f.required);
}

export function requiredDone(s: SigningState): number {
  return requiredFields(s).filter((f) => isFilled(s, f.field_id)).length;
}

export function requiredRemaining(s: SigningState): number {
  return requiredFields(s).length - requiredDone(s);
}

export function canFinish(s: SigningState): boolean {
  return requiredRemaining(s) === 0;
}

/** The next empty required field after `afterId` (wrapping), else the first empty one. */
export function nextEmptyRequired(
  s: SigningState,
  afterId: string | null = null,
): SigningField | null {
  const empty = (f: SigningField) => f.required && !isFilled(s, f.field_id);
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
      return { kind: 'mark', text: '✓' };
    case 'ACKNOWLEDGEMENT':
      return { kind: 'mark', text: ACK_TEXT };
    case 'SIGN_DATE':
      return { kind: 'text', text: displayDate(v.value) };
    default:
      return { kind: 'text', text: v.value };
  }
}

/** VoiceOver / TalkBack: "{Type}, for {signer}, {required|optional}, {empty|filled}" (§7). */
export function fieldAnnouncement(s: SigningState, f: SigningField, signerName: string): string {
  const who = signerName.trim() ? signerName.trim() : 'you';
  return `${fieldLabel(f.field_type)}, for ${who}, ${f.required ? 'required' : 'optional'}, ${
    isFilled(s, f.field_id) ? 'filled' : 'empty'
  }`;
}

/** The empty-field caption (handoff §4.4 "The user's fields"). */
export function emptyCaption(f: SigningField): string {
  if (f.field_type === 'ACKNOWLEDGEMENT') return 'Tap to acknowledge';
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
  const filled = isFilled(s, fieldId);
  const focused = { ...s, currentId: fieldId };
  if (f.field_type === 'TEXT') {
    return {
      state: focused,
      effect: { kind: 'text', fieldId, initial: s.values[fieldId]?.value ?? '' },
    };
  }
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
    case 'SIGNER_NAME':
      if (ctx.signerName.trim())
        return {
          state: withValue(s, fieldId, { value: ctx.signerName.trim() }),
          effect: { kind: 'none' },
        };
      return { state: focused, effect: { kind: 'text', fieldId, initial: '' } };
    case 'CHECKBOX':
    case 'ACKNOWLEDGEMENT':
      return { state: withValue(s, fieldId, { value: 'true' }), effect: { kind: 'none' } };
    default:
      return { state: focused, effect: { kind: 'text', fieldId, initial: '' } };
  }
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
    if (!v || v.fromServer) continue;
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
