// The Send flow's controller (handoff §4.6; directive §5, §9; M-A3 §6, §8). Framework-
// free so draft persistence, recovery, sync and conflict handling are unit-tested;
// useSendFlow.ts adapts it to React.
//
// Rules it keeps:
//   - Every change is saved to the encrypted DraftStore at once (survives a restart).
//   - Server writes happen only on Save as draft, on entering Review and on Send, and
//     always with If-Match (syncDraft.ts). A new envelope is never created silently.
//   - A 412 (revision_mismatch) reloads the envelope from the server, shows "This
//     envelope changed elsewhere", and never overwrites it.
//   - Send is an explicit user action, online only. Nothing is ever sent silently.
import { ApiError, isApiError } from '../../api/errors';
import { newIdempotencyKey } from '../../api/workspaceClient';
import type { DraftStore, SendStep } from '../../state/draftStore';
import { base64Decode, base64Encode } from '../../util/bytes';
import type { EditorField } from '../editor/editorReducer';
import type { PageSize } from '../editor/geometry';
import { readPdfPageSizes } from '../editor/pdfPageSizes';
import type { DocumentBytesStore } from './documentBytes';
import {
  MAX_RECIPIENTS,
  MESSAGE_MAX,
  SUBJECT_MAX,
  defaultSubject,
  effectiveSubject,
  emptyPayload,
  furthestStep,
  isDirty,
  payloadFromServer,
  type CopyDelivery,
  type DirtyFlags,
  type DraftRecipient,
  type RecipientKind,
  type RoutingMode,
  type SendDraft,
  type SendDraftPayload,
  type ServerEnvelope,
} from './draftModel';
import {
  changeKind,
  checkAdd,
  ROLE_COPY,
  signingRecipients,
  validEmail,
  type AddCheck,
} from './recipientRoles';
import { isRevisionMismatch, type SenderApi, type Versioned } from './senderApi';
import { syncDraft, SendFlowError } from './syncDraft';

export const CHANGED_ELSEWHERE = 'This envelope changed elsewhere. Showing the latest version.';

export interface SendFlowDeps {
  readonly drafts: DraftStore;
  readonly bytes: DocumentBytesStore;
  readonly api: SenderApi;
  /** The frozen source PDF of an uploaded document. */
  readonly fetchSource: (envelopeId: string, documentId: string) => Promise<Uint8Array>;
  readonly isOnline: () => boolean;
  readonly newId: () => string;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SendFlowState {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly draft: SendDraft | null;
  readonly step: SendStep;
  readonly busy: null | 'syncing' | 'sending' | 'adding';
  /** Shown after a 412: the server copy replaced the local one. */
  readonly notice: string | null;
  /** A user-facing error for the last action. */
  readonly error: string | null;
  /** The backend's refusal of the last send (rendered by reason in Review). */
  readonly refusal: ApiError | null;
  /** The envelope as last read from the server. */
  readonly server: ServerEnvelope | null;
  /** Raised whenever the server copy replaced the local one (editors re-initialise). */
  readonly generation: number;
}

export interface OpenParams {
  readonly localDraftId?: string | undefined;
  readonly envelopeId?: string | undefined;
  readonly step?: SendStep | undefined;
  /** 'self' = "Sign a document" (M-A4 §6.3): a new draft remembers it for after Send. */
  readonly intent?: 'request' | 'self' | undefined;
}

/** The outcome of adding a recipient. */
export type AddOutcome = 'added' | Exclude<AddCheck, 'ok'> | 'invalid';

/** A successful Send. */
export interface SentEnvelope {
  readonly envelopeId: string;
  /** Signing recipients (copy recipients never sign). */
  readonly signers: number;
  /** The server id of the signing recipient assigned to the user, if any. */
  readonly assignedSignerId: string | null;
}

export interface DocumentAsset {
  readonly base64: string;
  readonly pages: readonly PageSize[];
}

type Listener = (s: SendFlowState) => void;

function messageFor(e: unknown): string {
  if (e instanceof SendFlowError) {
    if (e.reason === 'document_bytes_missing')
      return 'A document is no longer on this phone. Remove it and add it again.';
    if (e.reason === 'pages_unknown')
      return 'A document couldn’t be read. Remove it and add it again.';
    return 'The recipients changed while saving. Check them and try again.';
  }
  if (isApiError(e)) {
    if (e.isNetwork) return 'You’re offline. Your changes are saved on this phone.';
    if (e.reason === 'unsupported_file_type')
      return 'Word files can’t be sent. Save the document as a PDF, then choose the PDF.';
    if (e.reason === 'unsafe_pdf') return 'This PDF can’t be used. Try another file.';
    if (e.reason === 'too_many_signers')
      return `An envelope can have at most ${MAX_RECIPIENTS} signers.`;
    const role = (ROLE_COPY as Record<string, string>)[e.reason];
    if (role) return role;
    if (e.reason === 'message_too_long')
      return `The message can be at most ${MESSAGE_MAX} characters.`;
    if (e.reason === 'session_expired') return 'Your session ended. Sign in again.';
    if (e.code === 'ENVELOPE_ILLEGAL_TRANSITION') return 'This envelope was already sent.';
  }
  return 'Something went wrong. Try again.';
}

export class SendFlowController {
  private state: SendFlowState = {
    status: 'loading',
    draft: null,
    step: 'documents',
    busy: null,
    notice: null,
    error: null,
    refusal: null,
    server: null,
    generation: 0,
  };
  private readonly listeners = new Set<Listener>();
  private persistChain: Promise<void> = Promise.resolve();
  /** Decoded documents for rendering (memory only). */
  private readonly assets = new Map<string, DocumentAsset>();

