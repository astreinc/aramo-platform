import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository, type LockingTx } from './esign.repository.js';
import { EXECUTION_PRODUCER_PORT, type ExecutionProducerPort } from './ports/execution-producer.port.js';
import { generateSigningToken, hashSigningToken, signingSessionExpiresAt } from './signing-token.js';
import { LIVE_SESSION_STATUSES, isTerminalEnvelopeStatus as isTerminal } from './domain/envelope-lifecycle.js';
import {
  DisclosureNotAcceptedError,
  EnvelopeAlreadyExecutedError,
  EnvelopeAmbiguousError,
  EnvelopeIllegalTransitionError,
  ReminderNotAllowedError,
  SignatureFieldIncompleteError,
  SignerNotFoundError,
  SigningSessionExpiredError,
  SigningSessionInvalidError,
} from './domain/errors.js';
import {
  EVIDENCE_MANIFEST_SIGNER_PORT,
  type EvidenceManifest,
  type EvidenceManifestSignerPort,
  type SignedEvidenceManifest,
} from './ports/evidence-manifest-signer.port.js';

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
}

export interface SignerDocumentMeta {
  document_id: string;
  title: string;
  ordinal: number;
}

export interface SignerDocumentView {
  documents: SignerDocumentMeta[];
  fields: SignerFieldView[];
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
  async send(tenant_id: string, envelope_id: string, actor_ref: string): Promise<{ envelope: unknown; sessions: IssuedSession[] }> {
    const full = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    if (full.signers.length === 0) throw new SigningSessionInvalidError('envelope has no signers');
    if (full.documents.length === 0) throw new SigningSessionInvalidError('envelope has no documents');

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const envelope = await this.repo.transitionEnvelopeIn(tx, {
        tenant_id,
        envelope_id,
        to: 'SENT',
        event_type: 'ENVELOPE_SENT',
        actor_type: 'SERVICE',
        actor_ref,
        timestampField: 'sent_at',
      });
      const sessions: IssuedSession[] = [];
      for (const signer of full.signers) {
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

  // ── Accept the e-sign disclosure (R16). Versioned frozen text + hash. ES-1:
  // under the envelope row lock, with a live session. ──
  async acceptDisclosure(ctx: SessionContext, input: { disclosure_version: string; disclosure_text_hash: string; ip_address?: string; user_agent?: string }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.repo.lockSignableEnvelope(tx, ctx.tenant_id, ctx.envelope_id);
      await this.assertLiveSession(tx, ctx);
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
        })),
    );
    fields.sort((a, b) => a.page_number - b.page_number || a.y - b.y || a.x - b.x);
    return { documents, fields };
  }

  // ── PX-V1 F3 — resolve the server-side source descriptor for a document in the
  // session's envelope. Disclosure-gated. The descriptor (incl. tenant_id) is for
  // the composition root's source resolver ONLY and is never returned to the
  // client. ──
  async resolveSignerSource(ctx: SessionContext, documentId: string): Promise<SignerSourceDescriptor> {
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
  async completeSigner(ctx: SessionContext): Promise<{ envelope_status: string }> {
    const completed = await this.prisma.$transaction(async (tx) => {
      const envelopeStatus = await this.repo.lockSignableEnvelope(tx, ctx.tenant_id, ctx.envelope_id);
      await this.assertLiveSession(tx, ctx);
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
      if (!signers.every((s) => s.status === 'SIGNED')) return false;
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
    if (!completed) return { envelope_status: 'IN_PROGRESS' };
    // DOC-4 (R-4-3) — produce executed bytes + completion notification when a
    // producer is bound (apps/esign-service composition root). Runs only for the
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
      if (session_id !== undefined) await this.assertLiveSession(tx, { session_id, tenant_id, envelope_id, signer_id });
      await tx.signer.update({ where: { id: signer_id }, data: { status: 'DECLINED', declined_at: new Date(), decline_reason: reason } });
      await this.repo.transitionEnvelopeIn(tx, {
        tenant_id, envelope_id, to: 'DECLINED', event_type: 'ENVELOPE_DECLINED', actor_type: 'SIGNER', actor_ref: signer_id, timestampField: 'declined_at', payload: { reason },
      });
    });
  }

  async voidEnvelope(tenant_id: string, envelope_id: string, actor_ref: string, reason: string): Promise<void> {
    await this.repo.transitionEnvelope({
      tenant_id, envelope_id, to: 'VOIDED', event_type: 'ENVELOPE_VOIDED', actor_type: 'SERVICE', actor_ref, timestampField: 'voided_at', payload: { reason },
    });
  }

  async expireEnvelope(tenant_id: string, envelope_id: string): Promise<void> {
    await this.repo.transitionEnvelope({
      tenant_id, envelope_id, to: 'EXPIRED', event_type: 'ENVELOPE_EXPIRED', actor_type: 'SYSTEM',
    });
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
      const minted: IssuedSession[] = [];
      for (const signer of incomplete) {
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
      await this.repo.appendEvent(tx, {
        tenant_id,
        envelope_id,
        event_type: 'SIGNATURE_REMINDER_SENT',
        actor_type: 'SERVICE',
        actor_ref,
      });
      return minted;
    });
    return { sessions };
  }
}
