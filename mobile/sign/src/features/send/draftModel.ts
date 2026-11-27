// The Send flow's local draft (directive §9): everything the sender prepares, kept in
// the encrypted DraftStore (state/draftStore.ts) so it survives an app restart and can
// be prepared offline. The server envelope (revision + ETag, M-A3 §6) stays the
// authority once it exists: a sync only ever writes with If-Match on the revision the
// draft is based on, and a 412 replaces the local copy with the server's.
import {
  ENVELOPE_MESSAGE_MAX,
  ENVELOPE_SUBJECT_MAX,
  MAX_COPY_RECIPIENTS as SHARED_MAX_COPY,
  MAX_SIGNERS,
  parseFieldCondition,
  type FieldCondition,
  type AutoRemindersView,
  SIGN_SUBJECT_PREFIX,
} from '@aramo/sign-client';

import type { EditorField } from '../editor/editorReducer';
import { settingsFromServer } from '../editor/fieldSettings';
import { isAuthoringFieldType } from '../editor/fieldTypes';
import { wireToEditor, type PageSize } from '../editor/geometry';
import type { LocalDraft, SendStep } from '../../state/draftStore';

// Client Rule Consolidation C3 (audit rows 18–21) — the limits live once in @aramo/sign-client
// (the server and the web use the same values).
/** Signing recipients (SIGNER + IN_PERSON_SIGNER), MAX_SIGNERS on the server. */
export const MAX_RECIPIENTS = MAX_SIGNERS;
/** M-A5 §1.4 — at most 10 RECEIVES_COPY recipients, on top of the signers. */
export const MAX_COPY_RECIPIENTS = SHARED_MAX_COPY;
export const MESSAGE_MAX = ENVELOPE_MESSAGE_MAX;
export const SUBJECT_MAX = ENVELOPE_SUBJECT_MAX;

export type RoutingMode = 'PARALLEL' | 'SEQUENTIAL';

export interface DraftDocument {
  /** Stable client key. */
  readonly key: string;
  /** The server document id once uploaded. */
  readonly serverId: string | null;
  readonly title: string;
  readonly filename: string;
  /** Page sizes in PDF points, when known (upload response, or read from the bytes). */
  readonly pages: readonly PageSize[] | null;
  /**
   * Set until the upload succeeds: the Idempotency-Key for this upload (created once
   * when the document was added, reused on every retry, M-A3 §8). The bytes wait in the
   * encrypted store (documentBytes.ts).
   */
  readonly pendingUpload: PendingUpload | null;
}

/**
 * A document waiting for upload. FIELD-PARITY-2 A-3 — the upload options chosen when it was
 * added (sign-web's two choices), kept with it so every retry sends the same request.
 */
export interface PendingUpload {
  readonly idempotencyKey: string;
  /** Import the PDF's form fields (import_fields). */
  readonly importFields?: boolean;
  /** Turn {{…}} text tags into fields (apply_text_tags). */
  readonly applyTextTags?: boolean;
}

/** FIELD-PARITY-2 A-3 — the upload options (sign-web's "When uploading" choices). */
export interface UploadOptions {
  readonly importFields: boolean;
  readonly applyTextTags: boolean;
}

export const NO_UPLOAD_OPTIONS: UploadOptions = { importFields: false, applyTextTags: false };

/** The upload creates fields on the server (and so needs a signing recipient there first). */
export function uploadMakesFields(u: PendingUpload | null): boolean {
  return u !== null && (u.importFields === true || u.applyTextTags === true);
}

/**
 * M-A5 §1 — what a recipient does. Never overloads the template role label.
 * Feature-Parity §1.17 — WITNESS attests for one signer (shown only while available).
 */
export type RecipientKind = 'SIGNER' | 'IN_PERSON_SIGNER' | 'RECEIVES_COPY' | 'WITNESS';
/** Feature-Parity §1.9 — the identity check a recipient passes before signing. */
export type IdentityCheck = 'ID_VERIFICATION' | 'KBA';
/** Feature-Parity §1.7 / §1.8 — the signing link also goes to the phone. */
export type TextChannel = 'SMS' | 'WHATSAPP';

