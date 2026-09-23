import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { EsignRepository } from './esign.repository.js';
import { generateSigningToken, hashSigningToken, signingSessionExpiresAt } from './signing-token.js';
import {
  DisclosureNotAcceptedError,
  EnvelopeIllegalTransitionError,
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

// Envelope lifecycle transition guard (§10 / R-3-3).
const ENVELOPE_TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ['SENT', 'VOIDED'],
  SENT: ['IN_PROGRESS', 'DECLINED', 'VOIDED', 'EXPIRED'],
  IN_PROGRESS: ['COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'],
  COMPLETED: [],
  DECLINED: [],
  VOIDED: [],
  EXPIRED: [],
};

function assertTransition(from: string, to: string): void {
  if (!(ENVELOPE_TRANSITIONS[from] ?? []).includes(to)) {
    throw new EnvelopeIllegalTransitionError(from, to);
  }
}

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

@Injectable()
export class EsignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: EsignRepository,
    @Inject(EVIDENCE_MANIFEST_SIGNER_PORT) private readonly evidenceSigner: EvidenceManifestSignerPort,
  ) {}

  private async requireStatus(tenant_id: string, envelope_id: string, expected: string): Promise<void> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    if (env.status !== expected) throw new EnvelopeIllegalTransitionError(env.status, `mutate(${expected}-only)`);
  }

  // ── Send: DRAFT -> SENT. Issues a signing session per signer (raw tokens
  // returned ONCE). Requires >=1 signer and >=1 document. ──
  async send(tenant_id: string, envelope_id: string, actor_ref: string): Promise<{ envelope: unknown; sessions: IssuedSession[] }> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    assertTransition(env.status, 'SENT');
    const full = await this.repo.getEnvelopeFull(tenant_id, envelope_id);
    if (full.signers.length === 0) throw new SigningSessionInvalidError('envelope has no signers');
    if (full.documents.length === 0) throw new SigningSessionInvalidError('envelope has no documents');

    const sessions: IssuedSession[] = [];
    const now = new Date();
    for (const signer of full.signers) {
      const minted = generateSigningToken();
      const sessionId = randomUUID();
      await this.prisma.signingSession.create({
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
    const envelope = await this.repo.transitionEnvelope({
      tenant_id,
      envelope_id,
      to: 'SENT',
      event_type: 'ENVELOPE_SENT',
      actor_type: 'SERVICE',
      actor_ref,
      timestampField: 'sent_at',
    });
    return { envelope, sessions };
  }

  // ── Exchange a raw capability token for an active session context (R17).
  // Validates hash match, not expired/revoked/consumed. Tenant resolved FROM
  // the session, never the client. ──
  async exchangeToken(rawToken: string): Promise<SessionContext> {
    const hash = hashSigningToken(rawToken);
    const session = await this.prisma.signingSession.findUnique({ where: { token_hash: hash } });
    if (session === null) throw new SigningSessionInvalidError('unknown token');
    if (session.status === 'REVOKED' || session.status === 'EXPIRED' || session.status === 'COMPLETED') {
      throw new SigningSessionExpiredError(session.id);
    }
    if (session.expires_at.getTime() < Date.now()) {
      await this.prisma.signingSession.update({ where: { id: session.id }, data: { status: 'EXPIRED' } });
      throw new SigningSessionExpiredError(session.id);
    }
    await this.prisma.signingSession.update({
      where: { id: session.id },
      data: { status: 'ACTIVE', first_accessed_at: session.first_accessed_at ?? new Date(), last_accessed_at: new Date() },
    });
    await this.prisma.$transaction((tx) =>
      this.repo.appendEvent(tx, {
        tenant_id: session.tenant_id,
        envelope_id: session.envelope_id,
        signer_id: session.signer_id,
        event_type: 'SESSION_EXCHANGED',
        actor_type: 'SIGNER',
        actor_ref: session.signer_id,
      }),
    );
    // Mark signer VIEWED + envelope IN_PROGRESS (first activity).
    await this.prisma.signer.update({ where: { id: session.signer_id }, data: { status: 'VIEWED', viewed_at: new Date() } });
    const env = await this.repo.getEnvelope(session.tenant_id, session.envelope_id);
    if (env.status === 'SENT') {
      await this.repo.transitionEnvelope({
        tenant_id: session.tenant_id,
        envelope_id: session.envelope_id,
        to: 'IN_PROGRESS',
        event_type: 'ENVELOPE_IN_PROGRESS',
        actor_type: 'SIGNER',
        actor_ref: session.signer_id,
      });
    }
    return { session_id: session.id, tenant_id: session.tenant_id, envelope_id: session.envelope_id, signer_id: session.signer_id };
  }

  // ── Read-only session resolution for subsequent signer ops (no side effects).
  // Validates hash match + not expired/revoked/consumed; tenant FROM the session. ──
  async resolveSession(rawToken: string): Promise<SessionContext> {
    const hash = hashSigningToken(rawToken);
    const session = await this.prisma.signingSession.findUnique({ where: { token_hash: hash } });
    if (session === null) throw new SigningSessionInvalidError('unknown token');
    if (session.status === 'REVOKED' || session.status === 'EXPIRED') throw new SigningSessionExpiredError(session.id);
    if (session.expires_at.getTime() < Date.now()) throw new SigningSessionExpiredError(session.id);
    return { session_id: session.id, tenant_id: session.tenant_id, envelope_id: session.envelope_id, signer_id: session.signer_id };
  }

  // ── Accept the e-sign disclosure (R16). Versioned frozen text + hash. ──
  async acceptDisclosure(ctx: SessionContext, input: { disclosure_version: string; disclosure_text_hash: string; ip_address?: string; user_agent?: string }): Promise<void> {
    await this.prisma.signerDisclosureAcceptance.create({
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
    await this.prisma.$transaction((tx) =>
      this.repo.appendEvent(tx, {
        tenant_id: ctx.tenant_id,
        envelope_id: ctx.envelope_id,
        signer_id: ctx.signer_id,
        event_type: 'DISCLOSURE_ACCEPTED',
        actor_type: 'SIGNER',
        actor_ref: ctx.signer_id,
        payload: { disclosure_version: input.disclosure_version },
        ip_address: input.ip_address,
        user_agent: input.user_agent,
      }),
    );
  }

  private async hasAcceptedDisclosure(tenant_id: string, signer_id: string): Promise<boolean> {
    const n = await this.prisma.signerDisclosureAcceptance.count({ where: { tenant_id, signer_id } });
    return n > 0;
  }

  // ── Fill a signature field (requires disclosure accepted). ──
  async fillField(ctx: SessionContext, fieldId: string, input: { value: string; signature_method?: string }): Promise<void> {
    if (!(await this.hasAcceptedDisclosure(ctx.tenant_id, ctx.signer_id))) throw new DisclosureNotAcceptedError(ctx.signer_id);
    const field = await this.prisma.signatureField.findFirst({ where: { tenant_id: ctx.tenant_id, id: fieldId, signer_id: ctx.signer_id } });
    if (field === null) throw new SignerNotFoundError(ctx.signer_id);
    await this.prisma.signatureField.update({
      where: { id: fieldId },
      data: { value: input.value, signature_method: input.signature_method ?? null, filled_at: new Date() },
    });
  }

  // ── Complete a signer: all required fields filled -> SIGNED; if all signers
  // signed -> envelope COMPLETED (build + sign evidence manifest). ──
  async completeSigner(ctx: SessionContext): Promise<{ envelope_status: string }> {
    if (!(await this.hasAcceptedDisclosure(ctx.tenant_id, ctx.signer_id))) throw new DisclosureNotAcceptedError(ctx.signer_id);
    const required = await this.repo.listSignerRequiredFields(ctx.tenant_id, ctx.signer_id);
    const unfilled = required.filter((f) => f.filled_at === null);
    if (unfilled.length > 0) throw new SignatureFieldIncompleteError(ctx.signer_id);

    await this.prisma.signer.update({ where: { id: ctx.signer_id }, data: { status: 'SIGNED', signed_at: new Date() } });
    await this.prisma.signingSession.update({ where: { id: ctx.session_id }, data: { status: 'COMPLETED', completed_at: new Date() } });
    await this.prisma.$transaction((tx) =>
      this.repo.appendEvent(tx, {
        tenant_id: ctx.tenant_id,
        envelope_id: ctx.envelope_id,
        signer_id: ctx.signer_id,
        event_type: 'SIGNER_SIGNED',
        actor_type: 'SIGNER',
        actor_ref: ctx.signer_id,
      }),
    );

    const signers = await this.prisma.signer.findMany({ where: { tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id } });
    const allSigned = signers.every((s) => s.status === 'SIGNED');
    if (allSigned) {
      await this.repo.transitionEnvelope({
        tenant_id: ctx.tenant_id,
        envelope_id: ctx.envelope_id,
        to: 'COMPLETED',
        event_type: 'ENVELOPE_COMPLETED',
        actor_type: 'SERVICE',
        timestampField: 'completed_at',
      });
      return { envelope_status: 'COMPLETED' };
    }
    return { envelope_status: 'IN_PROGRESS' };
  }

  async decline(tenant_id: string, envelope_id: string, signer_id: string, reason: string): Promise<void> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    assertTransition(env.status, 'DECLINED');
    await this.prisma.signer.update({ where: { id: signer_id }, data: { status: 'DECLINED', declined_at: new Date(), decline_reason: reason } });
    await this.repo.transitionEnvelope({
      tenant_id, envelope_id, to: 'DECLINED', event_type: 'ENVELOPE_DECLINED', actor_type: 'SIGNER', actor_ref: signer_id, timestampField: 'declined_at', payload: { reason },
    });
  }

  async voidEnvelope(tenant_id: string, envelope_id: string, actor_ref: string, reason: string): Promise<void> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    assertTransition(env.status, 'VOIDED');
    await this.repo.transitionEnvelope({
      tenant_id, envelope_id, to: 'VOIDED', event_type: 'ENVELOPE_VOIDED', actor_type: 'SERVICE', actor_ref, timestampField: 'voided_at', payload: { reason },
    });
  }

  async expireEnvelope(tenant_id: string, envelope_id: string): Promise<void> {
    const env = await this.repo.getEnvelope(tenant_id, envelope_id);
    assertTransition(env.status, 'EXPIRED');
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
    const manifest: EvidenceManifest = {
      envelope_id,
      source_sha256: full.documents[0]?.source_sha256 ?? null,
      executed_sha256: null, // DOC-4 produces executed bytes
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
}
