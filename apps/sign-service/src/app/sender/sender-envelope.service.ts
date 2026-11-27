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
  recipientKindOf,
  signingRecipients,
  type CopyDelivery,
  type RecipientKind,
  type CheckboxGroupRule,
  type SenderFieldInput,
  SenderFieldPassthroughRefusedError,
  SignPurgeRepository,
  hashAccessCode,
  normalizeAccessCode,
  ACCESS_CODE_MIN_LENGTH,
  ACCESS_CODE_MAX_LENGTH,
  isWitness,
  witnessReady,
  IDENTITY_VERIFICATION_METHODS,
  type IdentityVerificationMethod,
  PAYMENT_FIELD_TYPE,
  SignPaymentRepository,
  QesWorkflowService,
  EstampWorkflowService,
  RecipientInboxRepository,
  awaitingYouSteps,
  inboxHandleKey,
  mintInboxHandle,
  SignUserProfileRepository,
  type SendRiskVerdict,
} from '@aramo/sign';
import {
  selfSignTarget,
  sessionIssueRefusal,
  EMAIL_MAX,
  EMAIL_PATTERN,
  ENVELOPE_SUBJECT_MAX,
  MAX_SIGNERS,
  SENDER_FIELD_TYPES,
  VOID_REASON_MAX,
  AUTO_REMINDER_CADENCE,
  canSetAutoReminders,
} from '@aramo/sign-client';
import { SafePdfPipeline, UnsafePdfError } from '@aramo/documents-rendering';
import { checkboxGroupIssues, fieldConditionIssues, fieldTypesFor, fieldValueRefusal, isFieldKey, parseFieldSettings, senderFilledFieldsEnabled, FIELD_KEY_MAX, type FieldCondition, type FieldImportWarning } from '@aramo/sign-fields';
import { PDFDocument } from 'pdf-lib';

import { AramoSignStorageGate } from '../billing/aramo-sign-storage.gate.js';
import {
  SIGN_ACCESS_CODE_FEATURE,
  SIGN_DELEGATE_SIGNING_FEATURE,
  SIGN_ID_VERIFICATION_FEATURE,
  SIGN_IN_PERSON_SIGNING_FEATURE,
  SIGN_KBA_FEATURE,
  SIGN_WITNESS_SIGNING_FEATURE,
  SignFeatureGate,
} from '../sign-feature.gate.js';
import { NativeAramoSignatureProvider } from '../native-aramo-signature.provider.js';
import { PersonalSendGate } from '../personal/personal-send.gate.js';
import { purgeViewOf } from '../retention/purge-view.js';
import { SignPurgeService } from '../retention/sign-purge.service.js';
import { folderIdOf, folderNotFound, parseFolderParam, SignFoldersService } from '../folders/sign-folders.service.js';
import { SignPaymentsGate, paymentsNotAvailable } from '../payments/sign-payments.gate.js';
import { WORD_CONVERSION_PORT, WordConversionError, disabledWordConversion, isWordFilename, type WordConversionPort } from '../word-conversion/word-conversion.port.js';

import { ESIGN_SEND_SCOPE, SenderContextService } from './sender-context.service.js';
import { SIGNING_LINK_VALID_DAYS, expectedRevision, sanitizeMessage } from './envelope-contracts.js';
import { bindImportedFields, fieldRowOf, importUploadFields, uploadImportOptions, type BoundImportedField } from './upload-field-import.js';
import {
  SIGN_APPLICATION,
  canRemindRecipient,
  changeRefusal,
  deleteDraftStateRefusal,
  downloadStateRefusal,
  enforce,
  hostableRecipient,
  remindModeRefusal,
  sendStateRefusal,
  senderActions,
  voidStateRefusal,
  type ActionEnvelope,
  type SenderActionFacts,
  type SenderActions,
} from './envelope-actions.js';

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

// PX-V1 §1 — originally signature, date, initials and text; the amendments below
// widened the sender authoring types to the 11 in FIELD_TYPES (+ PAYMENT, accepted
// only while payments are available: 12 in the SenderFieldInput enum).
// Aramo-Sign-Multi-Signer-Amendment-v1_0-LOCKED — up to MAX_SIGNERS signers per
// envelope, signing in parallel or in order (ROUTING_MODES).
// M-A6 §2.1 — SIGNER_NAME and CHECKBOX are added to the sender authoring types;
// ACKNOWLEDGEMENT stays engine-only (the S2S / Sign API allow-list keeps its 7 types,
// envelope-field-mapper.ts).
// Aramo Sign Mobile M-A12 W1-C.4 — + the profile auto-fill text types (FIRST_NAME,
// LAST_NAME, EMAIL, COMPANY, TITLE): placed by the sender, filled by the signer.
export const FIELD_TYPES = SENDER_FIELD_TYPES;
const FIELD_TYPE_SET = new Set<string>(FIELD_TYPES);
// FIELD-PARITY-1 P3 — ACKNOWLEDGEMENT was engine-only before P3 (R-2 made it authorable): a
// stored engine row of it (S2S / Sign API: no recipient or no size) sent back with its id still
// passes through unchanged, exactly as before.
const LEGACY_ENGINE_ONLY_TYPES: ReadonlySet<string> = new Set(['ACKNOWLEDGEMENT']);
// The engine field types a sender may send back unchanged with their id
// (SenderFieldPassthrough): the catalog's `engine_passthrough` surface (FIELD-PARITY-1 P1-2;
// today FIELD_TYPES + ACKNOWLEDGEMENT, 12). PAYMENT is not among them; the DB CHECK
// (`sign_store`) allows 13 (these + PAYMENT).
const ENGINE_FIELD_TYPES: ReadonlySet<string> = new Set(fieldTypesFor('engine_passthrough'));
// Client Rule Consolidation C3 — the limits and patterns below come from @aramo/sign-client
// (one copy for the server and both Sign clients).
export { MAX_SIGNERS };
export const ROUTING_MODES = ['PARALLEL', 'SEQUENTIAL'] as const;
const MAX_FIELDS = 500;
const MAX_TITLE = ENVELOPE_SUBJECT_MAX;
const EMAIL_RE = EMAIL_PATTERN;

// The Sign application's own key (SignatureEnvelope.source_application).
export { SIGN_APPLICATION } from './envelope-actions.js';

export const ENVELOPE_TABS: Record<string, readonly string[] | undefined> = {
  all: undefined,
  drafts: ['DRAFT'],
  waiting: ['SENT', 'IN_PROGRESS'],
  completed: ['COMPLETED'],
  declined: ['DECLINED'],
  voided: ['VOIDED'],
  expired: ['EXPIRED'],
  // M-A13 #13 — the web dashboard's "Declined or expired" card.
  follow_up: ['DECLINED', 'EXPIRED'],
};

function bad(requestId: string, message: string, details?: Record<string, unknown>): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, ...(details !== undefined ? { details } : {}) });
}

// Aramo Sign Mobile M-A12 W1-A — the envelope mode (API value) and the self-sign refusals.
export const ENVELOPE_MODES = ['standard', 'self'] as const;
export type EnvelopeMode = (typeof ENVELOPE_MODES)[number];

export function envelopeModeOf(env: { envelope_mode?: string | null }): EnvelopeMode {
  return env.envelope_mode === 'SELF' ? 'self' : 'standard';
}

export function selfSignSingleRecipient(requestId: string): AramoError {
  return new AramoError('VALIDATION_ERROR', 'A document you sign yourself has exactly one recipient: you', 422, {
    requestId,
    details: { reason: 'self_sign_single_recipient' },
  });
}

// M-A12 W1-A.4 — "Sign now": the caller may open a self-sign session on this envelope now
// (the same rules the session route enforces: the caller's own signing recipient, bound to
// them by Assign to me or self mode, still to sign, their turn, a Sign envelope they may act
// on, and sign:envelope:send). The verified email is re-checked when the session is issued.
export function canSelfSignNow(
  auth: Pick<AuthContextType, 'sub' | 'scopes'>,
  env: {
    status: string;
    routing_mode: string;
    created_by: string;
    source_application: string;
    expires_at?: Date | null;
    signers: ReadonlyArray<{ id: string; status: string; signing_order: number; bound_user_id: string | null; recipient_kind?: string | null; witness_for_signer_id?: string | null }>;
  },
  now: Date = new Date(),
): boolean {
  if (!auth.scopes.includes(ESIGN_SEND_SCOPE) || env.source_application !== SIGN_APPLICATION) return false;
  if (env.created_by !== auth.sub && !auth.scopes.includes(ESIGN_SCOPE.ENVELOPE_MANAGE_ALL)) return false;
  // Client Rule Consolidation C3 (D-1) — the recipient and the session checks are the ONE
  // functions EsignService.issueSelfSignSession runs under the lock (selfSignTarget,
  // sessionIssueRefusal). An in-person signer is hosted, not self-signed, and a witness waits
  // for its signer (both re-checked by the engine when the signer acts).
  const target = selfSignTarget(env.signers, auth.sub);
  if (target === null || recipientKindOf(target) === 'IN_PERSON_SIGNER' || !witnessReady(env.signers, target)) return false;
  return sessionIssueRefusal({ status: env.status, routing_mode: env.routing_mode, expires_at: env.expires_at ?? null }, env.signers, target.id, now) === null;
}