/** Feature-Parity §1.7–§1.9 — a signer's text delivery and SMS code (saved apart from the list). */
export interface RecipientMessaging {
  readonly channel: TextChannel | null;
  readonly smsOtp: boolean;
  /** E.164 as typed ('' when none). */
  readonly phone: string;
}

export const NO_MESSAGING: RecipientMessaging = { channel: null, smsOtp: false, phone: '' };

export function hasMessaging(m: RecipientMessaging | undefined): boolean {
  return m !== undefined && (m.channel !== null || m.smsOtp);
}
/** M-A5 §2.1 — when a copy recipient receives their copy. */
export type CopyDelivery = 'ON_SEND' | 'ON_COMPLETION' | 'BOTH';

export interface DraftRecipient {
  readonly key: string;
  /** The server signer id once the recipients were saved. */
  readonly serverId: string | null;
  readonly name: string;
  /** '' only for an in-person signer without an email (M-A5 §3.5). */
  readonly email: string;
  /** Absent on drafts saved before M-A5: read as SIGNER (recipientRoles.kindOf). */
  readonly kind?: RecipientKind;
  /** Set only for RECEIVES_COPY (M-A5 §2.1). */
  readonly copyDelivery?: CopyDelivery | null;
  /**
   * Assign to me (M-A5 §4.1): the server binds the caller to this recipient. The PUT
   * replaces the whole list, so the flag is re-sent on every recipients write.
   */
  readonly assignToMe?: boolean;
  /** WITNESS only: the key of the signing recipient this witness attests for. */
  readonly witnessForKey?: string | null;
  /** The server has an access code for this recipient (the code is never returned). */
  readonly accessCodeSet?: boolean;
  /**
   * A change to the access code not yet saved: a string sets it, null removes it,
   * absent keeps it. Cleared after the recipients are saved.
   */
  readonly accessCode?: string | null;
  readonly identityCheck?: IdentityCheck | null;
  /** True when identityCheck was changed here (only then is it sent). */
  readonly identityDirty?: boolean;
  /** SIGN-FREE-PARITY-1 S3 — ask for a code sent to their email before signing (link signers). */
  readonly emailOtp?: boolean;
  readonly messaging?: RecipientMessaging;
  /** True when messaging still has to be saved (its own route, after the recipients). */
  readonly messagingDirty?: boolean;
}

/** What still has to reach the server. */
export interface DirtyFlags {
  readonly meta: boolean;
  readonly recipients: boolean;
  readonly fields: boolean;
}

export interface SendDraftPayload {
  readonly subject: string;
  /** False while the subject is the generated default (it keeps following the data). */
  readonly subjectEdited: boolean;
  readonly message: string;
  readonly routingMode: RoutingMode;
  readonly documents: readonly DraftDocument[];
  readonly recipients: readonly DraftRecipient[];
  /** EDITOR frame (top-left, PDF points), keyed to document and recipient keys. */
  readonly fields: readonly EditorField[];
  /**
   * Fields of the server copy whose type the editor does not author (an engine type
   * such as ACKNOWLEDGEMENT). Kept exactly as the server returned them (wire frame,
   * server ids) and re-sent with every replace-all PUT, so editing a draft never
   * deletes them. Absent in drafts stored before this existed.
   */
  readonly preservedFields?: readonly ServerField[];
  /** The ETag of the last server response this draft is based on. */
  readonly etag: string | null;
  readonly dirty: DirtyFlags;
  /**
   * "Sign a document" (M-A4 §6.3, M-A5 §4): after Send, open the self-sign session for
   * the recipient assigned to the user. Kept with the local draft only.
   */
  readonly selfSign?: boolean;
  /** Feature-Parity §1.17 — signers may hand off to someone else (set while a draft). */
  readonly allowDelegation?: boolean;
  /** The server's allow_delegation as last read (the PATCH carries a change only). */
  readonly serverAllowDelegation?: boolean;
  /** SIGN-FREE-PARITY-1 S4 — automatic reminders (absent: on, the server default). */
  readonly autoRemindersEnabled?: boolean;
  /** The server's auto_reminders.enabled as last read (absent: an older server; nothing is sent). */
  readonly serverAutoRemindersEnabled?: boolean;
  /**
   * FIELD-PARITY-1 P3 S-5 (ruling R-3) — the server's sender_filled_fields_enabled as last
   * read: the settings sheet offers sender-filled (and read-only) only while it is true.
   */
  readonly senderFilledEnabled?: boolean;
  /** FIELD-PARITY-2 A-3 — the upload options for documents added from now on (absent: both off). */
  readonly uploadOptions?: UploadOptions;
}

