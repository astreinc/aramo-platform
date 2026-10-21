import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import type { PrismaClient } from '../../../prisma/generated/client/client.js';
import type { EventType } from '../audit/identity-audit.repository.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isPersonalOrDisposableDomain } from '../util/email-domain.js';

// Aramo-Domain-Enforcement-P3 (LOCKED) — one organization per email domain.
//
// The claim lives in identity."TenantDomainClaim" (one row per BUSINESS tenant
// with a domain; `domain` = lower(Tenant.allowed_domain), which is never cleared).
// A tenant HOLDS its domain when claim ∈ {PROVISIONAL, AUTHORITATIVE} and
// exception = false — the partial unique index TenantDomainClaim_holder_key
// enforces at most one holder per domain. The index cannot see the clock, so
// every claim attempt first lapses that domain's EXPIRED provisional holder,
// in the same transaction, under the per-domain advisory lock.
//
// Every claim / lapse / release / promotion / exception write inserts its
// IdentityAuditEvent IN THE SAME TRANSACTION (§6 audit atomicity) — never the
// best-effort IdentityAuditService.

export const DOMAIN_CLAIM_PROVISIONAL_DAYS = 30;

export const DOMAIN_CLAIM_STATES = ['PROVISIONAL', 'AUTHORITATIVE', 'LAPSED', 'RELEASED'] as const;
export type DomainClaimState = (typeof DOMAIN_CLAIM_STATES)[number];
const HELD: DomainClaimState[] = ['PROVISIONAL', 'AUTHORITATIVE'];

export interface DomainClaimView {
  domain: string;
  claim: DomainClaimState;
  expires_at: Date | null;
  reason: string | null;
  exception: boolean;
}

export interface DomainExceptionView {
  id: string;
  domain: string;
  justification: string;
  evidence_ref: string;
  granted_by_user_id: string;
  granted_at: Date;
  revoked_by_user_id: string | null;
  revoked_at: Date | null;
}

export type PromoteOutcome = 'PROMOTED' | 'ALREADY' | 'CONFLICT' | 'NO_DOMAIN';

/** The client surface the claim writes need: a PrismaService or an interactive-transaction client. */
export type DomainClaimTx = Pick<
  PrismaClient,
  'tenant' | 'tenantDomainClaim' | 'tenantDomainException' | 'identityAuditEvent' | '$executeRaw'
>;

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeClaimDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

/** The §3 refusal: another organization already holds this email domain. */
export function domainUnavailableError(requestId = 'domain-claim'): AramoError {
  return new AramoError('TENANT_DOMAIN_UNAVAILABLE', 'An organization for this email domain already exists on Aramo', 409, {
    requestId,
    details: { reason: 'organization_domain_taken' },
  });
}

/** A unique violation on the holder index (TenantDomainClaim_holder_key), not the tenant_id primary key. */
export function isHolderIndexViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code !== 'P2002') return false;
  let meta = '';
  try {
    meta = JSON.stringify((err as { meta?: unknown }).meta ?? {});
  } catch {
    meta = '';
  }
  if (/holder_key/.test(meta)) return true;
  // The only other unique key on the claim table is its tenant_id primary key.
  return !/pkey|tenant_id/.test(meta);
}

class HolderConflict extends Error {}

function toView(row: { domain: string; claim: string; expires_at: Date | null; reason: string | null; exception: boolean }): DomainClaimView {
  return {
    domain: row.domain,
    claim: row.claim as DomainClaimState,
    expires_at: row.expires_at,
    reason: row.reason,
    exception: row.exception,
  };
}

@Injectable()
export class DomainClaimService {
  constructor(private readonly prisma: PrismaService) {}

  // ── reads ──────────────────────────────────────────────────────────────────

  async claimOf(tenant_id: string): Promise<DomainClaimView | null> {
    const row = await this.prisma.tenantDomainClaim.findUnique({ where: { tenant_id } });
    return row === null ? null : toView(row);
  }

  private async mustClaim(tenant_id: string): Promise<DomainClaimView> {
    const claim = await this.claimOf(tenant_id);
    if (claim === null) throw noClaimError(tenant_id);
    return claim;
  }

  /** AUTHORITATIVE claim (an exception row counts when its claim is AUTHORITATIVE). */
  async isAuthoritative(tenant_id: string): Promise<boolean> {
    return (await this.claimOf(tenant_id))?.claim === 'AUTHORITATIVE';
  }

  /**
   * Read-only pre-check: true iff a holder of the domain exists that is not an
   * expired PROVISIONAL claim. Free-mail / disposable domains are never held.
   */
  async isDomainHeld(domain: string, now: Date = new Date()): Promise<boolean> {
    const d = normalizeClaimDomain(domain);
    if (d.length === 0 || isPersonalOrDisposableDomain(d)) return false;
    const holder = await this.prisma.tenantDomainClaim.findFirst({
      where: { domain: d, claim: { in: HELD }, exception: false },
    });
    return holder !== null && !isExpiredProvisional(holder, now);
  }