function iso(d: Date | null | undefined): string | null {
  return d === null || d === undefined ? null : d.toISOString();
}

export interface UploadDocumentBody {
  title?: unknown;
  filename?: unknown;
  content_base64?: unknown;
  // FIELD-PARITY-1 P2-5 / P2-6 — opt-in, default false (upload-field-import.ts).
  import_fields?: unknown;
  apply_text_tags?: unknown;
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
    // Retention and Purge directive (ebd41d99) W5 — the "Deleted" folder.
    @Optional() private readonly purges?: SignPurgeRepository,
    // Sign 1.14 — PAYMENT fields: availability (feature, configuration, plan) and the
    // tenant's connected account. Absent ⇒ PAYMENT is never authorable.
    @Optional() private readonly payments?: SignPaymentsGate,
    @Optional() private readonly paymentRecords?: SignPaymentRepository,
    // Feature-Parity §1.16 / §1.19 (Amendment A1) — the QES and e-stamp send guards.
    @Optional() private readonly qes?: QesWorkflowService,
    @Optional() private readonly estamp?: EstampWorkflowService,
    // Aramo Sign W2 §A3.5 — the caller's proven current email, for `awaiting_you`.
    @Optional() private readonly inbox?: RecipientInboxRepository,
    // Aramo Sign Mobile M-A12 W1-A / W1-E — the caller's Sign profile name (self mode) and
    // date-format setting (stamped at send).
    @Optional() private readonly userData?: SignUserProfileRepository,
    // M-A13 R-4 — Word to PDF conversion (absent or disabled ⇒ Word uploads keep today's refusal).
    @Optional() @Inject(WORD_CONVERSION_PORT) private readonly wordConversion?: WordConversionPort,
    // Client Rule Consolidation C1 — SIGN_PURGE_ENABLED, for the delete / restore / purge actions.
    @Optional() private readonly purgeEngine?: SignPurgeService,
    // SIGN-FREE-PARITY-1 S7 — the caller's own folders (absent ⇒ no folders: every row's folder_id is null).
    @Optional() private readonly folders?: SignFoldersService,
  ) {}

  /** Feature-Parity (Amendment A1) — the ownership check, for the QES / e-stamp sender routes. */
  async assertMayChangeEnvelope(auth: AuthContextType, envelope_id: string, requestId: string): Promise<void> {
    await this.assertMayChange(auth, envelope_id, requestId);
  }

  // SIGN-FREE-PARITY-1 S7 — move an envelope the caller can see into one of their own folders
  // (out of any other of theirs), or take it out. The envelope itself never changes.
  async moveToFolder(auth: AuthContextType, envelope_id: string, body: { folder_id?: unknown } | undefined, requestId: string) {
    const folder_id = folderIdOf(body, requestId);
    await this.assertVisible(auth, envelope_id, requestId);
    if (this.folders === undefined) throw folderNotFound(requestId);
    return this.folders.place(auth, folder_id, 'SENDER', envelope_id, requestId);
  }

  async removeFromFolder(auth: AuthContextType, envelope_id: string, requestId: string) {
    await this.assertVisible(auth, envelope_id, requestId);
    if (this.folders === undefined) return { folder_id: null };
    return this.folders.unplace(auth, 'SENDER', envelope_id);
  }

  /** Throws ENVELOPE_NOT_FOUND unless the caller can see the envelope (owner or read-all). */
  async assertVisible(auth: AuthContextType, envelope_id: string, requestId: string): Promise<void> {
    await this.describe(auth, envelope_id, requestId, false);
  }

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
  //
  // Sign Unified Product S-3 — an envelope that another application created (e.g. an ATS
  // RTR or offer letter) is visible here but its lifecycle stays with that application,
  // whose workflow depends on it. Client Rule Consolidation C1 — the check is the `change`
  // check of the envelope actions (envelope-actions.ts changeRefusal). Returns the view read.
  async assertMayChange(auth: AuthContextType, envelope_id: string, requestId: string) {
    const d = await this.describe(auth, envelope_id, requestId, false);
    enforce(changeRefusal(auth, { owner_id: d.sender.id, source_application: d.source_application }), requestId);
    return d;
  }

  // Client Rule Consolidation C1 — the request facts every envelope's `actions` share (one
  // read per request; no per-envelope query). `can_author` is the authoring route guard itself
  // (SenderContextService.assertCanAuthor — the same call every write makes; for a PERSONAL
  // tenant it opens the FREE subscription, exactly as the context read does).
  private async actionFacts(auth: AuthContextType, requestId: string): Promise<Omit<SenderActionFacts, 'deleted' | 'can_self_sign_now' | 'inbox_item'>> {
    return {
      can_author: await this.context.assertCanAuthor(auth, requestId).then(
        () => true,
        () => false,
      ),
      purge_enabled: this.purgeEngine?.enabled === true,
      in_person_available: (this.features ?? new SignFeatureGate()).isAvailable(SIGN_IN_PERSON_SIGNING_FEATURE),
    };
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

  async list(auth: AuthContextType, query: { tab?: string; q?: string; days?: string; limit?: string; folder?: string }, requestId: string) {
    const createdBy = await this.ownerFilter(auth, requestId);
    // SIGN-FREE-PARITY-1 S7 — `folder` is the Deleted folder or one of the caller's own folders.
    const folder = parseFolderParam(query.folder, requestId);
    if (folder.kind === 'user' && this.folders === undefined) throw folderNotFound(requestId);
    // Retention and Purge W5 — envelopes this tenant deleted live only in the Deleted folder.
    const deleted = this.purges !== undefined ? await this.purges.deletedEnvelopeIds({ kind: 'SENDER', key: auth.tenant_id }) : [];
    const deletedIds = new Set(deleted);
    // S7 — a user folder lists what the caller put in it, never a deleted envelope.
    const folderIds = folder.kind === 'user' && this.folders !== undefined ? (await this.folders.itemRefs(auth, folder.id, 'SENDER', requestId)).filter((id) => !deletedIds.has(id)) : null;
    const placed = this.folders !== undefined ? await this.folders.placements(auth, 'SENDER') : new Map<string, string>();
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
      ...(folder.kind === 'deleted' ? { only_ids: deleted } : folderIds !== null ? { only_ids: folderIds } : { exclude_ids: deleted }),
      limit,
    });
    const last = await this.repo.lastEventAt(auth.tenant_id, rows.map((r) => r.id));
    const counts = await this.repo.countByStatus(auth.tenant_id, createdBy);
    // W2 §A3.5 — "Waiting for you": read the proof only when some envelope is still open.
    const open = rows.some((e) => e.status === 'SENT' || e.status === 'IN_PROGRESS');
    const proof = open && this.inbox !== undefined ? await this.inbox.verifiedEmailProof(auth.sub).catch(() => null) : null;
    const now = new Date();
    const mine = await this.myInboxItemIds(auth.sub, rows, proof, now);
    // Client Rule Consolidation C1 — one facts read per page; Deleted-folder membership from
    // the id list already loaded above (no per-row query).
    const facts = await this.actionFacts(auth, requestId);
    const deletedSet = deletedIds;
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
        awaiting_you: mine.has(e.id),
        // W2 (orchestrator addition) — the signed-in user's OWN actionable inbox item for this
        // envelope: the binding id, or a fresh handle issued to this same user (redeemable only
        // by them, through the full discovery revalidation). Null when there is none to sign
        // through (e.g. assigned but neither bound nor proven, or discovery off).
        my_inbox_item_id: mine.get(e.id) ?? null,
        // M-A12 W1-A — the envelope mode and whether the caller may "Sign now".
        mode: envelopeModeOf(e),
        can_self_sign_now: canSelfSignNow(auth, e),
        purge: purgeViewOf(e),
        // SIGN-FREE-PARITY-1 S7 — the caller's own folder holding this envelope, or null.
        folder_id: placed.get(e.id) ?? null,
        // C1 — what the caller may do with this envelope (envelope-actions.ts).
        actions: senderActions(auth, actionEnvelopeOf(e), {
          ...facts,
          deleted: deletedSet.has(e.id),
          can_self_sign_now: canSelfSignNow(auth, e),
          inbox_item: (mine.get(e.id) ?? null) !== null,
        }),
      })),
      counts,
    };
  }

  // The sender detail returned to the client: page sizes are filled for documents
  // uploaded before they were stored (Sign Mobile D-W6-2).
  //
  // Client Rule Consolidation C1 — the detail carries `actions` (the internal describe reads do
  // not: they never reach a client).
  async detail(auth: AuthContextType, envelope_id: string, requestId: string) {
    const { view, env } = await this.describeWith(auth, envelope_id, requestId, true);
    const actions: SenderActions = await this.actionsOf(auth, env, requestId);
    // Client Rule Consolidation C3 (audit row 13) — which in-person signer the caller may host
    // now: the host_in_person action AND the per-recipient rule the hosted-session route
    // enforces (envelope-actions.ts hostableRecipient). Clients never re-derive it.
    const actionEnv = actionEnvelopeOf(env);
    const now = new Date();
    const recipients = view.recipients.map((r) => {
      const row = actionEnv.recipients.find((x) => x.id === r.id);
      return { ...r, hostable: actions.host_in_person && row !== undefined && hostableRecipient(actionEnv, row, now) };
    });
    // SIGN-FREE-PARITY-1 S7 — the caller's own folder holding this envelope, or null.
    const folder_id = this.folders !== undefined ? ((await this.folders.placements(auth, 'SENDER')).get(env.id) ?? null) : null;
    return { ...view, recipients, actions, folder_id };
  }

  // C1 — the detail's `actions`: the request facts, this tenant's Deleted-folder membership
  // (only while purge is enabled — otherwise delete / restore are refused anyway), and the
  // caller's inbox item while signing is open.
  private async actionsOf(auth: AuthContextType, env: Awaited<ReturnType<EsignSenderRepository['getEnvelopeDetail']>>, requestId: string): Promise<SenderActions> {
    const facts = await this.actionFacts(auth, requestId);
    const deleted = this.purges !== undefined && facts.purge_enabled ? await this.purges.isDeletedBy(env.id, { kind: 'SENDER', key: auth.tenant_id }) : false;
    let inbox_item = false;
    if ((env.status === 'SENT' || env.status === 'IN_PROGRESS') && this.inbox !== undefined) {
      const proof = await this.inbox.verifiedEmailProof(auth.sub).catch(() => null);
      inbox_item = ((await this.myInboxItemIds(auth.sub, [env], proof, new Date())).get(env.id) ?? null) !== null;
    }
    return senderActions(auth, actionEnvelopeOf(env), { ...facts, deleted, can_self_sign_now: canSelfSignNow(auth, env), inbox_item });
  }

  // `fillPages` false for the internal visibility / readiness reads, which never
  // need page sizes (no source fetch on those paths).
  private async describe(auth: AuthContextType, envelope_id: string, requestId: string, fillPages: boolean) {
    return (await this.describeWith(auth, envelope_id, requestId, fillPages)).view;
  }

  // The view and the envelope row it was built from (C1 — the detail's `actions` read the row's
  // signers without a second fetch).
  private async describeWith(auth: AuthContextType, envelope_id: string, requestId: string, fillPages: boolean) {
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
    // M-A12 W1-A — a SELF envelope invites no one, so no one is reminded.
    // Client Rule Consolidation C1 — the one remind rule (envelope-actions.ts canRemindRecipient).
    const remindable = { status: env.status, envelope_mode: env.envelope_mode ?? null, routing_mode: env.routing_mode, recipients: env.signers };
    const canRemind = (s: { id: string; status: string; signing_order: number; recipient_kind?: string | null; witness_for_signer_id?: string | null }): boolean => canRemindRecipient(remindable, s);
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
    const reminderAvailableAt = (s: { id: string; status: string; signing_order: number; recipient_kind?: string | null; witness_for_signer_id?: string | null }): string | null => {
      if (!canRemind(s)) return null;
      const signerNext = nextReminderAt(history, s.id, now, SIGN_REMINDER_LIMITS);
      const later = [envelopeNext, signerNext].filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0];
      return later === undefined ? null : later.toISOString();
    };
    const view = {
      id: env.id,
      subject: env.subject,
      status: env.status,
      // Retention and Purge directive W4/W5 — null until queued for purge.
      purge: purgeViewOf(env as { purge_state?: string | null; purge_level?: string | null; purge_due_at?: Date | null; purge_executed_at?: Date | null }),
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
      // Feature-Parity §1.17 — whether a signer may delegate (set in DRAFT, fixed at send).
      allow_delegation: env.allow_delegation,
      // SIGN-FREE-PARITY-1 S4 — automatic reminders: the sender's switch, how many went, and
      // when the next one goes (only while signing is open and one is planned).
      auto_reminders: {
        enabled: env.auto_reminders_enabled,
        sent_count: env.auto_reminder_count,
        max_count: AUTO_REMINDER_CADENCE.max_count,
        next_at: open && env.auto_reminders_enabled ? iso(env.next_auto_reminder_at) : null,
      },
      // Aramo Sign Mobile M-A12 W1-A — standard | self, and whether the caller may "Sign now"
      // (open a self-sign session) on this envelope.
      mode: envelopeModeOf(env),
      can_self_sign_now: canSelfSignNow(auth, env),
      // M-A12 W1-E.2 — the SIGN_DATE format stamped at send (null before send: the sender's
      // setting applies when the envelope is sent).
      date_format: env.signer_date_format ?? null,
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
        // Feature-Parity §1.17 — the recipient a WITNESS attests for (null otherwise).
        witness_for_signer_id: isWitness(s) ? s.witness_for_signer_id : null,
        // §1.9 — whether an access code is set and whether the recipient is locked out
        // (the code and its hash are never returned).
        access_code_set: (s.access_code_hash ?? null) !== null,
        access_code_locked: (s.access_code_locked_at ?? null) !== null,
        // §1.17 — the original recipient of a delegated slot (this row now names the delegate).
        delegated_from:
          s.delegated_at instanceof Date ? { name: s.delegated_from_name ?? null, email: s.delegated_from_email ?? null, delegated_at: s.delegated_at.toISOString() } : null,
        // Feature-Parity §1.9 — the recipient's identity-verification method (null = none) and
        // whether verification locked them out (failed name match or every attempt used).
        identity_verification_method: s.identity_verification_method ?? null,
        identity_verification_locked: s.identity_verification_locked_at !== null,
      })),
      fields: env.documents.flatMap((d) =>
        d.fields.map((f) => ({
          id: f.id,
          // FIELD-PARITY-2 B-1 — the field's stable key (null on a legacy field): the editor's id.
          field_key: f.field_key ?? null,
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
          // Sign 1.14 — PAYMENT only (null for every other type).
          payment_amount_minor: f.payment_amount_minor ?? null,
          payment_currency: f.payment_currency ?? null,
          // FIELD-PARITY-1 P3 §6.2 — the field settings (null / false where not set).
          tooltip: f.tooltip ?? null,
          placeholder: f.placeholder ?? null,
          read_only: f.read_only === true,
          sender_filled: f.sender_filled === true,
          validation: f.validation ?? null,
          font_size: f.font_size ?? null,
          data_name: f.data_name ?? null,
          options: f.options ?? null,
          // FIELD-PARITY-2 B-2 — "show only when" (null = always shown).
          condition: f.condition ?? null,
          // S-5 — the sender's own value of a sender-filled field (null for every other field:
          // a signer's value is never returned here).
          value: f.sender_filled === true ? (f.value ?? null) : null,
        })),
      ),
      // FIELD-PARITY-1 P3 S-5 (ruling R-3) — whether sender-filled fields are switched on
      // (SIGN_SENDER_FILLED_FIELDS_ENABLED); false: the editors do not offer them.
      sender_filled_fields_enabled: senderFilledFieldsEnabled(process.env),
    };
    return { view, env };
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
      if (!EMAIL_RE.test(email) || email.length > EMAIL_MAX) throw bad(requestId, 'A contact needs a valid email', { field: 'email', reason: 'invalid_contact_email' });
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

  // Aramo Sign Mobile M-A12 W1-C.2 — the version key and a byte loader for a document the
  // caller may view (the same visibility as the source route: another tenant's envelope,
  // another member's envelope without read-all, or a document not in this envelope reads
  // as not found). The version is the stored source sha256 (or the frozen revision ref).
  async documentVersion(auth: AuthContextType, envelope_id: string, document_id: string, requestId: string): Promise<{ version: string; load: () => Promise<Uint8Array> }> {
    await this.describe(auth, envelope_id, requestId, false);
    const doc = await this.repo.getDocument(auth.tenant_id, envelope_id, document_id);
    const version = doc.source_sha256 ?? doc.document_revision_ref ?? doc.id;
    return {
      version,
      load: () =>
        this.sources.getSourcePdf({
          tenant_id: auth.tenant_id,
          source_mode: doc.source_mode as EnvelopeDocumentSourceMode,
          document_ref: doc.document_ref,
          document_revision_ref: doc.document_revision_ref,
          source_object_key: doc.source_object_key,
        }),
    };
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
    // C1 — the download / certificate rule (a completed envelope whose documents were not purged).
    enforce(downloadStateRefusal({ status: d.status, purge_state: d.purge?.state ?? null }, envelope_id), requestId);
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
    const evidence = await this.provider.getEvidence(auth.tenant_id, envelope_id);
    // UAT CMP-05 (PO 2026-11-18) — event_chain_hash is the chain now (it grows after
    // completion: certificate, custody, copies); the certificate cites the chain at completion.
    // Both are returned, so the page shows the value printed on the certificate.
    const certificate_event_chain_hash = await this.repo.certificateChainHash(auth.tenant_id, envelope_id);
    return { ...evidence, certificate_event_chain_hash };
  }

  // ── DRAFT authoring ────────────────────────────────────────────────────────

  // Aramo Sign Mobile M-A12 W1-A — `mode: "self"` creates a draft whose one recipient is the
  // caller: a SIGNER the server creates from the caller's verified account email and binds
  // to them (bound_user_id = auth.sub, never client-supplied). Client-supplied recipients
  // are refused (422 self_sign_single_recipient); no verified email ⇒ 403.
  async create(auth: AuthContextType, body: { subject?: unknown; mode?: unknown; recipients?: unknown }, requestId: string) {
    await this.context.assertCanAuthor(auth, requestId);
    const modeRaw = body?.mode ?? 'standard';
    if (typeof modeRaw !== 'string' || !(ENVELOPE_MODES as readonly string[]).includes(modeRaw)) {
      throw bad(requestId, 'mode must be standard or self', { field: 'mode', reason: 'invalid_mode' });
    }
    const mode = modeRaw as EnvelopeMode;
    const subject = typeof body?.subject === 'string' && body.subject.trim().length > 0 ? body.subject.trim() : 'Untitled envelope';
    if (subject.length > MAX_TITLE) throw bad(requestId, `subject must be at most ${MAX_TITLE} characters`);
    if (mode === 'standard') {
      const env = await this.repo.createDraft({ tenant_id: auth.tenant_id, subject, created_by: auth.sub });
      return { id: env.id, status: env.status, subject: env.subject, mode };
    }
    if (body?.recipients !== undefined) throw selfSignSingleRecipient(requestId);
    const me = await this.selfRecipient(auth, requestId);
    const env = await this.repo.createDraft({ tenant_id: auth.tenant_id, subject, created_by: auth.sub, envelope_mode: 'SELF' });
    await this.repo.replaceDraftRecipients({
      tenant_id: auth.tenant_id,
      envelope_id: env.id,
      recipients: [{ name: me.name, email: me.email, recipient_kind: 'SIGNER', copy_delivery: null, bound_user_id: auth.sub, witness_for_index: null }],
    });
    return { id: env.id, status: env.status, subject: env.subject, mode };
  }

  // M-A12 W1-A — the caller as their own recipient: the verified account email (as stored)
  // and the Sign profile display name, else the account display name, else the email.
  async selfRecipient(auth: AuthContextType, requestId: string): Promise<{ name: string; email: string }> {
    const verified = await this.verifiedAccountEmail(auth);
    const user = verified === null ? null : await this.identity.findUserById(auth.sub).catch(() => null);
    const email = user?.email?.trim() ?? '';
    if (verified === null || email.length === 0 || !EMAIL_RE.test(email)) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Signing a document yourself needs a verified account email', 403, {
        requestId,
        details: { reason: 'self_sign_email_unverified' },
      });
    }
    const profileName = (await this.userData?.getProfile(auth.tenant_id, auth.sub).catch(() => null))?.display_name ?? null;
    const names = [profileName, user?.display_name ?? null, email];
    const name = (names.find((n): n is string => typeof n === 'string' && n.trim().length > 0) ?? email).trim().slice(0, MAX_TITLE);
    return { name, email };
  }

  async update(
    auth: AuthContextType,
    envelope_id: string,
    body: { subject?: unknown; routing_mode?: unknown; message?: unknown; allow_delegation?: unknown; auto_reminders_enabled?: unknown },
    requestId: string,
    ifMatch?: string,
  ) {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    const hasSubject = body?.subject !== undefined;
    const hasRouting = body?.routing_mode !== undefined;
    // Sign Mobile M-A3 §3 — the sender message (DRAFT only; null or "" clears it).
    const hasMessage = body?.message !== undefined;
    // Feature-Parity §1.17 — the sender allows delegation (Business and up; dark until flipped).
    const hasDelegation = body?.allow_delegation !== undefined;
    // SIGN-FREE-PARITY-1 S4 — automatic reminders while drafting (default on; all plans).
    const hasAutoReminders = body?.auto_reminders_enabled !== undefined;
    if (!hasSubject && !hasRouting && !hasMessage && !hasDelegation && !hasAutoReminders) {
      throw bad(requestId, 'subject, routing_mode, message, allow_delegation or auto_reminders_enabled is required');
    }
    if (hasAutoReminders && typeof body.auto_reminders_enabled !== 'boolean') {
      throw bad(requestId, 'auto_reminders_enabled must be true or false', { field: 'auto_reminders_enabled' });
    }
    if (hasDelegation) {
      if (typeof body.allow_delegation !== 'boolean') throw bad(requestId, 'allow_delegation must be true or false', { field: 'allow_delegation' });
      if (body.allow_delegation) await this.assertBusinessFeature(auth, SIGN_DELEGATE_SIGNING_FEATURE, requestId);
    }
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
      ...(hasDelegation ? { allow_delegation: body.allow_delegation as boolean } : {}),
      ...(hasAutoReminders ? { auto_reminders_enabled: body.auto_reminders_enabled as boolean } : {}),
      ...(expected !== undefined ? { expected_revision: expected } : {}),
    });
    return this.detail(auth, envelope_id, requestId);
  }

  // SIGN-FREE-PARITY-1 S4 (FP-R5) — turn automatic reminders on or off while drafting or after
  // sending (PATCH envelopes/:id/reminders). The same authority and If-Match rule as void; a
  // closed envelope (completed, declined, voided, expired) or a self-signed one is refused.
  async setAutoReminders(auth: AuthContextType, envelope_id: string, body: { auto_reminders_enabled?: unknown }, requestId: string, ifMatch?: string) {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    const enabled = body?.auto_reminders_enabled;
    if (typeof enabled !== 'boolean') throw bad(requestId, 'auto_reminders_enabled must be true or false', { field: 'auto_reminders_enabled' });
    const env = await this.repo.getEnvelopeDetail(auth.tenant_id, envelope_id);
    enforce(remindModeRefusal(env), requestId);
    if (!canSetAutoReminders({ status: env.status })) {
      throw new AramoError('ESIGN_REMINDER_NOT_ALLOWED', 'Automatic reminders can be changed only before the envelope is finished', 409, {
        requestId,
        details: { reason: 'envelope_closed', status: env.status },
      });
    }
    await this.provider.setAutoReminders(auth.tenant_id, envelope_id, enabled, expected !== undefined ? { expected_revision: expected } : {});
    return this.detail(auth, envelope_id, requestId);
  }

  // Feature-Parity §1.17 — witness and delegate signing are Business-and-up features
  // (B+), dark until the PO makes them AVAILABLE. Refused 403 otherwise.
  private async assertBusinessFeature(auth: AuthContextType, feature_key: string, requestId: string): Promise<void> {
    (this.features ?? new SignFeatureGate()).assertAvailable(feature_key, requestId);
    if ((await this.context.tenantKind(auth.tenant_id, requestId)) !== 'BUSINESS') {
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'This feature is available on Business plans', 403, { requestId, details: { feature_key, reason: 'plan_not_eligible' } });
    }
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
    const importOpts = uploadImportOptions(body, requestId);
    // M-A3 §8 — PDF only; a Word document is refused with a stable reason.
    // M-A13 R-4 — unless Word conversion is on: a .docx / .doc is converted to PDF and the
    // PDF becomes the source (the Word file is never stored); the title keeps the file name.
    const words = this.wordConversion ?? disabledWordConversion;
    const fname = typeof body.filename === 'string' ? body.filename.toLowerCase() : '';
    const word = isWordFilename(fname);
    if (/\.(dotx?|rtf|odt)$/.test(fname) || (word && !words.enabled)) throw bad(requestId, 'Only PDF files can be signed. Save the document as a PDF and upload it again.', { reason: 'unsupported_file_type' });
    const given = typeof body.filename === 'string' && body.filename.length > 0 ? body.filename : 'document.pdf';
    const filename = word ? `${given.replace(/\.(docx|doc)$/i, '')}.pdf` : given;
    const rawTitle = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : filename.replace(/\.pdf$/i, '');
    const title = rawTitle.slice(0, MAX_TITLE);
    let bytes: Uint8Array = new Uint8Array(Buffer.from(body.content_base64, 'base64'));
    if (word) bytes = await this.convertWord(words, bytes, given, requestId);
    else if (isWordDocument(bytes)) throw bad(requestId, 'Only PDF files can be signed. Save the document as a PDF and upload it again.', { reason: 'unsupported_file_type' });
    const gate = async (b: Uint8Array): Promise<Uint8Array> => {
      try {
        return await this.safePdf.accept(b);
      } catch (e) {
        if (e instanceof UnsafePdfError) throw bad(requestId, `This file can't be used: ${e.message}`, { reason: 'unsafe_pdf', pdf_problem: e.problem });
        throw e;
      }
    };
    // FIELD-PARITY-1 P2-5 / P2-6 — the opt-in field import (both flags OFF: the gate alone,
    // exactly as before).
    const importing = importOpts.import_fields || importOpts.apply_text_tags;
    let accepted: Uint8Array;
    let imported: { rows: BoundImportedField[]; warnings: FieldImportWarning[]; stripped: string[] } | null = null;
    if (!importing) {
      accepted = await gate(bytes);
    } else {
      const env = await this.repo.getEnvelopeDetail(auth.tenant_id, envelope_id);
      const existing = env.documents.flatMap((d) => d.fields);
      const found = await importUploadFields(bytes, importOpts, new Set(existing.flatMap((f) => (f.group_key === null ? [] : [f.group_key]))), gate, requestId);
      accepted = found.bytes;
      const recipients = signingRecipients(env.signers).map((r) => ({ id: r.id, name: r.name, email: r.email, signer_role: r.signer_role }));
      const room = Math.max(0, MAX_FIELDS - existing.length);
      const bound = bindImportedFields(found.fields.slice(0, room), recipients, requestId);
      const warnings = [...found.warnings, ...bound.warnings];
      if (found.fields.length > room) warnings.push({ code: 'too_many_fields', message: `An envelope holds at most ${MAX_FIELDS} fields; ${found.fields.length - room} found fields were not added.` });
      imported = { rows: bound.rows, warnings, stripped: found.stripped };
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
        ...(imported !== null && imported.rows.length > 0 ? { fields: imported.rows.map(fieldRowOf) } : {}),
        ...(expected !== undefined ? { expected_revision: expected } : {}),
      });
    } catch (e) {
      await this.storageGate.release(auth.tenant_id, plannedKey).catch(() => undefined);
      throw e;
    }
    // Sign Mobile D-W6-1 — the envelope revision after this upload (the controller
    // sets ETag "{envelope_id}.{revision}"), so the next write chains its If-Match.
    const out = { id: row.id, envelope_id, title: row.title, ordinal: row.ordinal, byte_size: row.byte_size, page_count: pages.length, pages, revision: row.revision };
    if (imported === null) return out;
    // FIELD-PARITY-1 P2-5 / P2-6 — only when a flag was set: the fields created and why
    // anything found was not (or was differently) imported.
    const ids = row.field_ids ?? [];
    return {
      ...out,
      field_import: {
        fields: imported.rows.map((f, i) => ({
          id: ids[i] ?? null,
          source: f.source,
          source_name: f.name,
          envelope_document_id: row.id,
          signer_id: f.signer_id,
          field_type: f.field_type,
          page_number: f.page_number,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          required: f.required,
          label: f.label,
          group_key: f.group_key,
          group_rule: f.group_rule,
          min_selected: f.min_selected,
          name_mode: f.name_mode,
          options: f.options,
        })),
        warnings: imported.warnings,
        stripped: imported.stripped,
      },
    };
  }

  // M-A13 R-4 — the Word refusals carry details.reason (too large 413; password-protected
  // and could-not-convert 422) so the apps show a plain message.
  private async convertWord(words: WordConversionPort, bytes: Uint8Array, filename: string, requestId: string): Promise<Uint8Array> {
    try {
      return await words.convert({ bytes, filename });
    } catch (e) {
      if (!(e instanceof WordConversionError)) throw e;
      const message =
        e.reason === 'word_too_large'
          ? 'This Word file is over 20 MB.'
          : e.reason === 'word_password_protected'
            ? 'This Word file is password-protected. Remove the password, then try again.'
            : "We couldn't convert this Word file. Save it as a PDF, then choose the PDF.";
      throw new AramoError('VALIDATION_ERROR', message, e.reason === 'word_too_large' ? 413 : 422, { requestId, details: { reason: e.reason } });
    }
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
    const current = await this.assertMayChange(auth, envelope_id, requestId);
    // C1 — the delete_draft rule; the repository re-checks DRAFT under the row lock.
    enforce(deleteDraftStateRefusal(current), requestId);
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
    // M-A12 W1-A — a self-sign envelope's one recipient is fixed by the server.
    if ((await this.repo.getEnvelopeDetail(auth.tenant_id, envelope_id)).envelope_mode === 'SELF') throw selfSignSingleRecipient(requestId);
    if (!Array.isArray(body?.recipients)) throw bad(requestId, 'recipients must be an array');
    // M-A5 §1.4 — at most MAX_SIGNERS signing recipients and MAX_COPY_RECIPIENTS copies.
    if (body.recipients.length > MAX_SIGNERS + MAX_COPY_RECIPIENTS) {
      throw bad(requestId, `An envelope can have at most ${MAX_SIGNERS} signers`, { reason: 'too_many_signers', max: MAX_SIGNERS });
    }
    const seen = new Set<string>();
    let verifiedEmail: string | null | undefined;
    const recipients: Array<{
      id?: string;
      name: string;
      email: string | null;
      recipient_kind: RecipientKind;
      copy_delivery: CopyDelivery | null;
      bound_user_id: string | null;
      witness_for_index: number | null;
      access_code_hash?: string | null;
      identity_verification_method?: IdentityVerificationMethod | null;
    }> = [];
    const list = body.recipients as unknown[];
    for (const [i, r] of list.entries()) {
      const o = (r ?? {}) as Record<string, unknown>;
      const name = typeof o['name'] === 'string' ? o['name'].trim() : '';
      // M-A5 §1.7 — no recipient_kind ⇒ SIGNER (every existing client).
      const kindRaw = o['recipient_kind'] ?? 'SIGNER';
      if (typeof kindRaw !== 'string' || !(RECIPIENT_KINDS as readonly string[]).includes(kindRaw)) {
        throw bad(requestId, `recipient ${i + 1}: recipient_kind must be SIGNER, IN_PERSON_SIGNER, RECEIVES_COPY or WITNESS`, { index: i, field: 'recipient_kind', reason: 'invalid_recipient_kind' });
      }
      const kind = kindRaw as RecipientKind;
      // Feature-Parity §1.17 — a WITNESS names the signing recipient it attests for by list position.
      const witnessFor = this.witnessForIndex(o, kind, i, list, requestId);
      if (kind === 'WITNESS') await this.assertBusinessFeature(auth, SIGN_WITNESS_SIGNING_FEATURE, requestId);
      // §1.9 — the access code: a string sets it, null clears it, omitted keeps it.
      const accessCodeHash = this.accessCodeHashOf(o, kind, i, requestId);
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
      if (email !== null && (!EMAIL_RE.test(email) || email.length > EMAIL_MAX)) throw bad(requestId, `recipient ${i + 1} needs a valid email`, { index: i, field: 'email' });
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
      // Feature-Parity §1.9 — a value sets the method, null clears it, omitted keeps it.
      const idv = await this.identityVerificationMethodOf(auth, o, kind, i, requestId);
      recipients.push({
        ...(id !== undefined ? { id } : {}),
        name,
        email,
        recipient_kind: kind,
        copy_delivery: kind === 'RECEIVES_COPY' ? (cdRaw as CopyDelivery) : null,
        bound_user_id: bound,
        witness_for_index: witnessFor,
        ...(accessCodeHash !== undefined ? { access_code_hash: accessCodeHash } : {}),
        ...(idv !== undefined ? { identity_verification_method: idv } : {}),
      });
    }
    // §1.17 — one witness per signer.
    const witnessed = recipients.flatMap((r) => (r.witness_for_index === null ? [] : [r.witness_for_index]));
    if (new Set(witnessed).size !== witnessed.length) throw bad(requestId, 'A signer can have only one witness', { field: 'witness_for_index', reason: 'witness_duplicate' });
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

  // Feature-Parity §1.17 — witness_for_index: required for a WITNESS (and refused for any
  // other kind), an integer position in the same list naming a SIGNER or IN_PERSON_SIGNER
  // other than the witness. The signing-order rule (a witness signs after its signer when
  // the envelope signs in order) is checked at send (readiness).
  private witnessForIndex(o: Record<string, unknown>, kind: RecipientKind, i: number, list: readonly unknown[], requestId: string): number | null {
    const raw = o['witness_for_index'];
    if (kind !== 'WITNESS') {
      if (raw !== undefined && raw !== null) throw bad(requestId, `recipient ${i + 1}: witness_for_index applies only to a witness`, { index: i, field: 'witness_for_index', reason: 'witness_for_not_allowed' });
      return null;
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw >= list.length || raw === i) {
      throw bad(requestId, `recipient ${i + 1}: choose the signer this witness attests for`, { index: i, field: 'witness_for_index', reason: 'witness_for_required' });
    }
    const target = (list[raw] ?? {}) as Record<string, unknown>;
    const targetKind = target['recipient_kind'] ?? 'SIGNER';
    if (targetKind !== 'SIGNER' && targetKind !== 'IN_PERSON_SIGNER') {
      throw bad(requestId, `recipient ${i + 1}: a witness attests for a signer`, { index: i, field: 'witness_for_index', reason: 'witness_for_invalid' });
    }
    return raw;
  }

  // Feature-Parity §1.9 — the access code of one recipient, hashed (never stored or
  // returned as text). undefined = omitted (keep); null = clear. SIGNER and WITNESS only.
  private accessCodeHashOf(o: Record<string, unknown>, kind: RecipientKind, i: number, requestId: string): string | null | undefined {
    const raw = o['access_code'];
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    (this.features ?? new SignFeatureGate()).assertAvailable(SIGN_ACCESS_CODE_FEATURE, requestId);
    if (kind !== 'SIGNER' && kind !== 'WITNESS') {
      throw bad(requestId, `recipient ${i + 1}: an access code applies to a recipient who signs through a link`, { index: i, field: 'access_code', reason: 'access_code_not_allowed' });
    }
    const code = normalizeAccessCode(raw);
    if (code === null) {
      throw bad(requestId, `recipient ${i + 1}: the access code must be ${ACCESS_CODE_MIN_LENGTH} to ${ACCESS_CODE_MAX_LENGTH} printable characters`, {
        index: i,
        field: 'access_code',
        reason: 'access_code_invalid',
      });
    }
    return hashAccessCode(code);
  }

  // Feature-Parity §1.9 + A1 — government-ID verification and KBA are Professional and
  // Enterprise metered features (§1.9 "Plans"), DARK until the PO flips sign.id_verification /
  // sign.kba to AVAILABLE. Setting a method is refused 403 while the feature is not available
  // or for a Personal account; clearing (null) is always allowed. Link signers only.
  private async identityVerificationMethodOf(
    auth: AuthContextType,
    o: Record<string, unknown>,
    kind: RecipientKind,
    i: number,
    requestId: string,
  ): Promise<IdentityVerificationMethod | null | undefined> {
    const raw = o['identity_verification_method'];
    if (raw === undefined || raw === null) return raw;
    if (typeof raw !== 'string' || !(IDENTITY_VERIFICATION_METHODS as readonly string[]).includes(raw)) {
      throw bad(requestId, `recipient ${i + 1}: identity_verification_method must be ID_VERIFICATION, KBA or null`, { index: i, field: 'identity_verification_method', reason: 'invalid_identity_verification_method' });
    }
    if (kind === 'RECEIVES_COPY' || kind === 'IN_PERSON_SIGNER') {
      throw bad(requestId, `recipient ${i + 1}: only a signer who signs from a link can be asked to verify their identity`, { index: i, field: 'identity_verification_method', reason: 'identity_verification_not_link_signer' });
    }
    const feature_key = raw === 'KBA' ? SIGN_KBA_FEATURE : SIGN_ID_VERIFICATION_FEATURE;
    (this.features ?? new SignFeatureGate()).assertAvailable(feature_key, requestId);
    if ((await this.context.tenantKind(auth.tenant_id, requestId)) !== 'BUSINESS') {
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Identity verification is available on Business plans', 403, { requestId, details: { feature_key, reason: 'plan_not_eligible' } });
    }
    return raw as IdentityVerificationMethod;
  }

  async replaceFields(auth: AuthContextType, envelope_id: string, body: { fields?: unknown }, requestId: string, ifMatch?: string) {
    await this.context.assertCanAuthor(auth, requestId);
    const expected = expectedRevision(auth, ifMatch, envelope_id, requestId);
    await this.assertMayChange(auth, envelope_id, requestId);
    if (!Array.isArray(body?.fields)) throw bad(requestId, 'fields must be an array');
    if (body.fields.length > MAX_FIELDS) throw bad(requestId, `at most ${MAX_FIELDS} fields`);
    const current = await this.repo.getEnvelopeDetail(auth.tenant_id, envelope_id);
    const copyIds = new Set(current.signers.filter(isCopyRecipient).map((s) => s.id));
    // Sign 1.14 — a PAYMENT field is authorable only while payments are available to this
    // tenant (sign.payments AVAILABLE, Connect configured, plan Professional/Enterprise).
    if (body.fields.some((f: unknown) => ((f ?? {}) as Record<string, unknown>)['field_type'] === PAYMENT_FIELD_TYPE)) {
      if (this.payments === undefined) throw paymentsNotAvailable(requestId, 'payments_not_configured');
      await this.payments.assertAvailable(auth.tenant_id, requestId);
    }
    const fields = body.fields.map((f: unknown, i: number): SenderFieldInput => {
      const o = (f ?? {}) as Record<string, unknown>;
      const num = (k: string): number => {
        const v = o[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(requestId, `field ${i + 1}: ${k} must be a number`, { index: i, field: k });
        return v;
      };
      const field_type = o['field_type'];
      if (
        typeof field_type === 'string' &&
        LEGACY_ENGINE_ONLY_TYPES.has(field_type) &&
        typeof o['id'] === 'string' &&
        o['id'].length > 0 &&
        (o['signer_id'] === null || o['signer_id'] === undefined || o['width'] === null || o['width'] === undefined || o['height'] === null || o['height'] === undefined)
      ) {
        return passthroughField(o, field_type, i, requestId);
      }
      if (typeof field_type !== 'string' || (!FIELD_TYPE_SET.has(field_type) && field_type !== PAYMENT_FIELD_TYPE)) {
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
      const config = { ...fieldConfig(o, field_type, i, requestId), ...paymentConfig(o, field_type, i, requestId) };
      // FIELD-PARITY-2 B-1 — the editor's id as the field's stable key (absent / NULL: none).
      let field_key: string | null = null;
      if (o['field_key'] !== undefined && o['field_key'] !== null) {
        if (!isFieldKey(o['field_key'])) throw bad(requestId, `field ${i + 1}: field_key is 1 to ${FIELD_KEY_MAX} characters`, { index: i, field: 'field_key', reason: 'field_key_invalid' });
        field_key = o['field_key'];
      }
      return {
        ...config,
        field_key,
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
    onePaymentPerSigner(fields, requestId);
    // FIELD-PARITY-2 B-10 (ruling C-7) — no conditions in self-sign: the sender is the signer and
    // has nothing to branch on. Refused (condition_invalid), never silently dropped.
    if (envelopeModeOf(current) === 'self') {
      const index = fields.findIndex((f) => f.condition !== undefined && f.condition !== null);
      if (index >= 0) throw bad(requestId, `field ${index + 1}: a self-sign field cannot be conditional`, { index, field: 'condition', reason: 'condition_invalid' });
    }
    // FIELD-PARITY-2 B-1 / B-3 — a key names one field of the envelope, and every condition holds
    // the one cross-field rule (@aramo/sign-fields fieldConditionIssues).
    fieldConditions(fields, requestId);
    // (FIELD-PARITY-1 P3 S-5 — sender values were checked per field by fieldConfig.)
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
      await this.repo.replaceDraftFields({ tenant_id: auth.tenant_id, envelope_id, fields, actor_ref: auth.sub, ...(expected !== undefined ? { expected_revision: expected } : {}) });
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
  readiness(
    d: Pick<Awaited<ReturnType<SenderEnvelopeService['describe']>>, 'documents' | 'recipients' | 'fields'> & { routing_mode?: string },
  ): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    // Feature-Parity §1.17 — when signing in order, a witness comes after the signer it witnesses.
    for (const r of d.recipients as Array<{ id: string; name: string; recipient_kind?: string | null; witness_for_signer_id?: string | null; signing_order?: number }>) {
      if (!isWitness(r)) continue;
      const principal = d.recipients.find((x) => x.id === r.witness_for_signer_id) as { name: string; signing_order?: number } | undefined;
      if (principal === undefined) problems.push(`${r.name} needs a signer to witness`);
      else if (d.routing_mode === 'SEQUENTIAL' && (r.signing_order ?? 0) <= (principal.signing_order ?? 0)) problems.push(`${r.name} witnesses ${principal.name} and must sign after them`);
    }
    if (d.documents.length === 0) problems.push('Add at least one document');
    if (signingRecipients(d.recipients).length === 0) problems.push('Add at least one recipient who signs');
    for (const r of d.recipients) {
      if (isCopyRecipient(r)) {
        if (d.fields.some((f) => f.signer_id === r.id)) problems.push(`${r.name} receives a copy and cannot have fields`);
        continue;
      }
      // FIELD-PARITY-2 C-6 (amends 2.1-8) — a signature field that is always shown: a conditional
      // SIGNATURE may never be shown, so it does not count.
      const always = (f: { condition?: unknown }): boolean => f.condition === undefined || f.condition === null;
      if (!d.fields.some((f) => f.signer_id === r.id && f.field_type === 'SIGNATURE' && always(f as { condition?: unknown }))) problems.push(`${r.name} needs a signature field`);
    }
    // FIELD-PARITY-1 P3 S-5 — a required field the sender fills needs the sender's value (a
    // radio group: one chosen option) before the envelope can be sent.
    const senderFields = (d.fields as ReadonlyArray<{ field_type: string; required: boolean; sender_filled?: boolean; value?: string | null; label?: string | null; group_key?: string | null }>).filter(
      (f) => f.sender_filled === true && f.required,
    );
    const radioDone = new Set(senderFields.filter((f) => f.field_type === 'RADIO' && f.value === 'true').map((f) => f.group_key));
    const missing = new Set<string>();
    for (const f of senderFields) {
      const filled = f.field_type === 'RADIO' ? radioDone.has(f.group_key) : f.field_type === 'CHECKBOX' ? f.value === 'true' : typeof f.value === 'string' && f.value.trim().length > 0;
      if (!filled) missing.add(f.field_type === 'RADIO' ? `radio group ${f.group_key ?? ''}` : (f.label ?? f.field_type.toLowerCase()));
    }
    for (const m of missing) problems.push(`Fill in ${m} before sending`);
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
    let d = await this.assertMayChange(auth, envelope_id, requestId);
    // C1 — the send rule (envelope-actions.ts).
    enforce(sendStateRefusal(d), requestId);
    if (typeof body?.subject === 'string' && body.subject.trim().length > 0 && body.subject.trim() !== d.subject) {
      const rev = await this.repo.updateDraft({ tenant_id: auth.tenant_id, envelope_id, subject: body.subject.trim().slice(0, MAX_TITLE), ...(expected !== undefined ? { expected_revision: expected } : {}) });
      if (expected !== undefined) expected = rev;
      d = await this.describe(auth, envelope_id, requestId, false);
    }
    const ready = this.readiness(d);
    if (!ready.ok) throw bad(requestId, 'This envelope is not ready to send', { reason: 'not_ready', problems: ready.problems });
    // Sign 1.14 — an envelope that collects a payment is sent only while payments are
    // available and the organization's Stripe account can take them (charges enabled).
    if (d.fields.some((f) => f.field_type === PAYMENT_FIELD_TYPE)) {
      if (this.payments === undefined) throw paymentsNotAvailable(requestId, 'payments_not_configured');
      await this.payments.assertAvailable(auth.tenant_id, requestId);
      const account = await this.paymentRecords?.connectedAccount(auth.tenant_id);
      if (account === undefined || account === null || !account.charges_enabled) {
        throw bad(requestId, 'This envelope is not ready to send', { reason: 'not_ready', problems: ['Connect a Stripe account that can accept payments (Settings → Payments)'] });
      }
    }
    // Feature-Parity §1.16 / §1.19 (Amendment A1) — a QES signer needs a configured QTSP,
    // and a live e-stamp order must be attached, its certificate first.
    await this.qes?.assertSendable(auth.tenant_id, envelope_id);
    await this.estamp?.assertSendable(auth.tenant_id, envelope_id);
    // M-A12 W1-A / D-1 — a self-sign envelope reaches no one but the caller and never uses
    // the send allowance: the Personal gate keeps the legal acceptance and the risk gate
    // (and opens the FREE subscription) but not the allowance-bound young-account checks.
    const selfMode = d.mode === 'self';
    if (selfMode && tenant.kind === 'PERSONAL') {
      if (this.personal === undefined) throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Sending from a personal account is not enabled', 403, { requestId, details: { reason: 'personal_sending_not_enabled' } });
      await this.personal.assertLegalAccepted(tenant, auth.sub, requestId);
      await this.personal.ensureFreeSubscription(tenant);
      await this.personal.assertRiskGate(tenant.id, meta.ip ?? null, requestId);
    } else if (tenant.kind === 'PERSONAL') {
      // Personal Free v1.1 §4 / §6 — FREE subscription, risk gate, young-account checks.
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
    } else {
      // ToS v2.0 — a Business user who owes the Terms in effect is refused until they accept
      // them in the workspace (nothing is owed while no Business document is effective).
      await this.personal?.assertLegalAccepted(tenant, auth.sub, requestId);
    }
    // M-A12 W1-E.2 — the sender's date format is stamped on the envelope for SIGN_DATE.
    const settings = await this.userData?.getSettings(auth.tenant_id, auth.sub).catch(() => null);
    const rev = await this.repo.updateDraft({
      tenant_id: auth.tenant_id,
      envelope_id,
      execution_mode: signingRecipients(d.recipients).length > 1 ? 'MULTI_SIGNATURE' : 'SINGLE_SIGNATURE',
      ...(settings !== undefined && settings !== null ? { signer_date_format: settings.date_format } : {}),
      ...(expected !== undefined ? { expected_revision: expected } : {}),
    });
    if (expected !== undefined) expected = rev;
    // SIGN-FREE-PARITY-1 S4 (FP-R5) — the send-time check verdict, recorded on the envelope for
    // its automatic reminders (a system reminder has no IP and is never re-checked). A Personal
    // send reached here only because the check above passed; Business sends are not checked.
    const send_verdict: SendRiskVerdict = tenant.kind === 'PERSONAL' ? 'ALLOWED' : 'NOT_GATED';
    await this.provider.sendEnvelope(auth.tenant_id, envelope_id, auth.sub, undefined, { auto_reminders: { send_verdict }, ...(expected !== undefined ? { expected_revision: expected } : {}) });
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
    // M-A12 W1-A — a self-sign envelope sends no emails, so there is no one to remind.
    // C1 — the remind rule's mode check (envelope-actions.ts); the engine checks who may be reminded.
    enforce(remindModeRefusal(await this.repo.getEnvelopeDetail(auth.tenant_id, envelope_id)), requestId);
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
    if (reason.length > VOID_REASON_MAX) throw bad(requestId, `reason must be at most ${VOID_REASON_MAX} characters`);
    const d = await this.describe(auth, envelope_id, requestId, false);
    // C1 — the void rule (envelope-actions.ts).
    enforce(voidStateRefusal(d), requestId);
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

  // W2 §A3.5 — envelope id → the caller's inbox item id (or null) for every envelope awaiting
  // the caller; an envelope absent from the map is not awaiting the caller.
  private async myInboxItemIds(
    user_id: string,
    rows: ReadonlyArray<Parameters<typeof awaitingYouSteps>[0] & { id: string; signers: Parameters<typeof awaitingYouSteps>[1] }>,
    proof: { email: string; proven_at: Date } | null,
    now: Date,
  ): Promise<Map<string, string | null>> {
    const awaiting = rows.flatMap((e) => {
      const steps = awaitingYouSteps(e, e.signers, user_id, proof, now);
      return steps === null ? [] : [{ envelope_id: e.id, steps }];
    });
    const out = new Map<string, string | null>();
    if (awaiting.length === 0) return out;
    const signerIds = awaiting.flatMap((a) => a.steps.map((st) => st.row.id));
    const live = this.inbox !== undefined ? await this.inbox.liveBindingIds(user_id, signerIds) : new Map<string, string>();
    const anyBinding = this.inbox !== undefined ? await this.inbox.anyBindingSignerIds(user_id, signerIds) : new Set<string>(signerIds);
    const key = inboxHandleKey();
    for (const a of awaiting) {
      let id: string | null = null;
      for (const st of a.steps) {
        const bound = live.get(st.row.id);
        if (bound !== undefined) id = bound;
        else if (st.proven && key !== null && !anyBinding.has(st.row.id)) id = mintInboxHandle(key, { signer_id: st.row.id, user_id }, now);
        if (id !== null) break;
      }
      out.set(a.envelope_id, id);
    }
    return out;
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
// M-A6 §2 — the Name and Checkbox configuration of one authored field; FIELD-PARITY-1 P3 §6.2
// — every setting, through the ONE settings rule the template APIs use (@aramo/sign-fields
// parseFieldSettings). SIGNER_NAME takes name_mode (default SIGNER_PROFILE); a setting the type
// does not take is refused. The sender never supplies a value (§2.2, sender_value_refused) —
// except, S-5 (ruling R-3, dark), for a sender_filled field while the server flag
// SIGN_SENDER_FILLED_FIELDS_ENABLED is on: that value is checked with the signer's value rule
// (fieldValueRefusal) and recorded as the sender's. Every refusal carries a stable details.reason.
type FieldConfig = Pick<
  SenderFieldInput,
  'label' | 'group_key' | 'group_rule' | 'min_selected' | 'name_mode' | 'tooltip' | 'placeholder' | 'read_only' | 'sender_filled' | 'validation' | 'font_size' | 'data_name' | 'options' | 'condition' | 'sender_value'
>;
function fieldConfig(o: Record<string, unknown>, field_type: string, i: number, requestId: string): FieldConfig {
  const refuse = (field: string, reason: string, message: string): AramoError => bad(requestId, `field ${i + 1}: ${message}`, { index: i, field, reason });
  const present = (k: string): boolean => o[k] !== undefined && o[k] !== null;
  const parsed = parseFieldSettings(o, field_type, { sender_filled_enabled: senderFilledFieldsEnabled(process.env) });
  if (!parsed.ok) throw refuse(parsed.refusal.setting, parsed.refusal.reason, parsed.refusal.message);
  const st = parsed.settings;
  let sender_value: string | null = null;
  if (present('value')) {
    if (!st.sender_filled) throw refuse('value', 'sender_value_refused', 'a sender cannot fill a field value');
    const v = o['value'];
    if (typeof v !== 'string') throw refuse('value', 'sender_value_invalid', 'value must be text');
    const valueRefusal = fieldValueRefusal({ field_type, validation: st.validation, options: st.options }, v);
    if (valueRefusal !== null) throw refuse('value', valueRefusal, 'the value does not fit this field');
    sender_value = v;
  }
  const settings = {
    label: st.label,
    tooltip: st.tooltip,
    placeholder: st.placeholder,
    read_only: st.read_only,
    sender_filled: st.sender_filled,
    validation: st.validation,
    font_size: st.font_size,
    data_name: st.data_name,
    options: st.options as SenderFieldInput['options'],
    // FIELD-PARITY-2 B-2 — the condition's shape (the cross-field rule runs on the whole list).
    condition: st.condition,
    ...(st.sender_filled ? { sender_value } : {}),
  };
  if (field_type === 'SIGNER_NAME') return { ...settings, name_mode: st.name_mode ?? 'SIGNER_PROFILE' };
  if (field_type !== 'CHECKBOX' && field_type !== 'RADIO') return settings;
  return { ...settings, group_key: st.group_key, group_rule: st.group_rule as CheckboxGroupRule | null, min_selected: st.min_selected };
}

// Sign 1.14 — the PAYMENT configuration: the amount in cents (50 = the Stripe minimum, to
// 99999999) and the currency (USD only, directive §4). A PAYMENT field is always required
// (payment is required to complete). No other type takes these properties.
const PAYMENT_MIN_MINOR = 50;
const PAYMENT_MAX_MINOR = 99_999_999;
function paymentConfig(o: Record<string, unknown>, field_type: string, i: number, requestId: string): Pick<SenderFieldInput, 'payment_amount_minor' | 'payment_currency'> {
  const refuse = (field: string, reason: string, message: string): AramoError => bad(requestId, `field ${i + 1}: ${message}`, { index: i, field, reason });
  const present = (k: string): boolean => o[k] !== undefined && o[k] !== null;
  if (field_type !== PAYMENT_FIELD_TYPE) {
    for (const k of ['payment_amount_minor', 'payment_currency']) if (present(k)) throw refuse(k, 'field_config_not_applicable', `${k} applies to payment fields only`);
    return {};
  }
  const amount = o['payment_amount_minor'];
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < PAYMENT_MIN_MINOR || amount > PAYMENT_MAX_MINOR) {
    throw refuse('payment_amount_minor', 'payment_amount_invalid', `the amount must be a whole number of cents from ${PAYMENT_MIN_MINOR} to ${PAYMENT_MAX_MINOR}`);
  }
  const currency = o['payment_currency'] ?? 'USD';
  if (currency !== 'USD') throw refuse('payment_currency', 'payment_currency_invalid', 'payments are collected in USD only');
  if (o['required'] === false) throw refuse('required', 'payment_field_required', 'a payment field is always required');
  return { payment_amount_minor: amount, payment_currency: 'USD' };
}

// FIELD-PARITY-2 B-1 / B-3 — the one cross-field rule over the whole field list (the trigger
// exists by key, has a type the rule reads, is the same recipient's, the values are its choices,
// no cycle, depth ≤ 3, each recipient keeps an unconditional SIGNATURE; a key is used once). The
// first problem is refused with its named reason (§4.3).
function fieldConditions(fields: ReadonlyArray<SenderFieldInput>, requestId: string): void {
  const [issue] = fieldConditionIssues(
    fields.map((f) => ({
      field_key: f.field_key ?? null,
      field_type: f.field_type,
      signer: f.signer_id,
      condition: (f.condition ?? null) as FieldCondition | null,
      options: (f.options ?? null) as { choices?: { value: string }[] } | null,
      sender_filled: f.sender_filled === true,
    })),
  );
  if (issue === undefined) return;
  throw bad(requestId, `field ${issue.index + 1}: ${issue.message}`, { index: issue.index, field: issue.reason === 'field_key_duplicate' ? 'field_key' : 'condition', reason: issue.reason });
}

// Sign 1.14 — one PAYMENT field per signer (each signer pays at most one amount).
function onePaymentPerSigner(fields: ReadonlyArray<SenderFieldInput>, requestId: string): void {
  const seen = new Set<string>();
  for (const [i, f] of fields.entries()) {
    if (f.field_type !== PAYMENT_FIELD_TYPE || f.signer_id === null) continue;
    if (seen.has(f.signer_id)) throw bad(requestId, `field ${i + 1}: a recipient can have only one payment field`, { index: i, field: 'field_type', reason: 'payment_field_duplicate' });
    seen.add(f.signer_id);
  }
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
// group's size. FIELD-PARITY-2 A-7 — the group rule is the shared one
// (@aramo/sign-fields checkboxGroupIssues, also used by the template routes and the
// console fixed form); a box's recipient plays the template's signer role. The sender
// keeps its own refusal messages and details, and its sender-value check (a sender-filled
// radio group holds at most one choice), in the same order as before: per group, in the
// order the groups first appear, inconsistent, then radio_group_select_one, then the minimum.
function checkboxGroups(fields: ReadonlyArray<SenderFieldInput>, requestId: string): void {
  const grouped = fields.flatMap((f, i) =>
    f.group_key === undefined || f.group_key === null
      ? []
      : [
          {
            field_key: String(i),
            signer_role: f.signer_id,
            required: f.required,
            group_key: f.group_key,
            group_rule: f.group_rule ?? null,
            min_selected: f.min_selected ?? null,
            field_type: f.field_type,
            read_only: f.read_only ?? false,
            sender_filled: f.sender_filled ?? false,
          },
        ],
  );
  const issues = new Map(checkboxGroupIssues(grouped).map((issue) => [issue.group_key, issue.reason]));
  const groupKeys = [...new Set(grouped.map((g) => g.group_key))];
  for (const group_key of groupKeys) {
    const reason = issues.get(group_key);
    if (reason === 'checkbox_group_inconsistent') {
      throw bad(requestId, `check-box group ${group_key}: every box needs the same recipient, type, rule, minimum, required, read-only and sender-filled setting`, { group_key, reason: 'checkbox_group_inconsistent' });
    }
    // P3 T-5 / S-5 — a sender-filled radio group holds at most one choice.
    const boxes = fields.filter((f) => f.group_key === group_key);
    if (boxes[0]?.field_type === 'RADIO' && boxes.filter((b) => b.sender_value === 'true').length > 1) {
      throw bad(requestId, `radio group ${group_key}: choose one option`, { group_key, reason: 'radio_group_select_one' });
    }
    if (reason === 'checkbox_group_min_exceeds_size') {
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

// Client Rule Consolidation C1 — the envelope facts the action rules read, from a stored row
// (list row or detail row: both carry the signers and the purge columns).
function actionEnvelopeOf(e: {
  status: string;
  created_by: string;
  source_application: string;
  envelope_mode?: string | null;
  routing_mode: string;
  expires_at?: Date | null;
  purge_state?: string | null;
  signers: ReadonlyArray<{ id: string; status: string; signing_order: number; recipient_kind?: string | null; witness_for_signer_id?: string | null }>;
}): ActionEnvelope {
  return {
    status: e.status,
    owner_id: e.created_by,
    source_application: e.source_application,
    envelope_mode: e.envelope_mode ?? null,
    routing_mode: e.routing_mode,
    expires_at: e.expires_at ?? null,
    purge_state: e.purge_state ?? null,
    recipients: e.signers,
  };
}
