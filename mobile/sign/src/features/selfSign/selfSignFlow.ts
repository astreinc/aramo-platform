// M-A12 W1-A — the self-sign backend sequence (contract §1, "Mobile flow"):
//   1. create(self)   POST /v1/sign/sender/envelopes { subject, mode: "self" } — the server
//                     creates the one SIGNER (the caller); the client never names them
//   2. upload docs    (If-Match, one Idempotency-Key per document, reused on retry)
//   3. place fields   PUT …/fields, every field assigned to the self recipient
//   4. send           no invitation is sent and no send allowance is used (M-A12 D-1)
//   5. self-sign-session (SELF evidence, M-A5 §4.2-§4.3 unchanged)
//   6. accept the disclosure (the user ticks it on the consent step)
//   7. fill each field with the values entered while placing
//   8. complete
// Steps 1–2 run when the user leaves the document list (so Find can read the server's
// text layer while placing); 3–5 on Finish; 6–8 after the consent. Each stage is
// recorded so a retry resumes after the last stage that succeeded and never repeats a
// send. The signing token stays in the GuestSigningSession's memory only.
import { isApiError } from '../../api/errors';
import type { GuestSigningSession } from '../../api/guestSigningClient';
import { newIdempotencyKey, type WorkspaceClient } from '../../api/workspaceClient';
import type { EditorField } from '../editor/editorReducer';
import { editorToWire } from '../editor/geometry';
import { readPdfPageSizes } from '../editor/pdfPageSizes';
import { revisionMismatch, type FieldWire, type SenderApi } from '../send/senderApi';
import { uploadWithRetry } from '../send/syncDraft';
import { base64Decode } from '../../util/bytes';
import {
  acceptAndLoad,
  openSigning,
  type Disclosure,
  type SignerView,
} from '../signing/signingApi';
import {
  fillValue,
  matchServerFields,
  placedOnServer,
  type SelfContext,
  type SelfDoc,
  type SelfEdits,
} from './selfSignModel';
import { fillPath } from '../../api/types';

export interface SelfSignDeps {
  readonly api: Pick<SenderApi, 'detail' | 'upload' | 'removeDocument' | 'putFields' | 'send' | 'selfSignSession'>;
  /** POST /v1/sign/sender/envelopes with `mode: "self"`. */
  readonly createSelf: (subject: string) => Promise<{ id: string }>;
  /** Opens the capability-token transport on a SELF session token. */
  readonly openSession: (token: string) => GuestSigningSession;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Where the envelope stands on the server. */
export interface SelfProgress {
  readonly envelopeId: string | null;
  readonly etag: string | null;
  /** The server id of the self recipient (the caller). */
  readonly signerId: string | null;
  readonly sent: boolean;
  /** Upload keys by document key, reused on every retry. */
  readonly uploadKeys: Readonly<Record<string, string>>;
}

export const NO_PROGRESS: SelfProgress = {
  envelopeId: null,
  etag: null,
  signerId: null,
  sent: false,
  uploadKeys: {},
};

/** POST /v1/sign/sender/envelopes { mode: "self" } (not yet in the generated types). */
export function createSelfEnvelope(workspace: WorkspaceClient) {
  return async (subject: string): Promise<{ id: string }> => {
    const r = await workspace.request<{ id: string }>({
      method: 'POST',
      path: '/v1/sign/sender/envelopes',
      body: { ...(subject ? { subject } : {}), mode: 'self' },
    });
    return { id: r.data.id };
  };
}

/**
 * Steps 1–2: create the envelope (once) and upload every document not yet on the server;
 * documents removed from the list since are removed on the server. Returns the docs with
 * their server ids and page sizes.
 */
export async function createAndUpload(
  deps: SelfSignDeps,
  progress: SelfProgress,
  docs: readonly SelfDoc[],
  subject: string,
  onProgress: (p: SelfProgress, docs: readonly SelfDoc[]) => void = () => undefined,
): Promise<{ progress: SelfProgress; docs: SelfDoc[] }> {
  let p = progress;
  let out = [...docs];
  if (p.envelopeId === null) {
    const { id } = await deps.createSelf(subject);
    const v = await deps.api.detail(id);
    p = { ...p, envelopeId: id, etag: v.etag, signerId: v.env.recipients[0]?.id ?? null };
    onProgress(p, out);
  }
  const envelopeId = p.envelopeId as string;
  if (p.etag === null) {
    const v = await deps.api.detail(envelopeId);
    p = { ...p, etag: v.etag, signerId: p.signerId ?? v.env.recipients[0]?.id ?? null };
  }
  for (const d of out) {
    if (d.serverId !== null) continue;
    if (d.base64 === null) throw new Error('document bytes missing');
    const key = p.uploadKeys[d.key] ?? newIdempotencyKey();
    p = { ...p, uploadKeys: { ...p.uploadKeys, [d.key]: key } };
    const before = revisionOf(p.etag);
    const ifMatch = p.etag as string;
    const content = d.base64;
    const up = await uploadWithRetry(
      () =>
        deps.api.upload(envelopeId, ifMatch, {
          title: d.title,
          filename: d.filename,
          contentBase64: content,
          idempotencyKey: key,
        }),
      deps.sleep,
    );
    const v = await deps.api.detail(envelopeId);
    if (before !== null && v.env.revision !== null && v.env.revision !== before + 1)
      throw revisionMismatch(v.env.revision);
    const pages = up.pages.length > 0 ? up.pages : d.pages;
    out = out.map((x) => (x.key === d.key ? { ...x, serverId: up.id, pages, base64: x.base64 } : x));
    p = { ...p, etag: v.etag, signerId: p.signerId ?? v.env.recipients[0]?.id ?? null };
    onProgress(p, out);
  }
  return { progress: p, docs: out };
}

/** Remove an uploaded document from the self envelope (If-Match). */
export async function removeUploaded(
  deps: SelfSignDeps,
  progress: SelfProgress,
  documentId: string,
): Promise<SelfProgress> {
  if (!progress.envelopeId || !progress.etag) return progress;
  const v = await deps.api.removeDocument(progress.envelopeId, progress.etag, documentId);
  return { ...progress, etag: v.etag };
}

function revisionOf(etag: string | null): number | null {
  const m = /"[^".]+\.(\d+)"$/.exec(etag ?? '');
  return m ? Number(m[1]) : null;
}

