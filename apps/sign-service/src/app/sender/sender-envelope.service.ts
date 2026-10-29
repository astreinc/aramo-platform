import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, IdentityRepository } from '@aramo/identity';
import {
  DOCUMENT_SOURCE_PROVIDER_PORT,
  DOCUMENT_STORAGE_PORT,
  type DocumentSourceProviderPort,
  type DocumentStoragePort,
  type EnvelopeDocumentSourceMode,
  EnvelopeIllegalTransitionError,
  EsignSenderRepository,
  SIGNING_SESSION_TTL_MS,
  type DocumentPageSize,
  SIGN_REMINDER_LIMITS,
  SignContactDuplicateError,
  SignContactRepository,
  SignIdempotencyRepository,
  envelopeExpiresAt,
  envelopeReminderAvailableAt,
  idempotencyRequestHash,
  nextReminderAt,
  COPY_DELIVERIES,
  EsignService,
  MAX_COPY_RECIPIENTS,
  RECIPIENT_KINDS,
  currentTurnOf,
  isCopyRecipient,
  isLinkSigner,
  recipientKindOf,
  signingRecipients,
  type CopyDelivery,
  type RecipientKind,
  CHECKBOX_GROUP_RULES,
  SIGNER_NAME_MODES,
  type CheckboxGroupRule,
  type SenderFieldInput,
  type SignerNameMode,
  SenderFieldPassthroughRefusedError,
} from '@aramo/sign';
import { SafePdfPipeline, UnsafePdfError } from '@aramo/documents-rendering';
import { PDFDocument } from 'pdf-lib';

