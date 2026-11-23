// Push a locally prepared draft to the server (directive §9 "syncs when online";
// M-A3 §6, §8). Order: create the envelope (if new) -> upload pending documents ->
// subject / routing / message -> recipients -> fields. Every write carries If-Match
// with the ETag the previous step returned, so a concurrent change anywhere (web, a
// second device) stops the sync with 412 and nothing is overwritten. Progress is
// reported after every server write so a crash mid-sync never repeats a create, and a
// re-run upload replays under its Idempotency-Key instead of duplicating the document.
import { isApiError } from '../../api/errors';
import { parseEtag } from '../../api/workspaceClient';
import type { EditorField } from '../editor/editorReducer';
import { p3SettingsWire } from '../editor/fieldSettings';
import { editorToWire } from '../editor/geometry';
import type { DocumentBytesStore } from './documentBytes';
import {
  CLEAN,
  editorFieldsFromServer,
  effectiveSubject,
  fieldKeyOf,
  uploadMakesFields,
  type DraftDocument,
  type SendDraft,
  type SendDraftPayload,
  type ServerEnvelope,
  type ServerField,
} from './draftModel';
import { emailKey, recipientsToWire, takesMessaging, wireOrder } from './recipientRoles';
import {
  messagingToWire,
  revisionMismatch,
  type FieldWire,
  type SenderApi,
  type FieldImportResult,
  type UploadedDocument,
} from './senderApi';

export class SendFlowError extends Error {
  constructor(
    readonly reason: 'document_bytes_missing' | 'pages_unknown' | 'recipients_out_of_sync',
  ) {
    super(reason);
    this.name = 'SendFlowError';
  }
}

export interface SyncDeps {
  readonly api: SenderApi;
  readonly bytes: DocumentBytesStore;
  /** Persist intermediate progress (the encrypted DraftStore). */
  readonly onProgress?: (draft: SendDraft) => Promise<void>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

export interface SyncResult {
  readonly draft: SendDraft;
  /** The envelope as of the last write (null when nothing needed writing). */
  readonly server: ServerEnvelope | null;
  /** FIELD-PARITY-2 A-3 — what each opted-in upload of this sync created (empty when none). */
  readonly imports: readonly SyncImport[];
}

/** FIELD-PARITY-2 A-3 — the result of one opted-in upload, for the import summary. */
export interface SyncImport {
  readonly docKey: string;
  readonly title: string;
  readonly result: FieldImportResult;
}

/** The envelope has a signing recipient on the server (an opted-in upload needs one). */
function hasServerSigner(p: SendDraftPayload): boolean {
  return p.recipients.some((r) => r.serverId !== null && r.kind !== 'RECEIVES_COPY');
}

export const UPLOAD_ATTEMPTS = 3;

function retryable(e: unknown): boolean {
  return (
    isApiError(e) &&
    (e.isNetwork || e.reason === 'idempotency_request_in_progress' || e.status >= 500)
  );
}

/** Run an upload, retrying transient failures with the SAME Idempotency-Key (M-A3 §8). */
export async function uploadWithRetry(
  attempt: () => Promise<UploadedDocument>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts = UPLOAD_ATTEMPTS,
): Promise<UploadedDocument> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await attempt();
    } catch (e) {
      last = e;
      if (!retryable(e) || i === attempts - 1) throw e;
      await sleep(500 * 2 ** i);
    }
  }
  throw last;
}

function revisionOf(etag: string | null): number | null {
  return parseEtag(etag)?.revision ?? null;
}

/**
 * The wire fields for the payload. Every document and recipient must be on the server.
 * FIELD-PARITY-2 B-1 / B-2 — each authored field goes with its key as its field_key and with its
 * condition, so a re-save never blanks a key or drops a condition. A key that is not a valid
 * field key, or one already used (a preserved field's, an earlier field's), is not sent: the
 * server would refuse the whole list (field_key_invalid / field_key_duplicate).
 */