/** The PUT …/fields body: every placed field assigned to the self recipient. */
export function selfFieldsWire(
  fields: readonly EditorField[],
  docs: readonly SelfDoc[],
  signerId: string,
): FieldWire[] {
  return fields.map((f) => {
    const d = docs.find((x) => x.key === f.docKey);
    const size = d?.pages?.[f.page];
    if (!d?.serverId || !size) throw new SelfSignMismatch();
    const b = editorToWire(f, size);
    return {
      envelope_document_id: d.serverId,
      signer_id: signerId,
      field_type: f.type,
      page_number: f.page,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      required: f.required,
      ...(f.type === 'SIGNER_NAME' ? { name_mode: f.nameMode ?? 'SIGNER_PROFILE' } : {}),
      ...(f.type === 'CHECKBOX'
        ? { label: f.label ?? null, group_key: null, group_rule: null, min_selected: null }
        : {}),
    };
  });
}

/**
 * Steps 3–5 (+ the exchange): place the fields, send (once), and open the SELF session.
 * Returns the open session and the disclosure the user must accept.
 */
export async function sendAndOpen(
  deps: SelfSignDeps,
  progress: SelfProgress,
  fields: readonly EditorField[],
  docs: readonly SelfDoc[],
  subject: string,
  onProgress: (p: SelfProgress) => void = () => undefined,
): Promise<{ progress: SelfProgress; session: GuestSigningSession; disclosure: Disclosure }> {
  let p = progress;
  const envelopeId = p.envelopeId;
  if (!envelopeId || !p.signerId) throw new Error('the envelope is not ready');
  if (!p.sent) {
    const placed = await deps.api.putFields(envelopeId, p.etag as string, selfFieldsWire(fields, docs, p.signerId));
    const sent = await deps.api.send(envelopeId, placed.etag, subject);
    p = { ...p, etag: sent.etag, sent: true };
    onProgress(p);
  }
  const issued = await deps.api.selfSignSession(envelopeId, p.signerId ?? undefined);
  const session = deps.openSession(issued.token);
  const disclosure = await openSigning(session);
  return { progress: p, session, disclosure };
}

export class SelfSignMismatch extends Error {
  constructor() {
    super('placed fields do not match the envelope');
    this.name = 'SelfSignMismatch';
  }
}

const FILL_PATH = '/v1/sign/signing/fields/{fieldId}/fill';

/**
 * Steps 6–8: accept the exact disclosure shown, fill every field with the value the
 * user saw while placing, then complete. Returns the envelope status.
 */
export async function acceptFillComplete(
  session: GuestSigningSession,
  disclosure: Disclosure,
  fields: readonly EditorField[],
  docs: readonly SelfDoc[],
  ctx: SelfContext,
  edits: SelfEdits,
  stored: ReadonlySet<string> = new Set(),
  onStored: (serverFieldId: string) => void = () => undefined,
): Promise<{ envelopeStatus: string; view: SignerView }> {
  const view = await acceptAndLoad(session, disclosure);
  const pairs = matchServerFields(view.fields, placedOnServer(fields, docs));
  if (pairs.some((x) => x.field === null && x.server.server_filled !== true))
    throw new SelfSignMismatch();
  for (const { server, field } of pairs) {
    if (!field || server.server_filled === true || stored.has(server.field_id)) continue;
    const v = fillValue(field, ctx, edits);
    if (v === null) continue;
    await session.postRaw(fillPath(FILL_PATH, { fieldId: server.field_id }) as `/v1/sign/signing/${string}`, {
      value: v.value,
      ...(v.method ? { signature_method: v.method } : {}),
    });
    onStored(server.field_id);
  }
  const r = await session.post('/v1/sign/signing/complete', {});
  return { envelopeStatus: r?.envelope_status ?? 'IN_PROGRESS', view };
}

/** Page sizes of picked bytes (null when the PDF can't be read here). */
export function pagesOf(base64: string): SelfDoc['pages'] {
  try {
    const p = readPdfPageSizes(base64Decode(base64));
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

export function isOfflineError(e: unknown): boolean {
  return isApiError(e) && e.isNetwork;
}