import { AramoSignStorageGate } from '../billing/aramo-sign-storage.gate.js';
import { SIGN_IN_PERSON_SIGNING_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';
import { NativeAramoSignatureProvider } from '../native-aramo-signature.provider.js';
import { PersonalSendGate } from '../personal/personal-send.gate.js';

import { SenderContextService } from './sender-context.service.js';
import { SIGNING_LINK_VALID_DAYS, expectedRevision, sanitizeMessage } from './envelope-contracts.js';

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

// PX-V1 §1 — field types limited to signature, date, initials and text; the other
// engine field types (SIGNER_NAME, CHECKBOX, ACKNOWLEDGEMENT) stay out of scope.
// Aramo-Sign-Multi-Signer-Amendment-v1_0-LOCKED — up to MAX_SIGNERS signers per
// envelope, signing in parallel or in order (ROUTING_MODES).
// M-A6 §2.1 — SIGNER_NAME and CHECKBOX are added to the sender authoring types;
// ACKNOWLEDGEMENT stays engine-only (the S2S and Sign API keep all seven).
export const FIELD_TYPES = ['SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT', 'SIGNER_NAME', 'CHECKBOX'] as const;
const FIELD_TYPE_SET = new Set<string>(FIELD_TYPES);
const NAME_MODES = new Set<string>(SIGNER_NAME_MODES);
const GROUP_RULES = new Set<string>(CHECKBOX_GROUP_RULES);
const MAX_LABEL = 200;
const MAX_GROUP_KEY = 64;
const CHECKBOX_CONFIG = ['label', 'group_key', 'group_rule', 'min_selected'] as const;
// The seven engine field types (the S2S and Sign API paths accept all of them).
const ENGINE_FIELD_TYPES = new Set<string>(['SIGNATURE', 'INITIALS', 'SIGN_DATE', 'SIGNER_NAME', 'TEXT', 'CHECKBOX', 'ACKNOWLEDGEMENT']);
export const MAX_SIGNERS = 10;
export const ROUTING_MODES = ['PARALLEL', 'SEQUENTIAL'] as const;
const TERMINAL = new Set(['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED']);
const MAX_FIELDS = 500;
const MAX_TITLE = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The Sign application's own key (SignatureEnvelope.source_application).
export const SIGN_APPLICATION = 'aramo-sign';

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
    // Personal Free v1.1 §6 — the Personal sending gate (PERSONAL tenants only).
    @Optional() private readonly personal?: PersonalSendGate,
    // Sign Mobile M-A3 §7/§8 — request idempotency for remind and document upload.
    @Optional() private readonly idempotency?: SignIdempotencyRepository,
    // Sign Mobile M-A3 §5 — the caller's private contacts.
    @Optional() private readonly contactStore?: SignContactRepository,
    // M-A5 §3 / §4 — hosted and self-sign sessions (the engine).
    @Optional() private readonly engine?: EsignService,
    // M-A5 §3.7 — the sign.in_person_signing launch availability.
    @Optional() private readonly features?: SignFeatureGate,
  ) {}

  // Sign Mobile M-A3 §7/§8 — run `fn` at most once per (tenant, actor, operation,
  // Idempotency-Key). A replay with the same request returns the stored response
  // without running again (a replayed reminder never counts against the limits);
  // a different request with the same key is refused (422 idempotency_key_reuse).
  private async idempotent<T>(auth: AuthContextType, operation: string, key: string | undefined, request: unknown, status: number, fn: () => Promise<T>): Promise<T> {
    if (key === undefined || this.idempotency === undefined) return fn();
    const begun = await this.idempotency.begin({ tenant_id: auth.tenant_id, actor_id: auth.sub, operation, key }, idempotencyRequestHash(request));
    if (begun.kind === 'replay') return begun.body as T;
    let out: T;
    try {
      out = await fn();
    } catch (e) {
      await this.idempotency.release(begun.id).catch(() => undefined);
      throw e;
    }
    await this.idempotency.complete(begun.id, status, out);
    return out;
  }

  // Sign Unified Product S-1 (directive §4.3.5) — visibility. A member reads the
  // envelopes they own; the whole organization only with sign:envelope:read:all
  // (Sign Viewer / Admin / Owner) in a BUSINESS tenant. A PERSONAL account always
  // reads its own. Returns the owner filter (undefined = the whole tenant).
  private async ownerFilter(auth: AuthContextType, requestId: string): Promise<string | undefined> {
    const kind = await this.context.tenantKind(auth.tenant_id, requestId);
    return kind === 'BUSINESS' && auth.scopes.includes(ESIGN_SCOPE.ENVELOPE_READ_ALL) ? undefined : auth.sub;
  }

  // Sign Unified Product S-1 (directive §4.3.5) — ownership. Every draft change
  // and lifecycle action (send, remind, void) is checked against the envelope's
  // actual owner: the owner may act; anyone else needs sign:envelope:manage:all
  // (Sign Admin / Owner). An ordinary sender never changes another member's
  // envelope merely because they share a Business tenant. Visibility first: an
  // envelope the caller cannot see reads as not found.
  private async assertMayChange(auth: AuthContextType, envelope_id: string, requestId: string): Promise<void> {
    const d = await this.describe(auth, envelope_id, requestId, false);
    // Sign Unified Product S-3 — an envelope that another application created
    // (e.g. an ATS RTR or offer letter) is visible here but its lifecycle stays
    // with that application, whose workflow depends on it.
    if (d.source_application !== SIGN_APPLICATION) {
      throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'This envelope is managed by the application that sent it', 409, {
        requestId,
        details: { reason: 'managed_by_source_application', source_application: d.source_application },
      });
    }
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
        source_application: e.source_application,
        recipients: e.signers.map((s) => ({ id: s.id, name: s.name, email: s.email, status: s.status, recipient_kind: recipientKindOf(s) })),
      })),
      counts,
    };
  }

  // The sender detail returned to the client: page sizes are filled for documents
  // uploaded before they were stored (Sign Mobile D-W6-2).
  async detail(auth: AuthContextType, envelope_id: string, requestId: string) {
    return this.describe(auth, envelope_id, requestId, true);
  }

  // `fillPages` false for the internal visibility / readiness reads, which never
  // need page sizes (no source fetch on those paths).
  private async describe(auth: AuthContextType, envelope_id: string, requestId: string, fillPages: boolean) {
    const createdBy = await this.ownerFilter(auth, requestId);
    const env = await this.repo.getEnvelopeDetail(auth.tenant_id, envelope_id);
    if (createdBy !== undefined && env.created_by !== createdBy) {
      throw new AramoError('ENVELOPE_NOT_FOUND', `envelope ${envelope_id} not found`, 404, { requestId });
    }
    const sender = await this.identity.findUserById(env.created_by);
    const open = env.status === 'SENT' || env.status === 'IN_PROGRESS';
    // M-A5 §1.3 — the shared current-turn rule (a copy recipient never takes a turn).
    const nextSignerId = open && env.routing_mode === 'SEQUENTIAL' ? (currentTurnOf(env.signers)?.id ?? null) : null;
    // M-A5 §1.2 / §3 — only a SIGNER holds an emailed link, so only a SIGNER is reminded.
    const canRemind = (s: { id: string; status: string; recipient_kind?: string | null }): boolean =>
      open && isLinkSigner(s) && (s.status === 'PENDING' || s.status === 'VIEWED') && (env.routing_mode !== 'SEQUENTIAL' || s.id === nextSignerId);
    // Sign Mobile M-A3 §7 — when each remindable signer may next be reminded (the
    // later of their 60-minute cooldown and the envelope's rolling 24-hour limit).
    const now = new Date();
    const history = env.signers.some(canRemind) ? await this.repo.reminderHistory(auth.tenant_id, env.id, now) : [];
    const envelopeNext = envelopeReminderAvailableAt(history, now, SIGN_REMINDER_LIMITS);
    const pagesOf = new Map<string, DocumentPageSize[] | null>();
    for (const d of env.documents) {
      const stored = storedPages(d.page_sizes?.pages);
      pagesOf.set(d.id, stored ?? (fillPages ? await this.fillPageSizes(auth.tenant_id, envelope_id, d.id) : null));
    }
    const reminderAvailableAt = (s: { id: string; status: string }): string | null => {
      if (!canRemind(s)) return null;
      const signerNext = nextReminderAt(history, s.id, now, SIGN_REMINDER_LIMITS);
      const later = [envelopeNext, signerNext].filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0];
      return later === undefined ? null : later.toISOString();
    };
    return {
      id: env.id,
      subject: env.subject,
      status: env.status,
      created_at: env.created_at.toISOString(),
      sent_at: iso(env.sent_at),
      completed_at: iso(env.completed_at),
      declined_at: iso(env.declined_at),
      voided_at: iso(env.voided_at),
      // Deprecated (kept for web compatibility): sent_at + the 7-day link window.
      // Sign Mobile C-14 / M-A3 §6 — the two distinct fields below replace it.
      expires_at: env.sent_at !== null ? new Date(env.sent_at.getTime() + SIGNING_SESSION_TTL_MS).toISOString() : null,
      signing_window_days: Math.round(SIGNING_SESSION_TTL_MS / 86_400_000),
      // The constant signing-link TTL, and the envelope's own expiry (default 30 days;
      // envelopes sent before expires_at existed: sent_at + the configured TTL).
      signing_link_valid_days: SIGNING_LINK_VALID_DAYS,
      envelope_expires_at: iso(env.expires_at ?? (env.sent_at !== null ? envelopeExpiresAt(env.sent_at) : null)),
      // Sign Mobile M-A3 §6 — the revision validator (ETag "{id}.{revision}").
      revision: env.revision,
      // Sign Mobile M-A3 §3 — the sender's plain-text message (immutable after send).
      message: env.message ?? null,
      sender: { id: env.created_by, name: sender?.display_name ?? sender?.email ?? null },
      // Sign Unified Product S-3 — where the envelope came from; envelopes from
      // another application are read-only here.
      source_application: env.source_application,
      editable: env.status === 'DRAFT' && env.source_application === SIGN_APPLICATION,
      // Multi-Signer §4/§5 — the routing mode and, while signing is open, who may sign now.
      routing_mode: env.routing_mode,
      next_signer_id: nextSignerId,
      documents: env.documents.map((d) => ({
        id: d.id,
        title: d.title,
        ordinal: d.ordinal,
        content_type: d.content_type,
        byte_size: d.byte_size,
        source_sha256: d.source_sha256,
        field_count: d.fields.length,
        // Sign Mobile D-W6-2 — each page's size in PDF points (MediaBox), 0-based by
        // position: the frame field geometry is validated in. null only when the
        // source could not be read.
        page_count: pagesOf.get(d.id)?.length ?? null,
        pages: pagesOf.get(d.id) ?? null,
      })),
      recipients: env.signers.map((s) => ({
        id: s.id,
        name: s.name,
        email: s.email,
        status: s.status,
        signing_order: s.signing_order,
        // M-A5 §1 / §2 / §4 — the kind, copy timing, and whether the caller assigned
        // this recipient to themselves (the bound user id itself is never returned).
        recipient_kind: recipientKindOf(s),
        copy_delivery: isCopyRecipient(s) ? s.copy_delivery : null,
        assigned_to_me: s.bound_user_id !== null && s.bound_user_id === auth.sub,
        viewed_at: iso(s.viewed_at),
        signed_at: iso(s.signed_at),
        declined_at: iso(s.declined_at),
        decline_reason: s.decline_reason,
        // A reminder is possible for an unsigned signer who may sign now.
        can_remind: canRemind(s),
        // Sign Mobile M-A3 §7 — null when a reminder may be sent now (or never applies).
        reminder_available_at: reminderAvailableAt(s),
        // Amendment M-A6 §3.5 — the template role this recipient was bound to (from-template), else null.
        role_key: s.signer_role ?? null,
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
          // M-A6 §2 — the field configuration (null where it does not apply).
          label: f.label,
          group_key: f.group_key,
          group_rule: f.group_rule,
          min_selected: f.min_selected,
          name_mode: f.name_mode,
        })),
      ),
    };
  }

  // Sign Mobile D-W6-2 — measure and store the page sizes of a document uploaded
  // before they were recorded. Best effort: a source that cannot be read leaves
  // pages null (the next read tries again).
  private async fillPageSizes(tenant_id: string, envelope_id: string, document_id: string): Promise<DocumentPageSize[] | null> {
    try {
      const doc = await this.repo.getDocument(tenant_id, envelope_id, document_id);
      const bytes = await this.sources.getSourcePdf({
        tenant_id,
        source_mode: doc.source_mode as EnvelopeDocumentSourceMode,
        document_ref: doc.document_ref,
        document_revision_ref: doc.document_revision_ref,
        source_object_key: doc.source_object_key,
      });
      const pages = await measurePages(bytes);
      await this.repo.savePageSizes(tenant_id, document_id, pages);
      return pages;
    } catch {
      return null;
    }
  }

  async events(auth: AuthContextType, envelope_id: string, requestId: string) {
    await this.describe(auth, envelope_id, requestId, false); // tenant + owner visibility check
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

  // Sign Mobile M-A3 §5 — the caller's saved contacts (source 'saved', with an id)
  // merged with recent recipients derived from envelopes (source 'recent', id
  // null). A recent recipient who is also saved appears once, as the saved contact.
  // Recent recipients follow the envelope visibility rule (own envelopes, or the
  // organization's with sign:envelope:read:all); saved contacts are the caller's only.
  async contacts(auth: AuthContextType, requestId: string) {
    const createdBy = await this.ownerFilter(auth, requestId);
    const rows = await this.repo.listPastRecipients(auth.tenant_id, 200, createdBy);
    const byEmail = new Map<string, { name: string; email: string; envelope_count: number; last_used_at: string }>();
    for (const r of rows) {
      if (r.email === null) continue; // M-A5 §3.5 — an in-person signer without an email
      const k = r.email.toLowerCase();
      const cur = byEmail.get(k);
      if (cur === undefined) {
        byEmail.set(k, { name: r.name, email: r.email, envelope_count: 1, last_used_at: r.envelope.created_at.toISOString() });
      } else {
        cur.envelope_count += 1;
      }
    }
    const saved = (await this.contactStore?.list(auth.tenant_id, auth.sub)) ?? [];
    const savedKeys = new Set(saved.map((c) => c.email.trim().toLowerCase()));
    const items = [
      ...saved.map((c) => {
        const recent = byEmail.get(c.email.trim().toLowerCase());
        const lastUsed = [c.last_used_at?.toISOString() ?? null, recent?.last_used_at ?? null].filter((x): x is string => x !== null).sort().pop() ?? null;
        return { id: c.id, name: c.name, email: c.email, organization: c.organization, source: 'saved' as const, envelope_count: recent?.envelope_count ?? 0, last_used_at: lastUsed };
      }),
      ...[...byEmail.entries()]
        .filter(([k]) => !savedKeys.has(k))
        .map(([, r]) => ({ id: null, name: r.name, email: r.email, organization: null, source: 'recent' as const, envelope_count: r.envelope_count, last_used_at: r.last_used_at })),
    ];
    return { items: items.slice(0, 700) };
  }

  private contactsOrUnavailable(requestId: string): SignContactRepository {
    if (this.contactStore === undefined) throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Contacts are not available', 503, { requestId, details: { reason: 'contacts_unavailable' } });
    return this.contactStore;
  }

  private contactInput(body: Record<string, unknown> | undefined, requestId: string, partial: boolean): { name?: string; email?: string; organization?: string | null } {
    const o = body ?? {};
    const out: { name?: string; email?: string; organization?: string | null } = {};
    if (o['name'] !== undefined || !partial) {
      const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
      if (name.length === 0 || name.length > MAX_TITLE) throw bad(requestId, 'A contact needs a name of at most 200 characters', { field: 'name', reason: 'invalid_contact_name' });
      out.name = name;
    }
    if (o['email'] !== undefined || !partial) {
      const email = typeof o['email'] === 'string' ? o['email'].trim() : '';
      if (!EMAIL_RE.test(email) || email.length > 254) throw bad(requestId, 'A contact needs a valid email', { field: 'email', reason: 'invalid_contact_email' });
      out.email = email;
    }
    if (o['organization'] !== undefined) {
      const org = o['organization'];
      if (org !== null && (typeof org !== 'string' || org.trim().length > MAX_TITLE)) throw bad(requestId, 'organization must be text of at most 200 characters', { field: 'organization', reason: 'invalid_contact_organization' });
      out.organization = org === null || org.trim().length === 0 ? null : org.trim();
    }
    if (partial && Object.keys(out).length === 0) throw bad(requestId, 'name, email or organization is required', { reason: 'empty_contact_update' });
    return out;
  }

  private contactView(c: { id: string; name: string; email: string; organization: string | null; created_at: Date; updated_at: Date; last_used_at: Date | null }) {
    return { id: c.id, name: c.name, email: c.email, organization: c.organization, source: 'saved' as const, created_at: c.created_at.toISOString(), updated_at: c.updated_at.toISOString(), last_used_at: iso(c.last_used_at) };
  }

  private duplicateContact(requestId: string): AramoError {
    return new AramoError('VALIDATION_ERROR', 'You already have a contact with this email', 409, { requestId, details: { field: 'email', reason: 'contact_exists' } });
  }

  // M-A3 §5 — create / update / delete. Owner-isolated: a contact of another user or
  // tenant reads as not found. A contact grants nothing (recipients are validated on send).
  async createContact(auth: AuthContextType, body: Record<string, unknown> | undefined, requestId: string) {
    const store = this.contactsOrUnavailable(requestId);
    const input = this.contactInput(body, requestId, false);
    try {
      const c = await store.create(auth.tenant_id, auth.sub, { name: input.name!, email: input.email!, organization: input.organization ?? null });
      return this.contactView(c);
    } catch (e) {
      if (e instanceof SignContactDuplicateError) throw this.duplicateContact(requestId);
      throw e;
    }
  }

  async updateContact(auth: AuthContextType, id: string, body: Record<string, unknown> | undefined, requestId: string) {
    const store = this.contactsOrUnavailable(requestId);
    const patch = this.contactInput(body, requestId, true);
    try {
      const c = await store.update(auth.tenant_id, auth.sub, id, patch);
      if (c === null) throw new AramoError('NOT_FOUND', 'Contact not found', 404, { requestId });
      return this.contactView(c);
    } catch (e) {
      if (e instanceof SignContactDuplicateError) throw this.duplicateContact(requestId);
      throw e;
    }
  }

  async deleteContact(auth: AuthContextType, id: string, requestId: string): Promise<void> {
    const store = this.contactsOrUnavailable(requestId);
    if (!(await store.remove(auth.tenant_id, auth.sub, id))) throw new AramoError('NOT_FOUND', 'Contact not found', 404, { requestId });
  }

  async source(auth: AuthContextType, envelope_id: string, document_id: string, requestId: string): Promise<Uint8Array> {
    await this.describe(auth, envelope_id, requestId, false);
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
    const d = await this.describe(auth, envelope_id, requestId, false);
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
    await this.describe(auth, envelope_id, requestId, false);
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

  async update(auth: AuthContextType, envelope_id: string, body: { subject?: unknown; routing_mode?: unknown; message?: unknown }, requestId: string, ifMatch?: string) {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    const hasSubject = body?.subject !== undefined;
    const hasRouting = body?.routing_mode !== undefined;
    // Sign Mobile M-A3 §3 — the sender message (DRAFT only; null or "" clears it).
    const hasMessage = body?.message !== undefined;
    if (!hasSubject && !hasRouting && !hasMessage) throw bad(requestId, 'subject, routing_mode or message is required');
    const message = hasMessage ? sanitizeMessage(body.message, requestId) : undefined;
    if (hasSubject) {
      if (typeof body.subject !== 'string' || body.subject.trim().length === 0) throw bad(requestId, 'subject is required');
      if (body.subject.length > MAX_TITLE) throw bad(requestId, `subject must be at most ${MAX_TITLE} characters`);
    }
    // Multi-Signer §4 — Sign in any order (PARALLEL) or Sign in order (SEQUENTIAL).
    if (hasRouting && !(ROUTING_MODES as readonly unknown[]).includes(body.routing_mode)) {
      throw bad(requestId, 'routing_mode must be PARALLEL or SEQUENTIAL', { field: 'routing_mode' });
    }
    await this.repo.updateDraft({
      tenant_id: auth.tenant_id,
      envelope_id,
      ...(hasSubject ? { subject: (body.subject as string).trim() } : {}),
      ...(hasRouting ? { routing_mode: body.routing_mode as string } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(expected !== undefined ? { expected_revision: expected } : {}),
    });
    return this.detail(auth, envelope_id, requestId);
  }

  // Sign Mobile M-A3 §8 — with an Idempotency-Key a retried upload returns the first
  // result (no second document, no second storage reservation).
  async upload(auth: AuthContextType, envelope_id: string, body: UploadDocumentBody, requestId: string, opts: { ifMatch?: string; idempotencyKey?: string } = {}) {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, opts.ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    return this.idempotent(auth, `upload:${envelope_id}`, opts.idempotencyKey, { envelope_id, body }, 201, () => this.uploadOnce(auth, envelope_id, body, requestId, expected));
  }

  private async uploadOnce(auth: AuthContextType, envelope_id: string, body: UploadDocumentBody, requestId: string, expected: number | undefined) {
    if (typeof body?.content_base64 !== 'string' || body.content_base64.length === 0) throw bad(requestId, 'content_base64 is required');
    // M-A3 §8 — PDF only; a Word document is refused with a stable reason.
    const fname = typeof body.filename === 'string' ? body.filename.toLowerCase() : '';
    if (/\.(docx?|dotx?|rtf|odt)$/.test(fname)) throw bad(requestId, 'Only PDF files can be signed. Save the document as a PDF and upload it again.', { reason: 'unsupported_file_type' });
    const filename = typeof body.filename === 'string' && body.filename.length > 0 ? body.filename : 'document.pdf';
    const rawTitle = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : filename.replace(/\.pdf$/i, '');
    const title = rawTitle.slice(0, MAX_TITLE);
    const bytes = new Uint8Array(Buffer.from(body.content_base64, 'base64'));
    if (isWordDocument(bytes)) throw bad(requestId, 'Only PDF files can be signed. Save the document as a PDF and upload it again.', { reason: 'unsupported_file_type' });
    let accepted: Uint8Array;
    try {
      accepted = await this.safePdf.accept(bytes);
    } catch (e) {
      if (e instanceof UnsafePdfError) throw bad(requestId, `This file can't be used: ${e.message}`, { reason: 'unsafe_pdf' });
      throw e;
    }
    const pages = await measurePages(accepted);
    // A1 — the plan's storage allocation: reserve the bytes before writing the
    // object (the object id fixes the ledger reference), release on failure.
    const object_id = randomUUID();
    const plannedKey = this.storage.plannedSourceKey?.(auth.tenant_id, envelope_id, object_id) ?? `esign/source/${auth.tenant_id}/${envelope_id}/${object_id}`;
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
        pages,
        ...(expected !== undefined ? { expected_revision: expected } : {}),
      });
    } catch (e) {
      await this.storageGate.release(auth.tenant_id, plannedKey).catch(() => undefined);
      throw e;
    }
    // Sign Mobile D-W6-1 — the envelope revision after this upload (the controller
    // sets ETag "{envelope_id}.{revision}"), so the next write chains its If-Match.
    return { id: row.id, envelope_id, title: row.title, ordinal: row.ordinal, byte_size: row.byte_size, page_count: pages.length, pages, revision: row.revision };
  }

  async renameDocument(auth: AuthContextType, envelope_id: string, document_id: string, body: { title?: unknown }, requestId: string, ifMatch?: string) {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    if (typeof body?.title !== 'string' || body.title.trim().length === 0) throw bad(requestId, 'title is required');
    await this.repo.renameDraftDocument({ tenant_id: auth.tenant_id, envelope_id, document_id, title: body.title.trim().slice(0, MAX_TITLE), ...(expected !== undefined ? { expected_revision: expected } : {}) });
    return this.detail(auth, envelope_id, requestId);
  }

  async reorderDocuments(auth: AuthContextType, envelope_id: string, body: { order?: unknown }, requestId: string, ifMatch?: string) {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    if (!Array.isArray(body?.order) || body.order.some((x) => typeof x !== 'string')) throw bad(requestId, 'order must be an array of document ids');
    await this.repo.reorderDraftDocuments({ tenant_id: auth.tenant_id, envelope_id, order: body.order as string[], ...(expected !== undefined ? { expected_revision: expected } : {}) });
    return this.detail(auth, envelope_id, requestId);
  }

  async removeDocument(auth: AuthContextType, envelope_id: string, document_id: string, requestId: string, ifMatch?: string) {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    const removed = await this.repo.removeDraftDocument({ tenant_id: auth.tenant_id, envelope_id, document_id, actor_ref: auth.sub, ...(expected !== undefined ? { expected_revision: expected } : {}) });
    // A1 — removing a draft document releases its storage (and, D-W6-3, its bytes).
    if (removed.source_object_key !== null) await this.discardSource(auth.tenant_id, removed.source_object_key);
    return this.detail(auth, envelope_id, requestId);
  }

  // Sign Mobile D-W6-3 — delete a DRAFT envelope. The same authority as any draft
  // change (visibility, then ownership or sign:envelope:manage:all; an envelope of
  // another application is refused) and the same If-Match rule (428 / 412). A sent
  // envelope is refused 409 envelope_not_draft. After the commit the stored source
  // bytes are removed and their storage released; a failure there is logged by the
  // storage layer and never resurrects the draft.
  async deleteDraft(auth: AuthContextType, envelope_id: string, requestId: string, ifMatch?: string): Promise<void> {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    let removed: Awaited<ReturnType<EsignSenderRepository['deleteDraft']>>;
    try {
      removed = await this.repo.deleteDraft({ tenant_id: auth.tenant_id, envelope_id, actor_ref: auth.sub, ...(expected !== undefined ? { expected_revision: expected } : {}) });
    } catch (e) {
      if (e instanceof EnvelopeIllegalTransitionError) {
        throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', 'Only a draft can be deleted. Void a sent envelope instead.', 409, { requestId, details: { reason: 'envelope_not_draft' } });
      }
      throw e;
    }
    for (const key of removed.source_object_keys) await this.discardSource(auth.tenant_id, key);
  }

  private async discardSource(tenant_id: string, source_object_key: string): Promise<void> {
    await this.storage.deleteOwnedSource?.(source_object_key).catch(() => undefined);
    await this.storageGate.release(tenant_id, source_object_key).catch(() => undefined);
  }

  async replaceRecipients(auth: AuthContextType, envelope_id: string, body: { recipients?: unknown }, requestId: string, ifMatch?: string) {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    if (!Array.isArray(body?.recipients)) throw bad(requestId, 'recipients must be an array');
    // M-A5 §1.4 — at most MAX_SIGNERS signing recipients and MAX_COPY_RECIPIENTS copies.
    if (body.recipients.length > MAX_SIGNERS + MAX_COPY_RECIPIENTS) {
      throw bad(requestId, `An envelope can have at most ${MAX_SIGNERS} signers`, { reason: 'too_many_signers', max: MAX_SIGNERS });
    }
    const seen = new Set<string>();
    let verifiedEmail: string | null | undefined;
    const recipients: Array<{ id?: string; name: string; email: string | null; recipient_kind: RecipientKind; copy_delivery: CopyDelivery | null; bound_user_id: string | null }> = [];
    for (const [i, r] of (body.recipients as unknown[]).entries()) {
      const o = (r ?? {}) as Record<string, unknown>;
      const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
      // M-A5 §1.7 — no recipient_kind ⇒ SIGNER (every existing client).
      const kindRaw = o['recipient_kind'] ?? 'SIGNER';
      if (typeof kindRaw !== 'string' || !(RECIPIENT_KINDS as readonly string[]).includes(kindRaw)) {
        throw bad(requestId, `recipient ${i + 1}: recipient_kind must be SIGNER, IN_PERSON_SIGNER or RECEIVES_COPY`, { index: i, field: 'recipient_kind', reason: 'invalid_recipient_kind' });
      }
      const kind = kindRaw as RecipientKind;
      // M-A5 §2.1 — copy_delivery is required iff RECEIVES_COPY.
      const cdRaw = o['copy_delivery'] ?? null;
      if (kind === 'RECEIVES_COPY' && (typeof cdRaw !== 'string' || !(COPY_DELIVERIES as readonly string[]).includes(cdRaw))) {
        throw bad(requestId, `recipient ${i + 1}: choose when the copy is sent (ON_SEND, ON_COMPLETION or BOTH)`, { index: i, field: 'copy_delivery', reason: 'copy_delivery_required' });
      }
      if (kind !== 'RECEIVES_COPY' && cdRaw !== null) {
        throw bad(requestId, `recipient ${i + 1}: copy_delivery applies only to a recipient who receives a copy`, { index: i, field: 'copy_delivery', reason: 'copy_delivery_not_allowed' });
      }
      const emailRaw = typeof o['email'] === 'string' ? o['email'].trim() : '';
      // M-A5 §3.5 — email is optional for an in-person signer only.
      const email = emailRaw.length === 0 && kind === 'IN_PERSON_SIGNER' ? null : emailRaw;
      if (name.length === 0 || name.length > MAX_TITLE) throw bad(requestId, `recipient ${i + 1} needs a name`, { index: i, field: 'name' });
      if (email !== null && (!EMAIL_RE.test(email) || email.length > 254)) throw bad(requestId, `recipient ${i + 1} needs a valid email`, { index: i, field: 'email' });
      // M-A5 §1.4 / §3.5 — emails are distinct across all kinds; a missing email is never a duplicate.
      if (email !== null) {
        const k = email.toLowerCase();
        if (seen.has(k)) throw bad(requestId, `recipient ${i + 1} repeats an email already on this envelope`, { index: i, field: 'email' });
        seen.add(k);
      }
      // M-A5 §4.1 — Assign to me: the server binds the caller, only when this
      // recipient's email is the caller's verified account email. Never client-supplied.
      const assign = o['assign_to_me'];
      if (assign !== undefined && typeof assign !== 'boolean') throw bad(requestId, `recipient ${i + 1}: assign_to_me must be true or false`, { index: i, field: 'assign_to_me' });
      let bound: string | null = null;
      if (assign === true) {
        if (kind !== 'SIGNER') throw bad(requestId, `recipient ${i + 1}: only a signer can be assigned to you`, { index: i, field: 'assign_to_me', reason: 'assign_to_me_not_signer' });
        if (verifiedEmail === undefined) verifiedEmail = await this.verifiedAccountEmail(auth);
        if (verifiedEmail === null || email === null || email.toLowerCase() !== verifiedEmail) {
          throw new AramoError('INSUFFICIENT_PERMISSIONS', 'You can assign a recipient to yourself only with your own verified account email', 403, {
            requestId,
            details: { index: i, field: 'assign_to_me', reason: 'assign_to_me_email_mismatch' },
          });
        }
        bound = auth.sub;
      }
      const id = typeof o['id'] === 'string' && o['id'].length > 0 ? o['id'] : undefined;
      recipients.push({ ...(id !== undefined ? { id } : {}), name, email, recipient_kind: kind, copy_delivery: kind === 'RECEIVES_COPY' ? (cdRaw as CopyDelivery) : null, bound_user_id: bound });
    }
    const signingCount = recipients.filter((r) => r.recipient_kind !== 'RECEIVES_COPY').length;
    if (signingCount > MAX_SIGNERS) {
      throw bad(requestId, `An envelope can have at most ${MAX_SIGNERS} signers`, { reason: 'too_many_signers', max: MAX_SIGNERS });
    }
    if (recipients.length - signingCount > MAX_COPY_RECIPIENTS) {
      throw bad(requestId, `An envelope can have at most ${MAX_COPY_RECIPIENTS} copy recipients`, { reason: 'too_many_copy_recipients', max: MAX_COPY_RECIPIENTS });
    }
    await this.repo.replaceDraftRecipients({ tenant_id: auth.tenant_id, envelope_id, recipients, ...(expected !== undefined ? { expected_revision: expected } : {}) });
    return this.detail(auth, envelope_id, requestId);
  }

  async replaceFields(auth: AuthContextType, envelope_id: string, body: { fields?: unknown }, requestId: string, ifMatch?: string) {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    if (!Array.isArray(body?.fields)) throw bad(requestId, 'fields must be an array');
    if (body.fields.length > MAX_FIELDS) throw bad(requestId, `at most ${MAX_FIELDS} fields`);
    const copyIds = new Set((await this.repo.getEnvelopeDetail(auth.tenant_id, envelope_id)).signers.filter(isCopyRecipient).map((s) => s.id));
    const fields = body.fields.map((f: unknown, i: number): SenderFieldInput => {
      const o = (f ?? {}) as Record<string, unknown>;
      const num = (k: string): number => {
        const v = o[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(requestId, `field ${i + 1}: ${k} must be a number`, { index: i, field: k });
        return v;
      };
      const field_type = o['field_type'];
      if (typeof field_type !== 'string' || !FIELD_TYPE_SET.has(field_type)) {
        // M-A6 §2 (coordinator ruling) — an engine-only type passes through only
        // unchanged: it names an existing field (id) and the repository keeps it
        // when it is identical to the stored row (refused otherwise).
        if (typeof field_type === 'string' && ENGINE_FIELD_TYPES.has(field_type) && typeof o['id'] === 'string' && o['id'].length > 0) {
          return passthroughField(o, field_type, i, requestId);
        }
        throw bad(requestId, `field ${i + 1}: field type not available in this version`, { index: i, reason: 'v1_field_type', allowed: FIELD_TYPES });
      }
      if (typeof o['envelope_document_id'] !== 'string' || typeof o['signer_id'] !== 'string') throw bad(requestId, `field ${i + 1}: document and recipient are required`, { index: i });
      // M-A5 §1.5 — a copy recipient has no fields.
      if (copyIds.has(o['signer_id'] as string)) throw bad(requestId, `field ${i + 1}: a recipient who receives a copy has no fields`, { index: i, field: 'signer_id', reason: 'copy_recipient_has_fields' });
      const page_number = num('page_number');
      if (!Number.isInteger(page_number) || page_number < 0) throw bad(requestId, `field ${i + 1}: page_number must be 0 or more`, { index: i });
      const x = num('x');
      const y = num('y');
      const width = num('width');
      const height = num('height');
      if (x < 0 || y < 0 || width <= 0 || height <= 0) throw bad(requestId, `field ${i + 1}: position and size must be positive`, { index: i });
      const config = fieldConfig(o, field_type, i, requestId);
      return {
        ...config,
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
    checkboxGroups(fields, requestId);
    // Server-side geometry validation against the ACTUAL source pages: the page
    // must exist and the field box must lie inside it.
    const docIds = [...new Set(fields.map((f) => f.envelope_document_id))];
    for (const docId of docIds) {
      const bytes = await this.source(auth, envelope_id, docId, requestId);
      const pdf = await PDFDocument.load(bytes);
      const pages = pdf.getPages();
      for (const [i, f] of fields.entries()) {
        if (f.envelope_document_id !== docId || f.passthrough_id !== undefined) continue;
        const page = pages[f.page_number];
        if (page === undefined) throw bad(requestId, `field ${i + 1}: page ${f.page_number + 1} does not exist`, { index: i });
        if (f.x + (f.width ?? 0) > page.getWidth() + 0.5 || f.y + (f.height ?? 0) > page.getHeight() + 0.5) {
          throw bad(requestId, `field ${i + 1}: lies outside page ${f.page_number + 1}`, { index: i });
        }
      }
    }
    try {
      await this.repo.replaceDraftFields({ tenant_id: auth.tenant_id, envelope_id, fields, ...(expected !== undefined ? { expected_revision: expected } : {}) });
    } catch (e) {
      if (e instanceof SenderFieldPassthroughRefusedError) {
        throw bad(requestId, e.message, { index: e.index, reason: 'v1_field_type', allowed: FIELD_TYPES });
      }
      throw e;
    }
    return this.detail(auth, envelope_id, requestId);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  // Readiness the send step enforces (also returned to the UI): ≥1 document,
  // ≥1 signing recipient, every signing recipient has at least one SIGNATURE field,
  // and (M-A5 §1.5) a recipient who receives a copy has no fields.
  readiness(d: Pick<Awaited<ReturnType<SenderEnvelopeService['detail']>>, 'documents' | 'recipients' | 'fields'>): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    if (d.documents.length === 0) problems.push('Add at least one document');
    if (signingRecipients(d.recipients).length === 0) problems.push('Add at least one recipient who signs');
    for (const r of d.recipients) {
      if (isCopyRecipient(r)) {
        if (d.fields.some((f) => f.signer_id === r.id)) problems.push(`${r.name} receives a copy and cannot have fields`);
        continue;
      }
      if (!d.fields.some((f) => f.signer_id === r.id && f.field_type === 'SIGNATURE')) problems.push(`${r.name} needs a signature field`);
    }
    return { ok: problems.length === 0, problems };
  }

  // Sign Mobile M-A3 §6 — with If-Match every step of the send (subject, execution
  // mode, the send itself) is a compare-and-set on the revision the previous step
  // produced, each under the envelope row lock: a concurrent change anywhere in
  // between refuses the send with 412 instead of sending an envelope the caller
  // never saw.
  async send(auth: AuthContextType, envelope_id: string, body: { subject?: unknown }, requestId: string, meta: { ip?: string | null; ifMatch?: string } = {}) {
    const tenant = await this.context.assertCanAuthorTenant(auth, requestId);
    let expected = expectedRevision(auth, meta.ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    let d = await this.describe(auth, envelope_id, requestId, false);
    if (d.status !== 'DRAFT') throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', `envelope is ${d.status}`, 409, { requestId });
    if (typeof body?.subject === 'string' && body.subject.trim().length > 0 && body.subject.trim() !== d.subject) {
      const rev = await this.repo.updateDraft({ tenant_id: auth.tenant_id, envelope_id, subject: body.subject.trim().slice(0, MAX_TITLE), ...(expected !== undefined ? { expected_revision: expected } : {}) });
      if (expected !== undefined) expected = rev;
      d = await this.describe(auth, envelope_id, requestId, false);
    }
    const ready = this.readiness(d);
    if (!ready.ok) throw bad(requestId, 'This envelope is not ready to send', { reason: 'not_ready', problems: ready.problems });
    // Personal Free v1.1 §4 / §6 — FREE subscription, risk gate, young-account checks.
    if (tenant.kind === 'PERSONAL') {
      if (this.personal === undefined) throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Sending from a personal account is not enabled', 403, { requestId, details: { reason: 'personal_sending_not_enabled' } });
      const detail = d;
      await this.personal.assertLegalAccepted(tenant, auth.sub, requestId);
      await this.personal.assertMaySend(
        tenant,
        meta.ip ?? null,
        {
          subject: detail.subject,
          document_titles: detail.documents.map((x) => x.title),
          sender_name: detail.sender.name,
          recipient_count: detail.recipients.length,
          pdfs: async () => Promise.all(detail.documents.map((x) => this.source(auth, envelope_id, x.id, requestId))),
        },
        requestId,
      );
    }
    const rev = await this.repo.updateDraft({
      tenant_id: auth.tenant_id,
      envelope_id,
      execution_mode: signingRecipients(d.recipients).length > 1 ? 'MULTI_SIGNATURE' : 'SINGLE_SIGNATURE',
      ...(expected !== undefined ? { expected_revision: expected } : {}),
    });
    if (expected !== undefined) expected = rev;
    await this.provider.sendEnvelope(auth.tenant_id, envelope_id, auth.sub, undefined, expected !== undefined ? { expected_revision: expected } : {});
    // M-A3 §5 — the sender's saved contacts for these recipients were just used.
    await this.contactStore?.touchUsed(auth.tenant_id, auth.sub, d.recipients.flatMap((r) => (r.email === null ? [] : [r.email]))).catch(() => undefined);
    return this.detail(auth, envelope_id, requestId);
  }

  // Sign Mobile M-A3 §7 — the reminder limits (60 minutes per signer, 5 per envelope
  // per rolling 24 hours) are enforced by the engine under the envelope row lock.
  // With an Idempotency-Key a retried reminder returns the first response and does
  // not count again.
  async remind(auth: AuthContextType, envelope_id: string, body: { signer_id?: unknown }, requestId: string, meta: { ip?: string | null; idempotencyKey?: string } = {}) {
    const tenant = await this.context.assertCanAuthorTenant(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    // Multi-Signer M-3a — remind one signer, or (omitted) everyone who may sign now.
    const signer_id = body?.signer_id;
    if (signer_id !== undefined && typeof signer_id !== 'string') throw bad(requestId, 'signer_id must be a string', { field: 'signer_id' });
    return this.idempotent(auth, `remind:${envelope_id}`, meta.idempotencyKey, { envelope_id, signer_id: signer_id ?? null }, 200, async () => {
      // Personal Free v1.1 §6.3 / §6.6 — a reminder is a new email: the risk gate applies.
      if (tenant?.kind === 'PERSONAL' && this.personal !== undefined) await this.personal.assertRiskGate(tenant.id, meta.ip ?? null, requestId);
      await this.provider.remindEnvelopeSigner(auth.tenant_id, envelope_id, auth.sub, signer_id, { limits: SIGN_REMINDER_LIMITS });
      return this.detail(auth, envelope_id, requestId);
    });
  }

  async void(auth: AuthContextType, envelope_id: string, body: { reason?: unknown }, requestId: string, ifMatch?: string) {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    if (reason.length === 0) throw bad(requestId, 'A reason is required to void an envelope');
    if (reason.length > 500) throw bad(requestId, 'reason must be at most 500 characters');
    const d = await this.describe(auth, envelope_id, requestId, false);
    if (TERMINAL.has(d.status)) throw new AramoError('ENVELOPE_ILLEGAL_TRANSITION', `envelope is ${d.status}`, 409, { requestId });
    await this.provider.voidEnvelope(auth.tenant_id, envelope_id, reason, auth.sub, expected !== undefined ? { expected_revision: expected } : {});
    return this.detail(auth, envelope_id, requestId);
  }

  // ── M-A5 §3 — hosted (in-person) signing ───────────────────────────────────
  // The authenticated host (sign:envelope:send, may change the envelope) starts a
  // 30-minute HOSTED session for an IN_PERSON_SIGNER whose turn it is. The token is
  // returned ONLY in this response, to the host's authenticated client; the signer
  // then uses the guest signing transport (no workspace credentials).
  async hostedSession(auth: AuthContextType, envelope_id: string, body: { signer_id?: unknown }, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    (this.features ?? new SignFeatureGate()).assertAvailable(SIGN_IN_PERSON_SIGNING_FEATURE, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    const signer_id = body?.signer_id;
    if (typeof signer_id !== 'string' || signer_id.length === 0) throw bad(requestId, 'signer_id is required', { field: 'signer_id' });
    const s = await this.engineOrUnavailable(requestId).issueHostedSession(auth.tenant_id, envelope_id, signer_id, auth.sub);
    return { session_origin: 'HOSTED' as const, signer_id: s.signer_id, token: s.raw_token, expires_at: s.expires_at.toISOString() };
  }

  // ── M-A5 §4 — self-signing ("Sign a document") ─────────────────────────────
  // Requires the recipient bound to the caller (Assign to me) — sign:envelope:manage:all
  // never substitutes — and re-checks the caller's verified account email.
  async selfSignSession(auth: AuthContextType, envelope_id: string, body: { signer_id?: unknown }, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    const signer_id = body?.signer_id;
    if (signer_id !== undefined && (typeof signer_id !== 'string' || signer_id.length === 0)) throw bad(requestId, 'signer_id must be a string', { field: 'signer_id' });
    const email = await this.verifiedAccountEmail(auth);
    const s = await this.engineOrUnavailable(requestId).issueSelfSignSession(auth.tenant_id, envelope_id, auth.sub, email, signer_id as string | undefined);
    return { session_origin: 'SELF' as const, signer_id: s.signer_id, token: s.raw_token, expires_at: s.expires_at.toISOString() };
  }

  private engineOrUnavailable(requestId: string): EsignService {
    if (this.engine === undefined) throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Signing sessions are not available', 503, { requestId, details: { reason: 'signing_engine_unavailable' } });
    return this.engine;
  }

  // M-A5 §4.1 — the caller's verified account email: the email of their active
  // Aramo account (established by the identity provider at sign-in — the same
  // source the inbox claim matches, M-A2). Lower-cased; null when there is none.
  private async verifiedAccountEmail(auth: AuthContextType): Promise<string | null> {
    const user = await this.identity.findUserById(auth.sub).catch(() => null);
    if (user === null || !user.is_active || user.deactivated_at !== null) return null;
    const email = user.email?.trim().toLowerCase() ?? '';
    return email.length > 0 ? email : null;
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

// M-A3 §8 — a Word document (OOXML zip or legacy OLE compound file) is refused with
// a stable reason before the PDF pipeline.
// Sign Mobile D-W6-2 — each page's size in points. pdf-lib's getWidth/getHeight
// M-A6 §2 — the Name and Checkbox configuration of one authored field. The sender
// never supplies a value (§2.2). SIGNER_NAME takes name_mode (default
// SIGNER_PROFILE); CHECKBOX takes label and the group settings; no other type
// takes any of them. Every refusal carries a stable details.reason.
type FieldConfig = Pick<SenderFieldInput, 'label' | 'group_key' | 'group_rule' | 'min_selected' | 'name_mode'>;
function fieldConfig(o: Record<string, unknown>, field_type: string, i: number, requestId: string): FieldConfig {
  const refuse = (field: string, reason: string, message: string): AramoError => bad(requestId, `field ${i + 1}: ${message}`, { index: i, field, reason });
  const present = (k: string): boolean => o[k] !== undefined && o[k] !== null;
  if (present('value')) throw refuse('value', 'sender_value_refused', 'a sender cannot fill a field value');
  if (field_type !== 'SIGNER_NAME' && present('name_mode')) throw refuse('name_mode', 'field_config_not_applicable', 'name_mode applies to name fields only');
  if (field_type !== 'CHECKBOX') {
    for (const k of CHECKBOX_CONFIG) if (present(k)) throw refuse(k, 'field_config_not_applicable', `${k} applies to check boxes only`);
  }
  if (field_type === 'SIGNER_NAME') {
    const mode = o['name_mode'] ?? 'SIGNER_PROFILE';
    if (typeof mode !== 'string' || !NAME_MODES.has(mode)) throw refuse('name_mode', 'name_mode_invalid', 'name_mode must be SIGNER_PROFILE or SIGNER_ENTERED');
    return { name_mode: mode as SignerNameMode };
  }
  if (field_type !== 'CHECKBOX') return {};
  let label: string | null = null;
  if (present('label')) {
    if (typeof o['label'] !== 'string') throw refuse('label', 'checkbox_label_invalid', 'label must be text');
    const t = o['label'].trim();
    if (t.length > MAX_LABEL) throw refuse('label', 'checkbox_label_invalid', `label must be at most ${MAX_LABEL} characters`);
    label = t.length > 0 ? t : null;
  }
  let group_key: string | null = null;
  if (present('group_key')) {
    if (typeof o['group_key'] !== 'string') throw refuse('group_key', 'checkbox_group_invalid', 'group_key must be text');
    const t = o['group_key'].trim();
    if (t.length > MAX_GROUP_KEY) throw refuse('group_key', 'checkbox_group_invalid', `group_key must be at most ${MAX_GROUP_KEY} characters`);
    group_key = t.length > 0 ? t : null;
  }
  if (group_key === null) {
    if (present('group_rule') || present('min_selected')) throw refuse(present('group_rule') ? 'group_rule' : 'min_selected', 'checkbox_group_required', 'group_rule and min_selected need a group_key');
    return { label, group_key: null, group_rule: null, min_selected: null };
  }
  const rule = o['group_rule'] ?? 'SELECT_ANY';
  if (typeof rule !== 'string' || !GROUP_RULES.has(rule)) throw refuse('group_rule', 'checkbox_group_invalid', 'group_rule must be SELECT_ONE or SELECT_ANY');
  let min_selected: number | null = null;
  if (present('min_selected')) {
    const m = o['min_selected'];
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 1) throw refuse('min_selected', 'checkbox_group_invalid', 'min_selected must be a whole number of at least 1');
    if (rule === 'SELECT_ONE' && m !== 1) throw refuse('min_selected', 'checkbox_group_invalid', 'a select-one group has min_selected 1');
    min_selected = m;
  }
  return { label, group_key, group_rule: rule as CheckboxGroupRule, min_selected };
}

// M-A6 §2 (coordinator ruling) — an engine-only field sent back on the replace-all
// PUT. Its values are taken exactly as sent (no rounding; signer and size may be
// null, as stored rows from the S2S / Sign API / template paths may have them); the
// repository compares them with the stored row named by `id` and keeps that row
// only when every one is identical. A sender value is still refused.
function passthroughField(o: Record<string, unknown>, field_type: string, i: number, requestId: string): SenderFieldInput {
  const refuse = (): AramoError => bad(requestId, `field ${i + 1}: field type not available in this version`, { index: i, reason: 'v1_field_type', allowed: FIELD_TYPES });
  if (o['value'] !== undefined && o['value'] !== null) throw bad(requestId, `field ${i + 1}: a sender cannot fill a field value`, { index: i, field: 'value', reason: 'sender_value_refused' });
  const numOrNull = (k: string): number | null => {
    const v = o[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw refuse();
    return v;
  };
  const strOrNull = (k: string): string | null => {
    const v = o[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw refuse();
    return v;
  };
  const page_number = o['page_number'];
  const x = o['x'];
  const y = o['y'];
  if (typeof o['envelope_document_id'] !== 'string' || typeof page_number !== 'number' || typeof x !== 'number' || typeof y !== 'number') throw refuse();
  return {
    passthrough_id: o['id'] as string,
    envelope_document_id: o['envelope_document_id'],
    signer_id: strOrNull('signer_id'),
    field_type,
    page_number,
    x,
    y,
    width: numOrNull('width'),
    height: numOrNull('height'),
    required: o['required'] !== false,
    label: strOrNull('label'),
    group_key: strOrNull('group_key'),
    group_rule: strOrNull('group_rule'),
    min_selected: numOrNull('min_selected'),
    name_mode: strOrNull('name_mode'),
  };
}

// M-A6 §2.3 — every box of a check-box group belongs to one recipient and shares
// the group's rule, minimum and required setting; a minimum cannot exceed the
// group's size.
function checkboxGroups(fields: ReadonlyArray<SenderFieldInput>, requestId: string): void {
  const groups = new Map<string, SenderFieldInput[]>();
  for (const f of fields) {
    if (f.group_key === undefined || f.group_key === null) continue;
    const g = groups.get(f.group_key) ?? [];
    g.push(f);
    groups.set(f.group_key, g);
  }
  for (const [group_key, boxes] of groups) {
    const [first] = boxes;
    if (first === undefined) continue;
    const consistent = boxes.every((b) => b.signer_id === first.signer_id && b.group_rule === first.group_rule && (b.min_selected ?? null) === (first.min_selected ?? null) && b.required === first.required);
    if (!consistent) {
      throw bad(requestId, `check-box group ${group_key}: every box needs the same recipient, rule, minimum and required setting`, { group_key, reason: 'checkbox_group_inconsistent' });
    }
    if ((first.min_selected ?? 1) > boxes.length) {
      throw bad(requestId, `check-box group ${group_key}: min_selected is more than the boxes in the group`, { group_key, reason: 'checkbox_group_min_exceeds_size' });
    }
  }
}

// read the MediaBox, exactly what replaceFields validates field boxes against.
async function measurePages(bytes: Uint8Array): Promise<DocumentPageSize[]> {
  const pdf = await PDFDocument.load(bytes);
  return pdf.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() }));
}

function storedPages(raw: unknown): DocumentPageSize[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: DocumentPageSize[] = [];
  for (const p of raw) {
    const o = p as { width?: unknown; height?: unknown } | null;
    if (o === null || typeof o !== 'object' || typeof o.width !== 'number' || typeof o.height !== 'number') return null;
    out.push({ width: o.width, height: o.height });
  }
  return out;
}

function isWordDocument(b: Uint8Array): boolean {
  const zip = b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  const ole = b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
  return zip || ole;
}