export type SendDraft = LocalDraft<SendDraftPayload>;

export const CLEAN: DirtyFlags = { meta: false, recipients: false, fields: false };

export function emptyPayload(): SendDraftPayload {
  return {
    subject: '',
    subjectEdited: false,
    message: '',
    routingMode: 'PARALLEL',
    documents: [],
    recipients: [],
    fields: [],
    etag: null,
    dirty: CLEAN,
  };
}

/**
 * The default email subject. PO 2026-11-18 (DocuSign comparison): "Please sign: {first document}"
 * on web and app alike (was "{document} — {first signer}", which named one signer to all of
 * them). A document you sign yourself keeps the document's name. The sender can edit it; the
 * limit stays SUBJECT_MAX (200).
 */
export const SUBJECT_PREFIX = SIGN_SUBJECT_PREFIX; // the one rule's (@aramo/sign-client), as web and the emails
export function defaultSubject(p: Pick<SendDraftPayload, 'documents' | 'recipients'> & { readonly selfSign?: boolean }): string {
  const doc = p.documents[0]?.title ?? '';
  if (doc === '') return '';
  return (p.selfSign === true ? doc : `${SUBJECT_PREFIX}${doc}`).slice(0, SUBJECT_MAX);
}

export function effectiveSubject(p: SendDraftPayload): string {
  return p.subjectEdited ? p.subject : defaultSubject(p);
}

/** True when the sender has added anything (Cancel then asks to save). */
export function hasContent(p: SendDraftPayload): boolean {
  return (
    p.documents.length > 0 ||
    p.recipients.length > 0 ||
    p.fields.length > 0 ||
    p.message.trim().length > 0 ||
    (p.subjectEdited && p.subject.trim().length > 0)
  );
}

export function isDirty(p: SendDraftPayload): boolean {
  return (
    p.dirty.meta ||
    p.dirty.recipients ||
    p.dirty.fields ||
    p.recipients.some((r) => r.messagingDirty === true) ||
    p.documents.some((d) => d.pendingUpload !== null)
  );
}

/** "Continue editing" opens at the furthest step that has data (handoff §9 item 8). */
export function furthestStep(p: SendDraftPayload): SendStep {
  if (p.documents.length === 0) return 'documents';
  if (p.recipients.length === 0) return 'recipients';
  if (p.fields.length === 0) return 'fields';
  return 'review';
}

export const STEPS: readonly SendStep[] = ['documents', 'recipients', 'fields', 'review'];

// ── The server envelope (sender detail) ────────────────────────────────────────