  constructor(private readonly deps: SendFlowDeps) {}

  // ── state plumbing ──────────────────────────────────────────────────────────

  get snapshot(): SendFlowState {
    return this.state;
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<SendFlowState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  /** Persist (serialized: the last write always wins on disk). */
  private persist(draft: SendDraft): Promise<void> {
    this.persistChain = this.persistChain.then(
      () => this.deps.drafts.save(draft),
      () => this.deps.drafts.save(draft),
    );
    return this.persistChain;
  }

  /** Wait for pending disk writes (tests, and before leaving the flow). */
  flush(): Promise<void> {
    return this.persistChain;
  }

  private get payload(): SendDraftPayload {
    const d = this.state.draft;
    if (!d) throw new Error('the draft is not open');
    return d.payload;
  }

  /** Apply a local change: state + encrypted disk at once. */
  update(fn: (p: SendDraftPayload) => SendDraftPayload, dirty: Partial<DirtyFlags> = {}): void {
    const d = this.state.draft;
    if (!d) return;
    const next = fn(d.payload);
    // The stored subject follows the generated default until the sender edits it, so
    // lists that read the local draft show a meaningful title.
    const payload: SendDraftPayload = {
      ...next,
      subject: next.subjectEdited ? next.subject : defaultSubject(next),
      dirty: { ...next.dirty, ...dirty },
    };
    const draft: SendDraft = { ...d, payload, step: this.state.step, updatedAt: this.now() };
    this.set({ draft, error: null, refusal: null });
    void this.persist(draft);
  }

  setStep(step: SendStep): void {
    const d = this.state.draft;
    this.set({ step, error: null });
    if (d) void this.persist({ ...d, step });
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // ── open ────────────────────────────────────────────────────────────────────

  async open(params: OpenParams = {}): Promise<void> {
    try {
      if (params.localDraftId) {
        const local = await this.deps.drafts.load<SendDraftPayload>(params.localDraftId);
        if (local) return this.openLocal(local, params.step);
      }
      if (params.envelopeId) {
        const all = await this.deps.drafts.list();
        const local = all.find((x) => x.envelopeId === params.envelopeId) as SendDraft | undefined;
        if (local && (isDirty(local.payload) || !this.deps.isOnline())) {
          return this.openLocal(local, params.step);
        }
        if (!this.deps.isOnline()) {
          this.set({ status: 'failed', error: 'Connect to the internet to edit this draft.' });
          return;
        }
        const v = await this.deps.api.detail(params.envelopeId);
        if (!v.env.editable) {
          this.set({ status: 'failed', error: 'This envelope can’t be edited any more.' });
          return;
        }
        const draft = await this.draftFromServer(v, local?.localId ?? this.deps.newId());
        await this.persist(draft);
        this.set({
          status: 'ready',
          draft,
          step: params.step ?? furthestStep(draft.payload),
          server: v.env,
        });
        return;
      }
      const draft: SendDraft = {
        localId: this.deps.newId(),
        envelopeId: null,
        baseRevision: null,
        step: 'documents',
        updatedAt: this.now(),
        payload: params.intent === 'self' ? { ...emptyPayload(), selfSign: true } : emptyPayload(),
      };
      // Nothing is written to disk until the sender adds something.
      this.set({ status: 'ready', draft, step: 'documents' });
    } catch (e) {
      this.set({ status: 'failed', error: messageFor(e) });
    }
  }

  private openLocal(local: SendDraft, step: SendStep | undefined): void {
    this.set({
      status: 'ready',
      draft: local,
      step: step ?? (local.step || furthestStep(local.payload)),
    });
  }

  /** The local payload for a server envelope, reading page sizes from the sources. */
  private async draftFromServer(v: Versioned, localId: string): Promise<SendDraft> {
    const known = new Map<string, readonly PageSize[]>();
    const prev = this.state.draft?.payload.documents ?? [];
    for (const d of v.env.documents) {
      const had = prev.find((x) => x.serverId === d.id)?.pages;
      if (had) known.set(d.id, had);
      else {
        const asset = await this.loadServerAsset(v.env.id, d.id).catch(() => null);
        if (asset) known.set(d.id, asset.pages);
      }
    }
    const { payload } = payloadFromServer(v.env, v.etag, known);
    return {
      localId,
      envelopeId: v.env.id,
      baseRevision: v.env.revision,
      step: furthestStep(payload),
      updatedAt: this.now(),
      payload,
    };
  }

  private async loadServerAsset(envelopeId: string, documentId: string): Promise<DocumentAsset> {
    const cached = this.assets.get(documentId);
    if (cached) return cached;
    const bytes = await this.deps.fetchSource(envelopeId, documentId);
    const asset = { base64: base64Encode(bytes), pages: readPdfPageSizes(bytes) };
    this.assets.set(documentId, asset);
    return asset;
  }

  /** Rendering input for a draft document (memory cache, encrypted store, or the server). */
  async documentAsset(docKey: string): Promise<DocumentAsset> {
    const cached = this.assets.get(docKey);
    if (cached) return cached;
    const p = this.payload;
    const doc = p.documents.find((d) => d.key === docKey);
    if (!doc) throw new Error('unknown document');
    let base64: string | null = null;
    if (doc.pendingUpload !== null) base64 = await this.deps.bytes.get(docKey);
    if (base64 === null && doc.serverId && this.state.draft?.envelopeId) {
      const a = await this.loadServerAsset(this.state.draft.envelopeId, doc.serverId);
      base64 = a.base64;
    }
    if (base64 === null) throw new SendFlowError('document_bytes_missing');
    const pages = doc.pages ?? readPdfPageSizes(base64Decode(base64));
    if (!doc.pages) {
      this.update((q) => ({
        ...q,
        documents: q.documents.map((x) => (x.key === docKey ? { ...x, pages } : x)),
      }));
    }
    const asset = { base64, pages };
    this.assets.set(docKey, asset);
    return asset;
  }

  // ── step 1: documents ───────────────────────────────────────────────────────

  /**
   * Add a PDF (picked or scanned). The bytes go to the encrypted store under a fresh
   * Idempotency-Key that every later upload attempt reuses.
   */
  async addDocument(input: {
    readonly title: string;
    readonly filename: string;
    readonly bytes: Uint8Array;
    readonly pages?: readonly PageSize[];
  }): Promise<void> {
    this.set({ busy: 'adding', error: null });
    try {
      let pages: readonly PageSize[] | null = input.pages ?? null;
      if (!pages) {
        try {
          pages = readPdfPageSizes(input.bytes);
        } catch {
          pages = null; // the upload response reports them
        }
      }
      const key = this.deps.newId();
      const base64 = base64Encode(input.bytes);
      await this.deps.bytes.put(key, base64);
      if (pages) this.assets.set(key, { base64, pages });
      this.update((p) => ({
        ...p,
        documents: [
          ...p.documents,
          {
            key,
            serverId: null,
            title: input.title.slice(0, SUBJECT_MAX),
            filename: input.filename,
            pages,
            pendingUpload: { idempotencyKey: newIdempotencyKey() },
          },
        ],
      }));
    } catch (e) {
      this.set({ error: messageFor(e) });
    } finally {
      this.set({ busy: null });
    }
  }

  /** Remove a document and its fields. An uploaded one is removed on the server (If-Match). */
  async removeDocument(docKey: string): Promise<void> {
    const p = this.payload;
    const doc = p.documents.find((d) => d.key === docKey);
    if (!doc) return;
    const drop = (q: SendDraftPayload): SendDraftPayload => ({
      ...q,
      documents: q.documents.filter((d) => d.key !== docKey),
      fields: q.fields.filter((f) => f.docKey !== docKey),
    });
    if (doc.serverId === null || doc.pendingUpload !== null) {
      await this.deps.bytes.remove(docKey).catch(() => undefined);
      this.assets.delete(docKey);
      this.update(drop, p.fields.some((f) => f.docKey === docKey) ? { fields: true } : {});
      return;
    }
    if (!this.deps.isOnline()) {
      this.set({ error: 'Connect to the internet to remove an uploaded document.' });
      return;
    }
    const envelopeId = this.state.draft!.envelopeId!;
    try {
      const v = await this.deps.api.removeDocument(envelopeId, p.etag!, doc.serverId);
      this.assets.delete(docKey);
      this.update((q) => ({ ...drop(q), etag: v.etag }));
      this.set({ server: v.env });
    } catch (e) {
      if (isRevisionMismatch(e)) await this.reloadAfterConflict();
      else this.set({ error: messageFor(e) });
    }
  }

  /** A draft created from a template (templates.ts) becomes this flow's envelope. */
  async adoptTemplateEnvelope(v: Versioned): Promise<void> {
    const d = this.state.draft;
    if (!d || d.envelopeId !== null || d.payload.documents.length > 0) return;
    const draft = await this.draftFromServer(v, d.localId);
    await this.persist(draft);
    this.set({ draft, server: v.env, step: 'recipients', generation: this.state.generation + 1 });
  }

  // ── step 2: recipients ──────────────────────────────────────────────────────

  /**
   * Add a recipient (a signer unless `kind` says otherwise). The same checks every
   * recipient goes through: limits per kind, distinct emails, email unless in person.
   */
  addRecipient(
    input: { readonly name: string; readonly email: string },
    kind: RecipientKind = 'SIGNER',
    opts: { readonly assignToMe?: boolean } = {},
  ): AddOutcome {
    const p = this.payload;
    const email = input.email.trim();
    const name = input.name.trim();
    if (email.length > 0 ? !validEmail(email) : name.length === 0) return 'invalid';
    const check = checkAdd(p.recipients, kind, email);
    if (check !== 'ok') return check;
    const r: DraftRecipient = {
      key: this.deps.newId(),
      serverId: null,
      name: name || email,
      email,
      kind,
      copyDelivery: kind === 'RECEIVES_COPY' ? 'ON_COMPLETION' : null,
      ...(opts.assignToMe && kind === 'SIGNER' ? { assignToMe: true } : {}),
    };
    this.update((q) => ({ ...q, recipients: [...q.recipients, r] }), { recipients: true });
    return 'added';
  }

  /**
   * Signs · In person · Copy (M-A5 §1). Returns the refusal copy, or null when changed.
   * Moving to Copy removes the recipient's fields (a copy recipient has none).
   */
  setRecipientKind(key: string, kind: RecipientKind): string | null {
    const p = this.payload;
    const out = changeKind(p.recipients, key, kind);
    if (!out.ok) return ROLE_COPY[out.reason];
    if (out.recipients.every((r, i) => r === p.recipients[i])) return null;
    this.update(
      (q) => ({
        ...q,
        recipients: out.recipients,
        fields: out.dropsFields ? q.fields.filter((f) => f.recipientKey !== key) : q.fields,
      }),
      { recipients: true, ...(out.dropsFields ? { fields: true } : {}) },
    );
    return null;
  }

  /** When a copy recipient receives their copy (M-A5 §2.1). */
  setCopyDelivery(key: string, delivery: CopyDelivery): void {
    this.update(
      (q) => ({
        ...q,
        recipients: q.recipients.map((r) =>
          r.key === key && r.kind === 'RECEIVES_COPY' ? { ...r, copyDelivery: delivery } : r,
        ),
      }),
      { recipients: true },
    );
  }

  /** Remove a recipient and their fields (handoff §4.6). */
  removeRecipient(key: string): void {
    this.update(
      (q) => ({
        ...q,
        recipients: q.recipients.filter((r) => r.key !== key),
        fields: q.fields.filter((f) => f.recipientKey !== key),
      }),
      { recipients: true, fields: true },
    );
  }

  /**
   * Reorder for SEQUENTIAL routing (list position is the signing order). Moves among the
   * signing recipients only: copy recipients never take part in the order (M-A5 §1.6).
   */
  moveRecipient(key: string, delta: -1 | 1): void {
    this.update(
      (q) => {
        const signing = signingRecipients(q.recipients);
        const i = signing.findIndex((r) => r.key === key);
        const other = signing[i + delta];
        if (i < 0 || !other) return q;
        const a = q.recipients.findIndex((r) => r.key === key);
        const b = q.recipients.findIndex((r) => r.key === other.key);
        const next = [...q.recipients];
        [next[a], next[b]] = [next[b]!, next[a]!];
        return { ...q, recipients: next };
      },
      { recipients: true },
    );
  }

  setRouting(mode: RoutingMode): void {
    this.update((q) => ({ ...q, routingMode: mode }), { meta: true });
  }

  // ── step 3 / 4 ──────────────────────────────────────────────────────────────

  setFields(fields: readonly EditorField[]): void {
    this.update((q) => ({ ...q, fields }), { fields: true });
  }

  setSubject(subject: string): void {
    this.update((q) => ({ ...q, subject: subject.slice(0, SUBJECT_MAX), subjectEdited: true }), {
      meta: true,
    });
  }

  /** Plain text, at most 1000 characters (M-A3 §3); the server sanitizes again. */
  setMessage(message: string): void {
    this.update((q) => ({ ...q, message: message.slice(0, MESSAGE_MAX) }), { meta: true });
  }

  // ── server ──────────────────────────────────────────────────────────────────

  /** Push local changes (Save as draft, Review, before Send). True when in sync. */
  async sync(): Promise<boolean> {
    const d = this.state.draft;
    if (!d) return false;
    if (!this.deps.isOnline()) {
      this.set({ error: null });
      return false;
    }
    if (d.envelopeId !== null && !isDirty(d.payload)) {
      return this.refreshIfChanged();
    }
    this.set({ busy: 'syncing', error: null });
    try {
      const { draft, server } = await syncDraft(
        {
          api: this.deps.api,
          bytes: this.deps.bytes,
          // Keep the in-memory draft in step with every saved stage, not only the
          // store: a sync that fails part-way (after the envelope was created) must
          // leave the envelope id and its ETag here, so a retry continues that same
          // envelope instead of creating another one.
          onProgress: (x) => {
            this.set({ draft: x });
            return this.persist(x);
          },
          ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
          ...(this.deps.now ? { now: this.deps.now } : {}),
        },
        { ...d, step: this.state.step },
      );
      this.set({ draft, ...(server ? { server } : {}) });
      return true;
    } catch (e) {
      if (isRevisionMismatch(e)) {
        await this.reloadAfterConflict();
        return false;
      }
      this.set({ error: messageFor(e) });
      return false;
    } finally {
      this.set({ busy: null });
    }
  }

  /** In sync locally: read the envelope; a newer revision means it changed elsewhere. */
  private async refreshIfChanged(): Promise<boolean> {
    const d = this.state.draft!;
    try {
      const v = await this.deps.api.detail(d.envelopeId!);
      if (v.etag !== d.payload.etag) {
        await this.adoptServer(v);
        return false;
      }
      this.set({ server: v.env });
      return true;
    } catch (e) {
      this.set({ error: messageFor(e) });
      return false;
    }
  }

  /** 412: read the current envelope and show it. Local edits are not resubmitted. */
  private async reloadAfterConflict(): Promise<void> {
    const d = this.state.draft;
    if (!d?.envelopeId) return;
    try {
      await this.adoptServer(await this.deps.api.detail(d.envelopeId));
    } catch (e) {
      this.set({ error: messageFor(e) });
    }
  }

  private async adoptServer(v: Versioned): Promise<void> {
    const d = this.state.draft!;
    // Pending local uploads stay pending (their bytes are still on the device), so a
    // document added offline is not lost; everything else follows the server.
    const pendingDocs = d.payload.documents.filter((x) => x.pendingUpload !== null);
    const fresh = await this.draftFromServer(v, d.localId);
    const draft: SendDraft = {
      ...fresh,
      step: this.state.step,
      payload: { ...fresh.payload, documents: [...fresh.payload.documents, ...pendingDocs] },
    };
    await this.persist(draft);
    this.set({
      draft,
      server: v.env,
      generation: this.state.generation + 1,
      notice: CHANGED_ELSEWHERE,
      ...(v.env.editable ? {} : { error: 'This envelope can’t be edited any more.' }),
    });
  }

  /**
   * Send for signature (handoff §4.6): sync, then POST …/send with If-Match. Returns the
   * envelope id and signer count on success; a refusal is kept for Review.
   */
  async send(): Promise<SentEnvelope | null> {
    if (!this.deps.isOnline()) {
      this.set({ error: 'You’re offline. Connect to send.' });
      return null;
    }
    const synced = await this.sync();
    const d = this.state.draft;
    if (!synced || !d?.envelopeId || !d.payload.etag) return null;
    this.set({ busy: 'sending', refusal: null, error: null });
    try {
      const v = await this.deps.api.send(d.envelopeId, d.payload.etag, effectiveSubject(d.payload));
      await this.flush();
      await this.deps.drafts.remove(d.localId);
      this.set({ server: v.env });
      const signing = signingRecipients(v.env.recipients);
      return {
        envelopeId: v.env.id,
        signers: signing.length,
        assignedSignerId: signing.find((r) => r.assignedToMe)?.id ?? null,
      };
    } catch (e) {
      if (isRevisionMismatch(e)) {
        await this.reloadAfterConflict();
        return null;
      }
      if (isApiError(e) && !e.isNetwork) this.set({ refusal: e });
      else this.set({ error: messageFor(e) });
      return null;
    } finally {
      this.set({ busy: null });
    }
  }

  /** Save as draft: kept on the device, and on the server when online. */
  async saveDraft(): Promise<'synced' | 'local'> {
    const d = this.state.draft;
    if (!d) return 'local';
    await this.persist({ ...d, step: this.state.step, updatedAt: this.now() });
    const ok = await this.sync();
    await this.flush();
    return ok ? 'synced' : 'local';
  }

  /** Discard: forget the local draft and its waiting files. A server draft stays in Drafts. */
  async discard(): Promise<void> {
    const d = this.state.draft;
    if (!d) return;
    await this.flush();
    for (const doc of d.payload.documents) {
      if (doc.pendingUpload !== null) await this.deps.bytes.remove(doc.key).catch(() => undefined);
    }
    await this.deps.drafts.remove(d.localId);
    this.assets.clear();
  }

  /** True when the envelope already exists on the server. */
  get hasServerEnvelope(): boolean {
    return Boolean(this.state.draft?.envelopeId);
  }
}