  /** The operator view: the claim plus the tenant's exception history (newest first). */
  async operatorView(tenant_id: string): Promise<{ claim: DomainClaimView | null; exceptions: DomainExceptionView[] }> {
    const [claim, exceptions] = await Promise.all([
      this.claimOf(tenant_id),
      this.prisma.tenantDomainException.findMany({ where: { tenant_id }, orderBy: { granted_at: 'desc' } }),
    ]);
    return { claim, exceptions };
  }

  // ── creation ───────────────────────────────────────────────────────────────

  /**
   * Inside the caller's transaction (the tenant insert): lock the domain, lapse
   * an expired provisional holder, refuse if a holder remains, then claim
   * PROVISIONAL for DOMAIN_CLAIM_PROVISIONAL_DAYS. A holder-index P2002 maps to
   * the same refusal.
   */
  async claimForNewTenant(tx: DomainClaimTx, args: { tenant_id: string; domain: string; now: Date }): Promise<void> {
    const domain = normalizeClaimDomain(args.domain);
    if (domain.length === 0 || isPersonalOrDisposableDomain(domain)) return;
    await lockDomain(tx, domain);
    await lapseExpiredHolders(tx, domain, args.now, null);
    const holder = await tx.tenantDomainClaim.findFirst({
      where: { domain, claim: { in: HELD }, exception: false },
    });
    if (holder !== null) throw domainUnavailableError('provision');
    try {
      await tx.tenantDomainClaim.create({
        data: {
          tenant_id: args.tenant_id,
          domain,
          claim: 'PROVISIONAL',
          expires_at: new Date(args.now.getTime() + DOMAIN_CLAIM_PROVISIONAL_DAYS * DAY_MS),
          reason: 'provisioned',
          created_at: args.now,
          updated_at: args.now,
        },
      });
    } catch (err) {
      if (isHolderIndexViolation(err)) throw domainUnavailableError('provision');
      throw err;
    }
    await writeAudit(tx, {
      event_type: 'identity.domain.claim.provisional',
      tenant_id: args.tenant_id,
      actor_type: 'system',
      actor_id: null,
      payload: { domain, from: null, reason: 'provisioned' },
    });
  }

  // ── lapse ──────────────────────────────────────────────────────────────────