export interface ServerDocument {
  readonly id: string;
  readonly title: string;
}
export interface ServerRecipient {
  readonly id: string;
  readonly name: string;
  /** '' when the server has none (an in-person signer, M-A5 §3.5). */
  readonly email: string;
  readonly status: string;
  readonly signingOrder: number | null;
  readonly kind: RecipientKind;
  readonly copyDelivery: CopyDelivery | null;
  /** The server's `assigned_to_me` (the bound user id itself is never returned). */
  readonly assignedToMe: boolean;
  readonly witnessForSignerId: string | null;
  readonly accessCodeSet: boolean;
  readonly identityCheck: IdentityCheck | null;
  /** SIGN-FREE-PARITY-1 S3 — the server's `email_otp_required`. */
  readonly emailOtp: boolean;
}
export interface ServerField {
  /** The stored field id (sent back with a preserved engine-type field, M-A6 §2). */
  readonly id: string;
  readonly envelope_document_id: string;
  /** null for an unassigned engine field (S2S / Sign API). */
  readonly signer_id: string | null;
  readonly field_type: string;
  readonly page_number: number;
  readonly x: number;
  readonly y: number;
  /** null when the stored engine field has no size. */
  readonly width: number | null;
  readonly height: number | null;
  readonly required: boolean;
  /** M-A6 §2 — configuration (null where it does not apply). */
  readonly name_mode: string | null;
  readonly label: string | null;
  readonly group_key: string | null;
  readonly group_rule: string | null;
  readonly min_selected: number | null;
  // FIELD-PARITY-1 P3 §6.2 — the other settings (absent on older servers; null / false = not set).
  readonly tooltip?: string | null;
  readonly placeholder?: string | null;
  readonly read_only?: boolean;
  readonly sender_filled?: boolean;
  readonly validation?: string | null;
  readonly font_size?: number | null;
  readonly data_name?: string | null;
  readonly options?: Readonly<Record<string, unknown>> | null;
  /** S-5 — a sender-filled field's value (the sender's own; null otherwise). */
  readonly value?: string | null;
  /**
   * FIELD-PARITY-2 B-1 — the field's stable key (absent / null on a legacy, S2S or imported
   * field). It survives every replace-all PUT only when it is sent back; the row id does not.
   */
  readonly field_key?: string | null;
  /** FIELD-PARITY-2 B-2 — "show only when" (absent / null: always shown). */
  readonly condition?: FieldCondition | null;
}
export interface ServerEnvelope {
  readonly id: string;
  readonly subject: string;
  readonly status: string;
  readonly editable: boolean;
  readonly revision: number | null;
  readonly routingMode: RoutingMode;
  readonly message: string | null;
  readonly signingLinkValidDays: number | null;
  readonly envelopeExpiresAt: string | null;
  readonly allowDelegation: boolean;
  /** SIGN-FREE-PARITY-1 S4 — automatic reminders (null from an older server). */
  readonly autoReminders: AutoRemindersView | null;
  readonly documents: readonly ServerDocument[];
  readonly recipients: readonly ServerRecipient[];
  readonly fields: readonly ServerField[];
  /** FIELD-PARITY-1 P3 S-5 — sender-filled fields switched on (absent on an older server: false). */
  readonly senderFilledFieldsEnabled: boolean;
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** FIELD-PARITY-2 B-1 — a stored field key (1..200 characters), else null. */
export function fieldKeyOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= FIELD_KEY_LIMIT ? v : null;
}
/** The server's field-key limit (@aramo/sign-fields FIELD_KEY_MAX). */
const FIELD_KEY_LIMIT = 200;

/** FIELD-PARITY-2 B-2 — a stored condition (none, or a shape the server would refuse: none). */
function conditionOfWire(v: unknown): FieldCondition | null {
  const parsed = parseFieldCondition(v);
  return parsed.ok ? parsed.condition : null;
}

const KINDS: readonly RecipientKind[] = ['SIGNER', 'IN_PERSON_SIGNER', 'RECEIVES_COPY', 'WITNESS'];
const DELIVERIES: readonly CopyDelivery[] = ['ON_SEND', 'ON_COMPLETION', 'BOTH'];
function asKind(v: unknown): RecipientKind {
  return KINDS.includes(v as RecipientKind) ? (v as RecipientKind) : 'SIGNER';
}
function asCopyDelivery(v: unknown): CopyDelivery | null {
  return DELIVERIES.includes(v as CopyDelivery) ? (v as CopyDelivery) : null;
}

/** SIGN-FREE-PARITY-1 S4 — the detail's auto_reminders (null when absent: an older server). */
export function autoRemindersOf(v: unknown): AutoRemindersView | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o['enabled'] !== 'boolean') return null;
  return {
    enabled: o['enabled'],
    sent_count: num(o['sent_count']) ?? 0,
    max_count: num(o['max_count']) ?? 0,
    next_at: typeof o['next_at'] === 'string' ? (o['next_at'] as string) : null,
  };
}

