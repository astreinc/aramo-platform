// M-A12 W1-A "Sign a document" (true self-sign) and W1-B (documents). Pure: the
// document list, the values each placed field shows and sends, and the matching of the
// server's signer fields back to the fields the user placed. No Recipients step: the
// server creates the single signer (the caller) for a `mode: "self"` envelope.
import {
  checkboxGroupOf,
  fieldValueDisplay,
  isSignerLocked,
  radioChoiceClearable,
  signerFieldUnits,
  type FieldOptions,
  type SignerFieldLike,
} from '@aramo/sign-client';

import type { DateFormat, SignProfile } from '../../api/m-a12-contract-types';
import type { EditorField } from '../editor/editorReducer';
import { FIELD_TYPE_SPECS, isProfileFieldType } from '../editor/fieldTypes';
import { editorToWire, type PageSize } from '../editor/geometry';
import { formatDate, profileValue } from '../profile/signProfile';
import { ACK_TEXT, RADIO_MARK, type AdoptedMark, type SigningField } from '../signing/signingMachine';

/** The one recipient key the editor uses for the caller. */
export const SELF_KEY = 'self';

export const SELF_COPY = {
  needSignature: 'Add your signature before you finish',
  needValues: 'Fill in every required field before you finish',
  /** FIELD-PARITY-2 A-1 — a carried template field this screen does not place is required. */
  cannotFill: 'This document has a required field you can’t fill here yet.',
  offline: 'You’re offline. Connect to continue.',
  uploadFailed: 'Couldn’t add the documents. Check your connection and try again.',
  finishFailed: 'Couldn’t finish signing. Check your connection and try again.',
  done: 'Your signed copy and certificate are ready in Agreements.',
} as const;

// ── W1-B documents ───────────────────────────────────────────────────────────

export interface SelfDoc {
  readonly key: string;
  readonly title: string;
  readonly filename: string;
  /** null once uploaded (the bytes leave the device memory). */
  readonly base64: string | null;
  readonly pages: readonly PageSize[] | null;
  /** The server document id once uploaded. */
  readonly serverId: string | null;
}

export const TITLE_MAX = 200;

/** "3 pages" (null when the page count is not known). */
export function pageCountLabel(pages: readonly PageSize[] | null | undefined): string | null {
  if (!pages || pages.length === 0) return null;
  return `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`;
}

export function totalPages(docs: readonly SelfDoc[]): number {
  return docs.reduce((n, d) => n + (d.pages?.length ?? 0), 0);
}

export function renameDoc(docs: readonly SelfDoc[], key: string, title: string): SelfDoc[] {
  const t = title.trim().slice(0, TITLE_MAX);
  if (!t) return [...docs];
  return docs.map((d) => (d.key === key ? { ...d, title: t } : d));
}

