import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { generateSigningToken } from './signing-token.js';
import { EsignRepository } from './esign.repository.js';
import { LIVE_SESSION_STATUSES } from './domain/envelope-lifecycle.js';
import { InboxSigningRefusedError } from './domain/envelope-contract-errors.js';
import { currentTurnSignerId, isLinkSigner } from './domain/recipients.js';

// Sign Unified Product S-7 (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.6, mandatory refinement B) — persistence
// for recipient bindings and the recipient-only access they allow. Every read is
// keyed by the AUTHENTICATED user id: a binding never reaches another user, and
// nothing here lists or reads the sender tenant's envelopes.

// Inbox signing sessions are short: the user asked to sign now.
export const RECIPIENT_SESSION_TTL_MS = 30 * 60 * 1000;
// Inbox signed-copy links are short as well (the emailed one keeps its own TTL).
export const RECIPIENT_COPY_TTL_MS = 10 * 60 * 1000;

// Sign Mobile M-A2 §2.2 — the ledger event that audits an inbox-originated session.
export const RECIPIENT_INBOX_SESSION_EVENT = 'RECIPIENT_INBOX_SESSION_ISSUED';

export interface IssuedRecipientSession {
  raw_token: string;
  session_id: string;
  expires_at: Date;
}

export interface RecipientInboxRow {
  id: string;
  envelope_tenant_id: string;
  envelope_id: string;
  signer_id: string;
  created_at: Date;
  envelope: { subject: string; status: string; sent_at: Date | null; completed_at: Date | null; expires_at: Date | null };
  signer: { name: string; status: string; signed_at: Date | null };
}

@Injectable()
export class RecipientInboxRepository {
  private readonly esign: EsignRepository;

  constructor(
    private readonly prisma: PrismaService,
    esign?: EsignRepository,
  ) {
    this.esign = esign ?? new EsignRepository(prisma);
  }

  // The live session (if any) behind a raw signing token, with its recipient.
  // M-A5 §5 — `origin` lets the claim refuse HOSTED / SELF (and INBOX) sessions.
  async sessionForToken(token_hash: string): Promise<{ id: string; tenant_id: string; envelope_id: string; signer_id: string; status: string; expires_at: Date; signer_email: string | null; origin: string | null } | null> {
    const s = await this.prisma.signingSession.findUnique({
      where: { token_hash },
      select: { id: true, tenant_id: true, envelope_id: true, signer_id: true, status: true, expires_at: true, origin: true, signer: { select: { email: true } } },
    });
    return s === null ? null : { id: s.id, tenant_id: s.tenant_id, envelope_id: s.envelope_id, signer_id: s.signer_id, status: s.status, expires_at: s.expires_at, signer_email: s.signer.email, origin: s.origin };
  }

  // Sign Mobile M-A2 §2.2 — a (re-)claim records the emailed session it was made
  // with and the email it matched; inbox signing never outlives that link.
  async bind(input: { envelope_tenant_id: string; envelope_id: string; signer_id: string; user_id: string; user_tenant_id: string; email: string; claim_session_id?: string }): Promise<{ id: string }> {
    return this.prisma.signRecipientBinding.upsert({
      where: { signer_id_user_id: { signer_id: input.signer_id, user_id: input.user_id } },
      create: { id: randomUUID(), ...input },
      update: { revoked_at: null, email: input.email, ...(input.claim_session_id !== undefined ? { claim_session_id: input.claim_session_id } : {}) },
      select: { id: true },
    });
  }

