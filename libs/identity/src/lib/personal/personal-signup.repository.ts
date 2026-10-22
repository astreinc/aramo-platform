import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import type { GeoEvidence } from './geo-ip.port.js';
import type { PersonalRiskDecision, PersonalRiskSignal } from './personal-risk-rating.js';
import { writePersonalAudit, type TenantRiskStateValue } from './personal-risk.service.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §3 / §7 / §10 — the
// Personal signup request store, the pilot invites and the unbound-lapse sweep.
// The orchestration (validation, mail, provisioning saga) lives in
// apps/platform-admin; this class owns the identity-schema rows and writes each
// state change with its audit event in ONE transaction.

export const PERSONAL_SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;
export const PERSONAL_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PERSONAL_UNBOUND_LAPSE_DAYS = 7;
// PO decision 2026-10-22 — a signup request whose email was never verified is
// deleted (the row, with its email, phone and address) 3 days after it was created.
export const PERSONAL_UNVERIFIED_PURGE_DAYS = 3;
// The never-verified statuses: PENDING (started, email code sent) and REFUSED
// (refused by the risk rating at start, before any code). Every later status
// (EMAIL_VERIFIED, PROVISIONING, PROVISIONED, FAILED, LAPSED) is past email
// verification and keeps its own path.
export const PERSONAL_UNVERIFIED_STATUSES = ['PENDING', 'REFUSED'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export type PersonalSignupStatus = 'PENDING' | 'EMAIL_VERIFIED' | 'PROVISIONING' | 'PROVISIONED' | 'REFUSED' | 'FAILED' | 'LAPSED';

export interface PersonalSignupRow {
  id: string;
  email: string;
  canonical_email: string;
  display_name: string;
  phone_e164: string;
  declared_residence: string;
  ip: string | null;
  ip_country: string | null;
  phone_region: string | null;
  network_kind: string | null;
  geo_evidence: unknown;
  email_otp_hash: string | null;
  email_otp_expires_at: Date | null;
  email_otp_attempts: number;
  email_otp_sent_count: number;
  email_otp_last_sent_at: Date | null;
  email_verified_at: Date | null;
  phone_otp_hash: string | null;
  phone_otp_expires_at: Date | null;
  phone_otp_attempts: number;
  phone_otp_sent_count: number;
  phone_otp_last_sent_at: Date | null;
  phone_verified_at: Date | null;
  risk_points: number;
  risk_signals: unknown;
  decision: string;
  invite_id: string | null;
  accepted_documents: unknown;
  accepted_ip: string | null;
  accepted_at: Date | null;
  status: string;
  failure_code: string | null;
  tenant_id: string | null;
  owner_user_id: string | null;
  provisioned_at: Date | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface PersonalReviewItem {
  tenant_id: string;
  tenant_name: string | null;
  tenant_status: string | null;
  owner_email: string | null;
  state: TenantRiskStateValue;
  reason: string | null;
  step_up_required: boolean;
  // A review still owed under a (temporary) restriction.
  review_pending: boolean;
  // 'review' = an operator's review lifted the phone step while SMS was unavailable.
  step_up_cleared_by: string | null;
  // The signup's GeoLite2 evidence (country null = UNKNOWN), when recorded.
  geo: GeoEvidence | null;
  risk_points: number | null;
  decision: string | null;
  signals: { key: string; points: number; detail?: string }[];
  phone_verified_at: Date | null;
  restricted_until: Date | null;
  decided_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The pilot invite code shown once to the operator: 12 base32 characters in 3 groups. */
export function generatePersonalInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i += 1) out += alphabet[bytes[i]! % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

export function hashPersonalInviteCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return createHash('sha256').update(`personal-invite:${normalized}`, 'utf8').digest('hex');
}

/**
 * The initial risk state a completed signup opens with (§6.2 / §6.3).
 * `sms_available` (the SMS port is configured): with SMS, a step-up without phone
 * assurance waits in the review queue and only a phone code satisfies it. Without
 * SMS (PO 2026-10-21 "Review replaces phone"), the step-up is routed to review
 * (reason step_up_phone_unavailable); an operator clearing that review lifts the
 * phone step but NEVER records phone assurance (correction C).
 */
export function initialRiskState(
  decision: PersonalRiskDecision,
  phone_verified: boolean,
  sms_available = true,
): { state: TenantRiskStateValue; step_up_required: boolean; reason: string | null } {
  if (decision === 'review') return { state: 'review', step_up_required: false, reason: 'signup_review' };
  if (decision === 'step_up') {
    if (phone_verified) return { state: 'clear', step_up_required: true, reason: 'signup_step_up' };
    return sms_available
      ? { state: 'review', step_up_required: true, reason: 'signup_step_up_unverified' }
      : { state: 'review', step_up_required: true, reason: 'step_up_phone_unavailable' };
  }
  return { state: 'clear', step_up_required: false, reason: null };
}

@Injectable()
export class PersonalSignupRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    email: string;
    canonical_email: string;
    display_name: string;
    phone_e164: string;
    declared_residence: string;
    ip: string | null;
    ip_country: string | null;
    phone_region: string | null;
    network_kind: string | null;
    geo_evidence: GeoEvidence;
    risk_points: number;
    risk_signals: PersonalRiskSignal[];
    decision: PersonalRiskDecision;
    invite_id: string | null;
    status: 'PENDING' | 'REFUSED';
    now: Date;
  }): Promise<PersonalSignupRow> {
    const { now, risk_signals, geo_evidence, ...rest } = input;
    return this.prisma.personalSignupRequest.create({
      data: {
        id: uuidv7(),
        ...rest,
        risk_signals: risk_signals as never,
        geo_evidence: geo_evidence as never,
        expires_at: new Date(now.getTime() + PERSONAL_SIGNUP_TTL_MS),
        created_at: now,
        updated_at: now,
      },
    });
  }

  findById(id: string): Promise<PersonalSignupRow | null> {
    return this.prisma.personalSignupRequest.findUnique({ where: { id } });
  }

  countByIpSince(ip: string, since: Date): Promise<number> {
    return this.prisma.personalSignupRequest.count({ where: { ip, created_at: { gte: since } } });
  }

  countStartsSince(canonical_email: string, since: Date): Promise<number> {
    return this.prisma.personalSignupRequest.count({ where: { canonical_email, created_at: { gte: since } } });
  }

  /** Email codes sent to this (canonical) address in the window, across its requests. */
  async emailSendsSince(canonical_email: string, since: Date): Promise<number> {
    const r = await this.prisma.personalSignupRequest.aggregate({
      where: { canonical_email, created_at: { gte: since } },
      _sum: { email_otp_sent_count: true },
    });
    return r._sum.email_otp_sent_count ?? 0;
  }

  async phoneSendsSince(phone_e164: string, since: Date): Promise<number> {
    const r = await this.prisma.personalSignupRequest.aggregate({
      where: { phone_e164, created_at: { gte: since } },
      _sum: { phone_otp_sent_count: true },
    });
    return r._sum.phone_otp_sent_count ?? 0;
  }

  /**
   * §6.2 "Gmail alias of an existing account": another address with the same
   * canonical form already has an Aramo User or a Personal signup that got past
   * email verification.
   */
  async gmailAliasOfExisting(canonical_email: string, email: string): Promise<boolean> {
    if (!canonical_email.endsWith('@gmail.com')) return false;
    const users = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "identity"."User"
       WHERE lower("email") <> ${email}
         AND split_part(lower("email"), '@', 2) IN ('gmail.com', 'googlemail.com')
         AND regexp_replace(split_part(split_part(lower("email"), '@', 1), '+', 1), '\\.', '', 'g') || '@gmail.com' = ${canonical_email}`;
    if (Number(users[0]?.n ?? 0) > 0) return true;
    const reqs = await this.prisma.personalSignupRequest.count({
      where: { canonical_email, email: { not: email }, status: { in: ['EMAIL_VERIFIED', 'PROVISIONING', 'PROVISIONED'] } },
    });
    return reqs > 0;
  }

  /** §6.2 "Phone already used by another account". */
  async phoneUsedByAnother(phone_e164: string, canonical_email: string, except_tenant_id: string | null = null): Promise<boolean> {
    const held = await this.prisma.tenantRiskState.count({
      where: { phone_e164, ...(except_tenant_id === null ? {} : { tenant_id: { not: except_tenant_id } }) },
    });
    if (held > 0) return true;
    const reqs = await this.prisma.personalSignupRequest.count({
      where: { phone_e164, canonical_email: { not: canonical_email }, status: { in: ['EMAIL_VERIFIED', 'PROVISIONING', 'PROVISIONED'] } },
    });
    return reqs > 0;
  }

  async setEmailOtp(id: string, hash: string, expires_at: Date, now: Date): Promise<void> {
    await this.prisma.personalSignupRequest.update({
      where: { id },
      data: { email_otp_hash: hash, email_otp_expires_at: expires_at, email_otp_attempts: 0, email_otp_sent_count: { increment: 1 }, email_otp_last_sent_at: now, updated_at: now },
    });
  }

  async recordEmailAttempt(id: string, now: Date): Promise<void> {
    await this.prisma.personalSignupRequest.update({ where: { id }, data: { email_otp_attempts: { increment: 1 }, updated_at: now } });
  }

  /** PENDING → EMAIL_VERIFIED (CAS); the code hash is cleared so it cannot be replayed. */
  async markEmailVerified(id: string, now: Date): Promise<boolean> {
    const n = await this.prisma.personalSignupRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'EMAIL_VERIFIED', email_verified_at: now, email_otp_hash: null, email_otp_attempts: { increment: 1 }, updated_at: now },
    });
    return n.count === 1;
  }

  async setPhoneOtp(id: string, hash: string, expires_at: Date, now: Date): Promise<void> {
    await this.prisma.personalSignupRequest.update({
      where: { id },
      data: { phone_otp_hash: hash, phone_otp_expires_at: expires_at, phone_otp_attempts: 0, phone_otp_sent_count: { increment: 1 }, phone_otp_last_sent_at: now, updated_at: now },
    });
  }

  async recordPhoneAttempt(id: string, now: Date): Promise<void> {
    await this.prisma.personalSignupRequest.update({ where: { id }, data: { phone_otp_attempts: { increment: 1 }, updated_at: now } });
  }

  async markPhoneVerified(id: string, now: Date): Promise<void> {
    await this.prisma.personalSignupRequest.update({
      where: { id },
      data: { phone_verified_at: now, phone_otp_hash: null, phone_otp_attempts: { increment: 1 }, updated_at: now },
    });
  }

  /** EMAIL_VERIFIED | FAILED → PROVISIONING (CAS), recording the accepted documents + IP. */
  async claimForProvisioning(id: string, accepted: { documents: unknown; ip: string | null; at: Date }): Promise<boolean> {
    const n = await this.prisma.personalSignupRequest.updateMany({
      where: { id, status: { in: ['EMAIL_VERIFIED', 'FAILED'] } },
      data: { status: 'PROVISIONING', accepted_documents: accepted.documents as never, accepted_ip: accepted.ip, accepted_at: accepted.at, failure_code: null, updated_at: accepted.at },
    });
    return n.count === 1;
  }

  /**
   * §10 invite mode — the pilot cap, serialized. Under one transaction-scoped
   * advisory lock: count the active Personal tenants PLUS the signups already
   * claimed for provisioning (in-flight reservations), refuse at the cap, else
   * claim this signup (EMAIL_VERIFIED | FAILED → PROVISIONING). Because an
   * in-flight claim counts against the cap, two concurrent completes at cap-1
   * cannot both proceed — the second sees the first's reservation.
   */
  async claimForProvisioningWithinCap(
    id: string,
    accepted: { documents: unknown; ip: string | null; at: Date },
    cap: number,
  ): Promise<'claimed' | 'busy' | 'full'> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('personal-pilot-cap', 0))`;
      const rows = await tx.$queryRaw<{ n: bigint }[]>`
        SELECT (
          (SELECT count(*) FROM "identity"."PersonalSignupRequest" r
             JOIN "identity"."Tenant" t ON t.id = r.tenant_id
            WHERE r.status = 'PROVISIONED' AND t.is_active = true AND t.status <> 'CLOSED')
          +
          (SELECT count(*) FROM "identity"."PersonalSignupRequest" r
            WHERE r.status = 'PROVISIONING' AND r.id <> ${id}::uuid)
        )::bigint AS n`;
      if (Number(rows[0]?.n ?? 0) >= cap) return 'full';
      const n = await tx.personalSignupRequest.updateMany({
        where: { id, status: { in: ['EMAIL_VERIFIED', 'FAILED'] } },
        data: { status: 'PROVISIONING', accepted_documents: accepted.documents as never, accepted_ip: accepted.ip, accepted_at: accepted.at, failure_code: null, updated_at: accepted.at },
      });
      return n.count === 1 ? 'claimed' : 'busy';
    });
  }

  /**
   * A person whose earlier Personal signup LAPSED UNBOUND may sign up again: the
   * existing owner User has no ExternalIdentity, owns a PERSONAL tenant that the
   * 7-day lapse soft-disabled (inactive, still PROVISIONED), and that tenant's
   * signup request is LAPSED. Anything else is not resumable (the caller keeps
   * the non-enumerating "already have an account" path).
   */
  async findResumableLapsed(email: string): Promise<{ tenant_id: string; user_id: string; prior_signup_id: string } | null> {
    const rows = await this.prisma.$queryRaw<{ tenant_id: string; user_id: string; prior_signup_id: string }[]>`
      SELECT t.id AS tenant_id, u.id AS user_id, r.id AS prior_signup_id
        FROM "identity"."User" u
        JOIN "identity"."Tenant" t ON t.id = u.tenant_id
        JOIN "identity"."PersonalSignupRequest" r ON r.tenant_id = t.id AND r.owner_user_id = u.id
       WHERE lower(u.email) = ${email}
         AND t.kind = 'PERSONAL' AND t.is_active = false AND t.status = 'PROVISIONED'
         AND r.status = 'LAPSED'
         AND NOT EXISTS (SELECT 1 FROM "identity"."ExternalIdentity" e WHERE e.user_id = u.id)
       ORDER BY r.created_at DESC
       LIMIT 1`;
    return rows[0] ?? null;
  }

  async markFailed(id: string, failure_code: string, now: Date): Promise<void> {
    await this.prisma.personalSignupRequest.updateMany({ where: { id, status: 'PROVISIONING' }, data: { status: 'FAILED', failure_code, updated_at: now } });
  }

  /**
   * PROVISIONING → PROVISIONED in ONE transaction with: the tenant's risk state
   * (from the signup decision; phone assurance only if the phone code was
   * verified), the invite consumed, and the audit event.
   */
  async completeProvisioning(args: { id: string; tenant_id: string; owner_user_id: string; now: Date; resumed_from?: string; sms_available?: boolean }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.personalSignupRequest.findUnique({ where: { id: args.id } });
      if (row === null || row.status !== 'PROVISIONING') throw new Error(`personal signup ${args.id} is not provisioning`);
      const risk = initialRiskState(row.decision as PersonalRiskDecision, row.phone_verified_at !== null, args.sms_available ?? true);
      const fresh = {
        state: risk.state,
        step_up_required: risk.step_up_required,
        phone_e164: row.phone_e164,
        phone_verified_at: row.phone_verified_at,
        restricted_until: null,
        reason: risk.reason,
        decided_by: null,
        step_up_cleared_by: null,
        updated_at: args.now,
      };
      if (args.resumed_from !== undefined) {
        // Re-activate the SAME lapsed, still-unbound tenant (re-checked under this
        // transaction): fresh PROVISIONED / unbound state and a fresh risk state.
        const prior = await tx.personalSignupRequest.findUnique({ where: { id: args.resumed_from } });
        const tenant = await tx.tenant.findUnique({ where: { id: args.tenant_id }, select: { kind: true, is_active: true, status: true } });
        const bound = await tx.externalIdentity.count({ where: { user_id: args.owner_user_id } });
        if (prior?.status !== 'LAPSED' || prior.tenant_id !== args.tenant_id || tenant?.kind !== 'PERSONAL' || tenant.is_active || tenant.status !== 'PROVISIONED' || bound > 0) {
          throw new Error(`personal tenant ${args.tenant_id} is no longer resumable`);
        }
        await tx.tenant.update({ where: { id: args.tenant_id }, data: { is_active: true } });
        await tx.tenantRiskState.upsert({
          where: { tenant_id: args.tenant_id },
          create: { tenant_id: args.tenant_id, ...fresh, created_at: args.now },
          update: fresh,
        });
      } else {
        await tx.tenantRiskState.create({ data: { tenant_id: args.tenant_id, ...fresh, created_at: args.now } });
      }
      await tx.personalSignupRequest.update({
        where: { id: args.id },
        data: { status: 'PROVISIONED', tenant_id: args.tenant_id, owner_user_id: args.owner_user_id, provisioned_at: args.now, updated_at: args.now },
      });
      if (row.invite_id !== null) {
        const used = await tx.personalSignupInvite.updateMany({
          where: { id: row.invite_id, used_at: null },
          data: { used_at: args.now, used_by_signup_id: args.id },
        });
        if (used.count !== 1) throw new Error(`personal invite ${row.invite_id} already used`);
      }
      await writePersonalAudit(tx, {
        event_type: 'identity.personal.signup.provisioned',
        tenant_id: args.tenant_id,
        subject_id: args.tenant_id,
        actor_id: null,
        payload: {
          signup_id: args.id,
          decision: row.decision,
          risk_points: row.risk_points,
          state: risk.state,
          step_up_required: risk.step_up_required,
          phone_verified: row.phone_verified_at !== null,
          reason: risk.reason,
          geo: row.geo_evidence ?? null,
          invite: row.invite_id !== null,
          ...(args.resumed_from === undefined ? {} : { resumed_from_signup_id: args.resumed_from }),
        },
      });
    });
  }

  // ── invites (§10 `invite` mode) ────────────────────────────────────────────

  /** Issue a one-time code bound to `email`; only its hash is stored. Audited (global). */
  async issueInvite(email: string, issued_by: string, now: Date): Promise<{ id: string; code: string; email: string; expires_at: Date }> {
    const code = generatePersonalInviteCode();
    const id = uuidv7();
    const expires_at = new Date(now.getTime() + PERSONAL_INVITE_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      await tx.personalSignupInvite.create({ data: { id, code_hash: hashPersonalInviteCode(code), email, issued_by, expires_at, created_at: now } });
      await writePersonalAudit(tx, {
        event_type: 'identity.personal.invite.issued',
        tenant_id: null,
        subject_id: id,
        actor_id: issued_by,
        payload: { expires_at: expires_at.toISOString() },
      });
    });
    return { id, code, email, expires_at };
  }

  /** A valid invite for exactly this email: the code matches, unexpired, unused. */
  async findValidInvite(code: string, email: string, now: Date): Promise<{ id: string } | null> {
    if (code.trim() === '') return null;
    const row = await this.prisma.personalSignupInvite.findUnique({ where: { code_hash: hashPersonalInviteCode(code) } });
    if (row === null || row.used_at !== null || row.email !== email || row.expires_at.getTime() <= now.getTime()) return null;
    return { id: row.id };
  }

  async inviteStillValid(invite_id: string, now: Date): Promise<boolean> {
    const row = await this.prisma.personalSignupInvite.findUnique({ where: { id: invite_id } });
    return row !== null && row.used_at === null && row.expires_at.getTime() > now.getTime();
  }

  /** Active pilot tenants: provisioned by a Personal signup, still active and not closed. */
  async activePersonalTenantCount(): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "identity"."PersonalSignupRequest" r
      JOIN "identity"."Tenant" t ON t.id = r.tenant_id
      WHERE r.status = 'PROVISIONED' AND t.is_active = true AND t.status <> 'CLOSED'`;
    return Number(rows[0]?.n ?? 0);
  }

  // ── operator review queue (§6.5) ───────────────────────────────────────────

  async reviewQueue(limit = 200): Promise<PersonalReviewItem[]> {
    const states = await this.prisma.tenantRiskState.findMany({
      where: { state: { in: ['review', 'restricted'] } },
      orderBy: { updated_at: 'asc' },
      take: limit,
    });
    if (states.length === 0) return [];
    const ids = states.map((s) => s.tenant_id);
    const [tenants, signups] = await Promise.all([
      this.prisma.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true } }),
      // Oldest first, so a resumed tenant's latest signup wins in the map below.
      this.prisma.personalSignupRequest.findMany({ where: { tenant_id: { in: ids } }, orderBy: { created_at: 'asc' } }),
    ]);
    const tenantById = new Map(tenants.map((t) => [t.id, t]));
    const signupByTenant = new Map(signups.map((s) => [s.tenant_id!, s]));
    return states.map((s) => {
      const t = tenantById.get(s.tenant_id);
      const r = signupByTenant.get(s.tenant_id);
      const signals = Array.isArray(r?.risk_signals)
        ? (r!.risk_signals as unknown[])
            .filter((x): x is { key: string; points: number; detail?: string } => typeof x === 'object' && x !== null && typeof (x as { key?: unknown }).key === 'string')
            .map((x) => ({ key: x.key, points: typeof x.points === 'number' ? x.points : 0, ...(typeof x.detail === 'string' ? { detail: x.detail } : {}) }))
        : [];
      return {
        tenant_id: s.tenant_id,
        tenant_name: t?.name ?? null,
        tenant_status: t?.status ?? null,
        owner_email: r?.email ?? null,
        state: s.state as TenantRiskStateValue,
        reason: s.reason,
        step_up_required: s.step_up_required,
        review_pending: s.review_pending,
        step_up_cleared_by: s.step_up_cleared_by,
        geo: geoEvidenceFromJson(r?.geo_evidence),
        risk_points: r?.risk_points ?? null,
        decision: r?.decision ?? null,
        signals,
        phone_verified_at: s.phone_verified_at,
        restricted_until: s.restricted_until,
        decided_by: s.decided_by,
        created_at: s.created_at,
        updated_at: s.updated_at,
      };
    });
  }

  // ── unverified purge (PO decision 2026-10-22) ──────────────────────────────

  /**
   * DELETE every signup request whose email was never verified, created at least
   * `days` ago, in ONE statement, with one GLOBAL audit event (counts only) in the
   * same transaction when anything was deleted. Returns the count and the cutoff.
   *
   * The predicate is anchored on created_at (the promise is "3 days after you
   * started"; updated_at would let resends or wrong codes extend it). It cannot
   * race an in-flight verification: a request is verifiable only before its
   * expires_at (created_at + 24 h), and the DELETE also requires expires_at <= now
   * and a never-verified status — a verification that commits first moves the row
   * to EMAIL_VERIFIED and the DELETE's re-check under READ COMMITTED skips it.
   * Rows already bound to a tenant, or referenced by a used invite, are never
   * touched. Idempotent: a re-run deletes nothing more.
   */
  async purgeUnverified(now: Date, days = PERSONAL_UNVERIFIED_PURGE_DAYS): Promise<{ deleted: number; cutoff: Date }> {
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    const deleted = await this.prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        DELETE FROM "identity"."PersonalSignupRequest" r
         WHERE r.status IN ('PENDING', 'REFUSED')
           AND r.email_verified_at IS NULL
           AND r.tenant_id IS NULL
           AND r.created_at <= ${cutoff}
           AND r.expires_at <= ${now}
           AND NOT EXISTS (SELECT 1 FROM "identity"."PersonalSignupInvite" i WHERE i.used_by_signup_id = r.id)`;
      if (n > 0) {
        await writePersonalAudit(tx, {
          event_type: 'identity.personal.signup.unverified_purged',
          tenant_id: null,
          subject_id: uuidv7(),
          actor_id: null,
          payload: { deleted: n, cutoff: cutoff.toISOString(), days },
        });
      }
      return n;
    });
    return { deleted, cutoff };
  }

  // ── unbound lapse (§3.6) ───────────────────────────────────────────────────

  /**
   * Soft-disable every Personal tenant still PROVISIONED (never bound by its
   * owner's Google sign-in — no ExternalIdentity) `days` after provisioning: the
   * tenant becomes inactive (no session can be minted for it) and the request
   * LAPSED, audited in the same transaction. The owner User and membership are
   * left as they are (the ROLES-1 last-owner invariant forbids deactivating a
   * tenant's only owner). Nothing is deleted. Returns how many lapsed.
   */
  async lapseUnbound(now: Date, days = PERSONAL_UNBOUND_LAPSE_DAYS): Promise<number> {
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    const due = await this.prisma.$queryRaw<{ id: string; tenant_id: string; owner_user_id: string }[]>`
      SELECT r.id, r.tenant_id, r.owner_user_id FROM "identity"."PersonalSignupRequest" r
      JOIN "identity"."Tenant" t ON t.id = r.tenant_id
      WHERE r.status = 'PROVISIONED' AND r.provisioned_at <= ${cutoff}
        AND t.status = 'PROVISIONED' AND t.is_active = true
        AND NOT EXISTS (SELECT 1 FROM "identity"."ExternalIdentity" e WHERE e.user_id = r.owner_user_id)`;
    let lapsed = 0;
    for (const c of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const n = await tx.personalSignupRequest.updateMany({ where: { id: c.id, status: 'PROVISIONED' }, data: { status: 'LAPSED', updated_at: now } });
        if (n.count !== 1) return false;
        // Re-checked inside the transaction: a binding that raced the sweep wins.
        const bound = await tx.externalIdentity.count({ where: { user_id: c.owner_user_id } });
        const tenant = await tx.tenant.findUnique({ where: { id: c.tenant_id }, select: { status: true } });
        if (bound > 0 || tenant?.status !== 'PROVISIONED') throw new LapseRaced();
        await tx.tenant.update({ where: { id: c.tenant_id }, data: { is_active: false } });
        await writePersonalAudit(tx, {
          event_type: 'identity.personal.signup.lapsed',
          tenant_id: c.tenant_id,
          subject_id: c.tenant_id,
          actor_id: null,
          payload: { signup_id: c.id, reason: 'unbound_after_days', days },
        });
        return true;
      }).catch((err: unknown) => {
        if (err instanceof LapseRaced) return false;
        throw err;
      });
      if (done) lapsed += 1;
    }
    return lapsed;
  }
}

class LapseRaced extends Error {}

/** A stored geo_evidence JSON value as GeoEvidence (null when absent or malformed). */
export function geoEvidenceFromJson(v: unknown): GeoEvidence | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o['looked_up_at'] !== 'string') return null;
  return {
    country: typeof o['country'] === 'string' ? o['country'] : null,
    looked_up_at: o['looked_up_at'],
    db_version: typeof o['db_version'] === 'string' ? o['db_version'] : null,
  };
}