export function fieldsToWire(p: SendDraftPayload): FieldWire[] {
  const keys = new Set((p.preservedFields ?? []).map((f) => fieldKeyOf(f.field_key)).filter((k): k is string => k !== null));
  const authored: FieldWire[] = p.fields.map((f) => {
    const doc = p.documents.find((d) => d.key === f.docKey);
    const r = p.recipients.find((x) => x.key === f.recipientKey);
    const page = doc?.pages?.[f.page];
    if (!doc?.serverId || !page) throw new SendFlowError('pages_unknown');
    if (!r?.serverId) throw new SendFlowError('recipients_out_of_sync');
    const b = editorToWire(f, page);
    const key = fieldKeyOf(f.key);
    const keyed = key !== null && !keys.has(key);
    if (keyed) keys.add(key);
    return {
      ...(keyed ? { field_key: key } : {}),
      envelope_document_id: doc.serverId,
      signer_id: r.serverId,
      field_type: f.type,
      page_number: f.page,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      required: f.required,
      ...configWire(f),
      ...(f.condition ? { condition: f.condition } : {}),
    };
  });
  // Engine-type fields from the server copy go back exactly as they came (their
  // recipient must still exist: the server drops the fields of removed recipients).
  const signers = new Set(p.recipients.map((r) => r.serverId).filter((x): x is string => !!x));
  // M-A6 §2 — a preserved field carries its stored id and every stored value exactly
  // (the server keeps it only when it is identical to the stored row).
  const preserved: FieldWire[] = (p.preservedFields ?? [])
    .filter((f) => f.signer_id === null || signers.has(f.signer_id))
    .map(preservedFieldWire);
  return [...authored, ...preserved];
}

/**
 * A stored field sent back exactly as it came: its id and every stored value (the server keeps
 * an engine-type row only when it is identical; FIELD-PARITY-1 P3 — every setting that is set,
 * so a DROPDOWN keeps its choices). Also self-sign's carried template fields (FIELD-PARITY-2 A-1).
 */
export function preservedFieldWire(f: ServerField): FieldWire {
  return {
    id: f.id,
    ...storedFieldWire(f),
  };
}

/** A stored field's members as a PUT …/fields item, without its id (values exactly as stored). */
export function storedFieldWire(f: ServerField): FieldWire {
  return {
    envelope_document_id: f.envelope_document_id,
    signer_id: f.signer_id,
    field_type: f.field_type,
    page_number: f.page_number,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    required: f.required,
    name_mode: f.name_mode,
    label: f.label,
    group_key: f.group_key,
    group_rule: f.group_rule,
    min_selected: f.min_selected,
    ...(f.tooltip != null ? { tooltip: f.tooltip } : {}),
    ...(f.placeholder != null ? { placeholder: f.placeholder } : {}),
    ...(f.read_only === true ? { read_only: true } : {}),
    ...(f.sender_filled === true ? { sender_filled: true } : {}),
    ...(f.validation != null ? { validation: f.validation } : {}),
    ...(f.font_size != null ? { font_size: f.font_size } : {}),
    ...(f.data_name != null ? { data_name: f.data_name } : {}),
    ...(f.options != null ? { options: f.options } : {}),
    ...(f.sender_filled === true && f.value != null ? { value: f.value } : {}),
    // FIELD-PARITY-2 B-1 / B-2 — the stored key and condition go back as stored.
    ...(f.field_key != null ? { field_key: f.field_key } : {}),
    ...(f.condition != null ? { condition: f.condition } : {}),
  };
}

/**
 * M-A6 §2 — the configuration a field type carries on the wire. FIELD-PARITY-1 P3 §6.2 — plus
 * every P3 setting its type takes and that is set (fieldSettings.ts p3SettingsWire), and the
 * sender's value of a sender-filled field only (S-5; any other value is refused).
 */
export function configWire(f: EditorField): Partial<FieldWire> {
  const p3 = p3SettingsWire(f) as Partial<FieldWire>;
  const label = (f.label ?? '').trim();
  if (f.type === 'SIGNER_NAME') return { name_mode: f.nameMode ?? 'SIGNER_PROFILE', ...(label ? { label } : {}), ...p3 };
  if (f.type === 'RADIO') {
    // T-5 — always one option of a group; its rule is SELECT_ONE (the server's default).
    return { ...(label ? { label } : {}), group_key: f.groupKey ?? null, ...p3 };
  }
  if (f.type !== 'CHECKBOX') return { ...(label ? { label } : {}), ...p3 };
  const grouped = typeof f.groupKey === 'string' && f.groupKey.length > 0;
  return {
    label: f.label ?? null,
    group_key: grouped ? f.groupKey : null,
    group_rule: grouped ? (f.groupRule ?? 'SELECT_ANY') : null,
    min_selected: grouped && f.groupRule !== 'SELECT_ONE' ? (f.minSelected ?? null) : null,
    ...p3,
  };
}

