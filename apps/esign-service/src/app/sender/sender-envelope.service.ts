import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, IdentityRepository } from '@aramo/identity';
import {
  DOCUMENT_SOURCE_PROVIDER_PORT,
  DOCUMENT_STORAGE_PORT,
  type DocumentSourceProviderPort,
  type DocumentStoragePort,
  type EnvelopeDocumentSourceMode,
  EsignSenderRepository,
  SIGNING_SESSION_TTL_MS,
} from '@aramo/esign';
import { SafePdfPipeline, UnsafePdfError } from '@aramo/documents-rendering';
import { PDFDocument } from 'pdf-lib';

import { AramoSignStorageGate } from '../billing/aramo-sign-storage.gate.js';
import { NativeAramoSignatureProvider } from '../native-aramo-signature.provider.js';

import { SenderContextService } from './sender-context.service.js';

// PX-1 — the authenticated sender workspace (esign.aramo.ai). tenant_id and the
// acting user come ONLY from the verified auth context. Authoring writes are
// DRAFT-only (EsignSenderRepository locks + asserts DRAFT); lifecycle transitions
// reuse the native provider (EsignService under the hood) so the ledger, session
// mint and signer notifications are exactly the ones the ATS path uses.
//
// Field geometry is PDF-native, exactly the frame the execution stamper draws in:
// page_number is 0-based (pages[page_number]); x / y / width / height are points
// with the origin at the page's BOTTOM-LEFT corner and (x, y) the field box's
// lower-left corner. The sender UI converts from its top-left canvas frame.

// PX-V1 §1 / §15 — V1 scope: ONE signer per envelope, and field types limited to
// signature, date, initials and text. Multi-signer / signing order and the other
// engine field types (SIGNER_NAME, CHECKBOX, ACKNOWLEDGEMENT) are explicitly OUT
// of V1; enabling them needs a directive amendment, not a UI switch.
export const FIELD_TYPES = ['SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT'] as const;
const FIELD_TYPE_SET = new Set<string>(FIELD_TYPES);
export const MAX_SIGNERS_V1 = 1;
const TERMINAL = new Set(['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']);
const MAX_FIELDS = 500;
const MAX_TITLE = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ENVELOPE_TABS: Record<string, readonly string[] | undefined> = {
  all: undefined,
  drafts: ['DRAFT'],
  waiting: ['SENT', 'IN_PROGRESS'],
  completed: ['COMPLETED'],
  declined: ['DECLINED'],
  voided: ['VOIDED'],
  expired: ['EXPIRED'],
};

function bad(requestId: string, message: string, details?: Record<string, unknown>): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, ...(details !== undefined ? { details } : {}) });
}

function iso(d: Date | null | undefined): string | null {
  return d === null || d === undefined ? null : d.toISOString();
}

export interface UploadDocumentBody {
  title?: unknown;
  filename?: unknown;
  content_base64?: unknown;
}

@Injectable()
export class SenderEnvelopeService {
  private readonly safePdf = new SafePdfPipeline();

  constructor(
    private readonly repo: EsignSenderRepository,
    private readonly provider: NativeAramoSignatureProvider,
    private readonly context: SenderContextService,
    private readonly identity: IdentityRepository,
    @Inject(DOCUMENT_STORAGE_PORT) private readonly storage: DocumentStoragePort,
    @Inject(DOCUMENT_SOURCE_PROVIDER_PORT) private readonly sources: DocumentSourceProviderPort,
    // A1 — the plan's storage allocation.
    private readonly storageGate: AramoSignStorageGate,
  ) {}

  // Sign Unified Product S-1 (directive §4.3.5) — visibility. A member reads the
  // envelopes they own; the whole organization only with esign:envelope:read:all
  // (Sign Viewer / Admin / Owner) in a BUSINESS tenant. A PERSONAL account always
  // reads its own. Returns the owner filter (undefined = the whole tenant).
  private async ownerFilter(auth: AuthContextType, requestId: string): Promise<string | undefined> {
    const kind = await this.context.tenantKind(auth.tenant_id, requestId);
    return kind === 'BUSINESS' && auth.scopes.includes(ESIGN_SCOPE.ENVELOPE_READ_ALL) ? undefined : auth.sub;
  }

