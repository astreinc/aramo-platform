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
import { editorToWire, wireToEditor } from '../editor/geometry';
import { isSelfSignFieldType } from '../editor/fieldTypes';
import { configOf, parseEnvelope, type ServerField } from '../send/draftModel';
import { etagFor } from '../../api/workspaceClient';
import { refusalMessage } from '../../api/refusalMessages';
import { randomId } from '../../util/ids';
import { readPdfPageSizes } from '../editor/pdfPageSizes';
import { revisionMismatch, type FieldWire, type SenderApi } from '../send/senderApi';
import { configWire, preservedFieldWire, storedFieldWire, uploadWithRetry } from '../send/syncDraft';
import { base64Decode, base64Encode } from '../../util/bytes';
import {
  acceptAndLoad,
  openSigning,
  type Disclosure,
  type SignerView,
} from '../signing/signingApi';
import type { SigningField } from '../signing/signingMachine';
import {
  fillValue,
  matchServerFields,
  placedOnServer,
  SELF_KEY,
  type SelfContext,
  type SelfDoc,
  type SelfEdits,
} from './selfSignModel';
import { fillPath } from '../../api/types';
import { timeZoneBody } from '../signing/signDate';

export interface SelfSignDeps {
  readonly api: Pick<SenderApi, 'detail' | 'upload' | 'removeDocument' | 'putFields' | 'send' | 'selfSignSession'>;
  /** POST /v1/sign/sender/envelopes with `mode: "self"`. */
  readonly createSelf: (subject: string) => Promise<{ id: string }>;
  /** Opens the capability-token transport on a SELF session token. */
  readonly openSession: (token: string) => GuestSigningSession;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * M-A13 R-4 — the server's PDF of an uploaded document (GET …/source). A Word file is
   * converted on upload, so its PDF is read back to place fields on.
   */
  readonly fetchSource?: (envelopeId: string, documentId: string) => Promise<Uint8Array>;
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
  /**
   * FIELD-PARITY-2 A-1 — the fields a template start carried (absent for picked documents):
   * the fields-PUT sends them back so none is lost.
   */
  readonly template?: SelfTemplateFields;
}

/**
 * FIELD-PARITY-2 A-1 (fail-closed) — a template's fields on the self envelope. The fields PUT
 * replaces the whole list, so every template field goes back: a placed field the user has not
 * changed goes back exactly as stored (byte-equal), and a field the editor cannot place goes
 * back untouched with its id (the Send flow's preserved fields).
 */
