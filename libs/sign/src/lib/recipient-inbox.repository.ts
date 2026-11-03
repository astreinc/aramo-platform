import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { generateSigningToken } from './signing-token.js';
import { EsignRepository } from './esign.repository.js';
import { LIVE_SESSION_STATUSES } from './domain/envelope-lifecycle.js';
import { InboxSigningRefusedError } from './domain/envelope-contract-errors.js';
import { currentTurnSignerId, isLinkSigner, isWitness, mayActNow } from './domain/recipients.js';

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
  envelope: {
    subject: string;
    status: string;
    sent_at: Date | null;
    completed_at: Date | null;
    expires_at: Date | null;
    // W2 — read for the turn rule only; never part of a list item.
    routing_mode?: string;
    // W2 (orchestrator addition) — read only to answer i_am_sender; never part of a list item.
    created_by?: string;
    // Retention and Purge directive (ebd41d99) — the envelope's purge state (null until queued).
    purge_state?: string | null;
    purge_level?: string | null;
    purge_due_at?: Date | null;
    purge_executed_at?: Date | null;
  };
  signer: { name: string; status: string; signed_at: Date | null };
}

// Aramo Sign W2 (Aramo-Sign-W2-Inbox-Discovery-Gate5-Plan-and-Amendment-v1_0-LOCKED §A3.1-§A3.2)
// — an inbox item with what the list needs to decide "actionable" vs "upcoming":
//   source     bound (a recipient binding, `id` = the binding id) or discovered (no binding,
//              `id` = the signer id; the service replaces it with an opaque handle);
//   turn       'now' when the shared rule mayActNow holds (sequential turn AND witness
//              readiness), 'later' otherwise;
//   link_live  W-3: a live emailed link backs inbox signing (for a binding with a recorded
//              claim session, that session; otherwise any live emailed session of the signer).
export interface RecipientInboxEntry extends RecipientInboxRow {
  source: 'bound' | 'discovered';
  turn: 'now' | 'later';
  link_live: boolean;
}

// W-1 / W-2 (Lead C1, C2) — the signed-in user's proof of control of the CURRENT account
// email: `email` is that email normalized (lower(btrim)), `proven_at` the created_at of the
// earliest qualifying link. A qualifying link is a federated link with a recorded provider
// (google | microsoft) whose verified email at link time equals the current account email.
// The link time marks the start of recorded verification only; envelopes sent before it are
// never discovered. Null when the user is inactive or deactivated or holds no such link.
export interface VerifiedEmailProof {
  email: string;
  proven_at: Date;
}

type RawClient = Pick<PrismaService, '$queryRawUnsafe'>;

export async function readVerifiedEmailProof(client: RawClient, user_id: string): Promise<VerifiedEmailProof | null> {
  const rows = await client.$queryRawUnsafe<Array<{ email: string; proven_at: Date }>>(
    `SELECT lower(btrim(u.email)) AS email, min(e.created_at) AS proven_at
       FROM identity."User" u
       JOIN identity."ExternalIdentity" e ON e.user_id = u.id
       JOIN identity."ExternalIdentityIdp" p ON p.external_identity_id = e.id
      WHERE u.id = $1::uuid
        AND u.is_active = true
        AND u.deactivated_at IS NULL
        AND p.idp IN ('google', 'microsoft')
        AND e.email_snapshot IS NOT NULL
        AND lower(btrim(e.email_snapshot)) = lower(btrim(u.email))
      GROUP BY lower(btrim(u.email))`,
    user_id,
  );
  const r = rows[0];
  if (r === undefined || r.email.length === 0) return null;
  return { email: r.email, proven_at: r.proven_at };
}

