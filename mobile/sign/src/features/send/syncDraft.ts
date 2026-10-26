// Push a locally prepared draft to the server (directive §9 "syncs when online";
// M-A3 §6, §8). Order: create the envelope (if new) -> upload pending documents ->
// subject / routing / message -> recipients -> fields. Every write carries If-Match
// with the ETag the previous step returned, so a concurrent change anywhere (web, a
// second device) stops the sync with 412 and nothing is overwritten. Progress is
// reported after every server write so a crash mid-sync never repeats a create, and a
// re-run upload replays under its Idempotency-Key instead of duplicating the document.
import { isApiError } from '../../api/errors';
import { parseEtag } from '../../api/workspaceClient';
import { editorToWire } from '../editor/geometry';
import type { DocumentBytesStore } from './documentBytes';
import {
  CLEAN,
  effectiveSubject,
  type DraftDocument,
  type SendDraft,
  type SendDraftPayload,
  type ServerEnvelope,
} from './draftModel';
import {
  revisionMismatch,
  type FieldWire,
  type SenderApi,
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

/** The wire fields for the payload. Every document and recipient must be on the server. */
export function fieldsToWire(p: SendDraftPayload): FieldWire[] {
  return p.fields.map((f) => {
    const doc = p.documents.find((d) => d.key === f.docKey);
    const r = p.recipients.find((x) => x.key === f.recipientKey);
    const page = doc?.pages?.[f.page];
    if (!doc?.serverId || !page) throw new SendFlowError('pages_unknown');
    if (!r?.serverId) throw new SendFlowError('recipients_out_of_sync');
    const b = editorToWire(f, page);
    return {
      envelope_document_id: doc.serverId,
      signer_id: r.serverId,
      field_type: f.type,
      page_number: f.page,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      required: f.required,
    };
  });
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

  // 2. Documents waiting for upload.
  for (const doc of p.documents) {
    if (doc.pendingUpload === null) continue;
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
          idempotencyKey: doc.pendingUpload!.idempotencyKey,
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
    await save({
      etag: v.etag,
      documents: p.documents.map((d) => (d.key === doc.key ? uploaded : d)),
    });
    await bytes.remove(doc.key);
  }

  // 3. Subject, routing and message (PATCH, M-A3 §3).
  if (p.dirty.meta) {
    const subject = effectiveSubject(p).trim();
    const message = p.message.trim();
    const v = await api.update(envelopeId, p.etag as string, {
      ...(subject ? { subject } : {}),
      routing_mode: p.routingMode,
      message: message.length > 0 ? message : null,
    });
    server = v.env;
    await save({ etag: v.etag, dirty: { ...p.dirty, meta: false } });
  }

  // 4. Recipients, in signing order (list position).
  if (p.dirty.recipients) {
    const v = await api.putRecipients(
      envelopeId,
      p.etag as string,
      p.recipients.map((r) => ({
        ...(r.serverId ? { id: r.serverId } : {}),
        name: r.name,
        email: r.email,
      })),
    );
    const sent = v.env.recipients;
    if (
      sent.length !== p.recipients.length ||
      sent.some((s, i) => s.email.toLowerCase() !== p.recipients[i]!.email.toLowerCase())
    ) {
      throw new SendFlowError('recipients_out_of_sync');
    }
    server = v.env;
    // The server drops the fields of removed recipients, so the fields are re-sent.
    await save({
      etag: v.etag,
      recipients: p.recipients.map((r, i) => ({ ...r, serverId: sent[i]!.id })),
      dirty: { ...p.dirty, recipients: false, fields: true },
    });
  }

  // 5. Fields (replaced as a whole).
  if (p.dirty.fields) {
    const v = await api.putFields(envelopeId, p.etag as string, fieldsToWire(p));
    server = v.env;
    await save({ etag: v.etag, dirty: CLEAN });
  }

  return { draft, server };
}