export function moveDoc(docs: readonly SelfDoc[], key: string, dir: -1 | 1): SelfDoc[] {
  const i = docs.findIndex((d) => d.key === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= docs.length) return [...docs];
  const out = [...docs];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

export function removeDoc(docs: readonly SelfDoc[], key: string): SelfDoc[] {
  return docs.filter((d) => d.key !== key);
}

/**
 * Which per-document menu items apply. Rename and reordering change only what is on the
 * phone, so they apply until the document is uploaded (the server keeps its title and
 * order); Remove always applies.
 */
export function docMenu(docs: readonly SelfDoc[], key: string): {
  readonly rename: boolean;
  readonly up: boolean;
  readonly down: boolean;
  readonly remove: boolean;
} {
  const i = docs.findIndex((d) => d.key === key);
  const doc = docs[i];
  const local = (d: SelfDoc | undefined) => !!d && d.serverId === null;
  return {
    rename: local(doc),
    up: i > 0 && local(doc) && local(docs[i - 1]),
    down: i >= 0 && i < docs.length - 1 && local(doc) && local(docs[i + 1]),
    remove: i >= 0,
  };
}

/** The envelope subject: the first document's title (+ "and n more"). */
export function selfSubject(docs: readonly SelfDoc[]): string {
  const first = docs[0]?.title ?? 'Document';
  return docs.length > 1 ? `${first} and ${docs.length - 1} more` : first;
}

// ── W1-A values ─────────────────────────────────────────────────────────────

export interface SelfContext {
  readonly profile: SignProfile | null | undefined;
  readonly email: string | null | undefined;
  /** The account display name when the profile has none. */
  readonly fallbackName: string;
  readonly dateFormat: DateFormat;
  readonly adopted: { readonly SIGNATURE?: AdoptedMark; readonly INITIALS?: AdoptedMark };
  readonly today: Date;
}

/** What the user typed or toggled, by field key (overrides the pre-filled value). */
export type SelfEdits = Readonly<Record<string, string>>;

const TEXT_TYPES: ReadonlySet<string> = new Set(['TEXT', 'SIGNER_NAME']);

export function isTextLike(type: string): boolean {
  return TEXT_TYPES.has(type) || isProfileFieldType(type);
}

function profileOrFallback(ctx: SelfContext): SignProfile | null {
  const name = ctx.profile?.display_name?.trim() || ctx.fallbackName.trim();
  return name ? { ...(ctx.profile ?? {}), display_name: name } : (ctx.profile ?? null);
}

/** The text a text-like field starts with: the user's edit, else the profile value. */
export function textValue(f: EditorField, ctx: SelfContext, edits: SelfEdits): string {
  const edited = edits[f.key];
  if (edited !== undefined) return edited;
  if (f.type === 'TEXT') return '';
  return profileValue(f.type, profileOrFallback(ctx), ctx.email) ?? '';
}

/**
 * A box-kind field is on. A check box starts ticked (the prototype fills fields at once); an
 * acknowledgement and a radio option start off: the user ticks or chooses them (FIELD-PARITY-2 A-1).
 */
export function isChecked(f: EditorField, edits: SelfEdits): boolean {
  return (edits[f.key] ?? (f.type === 'CHECKBOX' ? 'true' : 'false')) === 'true';
}

/** FIELD-PARITY-2 A-1 — the Phase 3 types whose value is picked or typed in the signer's field editor. */
const PICKED_TYPES: ReadonlySet<string> = new Set(['DATE', 'DROPDOWN', 'NUMBER', 'MULTILINE_TEXT']);

/** A field whose value the signer's field editor takes (date, choice, number, multi-line). */
export function isPickedType(type: string): boolean {
  return PICKED_TYPES.has(type);
}

/** The sender's value of a sender-filled (or read-only) template field: shown, never sent. */
function lockedValue(f: EditorField): string | null {
  return isSignerLocked({ sender_filled: f.senderFilled, read_only: f.readOnly }) ? (f.senderValue ?? null) : null;
}

/** The placed field as the signer's field editor reads it (its type, settings and options). */
export function asSigningField(f: EditorField): SigningField {
  return {
    field_id: f.key,
    document_id: f.docKey,
    field_type: f.type,
    page_number: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    required: f.required,
    label: f.label ?? null,
    group_key: f.groupKey ?? null,
    tooltip: f.tooltip ?? null,
    placeholder: f.placeholder ?? null,
    validation: f.validation ?? null,
    options: (f.options ?? null) as FieldOptions | null,
    ...(f.readOnly ? { read_only: true } : {}),
    ...(f.senderFilled ? { sender_filled: true } : {}),
  };
}

/**
 * Choose a radio option: it is on and the other options of its group are off. FIELD-PARITY-2
 * A-2 — tapping the chosen option clears it in an optional set (the shared rule,
 * radioChoiceClearable); in a required set it stays chosen.
 */
export function chooseRadio(fields: readonly EditorField[], f: EditorField, edits: SelfEdits): SelfEdits {
  const g = checkboxGroupOf({ field_type: f.type, group_key: f.groupKey ?? null });
  if (isChecked(f, edits)) {
    const row = (x: EditorField) => ({ field_type: x.type, group_key: x.groupKey ?? null, required: x.required });
    return radioChoiceClearable(row(f), fields.map(row)) ? { ...edits, [f.key]: 'false' } : edits;
  }
  const next: Record<string, string> = { ...edits };
  for (const o of fields)
    if (o.key !== f.key && g !== null && checkboxGroupOf({ field_type: o.type, group_key: o.groupKey ?? null }) === g)
      next[o.key] = 'false';
  next[f.key] = 'true';
  return next;
}

/** What the box shows on the page while placing (the prototype fills fields at once). */
export function displayFill(
  f: EditorField,
  ctx: SelfContext,
  edits: SelfEdits,
): { kind: 'image'; uri: string } | { kind: 'text'; text: string } | null {
  switch (f.type) {
    case 'SIGNATURE':
    case 'INITIALS': {
      const m = ctx.adopted[f.type];
      return m ? { kind: 'image', uri: m.dataUrl } : null;
    }
    case 'SIGN_DATE':
      return { kind: 'text', text: formatDate(ctx.today, ctx.dateFormat) };
    case 'CHECKBOX':
      return isChecked(f, edits) ? { kind: 'text', text: '✓' } : null;
    case 'ACKNOWLEDGEMENT':
      return isChecked(f, edits) ? { kind: 'text', text: ACK_TEXT } : null;
    case 'RADIO':
      return isChecked(f, edits) ? { kind: 'text', text: RADIO_MARK } : null;
    case 'DATE':
    case 'DROPDOWN':
    case 'NUMBER':
    case 'MULTILINE_TEXT': {
      // FIELD-PARITY-2 A-1 — shown as the executed PDF prints it (the shared catalog's rule).
      const v = (edits[f.key] ?? lockedValue(f) ?? '').trim();
      return v ? { kind: 'text', text: fieldValueDisplay(asSigningField(f), v, { date_format: ctx.dateFormat }) } : null;
    }
    default: {
      const locked = lockedValue(f);
      if (locked) return { kind: 'text', text: locked };
      const v = textValue(f, ctx, edits).trim();
      return v ? { kind: 'text', text: v } : null;
    }
  }
}

export interface FinishCheck {
  readonly ok: boolean;
  readonly message: string | null;
  /** The first field that still needs something. */
  readonly fieldKey: string | null;
}

/**
 * Finish needs a signature, then every completion unit done: FIELD-PARITY-2 A-1 — the ONE rule
 * the server's completion check uses (@aramo/sign-client signerFieldUnits: required fields and
 * boxes, check-box and radio groups, a server-filled name and a sender's value skipped). A
 * required template field this screen carries but does not place can't be done here.
 */
export function canFinish(
  fields: readonly EditorField[],
  ctx: SelfContext,
  edits: SelfEdits,
  carried: readonly CarriedField[] = [],
): FinishCheck {
  if (!fields.some((f) => f.type === 'SIGNATURE'))
    return { ok: false, message: SELF_COPY.needSignature, fieldKey: null };
  type Row = SignerFieldLike & { readonly placed: EditorField | null };
  const rows: Row[] = [
    ...fields.map(
      (f): Row => ({
        placed: f,
        field_type: f.type,
        required: f.required,
        group_key: f.groupKey ?? null,
        group_rule: f.type === 'RADIO' ? 'SELECT_ONE' : (f.groupRule ?? null),
        min_selected: f.minSelected ?? null,
        name_mode: f.type === 'SIGNER_NAME' ? (f.nameMode ?? 'SIGNER_PROFILE') : null,
        sender_filled: f.senderFilled === true,
        read_only: f.readOnly === true,
      }),
    ),
    ...carried
      .filter((c) => c.signer_id !== null)
      .map((c): Row => ({ ...c, placed: null })),
  ];
  const open = signerFieldUnits(rows, {
    filled: (r) => r.placed !== null && fillValue(r.placed, ctx, edits) !== null,
    checked: (r) => r.placed !== null && fillValue(r.placed, ctx, edits)?.value === 'true',
  }).find((u) => !u.done);
  if (open === undefined) return { ok: true, message: null, fieldKey: null };
  const first = open.fields.find((r) => r.placed !== null)?.placed ?? null;
  if (first === null) return { ok: false, message: SELF_COPY.cannotFill, fieldKey: null };
  const mark = first.type === 'SIGNATURE' || first.type === 'INITIALS';
  return { ok: false, message: mark ? SELF_COPY.needSignature : SELF_COPY.needValues, fieldKey: first.key };
}

/** A template field this screen carries but does not place (its stored members). */
export interface CarriedField extends SignerFieldLike {
  readonly signer_id: string | null;
}

/** The fill-call value for a placed field; null = nothing to send (server-filled or empty). */
export function fillValue(
  f: EditorField,
  ctx: SelfContext,
  edits: SelfEdits,
): { value: string; method?: 'TYPED' | 'DRAWN' } | null {
  // FIELD-PARITY-1 P3 S-4 / S-5 — a sender's value is the server's already: never sent.
  if (isSignerLocked({ sender_filled: f.senderFilled, read_only: f.readOnly })) return null;
  switch (f.type) {
    case 'SIGNATURE':
    case 'INITIALS': {
      const m = ctx.adopted[f.type];
      return m ? { value: m.value, method: m.method } : null;
    }
    case 'SIGN_DATE': {
      // ISO on the wire; the server renders it in the envelope's stamped date format.
      const d = ctx.today;
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { value: iso };
    }
    case 'CHECKBOX':
      return { value: isChecked(f, edits) ? 'true' : 'false' };
    // FIELD-PARITY-2 A-1 — an acknowledgement or a radio option is sent only when it is on.
    case 'ACKNOWLEDGEMENT':
    case 'RADIO':
      return isChecked(f, edits) ? { value: 'true' } : null;
    // The field editor already checked and normalised the value (the server's own rule).
    case 'DATE':
    case 'DROPDOWN':
    case 'NUMBER':
    case 'MULTILINE_TEXT': {
      const v = (edits[f.key] ?? '').trim();
      return v ? { value: v } : null;
    }
    case 'SIGNER_NAME':
      // SIGNER_PROFILE (the default): the server fills it with the signer's name.
      if ((f.nameMode ?? 'SIGNER_PROFILE') === 'SIGNER_PROFILE') return null;
      return textOrNull(textValue(f, ctx, edits));
    default:
      return textOrNull(textValue(f, ctx, edits));
  }
}

function textOrNull(v: string): { value: string } | null {
  const t = v.trim();
  return t ? { value: t.slice(0, 500) } : null;
}

// ── Matching the server's signer fields to the placed fields ─────────────────

export interface PlacedOnServer {
  readonly field: EditorField;
  readonly documentId: string;
  readonly page: number;
  readonly x: number;
  readonly y: number;
}

/** The placed fields in wire coordinates (as PUT …/fields sent them). */
export function placedOnServer(fields: readonly EditorField[], docs: readonly SelfDoc[]): PlacedOnServer[] {
  const out: PlacedOnServer[] = [];
  for (const f of fields) {
    const d = docs.find((x) => x.key === f.docKey);
    const size = d?.pages?.[f.page];
    if (!d?.serverId || !size) continue;
    const b = editorToWire(f, size);
    out.push({ field: f, documentId: d.serverId, page: f.page, x: b.x, y: b.y });
  }
  return out;
}

/**
 * Pair each server field with the placed field of the same document, page and type at
 * the nearest position. A server field with no partner is returned with `field: null`
 * (the caller refuses to finish rather than guess).
 */
export function matchServerFields(
  server: readonly SigningField[],
  placed: readonly PlacedOnServer[],
): { readonly server: SigningField; readonly field: EditorField | null }[] {
  const pool = [...placed];
  return server.map((s) => {
    let best = -1;
    let bestD = Infinity;
    pool.forEach((p, i) => {
      if (p.documentId !== s.document_id || p.page !== s.page_number || p.field.type !== s.field_type) return;
      const d = Math.abs(p.x - s.x) + Math.abs(p.y - s.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) return { server: s, field: null };
    const [hit] = pool.splice(best, 1);
    return { server: s, field: hit!.field };
  });
}

/** The label of a field type (for the value editor header). */
export function typeLabel(type: EditorField['type']): string {
  return FIELD_TYPE_SPECS[type].label;
}