const ENVELOPE_SELECT = {
  subject: true, status: true, sent_at: true, completed_at: true, expires_at: true, routing_mode: true, created_by: true,
  purge_state: true, purge_level: true, purge_due_at: true, purge_executed_at: true,
} as const;
const SIGNER_SELECT = { name: true, status: true, signed_at: true } as const;
// The most discovered items one list returns (newest sent first).
const DISCOVERY_LIMIT = 200;

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

  // W2 (sender list my_inbox_item_id) — this user's LIVE binding per recipient, if any.
  async liveBindingIds(user_id: string, signer_ids: readonly string[]): Promise<Map<string, string>> {
    if (signer_ids.length === 0) return new Map();
    const rows = await this.prisma.signRecipientBinding.findMany({ where: { user_id, revoked_at: null, signer_id: { in: [...signer_ids] } }, select: { id: true, signer_id: true } });
    return new Map(rows.map((r) => [r.signer_id, r.id]));
  }

  // W2 (sender list my_inbox_item_id) — recipients this user holds ANY binding for (live or
  // removed): such a recipient is never discovered (rule 5), so it gets no handle either.
  async anyBindingSignerIds(user_id: string, signer_ids: readonly string[]): Promise<Set<string>> {
    if (signer_ids.length === 0) return new Set();
    const rows = await this.prisma.signRecipientBinding.findMany({ where: { user_id, signer_id: { in: [...signer_ids] } }, select: { signer_id: true } });
    return new Set(rows.map((r) => r.signer_id));
  }

  // W2 rule 1 — see readVerifiedEmailProof.
  verifiedEmailProof(user_id: string): Promise<VerifiedEmailProof | null> {
    return readVerifiedEmailProof(this.prisma, user_id);
  }

  // The user's live bindings, each with its turn and link liveness.
  async listForUser(user_id: string, now: Date = new Date()): Promise<RecipientInboxEntry[]> {
    const rows = await this.prisma.signRecipientBinding.findMany({
      where: { user_id, revoked_at: null },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        envelope_tenant_id: true,
        envelope_id: true,
        signer_id: true,
        created_at: true,
        claim_session_id: true,
        envelope: { select: ENVELOPE_SELECT },
        signer: { select: SIGNER_SELECT },
      },
    });
    return this.withActionability(
      rows.map((r) => ({ row: r, source: 'bound' as const, claim_session_id: r.claim_session_id })),
      now,
    );
  }

  // W2 §A3.1 — the recipient rows DISCOVERED for this user (never persisted; no binding,
  // claim or record in the user's organization is created). All of:
  //   1  `proof` (the caller reads it with readVerifiedEmailProof): active user, qualifying link;
  //   2  the recipient email equals the proven email (normalized), kind SIGNER or WITNESS;
  //   3  the envelope is SENT / IN_PROGRESS, or terminal where this recipient SIGNED;
  //   4  the envelope was sent at or after proof.proven_at;
  //   5  the user holds no binding for this recipient (a live one lists it as bound; a removed
  //      one keeps it out of the inbox, as removal promises);
  //   6  party deletion is applied by the service, keyed by the user (same as bound items).
  // No tenant scoping on the recipient side (option B): any organization's envelope.
  async listDiscoveredForUser(user_id: string, proof: VerifiedEmailProof, now: Date = new Date()): Promise<RecipientInboxEntry[]> {
    const ids = await this.prisma.$queryRawUnsafe<Array<{ signer_id: string }>>(
      `SELECT s.id AS signer_id
         FROM "sign"."Signer" s
         JOIN "sign"."SignatureEnvelope" e ON e.id = s.envelope_id AND e.tenant_id = s.tenant_id
        WHERE lower(btrim(s.email)) = $1
          AND s.recipient_kind IN ('SIGNER', 'WITNESS')
          AND e.deleted_at IS NULL
          AND e.sent_at IS NOT NULL
          AND e.sent_at >= $2::timestamptz
          AND (e.status IN ('SENT', 'IN_PROGRESS') OR (e.status <> 'DRAFT' AND s.status = 'SIGNED'))
          AND NOT EXISTS (SELECT 1 FROM "sign"."SignRecipientBinding" b WHERE b.signer_id = s.id AND b.user_id = $3::uuid)
        ORDER BY e.sent_at DESC, s.id
        LIMIT ${DISCOVERY_LIMIT}`,
      proof.email,
      proof.proven_at,
      user_id,
    );
    if (ids.length === 0) return [];
    const signers = await this.prisma.signer.findMany({
      where: { id: { in: ids.map((r) => r.signer_id) } },
      select: { id: true, tenant_id: true, envelope_id: true, ...SIGNER_SELECT, envelope: { select: ENVELOPE_SELECT } },
    });
    const byId = new Map(signers.map((s) => [s.id, s]));
    const rows = ids
      .map((r) => byId.get(r.signer_id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map((s) => ({
        row: {
          id: s.id,
          envelope_tenant_id: s.tenant_id,
          envelope_id: s.envelope_id,
          signer_id: s.id,
          created_at: s.envelope.sent_at ?? now,
          envelope: s.envelope,
          signer: { name: s.name, status: s.status, signed_at: s.signed_at },
        },
        source: 'discovered' as const,
        claim_session_id: null,
      }));
    return this.withActionability(rows, now);
  }

  // Turn (the shared mayActNow rule: sequential turn + witness readiness) and W-3 link
  // liveness, read in three set-based queries for the whole list.
  private async withActionability(
    items: Array<{ row: RecipientInboxRow & { envelope: { routing_mode: string } }; source: 'bound' | 'discovered'; claim_session_id: string | null }>,
    now: Date,
  ): Promise<RecipientInboxEntry[]> {
    if (items.length === 0) return [];
    const envelopeIds = [...new Set(items.map((i) => i.row.envelope_id))];
    const recipients = await this.prisma.signer.findMany({
      where: { envelope_id: { in: envelopeIds } },
      select: { id: true, envelope_id: true, status: true, signing_order: true, recipient_kind: true, witness_for_signer_id: true },
    });
    const byEnvelope = new Map<string, typeof recipients>();
    for (const r of recipients) byEnvelope.set(r.envelope_id, [...(byEnvelope.get(r.envelope_id) ?? []), r]);

    const claimIds = items.map((i) => i.claim_session_id).filter((x): x is string => x !== null);
    const claimed = claimIds.length === 0
      ? []
      : await this.prisma.signingSession.findMany({ where: { id: { in: claimIds } }, select: { id: true, signer_id: true, status: true, expires_at: true } });
    const claimLive = new Set(
      claimed.filter((c) => LIVE_SESSION_STATUSES.includes(c.status) && c.expires_at.getTime() > now.getTime()).map((c) => `${c.id}:${c.signer_id}`),
    );
    const emailedFor = items.filter((i) => i.claim_session_id === null).map((i) => i.row.signer_id);
    const emailed = emailedFor.length === 0
      ? []
      : await this.prisma.signingSession.findMany({
          where: { signer_id: { in: emailedFor }, status: { in: [...LIVE_SESSION_STATUSES] }, expires_at: { gt: now }, OR: [{ origin: null }, { origin: 'LINK' }] },
          select: { signer_id: true, created_at: true, expires_at: true },
        });
    // M-A5 §5 — only an emailed link qualifies (an inbox session lasts at most 30 minutes).
    const emailedLive = new Set(emailed.filter((s) => s.expires_at.getTime() - s.created_at.getTime() > RECIPIENT_SESSION_TTL_MS).map((s) => s.signer_id));

    return items.map(({ row, source, claim_session_id }) => {
      const rows = byEnvelope.get(row.envelope_id) ?? [];
      const turn: 'now' | 'later' = mayActNow(row.envelope.routing_mode, rows, row.signer_id) ? 'now' : 'later';
      const link_live = claim_session_id !== null ? claimLive.has(`${claim_session_id}:${row.signer_id}`) : emailedLive.has(row.signer_id);
      return { ...row, source, turn, link_live };
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
        envelope: { select: ENVELOPE_SELECT },
        signer: { select: SIGNER_SELECT },
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
      const env = await this.lockSignableEnvelope(tx, tenant_id, binding.envelope_id, now);
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
      await this.assertTurn(tx, tenant_id, binding.envelope_id, env.routing_mode, signer);
      const linkExpiry = await this.claimedLinkExpiry(tx, binding, now);
      return this.mint(tx, { tenant_id, envelope_id: binding.envelope_id, signer_id: signer.id, linkExpiry, envelopeExpiry: env.expires_at, now, payload: { binding_id: binding.id } });
    });
  }

  // Aramo Sign W2 §A3.3 / §A3.4 (Lead C3) — the binding-less mint for a DISCOVERED item. The
  // handle only named `signer_id`; this re-runs the whole discovery rule (§A3.1 rules 1-6)
  // against the user's CURRENT state and today's revalidation, in ONE transaction under the
  // envelope row lock, before anything is minted. Nothing is persisted but the session and
  // its ledger event: no binding, claim, consent or signing event.
  //   association_inactive   rule 1 (inactive / deactivated / no qualifying link for the
  //                          current email), rule 4 (sent before the proof), rule 5 (the
  //                          user holds a binding for this recipient: sign through it);
  //   envelope_not_signable  not SENT / IN_PROGRESS, expired, or a deleted draft;
  //   signer_ineligible      rule 2 (kind, email no longer the user's email, e.g. delegated)
  //                          or not PENDING / VIEWED;
  //   not_your_turn          sequential turn or witness readiness;
  //   session_revoked / link_expired   W-3: no live emailed link for this recipient.
  // Rule 6 (party deletion) applies to terminal envelopes only, which are refused above.
  // Recipient authentication (access code, ID verification, SMS OTP) stays on the token path.
  async issueDiscoveredRecipientSession(user_id: string, signer_id: string, now: Date = new Date()): Promise<IssuedRecipientSession> {
    return this.prisma.$transaction(async (tx) => {
      const located = await tx.signer.findFirst({ where: { id: signer_id }, select: { tenant_id: true, envelope_id: true } });
      if (located === null) throw new InboxSigningRefusedError('signer_ineligible');
      const { tenant_id, envelope_id } = located;
      const env = await this.lockSignableEnvelope(tx, tenant_id, envelope_id, now);
      const proof = await readVerifiedEmailProof(tx, user_id);
      if (proof === null) throw new InboxSigningRefusedError('association_inactive');
      if (env.sent_at === null || env.sent_at.getTime() < proof.proven_at.getTime()) throw new InboxSigningRefusedError('association_inactive');
      const bound = await tx.signRecipientBinding.findFirst({ where: { signer_id, user_id }, select: { id: true } });
      if (bound !== null) throw new InboxSigningRefusedError('association_inactive');
      const signer = await tx.signer.findFirst({ where: { id: signer_id, envelope_id, tenant_id } });
      if (
        signer === null ||
        !isLinkSigner(signer) ||
        signer.email === null ||
        (signer.status !== 'PENDING' && signer.status !== 'VIEWED') ||
        signer.email.trim().toLowerCase() !== proof.email
      ) {
        throw new InboxSigningRefusedError('signer_ineligible');
      }
      await this.assertTurn(tx, tenant_id, envelope_id, env.routing_mode, signer);
      const linkExpiry = await this.claimedLinkExpiry(tx, { signer_id, claim_session_id: null }, now);
      return this.mint(tx, { tenant_id, envelope_id, signer_id, linkExpiry, envelopeExpiry: env.expires_at, now, payload: { discovery: 'verified_account_email' } });
    });
  }

  private async lockSignableEnvelope(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    tenant_id: string,
    envelope_id: string,
    now: Date,
  ): Promise<{ routing_mode: string; expires_at: Date | null; sent_at: Date | null }> {
    const status = await this.esign.lockEnvelope(tx, tenant_id, envelope_id);
    const env = await tx.signatureEnvelope.findFirst({ where: { id: envelope_id, tenant_id }, select: { routing_mode: true, expires_at: true, sent_at: true, deleted_at: true } });
    if ((status !== 'SENT' && status !== 'IN_PROGRESS') || env === null || env.deleted_at !== null || (env.expires_at !== null && env.expires_at.getTime() <= now.getTime())) {
      throw new InboxSigningRefusedError('envelope_not_signable');
    }
    return env;
  }

  private async assertTurn(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    tenant_id: string,
    envelope_id: string,
    routing_mode: string,
    signer: { id: string; recipient_kind: string; witness_for_signer_id: string | null },
  ): Promise<void> {
    if (routing_mode === 'SEQUENTIAL') {
      // M-A5 §1.3 — the shared current-turn rule (copy recipients never take a turn).
      const next = await currentTurnSignerId(tx as never, tenant_id, envelope_id);
      if (next !== signer.id) throw new InboxSigningRefusedError('not_your_turn');
    }
    // Feature-Parity §1.17 — a witness signs only after the signer it witnesses.
    if (isWitness(signer)) {
      const principal = signer.witness_for_signer_id === null
        ? null
        : await tx.signer.findFirst({ where: { id: signer.witness_for_signer_id, tenant_id, envelope_id }, select: { status: true } });
      if (principal?.status !== 'SIGNED') throw new InboxSigningRefusedError('not_your_turn');
    }
  }

  private async mint(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    m: { tenant_id: string; envelope_id: string; signer_id: string; linkExpiry: Date; envelopeExpiry: Date | null; now: Date; payload: Record<string, string> },
  ): Promise<IssuedRecipientSession> {
    const bound = Math.min(m.now.getTime() + RECIPIENT_SESSION_TTL_MS, m.linkExpiry.getTime(), m.envelopeExpiry?.getTime() ?? Number.POSITIVE_INFINITY);
    const minted = generateSigningToken();
    const session_id = randomUUID();
    const expires_at = new Date(bound);
    await tx.signingSession.create({
      data: { id: session_id, tenant_id: m.tenant_id, envelope_id: m.envelope_id, signer_id: m.signer_id, token_hash: minted.hash, status: 'ISSUED', expires_at, origin: 'INBOX' },
    });
    await this.esign.appendEvent(tx, {
      tenant_id: m.tenant_id,
      envelope_id: m.envelope_id,
      signer_id: m.signer_id,
      event_type: RECIPIENT_INBOX_SESSION_EVENT,
      actor_type: 'SIGNER',
      actor_ref: m.signer_id,
      payload: { origin: 'inbox', session_id, ...m.payload },
    });
    return { raw_token: minted.raw, session_id, expires_at };
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