  // Sign Unified Product S-1 (directive §4.3.5) — ownership. Every draft change
  // and lifecycle action (send, remind, void) is checked against the envelope's
  // actual owner: the owner may act; anyone else needs esign:envelope:manage:all
  // (Sign Admin / Owner). An ordinary sender never changes another member's
  // envelope merely because they share a Business tenant. Visibility first: an
  // envelope the caller cannot see reads as not found.
  private async assertMayChange(auth: AuthContextType, envelope_id: string, requestId: string): Promise<void> {
    const d = await this.detail(auth, envelope_id, requestId);
    if (d.sender.id === auth.sub) return;
    if (auth.scopes.includes(ESIGN_SCOPE.ENVELOPE_MANAGE_ALL)) return;
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Only the sender of this envelope, or a Sign Admin, can change it', 403, {
      requestId,
      details: { reason: 'envelope_not_owned', missing_scopes: [ESIGN_SCOPE.ENVELOPE_MANAGE_ALL] },
    });
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async summary(auth: AuthContextType, requestId: string) {
    const createdBy = await this.ownerFilter(auth, requestId);
    const counts = await this.repo.countByStatus(auth.tenant_id, createdBy);
    const n = (k: string): number => counts[k] ?? 0;
    const since = new Date();
    since.setMonth(since.getMonth() - 5, 1);
    since.setHours(0, 0, 0, 0);
    const recent = await this.repo.listEnvelopes({ tenant_id: auth.tenant_id, created_since: since, created_by: createdBy, limit: 2000 });
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const months: { month: string; sent: number; completed: number; declined_or_expired: number }[] = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(monthStart);
      d.setMonth(d.getMonth() - i);
      months.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, sent: 0, completed: 0, declined_or_expired: 0 });
    }
    const key = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const byMonth = new Map(months.map((m) => [m.month, m]));
    let completedThisMonth = 0;
    for (const e of recent) {
      if (e.sent_at !== null) {
        const m = byMonth.get(key(e.sent_at));
        if (m !== undefined) {
          m.sent += 1;
          if (e.status === 'COMPLETED') m.completed += 1;
          if (e.status === 'DECLINED' || e.status === 'EXPIRED') m.declined_or_expired += 1;
        }
      }
      if (e.completed_at !== null && e.completed_at >= monthStart) completedThisMonth += 1;
    }
    const waiting = await this.repo.listEnvelopes({ tenant_id: auth.tenant_id, statuses: ['SENT', 'IN_PROGRESS'], created_by: createdBy, limit: 200 });
    const now = Date.now();
    const expiring = waiting
      .flatMap((e) => (e.sent_at === null ? [] : [{ id: e.id, subject: e.subject, expires_at: new Date(e.sent_at.getTime() + SIGNING_SESSION_TTL_MS) }]))
      .filter((e) => e.expires_at.getTime() - now <= 3 * 86_400_000)
      .sort((a, b) => a.expires_at.getTime() - b.expires_at.getTime())
      .slice(0, 5)
      .map((e) => ({ id: e.id, subject: e.subject, expires_at: e.expires_at.toISOString() }));
    const sentTotal = months.reduce((a, m) => a + m.sent, 0);
    const completedTotal = months.reduce((a, m) => a + m.completed, 0);
    return {
      counts: {
        draft: n('DRAFT'),
        sent: n('SENT'),
        in_progress: n('IN_PROGRESS'),
        completed: n('COMPLETED'),
        declined: n('DECLINED'),
        voided: n('VOIDED'),
        expired: n('EXPIRED'),
      },
      awaiting_signatures: n('SENT') + n('IN_PROGRESS'),
      completed_this_month: completedThisMonth,
      declined_or_expired: n('DECLINED') + n('EXPIRED'),
      months,
      completion_rate: sentTotal === 0 ? null : Math.round((completedTotal / sentTotal) * 100),
      expiring_soon: expiring,
      signing_window_days: Math.round(SIGNING_SESSION_TTL_MS / 86_400_000),
    };
  }

  async list(auth: AuthContextType, query: { tab?: string; q?: string; days?: string; limit?: string }, requestId: string) {
    const createdBy = await this.ownerFilter(auth, requestId);
    const statuses = ENVELOPE_TABS[query.tab ?? 'all'];
    if (query.tab !== undefined && !(query.tab in ENVELOPE_TABS)) throw bad(requestId, 'unknown tab', { tab: query.tab });
    const days = query.days !== undefined ? Number(query.days) : undefined;
    if (days !== undefined && (!Number.isInteger(days) || days <= 0 || days > 3650)) throw bad(requestId, 'days must be a positive integer');
    const limit = query.limit !== undefined ? Math.min(Math.max(Number(query.limit) || 100, 1), 500) : 200;
    const rows = await this.repo.listEnvelopes({
      tenant_id: auth.tenant_id,
      ...(statuses !== undefined ? { statuses } : {}),
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(days !== undefined ? { created_since: new Date(Date.now() - days * 86_400_000) } : {}),
      created_by: createdBy,
      limit,
    });
    const last = await this.repo.lastEventAt(auth.tenant_id, rows.map((r) => r.id));
    const counts = await this.repo.countByStatus(auth.tenant_id, createdBy);
    return {
      items: rows.map((e) => ({
        id: e.id,
        subject: e.subject,
        status: e.status,
        created_at: e.created_at.toISOString(),
        sent_at: iso(e.sent_at),
        completed_at: iso(e.completed_at),
        last_activity_at: iso(last.get(e.id) ?? e.updated_at),
        document_count: e.documents.length,
        recipients: e.signers.map((s) => ({ id: s.id, name: s.name, email: s.email, status: s.status })),
      })),
      counts,
    };
  }

  async detail(auth: AuthContextType, envelope_id: string, requestId: string) {
    const createdBy = await this.ownerFilter(auth, requestId);
    const env = await this.repo.getEnvelopeDetail(auth.tenant_id, envelope_id);
    if (createdBy !== undefined && env.created_by !== createdBy) {
      throw new AramoError('ENVELOPE_NOT_FOUND', `envelope ${envelope_id} not found`, 404, { requestId });
    }
    const sender = await this.identity.findUserById(env.created_by);
    return {
      id: env.id,
      subject: env.subject,
      status: env.status,
      created_at: env.created_at.toISOString(),
      sent_at: iso(env.sent_at),
      completed_at: iso(env.completed_at),
      declined_at: iso(env.declined_at),
      voided_at: iso(env.voided_at),
      expires_at: env.sent_at !== null ? new Date(env.sent_at.getTime() + SIGNING_SESSION_TTL_MS).toISOString() : null,
      signing_window_days: Math.round(SIGNING_SESSION_TTL_MS / 86_400_000),
      sender: { id: env.created_by, name: sender?.display_name ?? sender?.email ?? null },
      editable: env.status === 'DRAFT',
      documents: env.documents.map((d) => ({
        id: d.id,
        title: d.title,
        ordinal: d.ordinal,
        content_type: d.content_type,
        byte_size: d.byte_size,
        source_sha256: d.source_sha256,
        field_count: d.fields.length,
      })),
      recipients: env.signers.map((s) => ({
        id: s.id,
        name: s.name,
        email: s.email,
        status: s.status,
        signing_order: s.signing_order,
        viewed_at: iso(s.viewed_at),
        signed_at: iso(s.signed_at),
        declined_at: iso(s.declined_at),
        decline_reason: s.decline_reason,
      })),
      fields: env.documents.flatMap((d) =>
        d.fields.map((f) => ({
          id: f.id,
          envelope_document_id: d.id,
          signer_id: f.signer_id,
          field_type: f.field_type,
          page_number: f.page_number,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          required: f.required,
          filled: f.filled_at !== null,
        })),
      ),
    };
  }

  async events(auth: AuthContextType, envelope_id: string, requestId: string) {
    await this.detail(auth, envelope_id, requestId); // tenant + owner visibility check
    const env = await this.repo.getEnvelopeDetail(auth.tenant_id, envelope_id);
    const signerNames = new Map(env.signers.map((s) => [s.id, s.name]));
    const events = await this.repo.listEnvelopeEvents(auth.tenant_id, envelope_id);
    const users = await this.userNames(events.filter((e) => e.actor_type === 'SERVICE').map((e) => e.actor_ref));
    return {
      items: events.map((e) => ({
        id: e.id,
        event_type: e.event_type,
        occurred_at: e.occurred_at.toISOString(),
        actor: actorName(e.actor_type, e.actor_ref, signerNames, users),
        actor_type: e.actor_type,
        detail: eventDetail(e.payload),
        event_hash: e.event_hash,
      })),
    };
  }

  async activity(auth: AuthContextType, requestId: string, limitRaw?: string) {
    const createdBy = await this.ownerFilter(auth, requestId);
    const limit = Math.min(Math.max(Number(limitRaw) || 100, 1), 500);
    const events = await this.repo.listTenantEvents(auth.tenant_id, limit, createdBy);
    const signerIds = events.filter((e) => e.actor_type === 'SIGNER' && e.actor_ref !== null).map((e) => e.actor_ref as string);
    const signerNames = await this.signerNames(auth.tenant_id, events.map((e) => e.envelope_id), signerIds);
    const users = await this.userNames(events.filter((e) => e.actor_type === 'SERVICE').map((e) => e.actor_ref));
    return {
      items: events.map((e) => ({
        id: e.id,
        envelope_id: e.envelope_id,
        envelope_subject: e.envelope.subject,
        event_type: e.event_type,
        occurred_at: e.occurred_at.toISOString(),
        actor: actorName(e.actor_type, e.actor_ref, signerNames, users),
        actor_type: e.actor_type,
        detail: eventDetail(e.payload),
        event_hash: e.event_hash,
      })),
    };
  }

  async documents(auth: AuthContextType, requestId: string) {
    const createdBy = await this.ownerFilter(auth, requestId);
    const rows = await this.repo.listTenantDocuments(auth.tenant_id, 500, createdBy);
    const owners = await this.userNames(rows.map((r) => r.envelope.created_by));
    return {
      items: rows.map((d) => ({
        id: d.id,
        title: d.title,
        content_type: d.content_type,
        byte_size: d.byte_size,
        source: d.source_mode === 'OWNED' ? 'UPLOAD' : 'ARAMO_DOCUMENT',
        uploaded_at: d.envelope.created_at.toISOString(),
        envelope: { id: d.envelope.id, subject: d.envelope.subject, status: d.envelope.status },
        owner: owners.get(d.envelope.created_by) ?? null,
      })),
    };
  }

  async contacts(auth: AuthContextType, requestId: string) {
    await this.ownerFilter(auth, requestId);
    const rows = await this.repo.listPastRecipients(auth.tenant_id, 200);
    const byEmail = new Map<string, { name: string; email: string; envelope_count: number; last_used_at: string }>();
    for (const r of rows) {
      const k = r.email.toLowerCase();
      const cur = byEmail.get(k);
      if (cur === undefined) {
        byEmail.set(k, { name: r.name, email: r.email, envelope_count: 1, last_used_at: r.envelope.created_at.toISOString() });
      } else {
        cur.envelope_count += 1;
      }
    }
    return { items: [...byEmail.values()].slice(0, 200) };
  }

  async source(auth: AuthContextType, envelope_id: string, document_id: string, requestId: string): Promise<Uint8Array> {
    await this.detail(auth, envelope_id, requestId);
    const doc = await this.repo.getDocument(auth.tenant_id, envelope_id, document_id);
    return this.sources.getSourcePdf({
      tenant_id: auth.tenant_id,
      source_mode: doc.source_mode as EnvelopeDocumentSourceMode,
      document_ref: doc.document_ref,
      document_revision_ref: doc.document_revision_ref,
      source_object_key: doc.source_object_key,
    });
  }

  async executed(auth: AuthContextType, envelope_id: string, requestId: string) {
    const d = await this.detail(auth, envelope_id, requestId);
    if (d.status !== 'COMPLETED') {
      throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'Executed documents exist only for a completed envelope', 409, { requestId });
    }
    const bundle = await this.provider.getExecutedArtifacts(auth.tenant_id, envelope_id);
    const titles = new Map(d.documents.map((x) => [x.id, x.title]));
    return {
      envelope_id,
      documents: bundle.documents.map((x) => ({
        envelope_document_id: x.envelope_document_id,
        title: titles.get(x.envelope_document_id) ?? 'Document',
        executed_sha256: x.executed_sha256,
        byte_size: x.byte_size,
        executed_base64: x.executed_base64,
      })),
      certificate: bundle.certificate,
    };
  }

  async evidence(auth: AuthContextType, envelope_id: string, requestId: string) {
    await this.detail(auth, envelope_id, requestId);
    return this.provider.getEvidence(auth.tenant_id, envelope_id);
  }

  // ── DRAFT authoring ────────────────────────────────────────────────────────

  async create(auth: AuthContextType, body: { subject?: unknown }, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    const subject = typeof body?.subject === 'string' && body.subject.trim().length > 0 ? body.subject.trim() : 'Untitled envelope';
    if (subject.length > MAX_TITLE) throw bad(requestId, `subject must be at most ${MAX_TITLE} characters`);
    const env = await this.repo.createDraft({ tenant_id: auth.tenant_id, subject, created_by: auth.sub });
    return { id: env.id, status: env.status, subject: env.subject };
  }

  async update(auth: AuthContextType, envelope_id: string, body: { subject?: unknown }, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    if (typeof body?.subject !== 'string' || body.subject.trim().length === 0) throw bad(requestId, 'subject is required');
    if (body.subject.length > MAX_TITLE) throw bad(requestId, `subject must be at most ${MAX_TITLE} characters`);
    await this.repo.updateDraft({ tenant_id: auth.tenant_id, envelope_id, subject: body.subject.trim() });
    return this.detail(auth, envelope_id, requestId);
  }

  async upload(auth: AuthContextType, envelope_id: string, body: UploadDocumentBody, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    if (typeof body?.content_base64 !== 'string' || body.content_base64.length === 0) throw bad(requestId, 'content_base64 is required');
    const filename = typeof body.filename === 'string' && body.filename.length > 0 ? body.filename : 'document.pdf';
    const rawTitle = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : filename.replace(/\.pdf$/i, '');
    const title = rawTitle.slice(0, MAX_TITLE);
    const bytes = new Uint8Array(Buffer.from(body.content_base64, 'base64'));
    let accepted: Uint8Array;
    try {
      accepted = await this.safePdf.accept(bytes);
    } catch (e) {
      if (e instanceof UnsafePdfError) throw bad(requestId, `This file can't be used: ${e.message}`, { reason: 'unsafe_pdf' });
      throw e;
    }
    const pdf = await PDFDocument.load(accepted);
    const pages = pdf.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() }));
    // A1 — the plan's storage allocation: reserve the bytes before writing the
    // object (the object id fixes the ledger reference), release on failure.
    const object_id = randomUUID();
    const plannedKey = `esign/source/${auth.tenant_id}/${envelope_id}/${object_id}`;
    await this.storageGate.reserveUpload(auth.tenant_id, plannedKey, accepted.byteLength, requestId);
    let row: Awaited<ReturnType<EsignSenderRepository['addDraftDocument']>>;
    try {
      const stored = await this.storage.putOwnedSource({
        tenant_id: auth.tenant_id,
        envelope_id,
        filename,
        content_type: 'application/pdf',
        bytes: accepted,
        object_id,
      });
      row = await this.repo.addDraftDocument({
        tenant_id: auth.tenant_id,
        envelope_id,
        actor_ref: auth.sub,
        title,
        source_object_key: stored.source_object_key,
        content_type: 'application/pdf',
        byte_size: stored.byte_size,
        source_sha256: stored.source_sha256,
      });
    } catch (e) {
      await this.storageGate.release(auth.tenant_id, plannedKey).catch(() => undefined);
      throw e;
    }
    return { id: row.id, title: row.title, ordinal: row.ordinal, byte_size: row.byte_size, page_count: pages.length, pages };
  }

  async renameDocument(auth: AuthContextType, envelope_id: string, document_id: string, body: { title?: unknown }, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    if (typeof body?.title !== 'string' || body.title.trim().length === 0) throw bad(requestId, 'title is required');
    await this.repo.renameDraftDocument({ tenant_id: auth.tenant_id, envelope_id, document_id, title: body.title.trim().slice(0, MAX_TITLE) });
    return this.detail(auth, envelope_id, requestId);
  }

  async reorderDocuments(auth: AuthContextType, envelope_id: string, body: { order?: unknown }, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    if (!Array.isArray(body?.order) || body.order.some((x) => typeof x !== 'string')) throw bad(requestId, 'order must be an array of document ids');
    await this.repo.reorderDraftDocuments({ tenant_id: auth.tenant_id, envelope_id, order: body.order as string[] });
    return this.detail(auth, envelope_id, requestId);
  }

  async removeDocument(auth: AuthContextType, envelope_id: string, document_id: string, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    const removed = await this.repo.removeDraftDocument({ tenant_id: auth.tenant_id, envelope_id, document_id, actor_ref: auth.sub });
    // A1 — removing a draft document releases its storage.
    if (removed.source_object_key !== null) await this.storageGate.release(auth.tenant_id, removed.source_object_key).catch(() => undefined);
    return this.detail(auth, envelope_id, requestId);
  }

  async replaceRecipients(auth: AuthContextType, envelope_id: string, body: { recipients?: unknown }, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    if (!Array.isArray(body?.recipients)) throw bad(requestId, 'recipients must be an array');
    if (body.recipients.length > MAX_SIGNERS_V1) {
      throw bad(requestId, 'This version supports one signer per envelope', { reason: 'v1_single_signer', max: MAX_SIGNERS_V1 });
    }
    const seen = new Set<string>();
    const recipients = body.recipients.map((r: unknown, i: number) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
      const email = typeof o['email'] === 'string' ? o['email'].trim() : '';
      if (name.length === 0 || name.length > MAX_TITLE) throw bad(requestId, `recipient ${i + 1} needs a name`, { index: i, field: 'name' });
      if (!EMAIL_RE.test(email) || email.length > 254) throw bad(requestId, `recipient ${i + 1} needs a valid email`, { index: i, field: 'email' });
      const k = email.toLowerCase();
      if (seen.has(k)) throw bad(requestId, `recipient ${i + 1} repeats an email already on this envelope`, { index: i, field: 'email' });
      seen.add(k);
      const id = typeof o['id'] === 'string' && o['id'].length > 0 ? o['id'] : undefined;
      return { ...(id !== undefined ? { id } : {}), name, email };
    });
    await this.repo.replaceDraftRecipients({ tenant_id: auth.tenant_id, envelope_id, recipients });
    return this.detail(auth, envelope_id, requestId);
  }

  async replaceFields(auth: AuthContextType, envelope_id: string, body: { fields?: unknown }, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    if (!Array.isArray(body?.fields)) throw bad(requestId, 'fields must be an array');
    if (body.fields.length > MAX_FIELDS) throw bad(requestId, `at most ${MAX_FIELDS} fields`);
    const fields = body.fields.map((f: unknown, i: number) => {
      const o = (f ?? {}) as Record<string, unknown>;
      const num = (k: string): number => {
        const v = o[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(requestId, `field ${i + 1}: ${k} must be a number`, { index: i, field: k });
        return v;
      };
      const field_type = o['field_type'];
      if (typeof field_type !== 'string' || !FIELD_TYPE_SET.has(field_type)) {
        throw bad(requestId, `field ${i + 1}: field type not available in this version`, { index: i, reason: 'v1_field_type', allowed: FIELD_TYPES });
      }
      if (typeof o['envelope_document_id'] !== 'string' || typeof o['signer_id'] !== 'string') throw bad(requestId, `field ${i + 1}: document and recipient are required`, { index: i });
      const page_number = num('page_number');
      if (!Number.isInteger(page_number) || page_number < 0) throw bad(requestId, `field ${i + 1}: page_number must be 0 or more`, { index: i });
      const x = num('x');
      const y = num('y');
      const width = num('width');
      const height = num('height');
      if (x < 0 || y < 0 || width <= 0 || height <= 0) throw bad(requestId, `field ${i + 1}: position and size must be positive`, { index: i });
      return {
        envelope_document_id: o['envelope_document_id'] as string,
        signer_id: o['signer_id'] as string,
        field_type,
        page_number,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        width: Math.round(width * 100) / 100,
        height: Math.round(height * 100) / 100,
        required: o['required'] !== false,
      };
    });
    // Server-side geometry validation against the ACTUAL source pages: the page
    // must exist and the field box must lie inside it.
    const docIds = [...new Set(fields.map((f) => f.envelope_document_id))];
    for (const docId of docIds) {
      const bytes = await this.source(auth, envelope_id, docId, requestId);
      const pdf = await PDFDocument.load(bytes);
      const pages = pdf.getPages();
      for (const [i, f] of fields.entries()) {
        if (f.envelope_document_id !== docId) continue;
        const page = pages[f.page_number];
        if (page === undefined) throw bad(requestId, `field ${i + 1}: page ${f.page_number + 1} does not exist`, { index: i });
        if (f.x + f.width > page.getWidth() + 0.5 || f.y + f.height > page.getHeight() + 0.5) {
          throw bad(requestId, `field ${i + 1}: lies outside page ${f.page_number + 1}`, { index: i });
        }
      }
    }
    await this.repo.replaceDraftFields({ tenant_id: auth.tenant_id, envelope_id, fields });
    return this.detail(auth, envelope_id, requestId);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  // Readiness the send step enforces (also returned to the UI): ≥1 document,
  // ≥1 recipient, and every recipient has at least one SIGNATURE field.
  readiness(d: Awaited<ReturnType<SenderEnvelopeService['detail']>>): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    if (d.documents.length === 0) problems.push('Add at least one document');
    if (d.recipients.length === 0) problems.push('Add at least one recipient');
    for (const r of d.recipients) {
      if (!d.fields.some((f) => f.signer_id === r.id && f.field_type === 'SIGNATURE')) problems.push(`${r.name} needs a signature field`);
    }
    return { ok: problems.length === 0, problems };
  }

  async send(auth: AuthContextType, envelope_id: string, body: { subject?: unknown }, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    let d = await this.detail(auth, envelope_id, requestId);
    if (d.status !== 'DRAFT') throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', `envelope is ${d.status}`, 409, { requestId });
    if (typeof body?.subject === 'string' && body.subject.trim().length > 0 && body.subject.trim() !== d.subject) {
      await this.repo.updateDraft({ tenant_id: auth.tenant_id, envelope_id, subject: body.subject.trim().slice(0, MAX_TITLE) });
      d = await this.detail(auth, envelope_id, requestId);
    }
    const ready = this.readiness(d);
    if (!ready.ok) throw bad(requestId, 'This envelope is not ready to send', { reason: 'not_ready', problems: ready.problems });
    await this.repo.updateDraft({
      tenant_id: auth.tenant_id,
      envelope_id,
      execution_mode: d.recipients.length > 1 ? 'MULTI_SIGNATURE' : 'SINGLE_SIGNATURE',
    });
    await this.provider.sendEnvelope(auth.tenant_id, envelope_id, auth.sub);
    return this.detail(auth, envelope_id, requestId);
  }

  async remind(auth: AuthContextType, envelope_id: string, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    await this.detail(auth, envelope_id, requestId);
    await this.provider.remindEnvelopeSigner(auth.tenant_id, envelope_id, auth.sub);
    return this.detail(auth, envelope_id, requestId);
  }

  async void(auth: AuthContextType, envelope_id: string, body: { reason?: unknown }, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (reason.length === 0) throw bad(requestId, 'A reason is required to void an envelope');
    if (reason.length > 500) throw bad(requestId, 'reason must be at most 500 characters');
    const d = await this.detail(auth, envelope_id, requestId);
    if (TERMINAL.has(d.status)) throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', `envelope is ${d.status}`, 409, { requestId });
    await this.provider.voidEnvelope(auth.tenant_id, envelope_id, reason, auth.sub);
    return this.detail(auth, envelope_id, requestId);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async userNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of new Set(ids.filter((x): x is string => typeof x === 'string'))) {
      const u = await this.identity.findUserById(id).catch(() => null);
      if (u !== null) out.set(id, u.display_name ?? u.email);
    }
    return out;
  }

  private async signerNames(tenant_id: string, envelope_ids: readonly string[], signer_ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const envId of new Set(envelope_ids)) {
      if (signer_ids.length === 0) break;
      const env = await this.repo.getEnvelopeDetail(tenant_id, envId).catch(() => null);
      if (env === null) continue;
      for (const s of env.signers) out.set(s.id, s.name);
    }
    return out;
  }
}

function actorName(actor_type: string, actor_ref: string | null, signers: Map<string, string>, users: Map<string, string>): string {
  if (actor_type === 'SYSTEM') return 'System';
  if (actor_ref === null) return actor_type === 'SIGNER' ? 'Recipient' : 'Aramo Sign';
  if (actor_type === 'SIGNER') return signers.get(actor_ref) ?? 'Recipient';
  return users.get(actor_ref) ?? signers.get(actor_ref) ?? 'Aramo Sign';
}

// Only non-sensitive, display-safe payload facts (never tokens or keys).
function eventDetail(payload: unknown): Record<string, string> | null {
  if (payload === null || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of ['reason', 'title', 'signature_method', 'disclosure_version']) {
    if (typeof p[k] === 'string') out[k] = p[k] as string;
  }
  return Object.keys(out).length > 0 ? out : null;
}