/**
 * FIELD-PARITY-2 A-3 — the fields an upload created on its document (imported form fields, text
 * tags), adopted into the local draft: the server's list is the base for that document, and the
 * user's later edits apply to it. A field this editor can't hold (an unknown recipient, unknown
 * pages, an engine type) is kept exactly as stored, so a replace-all PUT never removes it.
 */
export function adoptUploadFields(
  p: SendDraftPayload,
  env: ServerEnvelope,
  doc: DraftDocument,
): Pick<SendDraftPayload, 'fields' | 'preservedFields'> | Record<string, never> {
  const made = env.fields.filter((f) => f.envelope_document_id === doc.serverId);
  if (made.length === 0) return {};
  const local = new Map(p.recipients.filter((r) => r.serverId !== null).map((r) => [r.serverId as string, r.key]));
  const known = made.filter((f) => f.signer_id === null || local.has(f.signer_id));
  const keyOf = (id: string) => (id === doc.serverId ? doc.key : (local.get(id) ?? id));
  const pages = new Map([[doc.serverId as string, doc.pages ?? []]]);
  const taken = new Set(p.fields.map((f) => f.key));
  const { fields, preservedFields, pendingFields } = editorFieldsFromServer(known, pages, keyOf, (f, i) => {
    let k = `imp-${f.id || `${doc.key}-${i}`}`;
    while (taken.has(k)) k = `${k}-${i}`;
    taken.add(k);
    return k;
  });
  const kept = [...preservedFields, ...pendingFields, ...made.filter((f) => !known.includes(f))];
  return {
    fields: [...p.fields, ...fields],
    ...(kept.length > 0 || p.preservedFields ? { preservedFields: [...(p.preservedFields ?? []), ...kept] } : {}),
  };
}