/** Read the sender detail defensively (its document and recipient items are untyped in OpenAPI). */
export function parseEnvelope(raw: unknown): ServerEnvelope {
  const o = rec(raw);
  const arr = (k: string): Record<string, unknown>[] =>
    Array.isArray(o[k]) ? (o[k] as unknown[]).map(rec) : [];
  return {
    id: str(o['id']),
    subject: str(o['subject']),
    status: str(o['status']),
    editable: o['editable'] === true,
    revision: num(o['revision']),
    routingMode: o['routing_mode'] === 'SEQUENTIAL' ? 'SEQUENTIAL' : 'PARALLEL',
    message: typeof o['message'] === 'string' ? (o['message'] as string) : null,
    signingLinkValidDays: num(o['signing_link_valid_days']),
    envelopeExpiresAt:
      typeof o['envelope_expires_at'] === 'string' ? (o['envelope_expires_at'] as string) : null,
    allowDelegation: o['allow_delegation'] === true,
    autoReminders: autoRemindersOf(o['auto_reminders']),
    documents: arr('documents').map((d) => ({
      id: str(d['id']),
      title: str(d['title'], 'Document'),
    })),
    recipients: arr('recipients')
      .map((r) => ({
        id: str(r['id']),
        name: str(r['name']),
        email: str(r['email']),
        status: str(r['status']),
        signingOrder: num(r['signing_order']),
        kind: asKind(r['recipient_kind']),
        copyDelivery: asCopyDelivery(r['copy_delivery']),
        assignedToMe: r['assigned_to_me'] === true,
        witnessForSignerId:
          typeof r['witness_for_signer_id'] === 'string' ? (r['witness_for_signer_id'] as string) : null,
        accessCodeSet: r['access_code_set'] === true,
        identityCheck:
          r['identity_verification_method'] === 'ID_VERIFICATION' ||
          r['identity_verification_method'] === 'KBA'
            ? (r['identity_verification_method'] as IdentityCheck)
            : null,
        emailOtp: r['email_otp_required'] === true,
      }))
      // Signing recipients in signing order, then copy recipients (M-A5 §1.6: a copy
      // recipient takes no part in the order and may come back without one).
      .sort(
        (a, b) =>
          Number(a.kind === 'RECEIVES_COPY') - Number(b.kind === 'RECEIVES_COPY') ||
          (a.signingOrder ?? 0) - (b.signingOrder ?? 0),
      ),
    fields: arr('fields').map((f) => ({
      id: str(f['id']),
      envelope_document_id: str(f['envelope_document_id']),
      signer_id: typeof f['signer_id'] === 'string' ? (f['signer_id'] as string) : null,
      field_type: str(f['field_type']),
      page_number: num(f['page_number']) ?? 0,
      x: num(f['x']) ?? 0,
      y: num(f['y']) ?? 0,
      width: num(f['width']),
      height: num(f['height']),
      required: f['required'] !== false,
      name_mode: typeof f['name_mode'] === 'string' ? (f['name_mode'] as string) : null,
      label: typeof f['label'] === 'string' ? (f['label'] as string) : null,
      group_key: typeof f['group_key'] === 'string' ? (f['group_key'] as string) : null,
      group_rule: typeof f['group_rule'] === 'string' ? (f['group_rule'] as string) : null,
      min_selected: num(f['min_selected']),
      // FIELD-PARITY-1 P3 §6.2 — every other setting, only where set (a preserved field goes
      // back with them; a DROPDOWN without its choices would be refused).
      ...(typeof f['tooltip'] === 'string' ? { tooltip: f['tooltip'] as string } : {}),
      ...(typeof f['placeholder'] === 'string' ? { placeholder: f['placeholder'] as string } : {}),
      ...(f['read_only'] === true ? { read_only: true } : {}),
      ...(f['sender_filled'] === true ? { sender_filled: true } : {}),
      ...(typeof f['validation'] === 'string' ? { validation: f['validation'] as string } : {}),
      ...(num(f['font_size']) !== null ? { font_size: num(f['font_size']) } : {}),
      ...(typeof f['data_name'] === 'string' ? { data_name: f['data_name'] as string } : {}),
      ...(f['options'] !== null && typeof f['options'] === 'object' && !Array.isArray(f['options'])
        ? { options: f['options'] as Record<string, unknown> }
        : {}),
      ...(f['sender_filled'] === true && typeof f['value'] === 'string' ? { value: f['value'] as string } : {}),
      // FIELD-PARITY-2 B-1 / B-2 — the key and the condition, so a re-save keeps both.
      ...(fieldKeyOf(f['field_key']) !== null ? { field_key: fieldKeyOf(f['field_key']) } : {}),
      ...(conditionOfWire(f['condition']) !== null ? { condition: conditionOfWire(f['condition']) } : {}),
    })),
    senderFilledFieldsEnabled: o['sender_filled_fields_enabled'] === true,
  };
}