  /** PROVISIONAL / AUTHORITATIVE → LAPSED (never deletes anything). No-op otherwise. */
  async lapse(tenant_id: string, reason: string, now: Date = new Date()): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.tenantDomainClaim.findUnique({ where: { tenant_id } });
      if (row === null || !HELD.includes(row.claim as DomainClaimState)) return;
      const n = await tx.tenantDomainClaim.updateMany({
        where: { tenant_id, claim: { in: HELD } },
        data: { claim: 'LAPSED', reason, expires_at: null, updated_at: now },
      });
      if (n.count === 1) {
        await writeAudit(tx, {
          event_type: 'identity.domain.claim.lapsed',
          tenant_id,
          actor_type: 'system',
          actor_id: null,
          payload: { domain: row.domain, from: row.claim, reason },
        });
      }
    });
  }

  /** The opt-in sweeper: lapse every expired PROVISIONAL claim. Returns how many lapsed. */
  async sweepExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.prisma.tenantDomainClaim.findMany({
      where: { claim: 'PROVISIONAL', expires_at: { lte: now } },
      select: { domain: true },
      distinct: ['domain'],
    });
    let total = 0;
    for (const { domain } of expired) {
      total += await this.prisma.$transaction(async (tx) => {
        await lockDomain(tx, domain);
        return lapseExpiredHolders(tx, domain, now, null);
      });
    }
    return total;
  }

  // ── promotion ──────────────────────────────────────────────────────────────

  /**
   * P2b VERIFIED → AUTHORITATIVE (reason 'domain_verified'). The tenant's own
   * PROVISIONAL / LAPSED claim is upgraded; a tenant with no row but a BUSINESS
   * domain gets one. Refused ('CONFLICT', nothing changes) while another tenant
   * holds the domain.
   */
  async promoteOnVerified(tenant_id: string, now: Date = new Date()): Promise<PromoteOutcome> {
    return this.promote({ tenant_id, now, actor_type: 'system', actor_id: null, reason: 'domain_verified', evidence_ref: null });
  }

  /** Operator promotion with recorded domain-control evidence. 409 TENANT_DOMAIN_UNAVAILABLE while held elsewhere. */
  async promoteWithEvidence(tenant_id: string, actor_user_id: string, evidence_ref: string, now: Date = new Date()): Promise<DomainClaimView> {
    const outcome = await this.promote({ tenant_id, now, actor_type: 'user', actor_id: actor_user_id, reason: 'operator_evidence', evidence_ref });
    if (outcome === 'CONFLICT') throw domainUnavailableError('platform.domain.promote');
    if (outcome === 'NO_DOMAIN') throw noDomainError(tenant_id);
    return await this.mustClaim(tenant_id);
  }

  private async promote(args: {
    tenant_id: string;
    now: Date;
    actor_type: 'system' | 'user';
    actor_id: string | null;
    reason: string;
    evidence_ref: string | null;
  }): Promise<PromoteOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const domain = await domainForTenant(tx, args.tenant_id);
        if (domain === null) return 'NO_DOMAIN';
        await lockDomain(tx, domain);
        const own = await tx.tenantDomainClaim.findUnique({ where: { tenant_id: args.tenant_id } });
        if (own?.claim === 'AUTHORITATIVE') return 'ALREADY';
        await lapseExpiredHolders(tx, domain, args.now, args.tenant_id);
        const ownException = own?.exception ?? false;
        if (!ownException) {
          const other = await tx.tenantDomainClaim.findFirst({
            where: { domain, claim: { in: HELD }, exception: false, tenant_id: { not: args.tenant_id } },
          });
          if (other !== null) return 'CONFLICT';
        }
        const data = { claim: 'AUTHORITATIVE', reason: args.reason, expires_at: null, updated_at: args.now };
        if (own === null) {
          await tx.tenantDomainClaim.create({ data: { tenant_id: args.tenant_id, domain, ...data, created_at: args.now } });
        } else {
          await tx.tenantDomainClaim.update({ where: { tenant_id: args.tenant_id }, data });
        }
        await writeAudit(tx, {
          event_type: 'identity.domain.claim.authoritative',
          tenant_id: args.tenant_id,
          actor_type: args.actor_type,
          actor_id: args.actor_id,
          payload: {
            domain,
            from: own?.claim ?? null,
            reason: args.reason,
            ...(args.evidence_ref === null ? {} : { evidence_ref: args.evidence_ref }),
          },
        });
        return 'PROMOTED';
      });
    } catch (err) {
      if (isHolderIndexViolation(err)) return 'CONFLICT';
      throw err;
    }
  }

  // ── operator actions (§6) ──────────────────────────────────────────────────

  /** Audited operator release (the only path to RELEASED). Idempotent on an already-released claim. */
  async release(tenant_id: string, actor_user_id: string, reason: string, now: Date = new Date()): Promise<DomainClaimView> {
    await this.prisma.$transaction(async (tx) => {
      const own = await tx.tenantDomainClaim.findUnique({ where: { tenant_id } });
      if (own === null) throw noClaimError(tenant_id);
      if (own.claim === 'RELEASED') return;
      await lockDomain(tx, own.domain);
      await tx.tenantDomainClaim.update({
        where: { tenant_id },
        data: { claim: 'RELEASED', reason, expires_at: null, updated_at: now },
      });
      await writeAudit(tx, {
        event_type: 'identity.domain.claim.released',
        tenant_id,
        actor_type: 'user',
        actor_id: actor_user_id,
        payload: { domain: own.domain, from: own.claim, reason },
      });
    });
    return await this.mustClaim(tenant_id);
  }

  /** Audited shared-domain exception: an append-only TenantDomainException row + claim.exception = true. */
  async grantException(
    tenant_id: string,
    actor_user_id: string,
    justification: string,
    evidence_ref: string,
    now: Date = new Date(),
  ): Promise<DomainClaimView> {
    await this.prisma.$transaction(async (tx) => {
      const own = await tx.tenantDomainClaim.findUnique({ where: { tenant_id } });
      if (own === null) throw noClaimError(tenant_id);
      await lockDomain(tx, own.domain);
      if (own.exception) return;
      await tx.tenantDomainException.create({
        data: {
          id: uuidv7(),
          tenant_id,
          domain: own.domain,
          justification,
          evidence_ref,
          granted_by_user_id: actor_user_id,
          granted_at: now,
        },
      });
      await tx.tenantDomainClaim.update({ where: { tenant_id }, data: { exception: true, updated_at: now } });
      await writeAudit(tx, {
        event_type: 'identity.domain.exception.granted',
        tenant_id,
        actor_type: 'user',
        actor_id: actor_user_id,
        payload: { domain: own.domain, claim: own.claim, justification, evidence_ref },
      });
    });
    return await this.mustClaim(tenant_id);
  }

  /**
   * exception = false in one transaction. If the tenant would then collide with
   * another holder → 409 TENANT_DOMAIN_UNAVAILABLE and NOTHING changes (fails closed).
   */
  async revokeException(tenant_id: string, actor_user_id: string, now: Date = new Date()): Promise<DomainClaimView> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const own = await tx.tenantDomainClaim.findUnique({ where: { tenant_id } });
        if (own === null) throw noClaimError(tenant_id);
        await lockDomain(tx, own.domain);
        if (!own.exception) return;
        if (HELD.includes(own.claim as DomainClaimState) && !isExpiredProvisional(own, now)) {
          // Expired provisional holders lapse first (rolled back with everything
          // else if the revoke is refused).
          await lapseExpiredHolders(tx, own.domain, now, tenant_id);
          const other = await tx.tenantDomainClaim.findFirst({
            where: { domain: own.domain, claim: { in: HELD }, exception: false, tenant_id: { not: tenant_id } },
          });
          if (other !== null) throw new HolderConflict();
        }
        await tx.tenantDomainClaim.update({ where: { tenant_id }, data: { exception: false, updated_at: now } });
        await tx.tenantDomainException.updateMany({
          where: { tenant_id, revoked_at: null },
          data: { revoked_at: now, revoked_by_user_id: actor_user_id },
        });
        await writeAudit(tx, {
          event_type: 'identity.domain.exception.revoked',
          tenant_id,
          actor_type: 'user',
          actor_id: actor_user_id,
          payload: { domain: own.domain, claim: own.claim },
        });
      });
    } catch (err) {
      if (err instanceof HolderConflict || isHolderIndexViolation(err)) {
        throw domainUnavailableError('platform.domain.exception.revoke');
      }
      throw err;
    }
    return await this.mustClaim(tenant_id);
  }
}