export async function syncDraft(deps: SyncDeps, input: SendDraft): Promise<SyncResult> {
  const { api, bytes } = deps;
  const now = deps.now ?? (() => new Date());
  let draft = input;
  let p = input.payload;
  let server: ServerEnvelope | null = null;

  const save = async (patch: Partial<SendDraftPayload>, envelopeId = draft.envelopeId) => {
    p = { ...p, ...patch };
    draft = {
      ...draft,
      envelopeId,
      baseRevision: revisionOf(p.etag),
      updatedAt: now().toISOString(),
      payload: p,
    };
    await deps.onProgress?.(draft);
  };

  // 4. Recipients: the signing recipients in signing order (list position), then the
  // copy recipients, which never take part in the order (M-A5 §1.6). The PUT replaces
  // the list, so every item carries its kind, copy timing and Assign to me again.
  const syncRecipients = async () => {
    const ordered = wireOrder(p.recipients);
    const v = await api.putRecipients(envelopeId, p.etag as string, recipientsToWire(p.recipients));
    const sent = v.env.recipients;
    const same = (s: (typeof sent)[number], r: (typeof ordered)[number]) => {
      const a = emailKey(s.email);
      const b = emailKey(r.email);
      return a !== null || b !== null ? a === b : s.name.trim() === r.name.trim();
    };
    if (sent.length !== ordered.length || sent.some((s, i) => !same(s, ordered[i]!))) {
      throw new SendFlowError('recipients_out_of_sync');
    }
    server = v.env;
    const byKey = new Map(ordered.map((r, i) => [r.key, sent[i]!]));
    // The server drops the fields of removed recipients, so the fields are re-sent. A
    // saved access code or identity check is no longer pending (the code is forgotten).
    await save({
      etag: v.etag,
      recipients: p.recipients.map((r) => {
        const s = byKey.get(r.key);
        const { accessCode: _code, identityDirty: _idv, ...rest } = r;
        return {
          ...rest,
          serverId: s?.id ?? r.serverId,
          accessCodeSet: s ? s.accessCodeSet : r.accessCodeSet === true,
        };
      }),
      dirty: { ...p.dirty, recipients: false, fields: true },
    });
  };

  // 1. The envelope.
  if (draft.envelopeId === null) {
    const { id } = await api.create(effectiveSubject(p));
    const v = await api.detail(id);
    server = v.env;
    // A new envelope still needs the routing mode and message.
    await save({ etag: v.etag, dirty: { ...p.dirty, meta: true } }, id);
  }
  const envelopeId = draft.envelopeId as string;
  if (p.etag === null) {
    // A server id without a version can only come from an interrupted create.
    const v = await api.detail(envelopeId);
    server = v.env;
    await save({ etag: v.etag });
  }

  // 2. Documents waiting for upload. FIELD-PARITY-2 A-3 — an upload with an option creates
  // fields for a signing recipient, so the recipients go first; with no signing recipient yet it
  // waits (and so do the fields). The fields it created are adopted into the local draft, so the
  // replace-all fields PUT keeps every one the user did not delete.
  const imports: SyncImport[] = [];
  if (p.dirty.recipients && p.documents.some((d) => uploadMakesFields(d.pendingUpload))) await syncRecipients();
  let deferred = false;
  for (const doc of p.documents) {
    if (doc.pendingUpload === null) continue;
    const pending = doc.pendingUpload;
    if (uploadMakesFields(pending) && !hasServerSigner(p)) {
      deferred = true;
      continue;
    }
    const content = await bytes.get(doc.key);
    if (content === null) throw new SendFlowError('document_bytes_missing');
    const before = revisionOf(p.etag);
    const ifMatch = p.etag as string;
    const up = await uploadWithRetry(
      () =>
        api.upload(envelopeId, ifMatch, {
          title: doc.title,
          filename: doc.filename,
          contentBase64: content,
          idempotencyKey: pending.idempotencyKey,
          ...(pending.importFields ? { importFields: true } : {}),
          ...(pending.applyTextTags ? { applyTextTags: true } : {}),
        }),
      deps.sleep,
    );
    // The upload answers without a version: read it, and require that exactly this
    // upload happened since our version (anything more is a change made elsewhere).
    const v = await api.detail(envelopeId);
    if (before !== null && v.env.revision !== null && v.env.revision !== before + 1) {
      throw revisionMismatch(v.env.revision);
    }
    server = v.env;
    const uploaded: DraftDocument = {
      ...doc,
      serverId: up.id,
      pages: up.pages.length > 0 ? up.pages : doc.pages,
      pendingUpload: null,
    };
    const adopted = adoptUploadFields(p, v.env, uploaded);
    await save({
      etag: v.etag,
      documents: p.documents.map((d) => (d.key === doc.key ? uploaded : d)),
      ...adopted,
    });
    if (up.fieldImport) imports.push({ docKey: doc.key, title: doc.title, result: up.fieldImport });
    await bytes.remove(doc.key);
  }

  // 3. Subject, routing and message (PATCH, M-A3 §3).
  if (p.dirty.meta) {
    const subject = effectiveSubject(p).trim();
    const message = p.message.trim();
    // Feature-Parity §1.17 — allow_delegation goes only when it changed here.
    const delegation =
      p.allowDelegation !== undefined && p.allowDelegation !== (p.serverAllowDelegation ?? false)
        ? { allow_delegation: p.allowDelegation }
        : {};
    const v = await api.update(envelopeId, p.etag as string, {
      ...(subject ? { subject } : {}),
      routing_mode: p.routingMode,
      message: message.length > 0 ? message : null,
      ...delegation,
    });
    server = v.env;
    await save({
      etag: v.etag,
      serverAllowDelegation: v.env.allowDelegation,
      dirty: { ...p.dirty, meta: false },
    });
  }

  // 4. Recipients (unless already sent before an opted-in upload, step 2).
  if (p.dirty.recipients) await syncRecipients();

  // 4b. Text delivery and the SMS code (Feature-Parity §1.7–§1.9): one PUT per changed
  // recipient, after the recipients exist on the server. No If-Match: this route does not
  // change the envelope's revision.
  for (const r of p.recipients) {
    if (r.messagingDirty !== true) continue;
    if (!r.serverId) throw new SendFlowError('recipients_out_of_sync');
    const m = r.messaging && takesMessaging(r) ? r.messaging : { channel: null, smsOtp: false, phone: '' };
    await api.putMessaging(envelopeId, r.serverId, messagingToWire(m));
    await save({
      recipients: p.recipients.map((x) => (x.key === r.key ? { ...x, messagingDirty: false } : x)),
    });
  }

  // 5. Fields (replaced as a whole). Not while a document waits for its upload (step 2).
  if (p.dirty.fields && !deferred) {
    const v = await api.putFields(envelopeId, p.etag as string, fieldsToWire(p));
    server = v.env;
    await save({ etag: v.etag, dirty: CLEAN });
  }

  return { draft, server, imports };
}