export interface SelfTemplateFields {
  /** By placed-field key: the field as placed from the template, and its stored members. */
  readonly untouched: Readonly<Record<string, { readonly placed: EditorField; readonly wire: FieldWire }>>;
  /** Stored fields the editor does not place, sent back unchanged. */
  readonly preserved: readonly ServerField[];
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
    // M-A13 R-4 — a Word upload became a PDF on the server: place fields on that PDF.
    const base64 =
      isWordUpload(d.filename) && deps.fetchSource
        ? base64Encode(await deps.fetchSource(envelopeId, up.id))
        : d.base64;
    out = out.map((x) => (x.key === d.key ? { ...x, serverId: up.id, pages, base64 } : x));
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

function isWordUpload(filename: string): boolean {
  return /\.(docx|doc)$/i.test(filename.trim());
}

function revisionOf(etag: string | null): number | null {
  const m = /"[^".]+\.(\d+)"$/.exec(etag ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * The PUT …/fields body: every placed field assigned to the self recipient, with every setting
 * it carries (the Send flow's configWire), then the template's fields the editor does not place
 * (FIELD-PARITY-2 A-1: the replace-all PUT never loses one). A template field the user did not
 * change goes back exactly as stored.
 */
export function selfFieldsWire(
  fields: readonly EditorField[],
  docs: readonly SelfDoc[],
  signerId: string,
  template?: SelfTemplateFields,
): FieldWire[] {
  const placed = fields.map((f): FieldWire => {
    const d = docs.find((x) => x.key === f.docKey);
    const size = d?.pages?.[f.page];
    if (!d?.serverId || !size) throw new SelfSignMismatch();
    const kept = template?.untouched[f.key];
    if (kept && sameField(kept.placed, f)) return kept.wire;
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
      ...configWire(f),
    };
  });
  const onEnvelope = new Set(docs.map((d) => d.serverId).filter((x): x is string => !!x));
  const preserved = (template?.preserved ?? [])
    .filter((f) => onEnvelope.has(f.envelope_document_id))
    .map(preservedFieldWire);
  return [...placed, ...preserved];
}

/** The placed field is still exactly as the template placed it. */
function sameField(a: EditorField, b: EditorField): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
    const placed = await deps.api.putFields(
      envelopeId,
      p.etag as string,
      selfFieldsWire(fields, docs, p.signerId, p.template),
    );
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

/** A server field that is one of the carried template fields (same place and type); it is used up. */
function takeCarried(pool: ServerField[], s: SigningField): boolean {
  const i = pool.findIndex(
    (p) =>
      p.envelope_document_id === s.document_id &&
      p.page_number === s.page_number &&
      p.field_type === s.field_type &&
      Math.abs(p.x - s.x) < 0.01 &&
      Math.abs(p.y - s.y) < 0.01,
  );
  if (i < 0) return false;
  pool.splice(i, 1);
  return true;
}

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
  template?: SelfTemplateFields,
): Promise<{ envelopeStatus: string; view: SignerView }> {
  const view = await acceptAndLoad(session, disclosure);
  // FIELD-PARITY-2 A-1 — a carried template field the editor does not place stays unfilled here
  // (the server's completion rule decides); any other unmatched field is a mismatch.
  const carried = (template?.preserved ?? []).filter((f) => docs.some((d) => d.serverId === f.envelope_document_id));
  const pairs = matchServerFields(view.fields, placedOnServer(fields, docs));
  const isCarried = (s: SigningField) => takeCarried(carried, s);
  if (pairs.some((x) => x.field === null && x.server.server_filled !== true && !isCarried(x.server)))
    throw new SelfSignMismatch();
  for (const { server, field } of pairs) {
    if (!field || server.server_filled === true || stored.has(server.field_id)) continue;
    const v = fillValue(field, ctx, edits);
    if (v === null) continue;
    await session.postRaw(fillPath(FILL_PATH, { fieldId: server.field_id }) as `/v1/sign/signing/${string}`, {
      value: v.value,
      ...(v.method ? { signature_method: v.method } : {}),
      // C0-2 — the server stamps SIGN_DATE in the device's time zone.
      ...timeZoneBody(),
    });
    onStored(server.field_id);
  }
  const r = await session.post('/v1/sign/signing/complete', timeZoneBody());
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

// ── Templates as a source (M-A12 W1-A; agent A's from-template `mode: "self"`) ─────

/**
 * POST /v1/sign/sender/envelopes/from-template { template_id, values, idempotency_key,
 * mode: "self" }. No signer, recipients, cc or routing_mode is sent: the server binds the
 * template's one signer role to the caller (422 self_sign_single_recipient otherwise).
 */
export function createSelfFromTemplate(workspace: WorkspaceClient) {
  return async (input: {
    readonly templateId: string;
    readonly values: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
  }) => {
    const r = await workspace.request<unknown>({
      method: 'POST',
      path: '/v1/sign/sender/envelopes/from-template',
      body: {
        template_id: input.templateId,
        values: { ...input.values },
        idempotency_key: input.idempotencyKey,
        mode: 'self',
      },
    });
    const raw = (r.data ?? {}) as Record<string, unknown>;
    const env = parseEnvelope(raw['envelope'] ?? raw);
    if (!env.id || env.revision === null) throw new Error('the server returned no envelope');
    return { env, etag: r.etag ?? etagFor({ id: env.id, revision: env.revision }) };
  };
}

export interface TemplateStartDeps {
  readonly createFromTemplate: ReturnType<typeof createSelfFromTemplate>;
  /** The frozen source PDF of a document on the envelope. */
  readonly fetchSource: (envelopeId: string, documentId: string) => Promise<Uint8Array>;
}

/**
 * Start "Sign a document" from a template: the server creates the self envelope with the
 * template's documents and fields; the app loads each document and turns the template's
 * fields into placed fields for the self recipient, ready to fill.
 */
export async function startFromTemplate(
  deps: TemplateStartDeps,
  input: { readonly templateId: string; readonly values: Readonly<Record<string, string>>; readonly idempotencyKey: string },
): Promise<{ progress: SelfProgress; docs: SelfDoc[]; fields: EditorField[] }> {
  const v = await deps.createFromTemplate(input);
  const docs: SelfDoc[] = [];
  for (const d of v.env.documents) {
    const bytes = await deps.fetchSource(v.env.id, d.id);
    const base64 = base64Encode(bytes);
    docs.push({ key: randomId(), title: d.title, filename: `${d.title}.pdf`, base64, pages: pagesOf(base64), serverId: d.id });
  }
  const fields: EditorField[] = [];
  const untouched: Record<string, { placed: EditorField; wire: FieldWire }> = {};
  const preserved: ServerField[] = [];
  for (const f of v.env.fields) {
    // FIELD-PARITY-2 A-1 (fail-closed) — no template field is ever dropped. One this screen
    // places becomes a placed field with every setting; any other (a type it does not place, a
    // field with no recipient or size, a page it cannot read) goes back unchanged on the PUT.
    const doc = docs.find((x) => x.serverId === f.envelope_document_id);
    const page = doc?.pages?.[f.page_number];
    if (!doc || !page || !isSelfSignFieldType(f.field_type) || f.signer_id === null || f.width === null || f.height === null) {
      preserved.push(f);
      continue;
    }
    const box = wireToEditor({ x: f.x, y: f.y, width: f.width, height: f.height }, page);
    const placed: EditorField = {
      key: randomId(),
      docKey: doc.key,
      page: f.page_number,
      recipientKey: SELF_KEY,
      type: f.field_type,
      ...box,
      required: f.required,
      ...configOf(f),
    };
    fields.push(placed);
    untouched[placed.key] = { placed, wire: storedFieldWire(f) };
  }
  const signerId = v.env.recipients[0]?.id ?? null;
  return {
    progress: {
      ...NO_PROGRESS,
      envelopeId: v.env.id,
      etag: v.etag,
      signerId,
      template: { untouched, preserved },
    },
    docs,
    fields,
  };
}
const SELF_REFUSAL: Record<string, string> = {
  self_sign_email_unverified: 'Verify your account email to sign documents here.',
  self_sign_single_recipient: 'This template needs more than one signer, so it can’t be signed by you alone.',
};

/**
 * M-A12 D-1 — the app never blocks "Sign a document" itself; when the server refuses,
 * this is the copy (network problems keep the given fallback).
 */
export function selfSignRefusalCopy(e: unknown, fallback: string): string {
  if (!isApiError(e) || e.isNetwork) return fallback;
  return SELF_REFUSAL[e.reason] ?? SELF_REFUSAL[e.code] ?? (e.status >= 500 ? fallback : refusalMessage(e));
}