/** The editor's configuration for a server field of an authoring type (also self-sign's template start). */
export function configOf(f: ServerField): Partial<EditorField> {
  // FIELD-PARITY-1 P3 §6.2 — the P3 settings of every type, then the M-A6 ones.
  const p3 = settingsFromServer(f);
  if (f.field_type === 'SIGNER_NAME')
    return {
      ...p3,
      nameMode: f.name_mode === 'SIGNER_ENTERED' ? 'SIGNER_ENTERED' : 'SIGNER_PROFILE',
      ...(f.label !== null ? { label: f.label } : {}),
    };
  if (f.field_type === 'RADIO') {
    return { ...p3, label: f.label, groupKey: f.group_key, groupRule: 'SELECT_ONE', minSelected: null };
  }
  if (f.field_type !== 'CHECKBOX') return { ...p3, ...(f.label !== null ? { label: f.label } : {}) };
  const rule = f.group_rule === 'SELECT_ONE' || f.group_rule === 'SELECT_ANY' ? f.group_rule : null;
  return {
    ...p3,
    label: f.label,
    groupKey: f.group_key,
    groupRule: f.group_key !== null ? (rule ?? 'SELECT_ANY') : null,
    minSelected: f.group_key !== null ? f.min_selected : null,
  };
}

/**
 * Server fields → the editor's fields. A type the editor does not author is kept untouched,
 * never dropped: the fields PUT replaces every field, so dropping it here would delete it on the
 * next sync. So is an engine row with no recipient or size (an S2S / Sign API ACKNOWLEDGEMENT,
 * FIELD-PARITY-1 P3): the server passes it through only unchanged, with its id. A field on a
 * document whose pages are not known yet is left out (`fieldsPending`). Also the sync's adoption
 * of the fields an upload created (FIELD-PARITY-2 A-3).
 */
export function editorFieldsFromServer(
  serverFields: readonly ServerField[],
  pagesByDoc: ReadonlyMap<string, readonly PageSize[]>,
  keyOf: (serverId: string) => string,
  fieldKey: (f: ServerField, i: number) => string,
): { fields: EditorField[]; preservedFields: ServerField[]; fieldsPending: boolean; pendingFields: ServerField[] } {
  const pendingFields: ServerField[] = [];
  const fields: EditorField[] = [];
  const preservedFields: ServerField[] = [];
  // FIELD-PARITY-2 B-1 — an editor field's key IS its field_key (sent back on every PUT), so a
  // condition's trigger_key keeps naming it. A field without a stored key gets `fieldKey`'s,
  // kept clear of every stored key (the server refuses a key used twice in an envelope).
  const stored = new Set(serverFields.map((f) => fieldKeyOf(f.field_key)).filter((k): k is string => k !== null));
  const used = new Set<string>();
  const keyFor = (f: ServerField, i: number): string => {
    const own = fieldKeyOf(f.field_key);
    if (own !== null && !used.has(own)) return own;
    let k = fieldKey(f, i);
    while (stored.has(k) || used.has(k)) k = `${k}-${i}`;
    return k;
  };
  serverFields.forEach((f, i) => {
    if (!isAuthoringFieldType(f.field_type) || f.signer_id === null || f.width === null || f.height === null) {
      preservedFields.push(f);
      return;
    }
    const page = pagesByDoc.get(f.envelope_document_id)?.[f.page_number];
    if (!page) {
      pendingFields.push(f);
      return;
    }
    const box = wireToEditor({ x: f.x, y: f.y, width: f.width, height: f.height }, page);
    const key = keyFor(f, i);
    used.add(key);
    fields.push({
      key,
      docKey: keyOf(f.envelope_document_id),
      page: f.page_number,
      recipientKey: keyOf(f.signer_id),
      type: f.field_type,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      required: f.required,
      ...configOf(f),
      // FIELD-PARITY-2 B-2 — the Send flow keeps the condition (self-sign never has one, C-7).
      ...(f.condition ? { condition: f.condition } : {}),
    });
  });
  return { fields, preservedFields, fieldsPending: pendingFields.length > 0, pendingFields };
}

