import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository, type LockingTx } from './esign.repository.js';
import { EXECUTION_PRODUCER_PORT, type ExecutionProducerPort } from './ports/execution-producer.port.js';
import { generateSigningToken, hashSigningToken, signingSessionExpiresAt } from './signing-token.js';
import { LIVE_SESSION_STATUSES, isTerminalEnvelopeStatus as isTerminal } from './domain/envelope-lifecycle.js';
import { findDisclosure } from './domain/disclosure.js';
import {
  DisclosureNotAcceptedError,
  DisclosureVersionInvalidError,
  EnvelopeAlreadyExecutedError,
  EnvelopeAmbiguousError,
  EnvelopeIllegalTransitionError,
  ReminderNotAllowedError,
  SignatureFieldIncompleteError,
  SignerNotFoundError,
  SignerNotYetEligibleError,
  SigningSessionExpiredError,
  SigningSessionInvalidError,
} from './domain/errors.js';
import {
  EVIDENCE_MANIFEST_SIGNER_PORT,
  type EvidenceManifest,
  type EvidenceManifestSignerPort,
  type SignedEvidenceManifest,
} from './ports/evidence-manifest-signer.port.js';
import { applyReminderLimits, reminderHistory, type ReminderLimits } from './reminder-limits.js';

// Aramo Sign launch — how long a sent envelope stays signable before the expiry
// sweep moves it to EXPIRED (SIGN_ENVELOPE_TTL_DAYS, default 30). Individual
// signing links still expire after 7 days unless a reminder re-issues them.
export const ENVELOPE_TTL_DAYS_DEFAULT = 30;

export function envelopeExpiresAt(sentAt: Date): Date {
  const days = Number(process.env['SIGN_ENVELOPE_TTL_DAYS'] ?? ENVELOPE_TTL_DAYS_DEFAULT);
  const ttl = Number.isFinite(days) && days > 0 ? days : ENVELOPE_TTL_DAYS_DEFAULT;
  return new Date(sentAt.getTime() + ttl * 24 * 60 * 60 * 1000);
}

// DOC-3 boundary 2-4 — E-Sign state-machine orchestration. TRANSPORT ONLY: no
// RTR/Submittal/Offer/Placement/recruiter-workflow logic (that is DOC-5/6, which
// consume this seam). ATS-neutral.

const SERVICE_VERSION = 'doc3';

// Envelope lifecycle: the transition table, terminal/signable sets and the
// compare-and-set transition live in domain/envelope-lifecycle.ts and
// EsignRepository.transitionEnvelopeIn (ES-1).

export interface IssuedSession {
  session_id: string;
  signer_id: string;
  raw_token: string; // emitted ONCE to the caller; never stored/logged
}

export interface SessionContext {
  session_id: string;
  tenant_id: string;
  envelope_id: string;
  signer_id: string;
}

// PX-V1 F3 — the signer-scoped document view (fields + doc metadata) returned to
// Sign Web. Carries NO tenant_id: tenant is resolved server-side from the token.
export interface SignerFieldView {
  field_id: string;
  document_id: string;
  field_type: string;
  page_number: number;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  required: boolean;
  // PX-2 — true once this signer has filled the field (restores progress on reload).
  filled: boolean;
  // PX-2 — the signer's own entered value (typed text, date, or a drawn-signature
  // data URL); null for unfilled or unassigned fields.
  value: string | null;
}

export interface SignerDocumentMeta {
  document_id: string;
  title: string;
  ordinal: number;
}

export interface SignerDocumentView {
  documents: SignerDocumentMeta[];
  fields: SignerFieldView[];
  // Sign Mobile M-A3 §3 — the sender's plain-text message (sender-supplied; not
  // part of the signed document content). Null when none was given.
  message: string | null;
}

// Server-side source descriptor (NOT returned to the client) used by the
// composition root to fetch bytes via the mode-dispatching source resolver.
export interface SignerSourceDescriptor {
  tenant_id: string;
  source_mode: 'OWNED' | 'CORE_REF';
  document_ref: string | null;
  document_revision_ref: string | null;
  source_object_key: string | null;
  content_type: string;
}

