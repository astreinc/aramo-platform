// The Send flow's local draft (directive §9): everything the sender prepares, kept in
// the encrypted DraftStore (state/draftStore.ts) so it survives an app restart and can
// be prepared offline. The server envelope (revision + ETag, M-A3 §6) stays the
// authority once it exists: a sync only ever writes with If-Match on the revision the
// draft is based on, and a 412 replaces the local copy with the server's.
import type { EditorField } from '../editor/editorReducer';
import { isAuthoringFieldType } from '../editor/fieldTypes';
import { wireToEditor, type PageSize } from '../editor/geometry';
import type { LocalDraft, SendStep } from '../../state/draftStore';

export const MAX_RECIPIENTS = 10;
export const MESSAGE_MAX = 1000;
export const SUBJECT_MAX = 200;

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
  readonly pendingUpload: { readonly idempotencyKey: string } | null;
}

export interface DraftRecipient {
  readonly key: string;
  /** The server signer id once the recipients were saved. */
  readonly serverId: string | null;
  readonly name: string;
  readonly email: string;
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

/** "{first document} — {first signer}" (handoff §4.6 Review). */
export function defaultSubject(p: Pick<SendDraftPayload, 'documents' | 'recipients'>): string {
  const doc = p.documents[0]?.title ?? '';
  const who = p.recipients[0]?.name ?? '';
  return (doc && who ? `${doc} — ${who}` : doc || who).slice(0, SUBJECT_MAX);
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
  readonly email: string;
  readonly status: string;
  readonly signingOrder: number | null;
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
  readonly documents: readonly ServerDocument[];
  readonly recipients: readonly ServerRecipient[];
  readonly fields: readonly ServerField[];
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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
      }))
      .sort((a, b) => (a.signingOrder ?? 0) - (b.signingOrder ?? 0)),
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
    })),
  };
}

/** The editor's configuration for a server field of an authoring type. */
function configOf(f: ServerField): Partial<EditorField> {
  if (f.field_type === 'SIGNER_NAME')
    return { nameMode: f.name_mode === 'SIGNER_ENTERED' ? 'SIGNER_ENTERED' : 'SIGNER_PROFILE' };
  if (f.field_type !== 'CHECKBOX') return {};
  const rule = f.group_rule === 'SELECT_ONE' || f.group_rule === 'SELECT_ANY' ? f.group_rule : null;
  return {
    label: f.label,
    groupKey: f.group_key,
    groupRule: f.group_key !== null ? (rule ?? 'SELECT_ANY') : null,
    minSelected: f.group_key !== null ? f.min_selected : null,
  };
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
  }));
  let fieldsPending = false;
  const fields: EditorField[] = [];
  const preservedFields: ServerField[] = [];
  env.fields.forEach((f, i) => {
    // A type the editor does not author is kept untouched, never dropped: the fields
    // PUT replaces every field, so dropping it here would delete it on the next sync.
    if (!isAuthoringFieldType(f.field_type)) {
      preservedFields.push(f);
      return;
    }
    const page = pagesByDoc.get(f.envelope_document_id)?.[f.page_number];
    if (!page) {
      fieldsPending = true;
      return;
    }
    const box = wireToEditor({ x: f.x, y: f.y, width: f.width ?? 0, height: f.height ?? 0 }, page);
    fields.push({
      key: `srv-${i}`,
      docKey: keyOf(f.envelope_document_id),
      page: f.page_number,
      recipientKey: keyOf(f.signer_id ?? ''),
      type: f.field_type,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      required: f.required,
      ...configOf(f),
    });
  });
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
      etag,
      dirty: CLEAN,
    },
    fieldsPending,
  };
}