/**
 * Build the local payload from the server envelope. Page sizes come from `pagesByDoc`
 * (known locally or read from the source PDF); fields on a document without known
 * pages stay on the server copy only until the pages are known (`fieldsPending`).
 */
export function payloadFromServer(
  env: ServerEnvelope,
  etag: string | null,
  pagesByDoc: ReadonlyMap<string, readonly PageSize[]>,
  keyOf: (serverId: string) => string = (id) => id,
): { payload: SendDraftPayload; fieldsPending: boolean } {
  const documents: DraftDocument[] = env.documents.map((d) => ({
    key: keyOf(d.id),
    serverId: d.id,
    title: d.title,
    filename: `${d.title}.pdf`,
    pages: pagesByDoc.get(d.id) ?? null,
    pendingUpload: null,
  }));
  const recipients: DraftRecipient[] = env.recipients.map((r) => ({
    key: keyOf(r.id),
    serverId: r.id,
    name: r.name,
    email: r.email,
    kind: r.kind,
    copyDelivery: r.kind === 'RECEIVES_COPY' ? r.copyDelivery : null,
    assignToMe: r.assignedToMe,
    ...(r.kind === 'WITNESS' ? { witnessForKey: r.witnessForSignerId ? keyOf(r.witnessForSignerId) : null } : {}),
    ...(r.accessCodeSet ? { accessCodeSet: true } : {}),
    ...(r.identityCheck ? { identityCheck: r.identityCheck } : {}),
    ...(r.emailOtp ? { emailOtp: true } : {}),
  }));
  const { fields, preservedFields, fieldsPending } = editorFieldsFromServer(env.fields, pagesByDoc, keyOf, (_f, i) => `srv-${i}`);
  const generated = defaultSubject({ documents, recipients });
  return {
    payload: {
      subject: env.subject,
      subjectEdited: env.subject.length > 0 && env.subject !== generated,
      message: env.message ?? '',
      routingMode: env.routingMode,
      documents,
      recipients,
      fields,
      ...(preservedFields.length > 0 ? { preservedFields } : {}),
      ...(env.allowDelegation ? { allowDelegation: true, serverAllowDelegation: true } : {}),
      ...(env.autoReminders !== null
        ? { autoRemindersEnabled: env.autoReminders.enabled, serverAutoRemindersEnabled: env.autoReminders.enabled }
        : {}),
      ...(env.senderFilledFieldsEnabled ? { senderFilledEnabled: true } : {}),
      etag,
      dirty: CLEAN,
    },
    fieldsPending,
  };
}

/** The server's per-signer messaging choices (GET …/messaging), by signer id. */
export type MessagingBySigner = ReadonlyMap<string, RecipientMessaging>;

/** Merge the server's messaging choices into the recipients (by server id). */
export function withMessaging(p: SendDraftPayload, bySigner: MessagingBySigner): SendDraftPayload {
  if (bySigner.size === 0) return p;
  return {
    ...p,
    recipients: p.recipients.map((r) => {
      const m = r.serverId ? bySigner.get(r.serverId) : undefined;
      return m && !r.messagingDirty ? { ...r, messaging: m } : r;
    }),
  };
}

/**
 * Whether the draft's documents are not all on the server yet (no envelope, or a document still
 * waiting to upload): then Find and "Find fields" have nothing to read until the draft is saved.
 */
export function draftNeedsUpload(
  envelopeId: string | null,
  documents: readonly { readonly serverId: string | null; readonly pendingUpload: unknown }[],
): boolean {
  return documents.length > 0 && (envelopeId === null || documents.some((d) => d.pendingUpload !== null || !d.serverId));
}