@Injectable()
export class EsignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
    @Inject(EVIDENCE_MANIFEST_SIGNER_PORT) private readonly evidenceSigner: EvidenceManifestSignerPort,
    // DOC-4 — OPTIONAL: when unbound (DOC-3 domain tests) completion has no
    // executed-bytes side-effect, preserving DOC-3 behavior.
    @Optional() @Inject(EXECUTION_PRODUCER_PORT) private readonly executionProducer?: ExecutionProducerPort,
  ) {}

  private async requireStatus(tenant_id: string, envelope_id: string, expected: string): Promise<void> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    if (env.status !== expected) throw new EnvelopeIllegalTransitionError(env.status, `mutate(${expected}-only)`);
  }

  // ── Send: DRAFT -> SENT. Issues a signing session per signer (raw tokens
  // returned ONCE). Requires >=1 signer and >=1 document. ES-1: the transition
  // and the session mint commit together — a lost race mints nothing. ──
  // Sign Mobile M-A3 §6 — `expected_revision` (the caller's If-Match) is compared
  // under the envelope row lock in the send transaction. M-A3 §3 — the sender
  // message is recorded in the ENVELOPE_SENT ledger payload as sender-supplied text
  // (never in the evidence manifest fields or the certificate).
  async send(tenant_id: string, envelope_id: string, actor_ref: string, opts: { expected_revision?: number } = {}): Promise<{ envelope: unknown; sessions: IssuedSession[] }> {
    const full = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    if (full.signers.length === 0) throw new SigningSessionInvalidError('envelope has no signers');
    if (full.documents.length === 0) throw new SigningSessionInvalidError('envelope has no documents');

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelopeRevision(tx, tenant_id, envelope_id, opts.expected_revision);
      const message = await tx.signatureEnvelope.findFirst({ where: { id: envelope_id, tenant_id }, select: { message: true } });
      const envelope = await this.repo.transitionEnvelopeIn(tx, {
        tenant_id,
        envelope_id,
        to: 'SENT',
        event_type: 'ENVELOPE_SENT',
        actor_type: 'SERVICE',
        actor_ref,
        timestampField: 'sent_at',
        ...(message?.message ? { payload: { sender_message: message.message, sender_message_source: 'SENDER_SUPPLIED' } } : {}),
      });
      await tx.signatureEnvelope.update({ where: { id: envelope_id }, data: { expires_at: envelopeExpiresAt(now) } });
      const sessions: IssuedSession[] = [];
      // Multi-Signer §3/§4 — PARALLEL: every signer gets a live link now. SEQUENTIAL:
      // only the first signer (lowest signing_order); each next signer is invited when
      // the previous one completes (completeSigner records a durable intent).
      const invited = full.routing_mode === 'SEQUENTIAL' ? full.signers.slice(0, 1) : full.signers;
      for (const signer of invited) {
        const minted = generateSigningToken();
        const sessionId = randomUUID();
        await tx.signingSession.create({
          data: {
            id: sessionId,
            tenant_id,
            envelope_id,
            signer_id: signer.id,
            token_hash: minted.hash,
            status: 'ISSUED',
            expires_at: signingSessionExpiresAt(now),
          },
        });
        sessions.push({ session_id: sessionId, signer_id: signer.id, raw_token: minted.raw });
      }
      return { envelope, sessions };
    });
  }

  // ── Exchange a raw capability token for an active session context (R17).
  // Validates hash match, not expired/revoked/consumed. Tenant resolved FROM
  // the session, never the client. ES-1: runs under the envelope row lock; a
  // terminal envelope is refused before any write. ──
  async exchangeToken(rawToken: string): Promise<SessionContext> {
    const found = await this.findSessionByToken(rawToken);
    const outcome = await this.prisma.$transaction(async (tx) => {
      const envelopeStatus = await this.repo.lockSignableEnvelope(tx, found.tenant_id, found.envelope_id);
      const session = await tx.signingSession.findUniqueOrThrow({ where: { id: found.id } });
      if (!LIVE_SESSION_STATUSES.includes(session.status)) return 'spent' as const;
      if (session.expires_at.getTime() < Date.now()) {
        await tx.signingSession.update({ where: { id: session.id }, data: { status: 'EXPIRED' } });
        return 'spent' as const;
      }
      await this.assertEligible(tx, { tenant_id: session.tenant_id, envelope_id: session.envelope_id, signer_id: session.signer_id });
      await tx.signingSession.update({
        where: { id: session.id },
        data: { status: 'ACTIVE', first_accessed_at: session.first_accessed_at ?? new Date(), last_accessed_at: new Date() },
      });
      await this.repo.appendEvent(tx, {
        tenant_id: session.tenant_id,
        envelope_id: session.envelope_id,
        signer_id: session.signer_id,
        event_type: 'SESSION_EXCHANGED',
        actor_type: 'SIGNER',
        actor_ref: session.signer_id,
      });
      // Mark signer VIEWED + envelope IN_PROGRESS (first activity).
      await tx.signer.updateMany({
        where: { id: session.signer_id, tenant_id: session.tenant_id, status: { in: ['PENDING', 'VIEWED'] } },
        data: { status: 'VIEWED', viewed_at: new Date() },
      });
      if (envelopeStatus === 'SENT') {
        await this.repo.transitionEnvelopeIn(tx, {
          tenant_id: session.tenant_id,
          envelope_id: session.envelope_id,
          to: 'IN_PROGRESS',
          event_type: 'ENVELOPE_IN_PROGRESS',
          actor_type: 'SIGNER',
          actor_ref: session.signer_id,
        });
      }
      return 'exchanged' as const;
    });
    if (outcome === 'spent') throw new SigningSessionExpiredError(found.id);
    return { session_id: found.id, tenant_id: found.tenant_id, envelope_id: found.envelope_id, signer_id: found.signer_id };
  }

  // ── Read-only session resolution for subsequent signer ops (no side effects).
  // Validates hash match + not expired/revoked; tenant FROM the session. ES-1: a
  // terminal envelope is refused first, whatever the session's own state. Every
  // signer mutation re-checks eligibility under the envelope row lock. ──
  async resolveSession(rawToken: string): Promise<SessionContext> {
    const session = await this.findSessionByToken(rawToken);
    const envelope = await this.repo.getEnvelope(session.tenant_id, session.envelope_id);
    if (isTerminal(envelope.status)) throw new EnvelopeAlreadyExecutedError(session.envelope_id, envelope.status);
    if (session.status === 'REVOKED' || session.status === 'EXPIRED') throw new SigningSessionExpiredError(session.id);
    if (session.expires_at.getTime() < Date.now()) throw new SigningSessionExpiredError(session.id);
    return { session_id: session.id, tenant_id: session.tenant_id, envelope_id: session.envelope_id, signer_id: session.signer_id };
  }

  private async findSessionByToken(rawToken: string) {
    const session = await this.prisma.signingSession.findUnique({ where: { token_hash: hashSigningToken(rawToken) } });
    if (session === null) throw new SigningSessionInvalidError('unknown token');
    return session;
  }

  // ES-1 — inside a locked transaction: the session still carries signing
  // authority (not COMPLETED / REVOKED / EXPIRED, not past its TTL).
  private async assertLiveSession(tx: LockingTx, ctx: SessionContext): Promise<void> {
    const session = await tx.signingSession.findFirst({
      where: { id: ctx.session_id, tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id, signer_id: ctx.signer_id },
      select: { status: true, expires_at: true },
    });
    if (session === null) throw new SigningSessionInvalidError('unknown session');
    if (!LIVE_SESSION_STATUSES.includes(session.status) || session.expires_at.getTime() < Date.now()) {
      throw new SigningSessionExpiredError(ctx.session_id);
    }
  }

  // Multi-Signer §4 — the signer allowed to act in a SEQUENTIAL envelope: the lowest
  // signing_order among signers who have not SIGNED (null when everyone has).
  private async currentSequentialSigner(client: Pick<LockingTx, 'signer'>, tenant_id: string, envelope_id: string): Promise<string | null> {
    const next = await client.signer.findFirst({
      where: { tenant_id, envelope_id, status: { not: 'SIGNED' } },
      orderBy: { signing_order: 'asc' },
      select: { id: true },
    });
    return next?.id ?? null;
  }

  // Multi-Signer §4 — enforced by the ENGINE on every signer action (exchange, view,
  // disclosure, fill, complete): in a SEQUENTIAL envelope a signer may act only when
  // every earlier signer has signed, whatever link or token they present.
  private async assertEligible(
    client: Pick<LockingTx, 'signer' | 'signatureEnvelope'>,
    ctx: { tenant_id: string; envelope_id: string; signer_id: string },
  ): Promise<void> {
    const env = await client.signatureEnvelope.findFirst({ where: { id: ctx.envelope_id, tenant_id: ctx.tenant_id }, select: { routing_mode: true } });
    if (env?.routing_mode !== 'SEQUENTIAL') return;
    if ((await this.currentSequentialSigner(client, ctx.tenant_id, ctx.envelope_id)) !== ctx.signer_id) throw new SignerNotYetEligibleError(ctx.signer_id);
  }

  // ── Accept the e-sign disclosure (R16). Versioned frozen text + hash. ES-1:
  // under the envelope row lock, with a live session. ──
  async acceptDisclosure(ctx: SessionContext, input: { disclosure_version: string; disclosure_text_hash: string; ip_address?: string; user_agent?: string }): Promise<void> {
    // A-7 — only a server-held disclosure version, with its exact text hash.
    const held = findDisclosure(input.disclosure_version);
    if (held === undefined || held.text_sha256 !== input.disclosure_text_hash) {
      throw new DisclosureVersionInvalidError(input.disclosure_version);
    }
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lockSignableEnvelope(tx, ctx.tenant_id, ctx.envelope_id);
      await this.assertLiveSession(tx, ctx);
      await this.assertEligible(tx, ctx);
      await tx.signerDisclosureAcceptance.create({
        data: {
          id: randomUUID(),
          tenant_id: ctx.tenant_id,
          signer_id: ctx.signer_id,
          disclosure_version: input.disclosure_version,
          disclosure_text_hash: input.disclosure_text_hash,
          ip_address: input.ip_address ?? null,
          user_agent: input.user_agent ?? null,
          session_id: ctx.session_id,
        },
      });
      await this.repo.appendEvent(tx, {
        tenant_id: ctx.tenant_id,
        envelope_id: ctx.envelope_id,
        signer_id: ctx.signer_id,
        event_type: 'DISCLOSURE_ACCEPTED',
        actor_type: 'SIGNER',
        actor_ref: ctx.signer_id,
        payload: { disclosure_version: input.disclosure_version },
        ip_address: input.ip_address,
        user_agent: input.user_agent,
      });
    });
  }

  private async hasAcceptedDisclosure(tenant_id: string, signer_id: string, client: Pick<LockingTx, 'signerDisclosureAcceptance'> = this.prisma): Promise<boolean> {
    const n = await client.signerDisclosureAcceptance.count({ where: { tenant_id, signer_id } });
    return n > 0;
  }

  // ── Fill a signature field (requires disclosure accepted). ES-1: under the
  // envelope row lock, with a live session — a signer who has completed, or a
  // signer on a terminal envelope, can no longer alter a field value. ──
  async fillField(ctx: SessionContext, fieldId: string, input: { value: string; signature_method?: string }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lockSignableEnvelope(tx, ctx.tenant_id, ctx.envelope_id);
      await this.assertLiveSession(tx, ctx);
      await this.assertEligible(tx, ctx);
      if (!(await this.hasAcceptedDisclosure(ctx.tenant_id, ctx.signer_id, tx))) throw new DisclosureNotAcceptedError(ctx.signer_id);
      const field = await tx.signatureField.findFirst({ where: { tenant_id: ctx.tenant_id, id: fieldId, signer_id: ctx.signer_id } });
      if (field === null) throw new SignerNotFoundError(ctx.signer_id);
      await tx.signatureField.update({
        where: { id: fieldId },
        data: { value: input.value, signature_method: input.signature_method ?? null, filled_at: new Date() },
      });
    });
  }

  // ── PX-V1 F3 — signer document view: positioned fields + document metadata for
  // the Sign Web viewer. Disclosure-gated (same guard as fillField). Returns only
  // the signer's own (or unbound) fields; NO tenant_id, NO source bytes. ──
  async getSignerDocumentView(ctx: SessionContext): Promise<SignerDocumentView> {
    await this.assertEligible(this.prisma, ctx);
    if (!(await this.hasAcceptedDisclosure(ctx.tenant_id, ctx.signer_id))) throw new DisclosureNotAcceptedError(ctx.signer_id);
    const full = await this.repo.getEnvelopeFull(ctx.tenant_id, ctx.envelope_id);
    const documents = full.documents.map((d) => ({ document_id: d.id, title: d.title, ordinal: d.ordinal }));
    const fields = full.documents.flatMap((d) =>
      d.fields
        .filter((f) => f.signer_id === ctx.signer_id || f.signer_id === null)
        .map((f) => ({
          field_id: f.id,
          document_id: d.id,
          field_type: f.field_type,
          page_number: f.page_number,
          x: f.x,
          y: f.y,
          width: f.width,
          height: f.height,
          required: f.required,
          // PX-2 — restores the signer's own progress after a reload. The value is
          // returned ONLY for this session's own fields (capability token + accepted
          // disclosure), so the page shows the signer's actual entries in place.
          filled: f.filled_at !== null,
          value: f.signer_id === ctx.signer_id ? (f.value ?? null) : null,
        })),
    );
    fields.sort((a, b) => a.page_number - b.page_number || a.y - b.y || a.x - b.x);
    return { documents, fields, message: full.message ?? null };
  }

  // Sign Mobile M-A3 §3 — the sender message for the signer consent screen. Read
  // with an already-resolved session (token-authorized); no tenant id leaves here.
  async signerEnvelopeMessage(ctx: SessionContext): Promise<string | null> {
    const env = await this.prisma.signatureEnvelope.findFirst({ where: { id: ctx.envelope_id, tenant_id: ctx.tenant_id }, select: { message: true } });
    return env?.message ?? null;
  }

  // ── PX-V1 F3 — resolve the server-side source descriptor for a document in the
  // session's envelope. Disclosure-gated. The descriptor (incl. tenant_id) is for
  // the composition root's source resolver ONLY and is never returned to the
  // client. ──
  async resolveSignerSource(ctx: SessionContext, documentId: string): Promise<SignerSourceDescriptor> {
    await this.assertEligible(this.prisma, ctx);
    if (!(await this.hasAcceptedDisclosure(ctx.tenant_id, ctx.signer_id))) throw new DisclosureNotAcceptedError(ctx.signer_id);
    const full = await this.repo.getEnvelopeFull(ctx.tenant_id, ctx.envelope_id);
    const doc = full.documents.find((d) => d.id === documentId);
    if (doc === undefined) throw new SigningSessionInvalidError('document not in session');
    return {
      tenant_id: ctx.tenant_id,
      source_mode: doc.source_mode === 'OWNED' ? 'OWNED' : 'CORE_REF',
      document_ref: doc.document_ref,
      document_revision_ref: doc.document_revision_ref,
      source_object_key: doc.source_object_key,
      content_type: doc.content_type ?? 'application/pdf',
    };
  }

  // ── Complete a signer: all required fields filled -> SIGNED; if all signers
  // signed -> envelope COMPLETED (build + sign evidence manifest). ES-1: one
  // transaction under the envelope row lock, so racing completions serialize and
  // exactly one of them performs the COMPLETED transition — and only that one
  // produces executed artifacts, after commit. Parallel signing is unchanged:
  // signers complete in any order; signing_order is not enforced. ──
  async completeSigner(ctx: SessionContext): Promise<{ envelope_status: string; next_signer_id?: string }> {
    let nextSignerId: string | undefined;
    const completed = await this.prisma.$transaction(async (tx) => {
      const envelopeStatus = await this.repo.lockSignableEnvelope(tx, ctx.tenant_id, ctx.envelope_id);
      await this.assertLiveSession(tx, ctx);
      await this.assertEligible(tx, ctx);
      if (!(await this.hasAcceptedDisclosure(ctx.tenant_id, ctx.signer_id, tx))) throw new DisclosureNotAcceptedError(ctx.signer_id);
      const required = await tx.signatureField.findMany({ where: { tenant_id: ctx.tenant_id, signer_id: ctx.signer_id, required: true } });
      if (required.some((f) => f.filled_at === null)) throw new SignatureFieldIncompleteError(ctx.signer_id);

      await tx.signer.update({ where: { id: ctx.signer_id }, data: { status: 'SIGNED', signed_at: new Date() } });
      await tx.signingSession.update({ where: { id: ctx.session_id }, data: { status: 'COMPLETED', completed_at: new Date() } });
      await this.repo.appendEvent(tx, {
        tenant_id: ctx.tenant_id,
        envelope_id: ctx.envelope_id,
        signer_id: ctx.signer_id,
        event_type: 'SIGNER_SIGNED',
        actor_type: 'SIGNER',
        actor_ref: ctx.signer_id,
      });

      const signers = await tx.signer.findMany({ where: { tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id }, select: { status: true } });
      if (!signers.every((s) => s.status === 'SIGNED')) {
        // Multi-Signer §4 — SEQUENTIAL: record the next signer's invitation as a
        // durable intent IN THIS TRANSACTION (it commits with the completion or not at
        // all). SigningInvitationService issues the link and sends the email after
        // commit; its worker retries an intent that was recorded but not delivered.
        const env = await tx.signatureEnvelope.findFirstOrThrow({ where: { id: ctx.envelope_id, tenant_id: ctx.tenant_id }, select: { routing_mode: true } });
        if (env.routing_mode === 'SEQUENTIAL') {
          const nextId = await this.currentSequentialSigner(tx, ctx.tenant_id, ctx.envelope_id);
          if (nextId !== null) {
            const open = await tx.notificationDelivery.count({
              where: { tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id, signer_id: nextId, notification_kind: 'SIGNATURE_REQUEST', status: { in: ['PENDING', 'DISPATCHING'] } },
            });
            if (open === 0) {
              await tx.notificationDelivery.create({
                data: { id: randomUUID(), tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id, signer_id: nextId, notification_kind: 'SIGNATURE_REQUEST', status: 'PENDING' },
              });
            }
            nextSignerId = nextId;
          }
        }
        return false;
      }
      // A signer may complete without a prior exchange (SENT); the lifecycle
      // only reaches COMPLETED through IN_PROGRESS, so record that step first.
      if (envelopeStatus === 'SENT') {
        await this.repo.transitionEnvelopeIn(tx, {
          tenant_id: ctx.tenant_id,
          envelope_id: ctx.envelope_id,
          to: 'IN_PROGRESS',
          event_type: 'ENVELOPE_IN_PROGRESS',
          actor_type: 'SIGNER',
          actor_ref: ctx.signer_id,
        });
      }
      await this.repo.transitionEnvelopeIn(tx, {
        tenant_id: ctx.tenant_id,
        envelope_id: ctx.envelope_id,
        to: 'COMPLETED',
        event_type: 'ENVELOPE_COMPLETED',
        actor_type: 'SERVICE',
        timestampField: 'completed_at',
      });
      return true;
    });
    if (!completed) return nextSignerId === undefined ? { envelope_status: 'IN_PROGRESS' } : { envelope_status: 'IN_PROGRESS', next_signer_id: nextSignerId };
    // DOC-4 (R-4-3) — produce executed bytes + completion notification when a
    // producer is bound (apps/sign-service composition root). Runs only for the
    // transaction that won the COMPLETED transition.
    await this.executionProducer?.produce(ctx.tenant_id, ctx.envelope_id);
    return { envelope_status: 'COMPLETED' };
  }

  // ES-1 — decline is a terminal transition: the CAS, the signer's DECLINED
  // status and the revocation of every live session commit together. When the
  // signer surface passes its session, that session must still be live (a signer
  // who has already completed cannot decline).
  async decline(tenant_id: string, envelope_id: string, signer_id: string, reason: string, session_id?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const status = await this.repo.lockEnvelope(tx, tenant_id, envelope_id);
      if (status !== 'SENT' && status !== 'IN_PROGRESS') throw new EnvelopeIllegalTransitionError(status, 'DECLINED');
      if (session_id !== undefined) {
        await this.assertLiveSession(tx, { session_id, tenant_id, envelope_id, signer_id });
        // Multi-Signer §4 — a signer acting through their link may decline only on their turn.
        await this.assertEligible(tx, { tenant_id, envelope_id, signer_id });
      }
      await tx.signer.update({ where: { id: signer_id }, data: { status: 'DECLINED', declined_at: new Date(), decline_reason: reason } });
      await this.repo.transitionEnvelopeIn(tx, {
        tenant_id, envelope_id, to: 'DECLINED', event_type: 'ENVELOPE_DECLINED', actor_type: 'SIGNER', actor_ref: signer_id, timestampField: 'declined_at', payload: { reason },
      });
    });
  }

  // Sign Mobile M-A3 §6 — with `expected_revision` the void runs under the envelope
  // row lock and is refused when the revision moved (If-Match).
  async voidEnvelope(tenant_id: string, envelope_id: string, actor_ref: string, reason: string, opts: { expected_revision?: number } = {}): Promise<void> {
    const input = {
      tenant_id, envelope_id, to: 'VOIDED', event_type: 'ENVELOPE_VOIDED', actor_type: 'SERVICE', actor_ref, timestampField: 'voided_at' as const, payload: { reason },
    };
    if (opts.expected_revision === undefined) {
      await this.repo.transitionEnvelope(input);
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lockEnvelopeRevision(tx, tenant_id, envelope_id, opts.expected_revision);
      await this.repo.transitionEnvelopeIn(tx, input);
    });
  }

  async expireEnvelope(tenant_id: string, envelope_id: string): Promise<void> {
    await this.repo.transitionEnvelope({
      tenant_id, envelope_id, to: 'EXPIRED', event_type: 'ENVELOPE_EXPIRED', actor_type: 'SYSTEM',
    });
  }

  // ── Aramo Sign launch — the expiry sweep. Moves every SENT / IN_PROGRESS envelope
  // whose signing window has passed to EXPIRED (compare-and-set + session
  // revocation via expireEnvelope). Envelopes sent before expires_at existed use
  // sent_at + the configured TTL. A concurrent completion or void simply wins the
  // CAS and the envelope is skipped. Returns the envelopes this call expired. ──
  async expireDueEnvelopes(now: Date, limit = 100): Promise<Array<{ tenant_id: string; envelope_id: string }>> {
    const ttlMs = envelopeExpiresAt(now).getTime() - now.getTime();
    const legacyCutoff = new Date(now.getTime() - ttlMs);
    const due = await this.prisma.signatureEnvelope.findMany({
      where: {
        status: { in: ['SENT', 'IN_PROGRESS'] },
        OR: [{ expires_at: { lte: now } }, { expires_at: null, sent_at: { lte: legacyCutoff } }],
      },
      select: { id: true, tenant_id: true },
      orderBy: { sent_at: 'asc' },
      take: limit,
    });
    const expired: Array<{ tenant_id: string; envelope_id: string }> = [];
    for (const env of due) {
      try {
        await this.expireEnvelope(env.tenant_id, env.id);
        expired.push({ tenant_id: env.tenant_id, envelope_id: env.id });
      } catch (err) {
        if (!(err instanceof EnvelopeIllegalTransitionError)) throw err;
      }
    }
    return expired;
  }

  // ── Aramo Sign launch — resolve a signer's signed-copy access token (sent in the
  // completion email). Valid only for a COMPLETED envelope, within the grant's
  // window; each use is counted. Tenant comes from the grant, never the client. ──
  async resolveExecutedAccess(rawToken: string): Promise<{ tenant_id: string; envelope_id: string; signer_id: string }> {
    const grant = await this.prisma.executedAccessGrant.findUnique({ where: { token_hash: hashSigningToken(rawToken) } });
    if (grant === null) throw new SigningSessionInvalidError('unknown token');
    if (grant.expires_at.getTime() < Date.now()) throw new SigningSessionExpiredError(grant.id);
    const env = await this.repo.getEnvelope(grant.tenant_id, grant.envelope_id);
    if (env.status !== 'COMPLETED') throw new SigningSessionInvalidError('envelope not completed');
    await this.prisma.executedAccessGrant.update({
      where: { id: grant.id },
      data: { last_accessed_at: new Date(), access_count: { increment: 1 } },
    });
    return { tenant_id: grant.tenant_id, envelope_id: grant.envelope_id, signer_id: grant.signer_id };
  }

  // ── Evidence metadata (R19). DOC-3 provides hashes + event-chain hash +
  // (software) signature; KMS signer + executed bytes/certificate are DOC-4. ──
  async evidenceManifest(tenant_id: string, envelope_id: string): Promise<SignedEvidenceManifest> {
    const full = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    const chainHash = (await this.repo.terminalEventHash(tenant_id, envelope_id)) ?? '';
    const disclosures = await this.prisma.signerDisclosureAcceptance.findMany({ where: { tenant_id, signer_id: { in: full.signers.map((s) => s.id) } } });
    const disclosureHash = disclosures.length > 0 ? disclosures.map((d) => d.disclosure_text_hash).sort().join('|') : null;
    // DOC-4 — the executed-document hash, if executed bytes have been produced.
    const executed = await this.prisma.executedDocument.findFirst({
      where: { tenant_id, envelope_id },
      orderBy: { produced_at: 'desc' },
    });
    const manifest: EvidenceManifest = {
      envelope_id,
      source_sha256: executed?.source_sha256 ?? full.documents[0]?.source_sha256 ?? null,
      executed_sha256: executed?.executed_sha256 ?? null,
      event_chain_hash: chainHash,
      disclosure_hash: disclosureHash,
      execution_manifest_hash: chainHash,
      consent_version: disclosures[0]?.disclosure_version ?? null,
      signers: full.signers.map((s) => s.id),
      completed_at: full.completed_at ? full.completed_at.toISOString() : null,
      service_version: SERVICE_VERSION,
    };
    return this.evidenceSigner.sign(manifest, new Date().toISOString());
  }

  // COMM-RECRUITER-W1 (W1-C1) — reverse-resolve the single NON-TERMINAL envelope
  // for a document revision. 0 matches → null (not found / reminder unavailable);
  // exactly 1 → that envelope; >1 → fail closed (EnvelopeAmbiguousError). NEVER
  // picks "latest". Used by the RTR duplicate-send guard and the reminder flow.
  async findEnvelopeForDocument(
    tenant_id: string,
    document_ref: string,
    document_revision_ref: string,
  ): Promise<{ envelope_id: string; status: string } | null> {
    const matches = await this.repo.findNonTerminalEnvelopesByDocument(
      tenant_id,
      document_ref,
      document_revision_ref,
    );
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new EnvelopeAmbiguousError(document_ref, document_revision_ref, matches.length);
    }
    return { envelope_id: matches[0]!.id, status: matches[0]!.status };
  }

  // COMM-RECRUITER-W1 (W1-C2) — same-envelope reminder. Valid ONLY for a SENT or
  // IN_PROGRESS envelope. For each INCOMPLETE signer (PENDING|VIEWED): atomically
  // REVOKE its prior non-terminal session(s) and mint exactly ONE replacement
  // SigningSession (new raw token — the original is unrecoverable), then append a
  // single SIGNATURE_REMINDER_SENT ledger event. NEVER touches the envelope
  // status, documents, revision, or template. Returns the issued sessions (raw
  // tokens ONCE) so the composition root can dispatch the reminder links.
  async remindSigner(
    tenant_id: string,
    envelope_id: string,
    actor_ref: string,
    // Multi-Signer M-3a — remind ONE signer. Omitted: every signer who may sign now.
    signer_id?: string,
    // Sign Mobile M-A3 §7 — the Sign console's limits (web and mobile alike). When
    // given they are checked under the SAME envelope row lock as the re-mint, by
    // counting SIGNATURE_REMINDER_SENT events, so two concurrent reminders can never
    // both pass a limit. Omitted (ATS internal / integration API): no limit, as before.
    opts: { limits?: ReminderLimits } = {},
  ): Promise<{ sessions: IssuedSession[] }> {
    const now = new Date();
    // ES-1 — status check and re-mint under the envelope row lock, so a reminder
    // can never mint a live capability for an envelope voided concurrently.
    const sessions = await this.prisma.$transaction(async (tx) => {
      const status = await this.repo.lockEnvelope(tx, tenant_id, envelope_id);
      if (status !== 'SENT' && status !== 'IN_PROGRESS') {
        throw new ReminderNotAllowedError(`envelope status ${status} is not remindable`);
      }
      const incomplete = await tx.signer.findMany({
        where: { tenant_id, envelope_id, status: { in: ['PENDING', 'VIEWED'] } },
        orderBy: { signing_order: 'asc' },
      });
      if (incomplete.length === 0) {
        throw new ReminderNotAllowedError('no incomplete signer to remind');
      }
      // Multi-Signer §4 — in a SEQUENTIAL envelope only the signer whose turn it is
      // holds a link, so only they can be reminded.
      const env = await tx.signatureEnvelope.findFirstOrThrow({ where: { id: envelope_id, tenant_id }, select: { routing_mode: true } });
      const eligible = env.routing_mode === 'SEQUENTIAL' ? incomplete.slice(0, 1) : incomplete;
      let targets = signer_id === undefined ? eligible : eligible.filter((s) => s.id === signer_id);
      if (targets.length === 0) {
        throw new ReminderNotAllowedError(
          env.routing_mode === 'SEQUENTIAL' ? 'only the signer whose turn it is can be reminded' : 'that signer has already signed or is not on this envelope',
        );
      }
      if (opts.limits !== undefined) {
        const history = await reminderHistory(tx, tenant_id, envelope_id, now, opts.limits);
        const verdict = applyReminderLimits(history, targets.map((s) => s.id), now, opts.limits);
        if (verdict.refused !== undefined) throw verdict.refused;
        targets = targets.filter((s) => verdict.allowed.includes(s.id));
      }
      const minted: IssuedSession[] = [];
      for (const signer of targets) {
        // Revoke prior live sessions FIRST → one live capability per signer.
        await tx.signingSession.updateMany({
          where: {
            tenant_id,
            envelope_id,
            signer_id: signer.id,
            status: { in: ['ISSUED', 'EXCHANGED', 'ACTIVE'] },
          },
          data: { status: 'REVOKED', revoked_at: now },
        });
        const tok = generateSigningToken();
        const sessionId = randomUUID();
        await tx.signingSession.create({
          data: {
            id: sessionId,
            tenant_id,
            envelope_id,
            signer_id: signer.id,
            token_hash: tok.hash,
            status: 'ISSUED',
            expires_at: signingSessionExpiresAt(now),
          },
        });
        minted.push({ session_id: sessionId, signer_id: signer.id, raw_token: tok.raw });
      }
      // M-A3 §7 — the reminded signers are recorded so the per-signer cooldown can
      // be counted from the ledger.
      await this.repo.appendEvent(tx, {
        tenant_id,
        envelope_id,
        event_type: 'SIGNATURE_REMINDER_SENT',
        actor_type: 'SERVICE',
        actor_ref,
        payload: { signer_ids: targets.map((s) => s.id) },
      });
      return minted;
    });
    return { sessions };
  }
}