// ── helpers (all run on the caller's transaction client) ─────────────────────

function isExpiredProvisional(row: { claim: string; expires_at: Date | null }, now: Date): boolean {
  return row.claim === 'PROVISIONAL' && row.expires_at !== null && row.expires_at.getTime() <= now.getTime();
}

async function lockDomain(tx: DomainClaimTx, domain: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`domain:${domain}`}, 0))`;
}

/** Lapse this domain's expired PROVISIONAL holder(s) (reason reservation_expired), except `keep`. */
async function lapseExpiredHolders(tx: DomainClaimTx, domain: string, now: Date, keep: string | null): Promise<number> {
  const expired = await tx.tenantDomainClaim.findMany({
    where: {
      domain,
      claim: 'PROVISIONAL',
      expires_at: { lte: now },
      ...(keep === null ? {} : { tenant_id: { not: keep } }),
    },
  });
  for (const row of expired) {
    await tx.tenantDomainClaim.update({
      where: { tenant_id: row.tenant_id },
      data: { claim: 'LAPSED', reason: 'reservation_expired', updated_at: now },
    });
    await writeAudit(tx, {
      event_type: 'identity.domain.claim.lapsed',
      tenant_id: row.tenant_id,
      actor_type: 'system',
      actor_id: null,
      payload: { domain, from: 'PROVISIONAL', reason: 'reservation_expired' },
    });
  }
  return expired.length;
}

/** The tenant's claim domain: its claim row's, else a BUSINESS tenant's allowed_domain. */
async function domainForTenant(tx: DomainClaimTx, tenant_id: string): Promise<string | null> {
  const own = await tx.tenantDomainClaim.findUnique({ where: { tenant_id }, select: { domain: true } });
  if (own !== null) return own.domain;
  const tenant = await tx.tenant.findUnique({ where: { id: tenant_id }, select: { kind: true, allowed_domain: true } });
  if (tenant === null || tenant.kind !== 'BUSINESS' || tenant.allowed_domain === null) return null;
  const d = normalizeClaimDomain(tenant.allowed_domain);
  return d.length === 0 || isPersonalOrDisposableDomain(d) ? null : d;
}

async function writeAudit(
  tx: DomainClaimTx,
  e: { event_type: EventType; tenant_id: string; actor_type: 'system' | 'user'; actor_id: string | null; payload: Record<string, unknown> },
): Promise<void> {
  await tx.identityAuditEvent.create({
    data: {
      id: uuidv7(),
      tenant_id: e.tenant_id,
      actor_id: e.actor_id,
      actor_type: e.actor_type,
      event_type: e.event_type,
      subject_id: e.tenant_id,
      event_payload: e.payload as never,
    },
  });
}

function noClaimError(tenant_id: string): AramoError {
  return new AramoError('NOT_FOUND', 'This organization has no domain claim', 404, {
    requestId: 'platform.domain',
    details: { tenant_id, reason: 'no_domain_claim' },
  });
}

function noDomainError(tenant_id: string): AramoError {
  return new AramoError('VALIDATION_ERROR', 'This organization has no email domain', 400, {
    requestId: 'platform.domain',
    details: { tenant_id, reason: 'tenant_has_no_domain' },
  });
}