  listForUser(user_id: string): Promise<RecipientInboxRow[]> {
    return this.prisma.signRecipientBinding.findMany({
      where: { user_id, revoked_at: null },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        envelope_tenant_id: true,
        envelope_id: true,
        signer_id: true,
        created_at: true,
        envelope: { select: { subject: true, status: true, sent_at: true, completed_at: true, expires_at: true } },
        signer: { select: { name: true, status: true, signed_at: true } },
      },
    });
  }

  getForUser(user_id: string, id: string): Promise<RecipientInboxRow | null> {
    return this.prisma.signRecipientBinding.findFirst({
      where: { id, user_id, revoked_at: null },
      select: {
        id: true,
        envelope_tenant_id: true,
        envelope_id: true,
        signer_id: true,
        created_at: true,
        envelope: { select: { subject: true, status: true, sent_at: true, completed_at: true, expires_at: true } },
        signer: { select: { name: true, status: true, signed_at: true } },
      },
    });
  }

  async revoke(user_id: string, id: string): Promise<boolean> {
    const r = await this.prisma.signRecipientBinding.updateMany({ where: { id, user_id, revoked_at: null }, data: { revoked_at: new Date() } });
    return r.count > 0;
  }

  // A NEW, short-lived signing session for this recipient. It never revokes the
  // emailed link's session (that stays independently valid), and the ledger
  // records that the recipient opened it from their Aramo inbox.
  //
  // Sign Mobile M-A2 §2.2 (continuing authority) — the claim is an association, not
  // a standing right. EVERY call revalidates, in ONE transaction under the envelope
  // row lock, before anything is minted:
  //   association_inactive   the binding was removed (it is the caller's — a foreign
  //                          or unknown binding returns null, read as not found);
  //   envelope_not_signable  the envelope is not SENT / IN_PROGRESS or has expired;
  //   signer_ineligible      the signer is not PENDING / VIEWED, no longer on the
  //                          envelope, or no longer has the email matched at claim;
  //   not_your_turn          SEQUENTIAL routing and an earlier signer has not signed;
  //   session_revoked        the claimed link was revoked (a reminder replaced it);
  //   link_expired           the claimed link has expired.
  // The minted session is single-envelope, single-signer, at most 30 minutes and
  // never outlives the claimed link or the envelope. The ledger event
  // RECIPIENT_INBOX_SESSION_ISSUED audits it (in the same transaction).
  async issueRevalidatedRecipientSession(user_id: string, binding_id: string, now: Date = new Date()): Promise<IssuedRecipientSession | null> {
    return this.prisma.$transaction(async (tx) => {
      const binding = await tx.signRecipientBinding.findFirst({ where: { id: binding_id, user_id } });
      if (binding === null) return null;
      if (binding.revoked_at !== null) throw new InboxSigningRefusedError('association_inactive');
      const tenant_id = binding.envelope_tenant_id;
      const status = await this.esign.lockEnvelope(tx, tenant_id, binding.envelope_id);
      const env = await tx.signatureEnvelope.findFirst({ where: { id: binding.envelope_id, tenant_id }, select: { routing_mode: true, expires_at: true } });
      if ((status !== 'SENT' && status !== 'IN_PROGRESS') || env === null || (env.expires_at !== null && env.expires_at.getTime() <= now.getTime())) {
        throw new InboxSigningRefusedError('envelope_not_signable');
      }
      const signer = await tx.signer.findFirst({ where: { id: binding.signer_id, envelope_id: binding.envelope_id, tenant_id } });
      if (
        signer === null ||
        !isLinkSigner(signer) ||
        signer.email === null ||
        (signer.status !== 'PENDING' && signer.status !== 'VIEWED') ||
        signer.email.trim().toLowerCase() !== binding.email.trim().toLowerCase()
      ) {
        throw new InboxSigningRefusedError('signer_ineligible');
      }
      if (env.routing_mode === 'SEQUENTIAL') {
        // M-A5 §1.3 — the shared current-turn rule (copy recipients never take a turn).
        const next = await currentTurnSignerId(tx as never, tenant_id, binding.envelope_id);
        if (next !== signer.id) throw new InboxSigningRefusedError('not_your_turn');
      }
      const linkExpiry = await this.claimedLinkExpiry(tx, binding, now);
      const bound = Math.min(now.getTime() + RECIPIENT_SESSION_TTL_MS, linkExpiry.getTime(), env.expires_at?.getTime() ?? Number.POSITIVE_INFINITY);
      const minted = generateSigningToken();
      const session_id = randomUUID();
      const expires_at = new Date(bound);
      await tx.signingSession.create({
        data: { id: session_id, tenant_id, envelope_id: binding.envelope_id, signer_id: signer.id, token_hash: minted.hash, status: 'ISSUED', expires_at, origin: 'INBOX' },
      });
      await this.esign.appendEvent(tx, {
        tenant_id,
        envelope_id: binding.envelope_id,
        signer_id: signer.id,
        event_type: RECIPIENT_INBOX_SESSION_EVENT,
        actor_type: 'SIGNER',
        actor_ref: signer.id,
        payload: { origin: 'inbox', session_id, binding_id: binding.id },
      });
      return { raw_token: minted.raw, session_id, expires_at };
    });
  }

  // The emailed link behind this association must still be live. Bindings claimed
  // before claim_session_id existed fall back to "the signer still holds a live
  // EMAILED link" (an inbox session never qualifies — it lasts at most 30 minutes).
  private async claimedLinkExpiry(
    tx: Pick<PrismaService, 'signingSession'>,
    binding: { signer_id: string; claim_session_id: string | null },
    now: Date,
  ): Promise<Date> {
    if (binding.claim_session_id !== null) {
      const s = await tx.signingSession.findFirst({ where: { id: binding.claim_session_id, signer_id: binding.signer_id }, select: { status: true, expires_at: true } });
      if (s === null || s.status === 'REVOKED') throw new InboxSigningRefusedError('session_revoked');
      if (s.status === 'EXPIRED' || s.expires_at.getTime() <= now.getTime()) throw new InboxSigningRefusedError('link_expired');
      if (!LIVE_SESSION_STATUSES.includes(s.status)) throw new InboxSigningRefusedError('session_revoked');
      return s.expires_at;
    }
    // M-A5 §5 — only an emailed (LINK or legacy) session qualifies.
    const live = await tx.signingSession.findMany({
      where: { signer_id: binding.signer_id, status: { in: [...LIVE_SESSION_STATUSES] }, expires_at: { gt: now }, OR: [{ origin: null }, { origin: 'LINK' }] },
      select: { created_at: true, expires_at: true },
    });
    const emailed = live.filter((s) => s.expires_at.getTime() - s.created_at.getTime() > RECIPIENT_SESSION_TTL_MS);
    if (emailed.length === 0) throw new InboxSigningRefusedError('session_revoked');
    return new Date(Math.max(...emailed.map((s) => s.expires_at.getTime())));
  }

  async issueRecipientCopyAccess(tenant_id: string, envelope_id: string, signer_id: string): Promise<string> {
    const minted = generateSigningToken();
    await this.prisma.executedAccessGrant.create({
      data: { id: randomUUID(), tenant_id, envelope_id, signer_id, token_hash: minted.hash, expires_at: new Date(Date.now() + RECIPIENT_COPY_TTL_MS), access_kind: 'EXECUTED' },
    });
    return minted.raw;
  }
}
