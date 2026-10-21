import { Inject, Injectable } from '@nestjs/common';
import { AramoError, createAramoLogger, type AramoLogger } from '@aramo/common';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';
import { v7 as uuidv7 } from 'uuid';

import { IdentityAuditService } from '../audit/identity-audit.service.js';
import {
  IdentityAuditRepository,
  type EventType,
} from '../audit/identity-audit.repository.js';
import { IdentityService } from '../identity.service.js';
import { TenantRepository } from '../tenant.repository.js';

import {
  DELEGATE_BUDGET_MAX_PER_IP,
  DELEGATE_BUDGET_MAX_PER_TOKEN,
  DelegateBudget,
} from './delegate-budget.js';
import { renderDelegationEmail } from './delegation-email.js';
import {
  DELEGATION_TTL_MS,
  buildDelegateLink,
  delegateLinkBase,
  generateDelegationToken,
  hashDelegationToken,
} from './delegation-token.js';
import {
  DomainVerificationDelegationRepository,
  type DelegationRow,
} from './domain-verification-delegation.repository.js';
import {
  DomainVerificationService,
  alreadyVerifiedError,
} from './domain-verification.service.js';
import type { DomainVerificationView } from './domain-verification.view.js';

// Domain-Enforcement P3 (LOCKED) §5 — delegation of the P2b domain verification to
// an IT / domain administrator.
//
// ISSUE (tenant_owner / tenant_admin via tenant:admin:domain): a row with the
// SHA-256 of a fresh 256-bit token, expiring in 7 days; the delegate is emailed a
// link carrying the raw token in the URL fragment.
//
// USE (session-less, token in the body): the delegate can (a) read the DNS record
// to publish and (b) run the P2b check (and with it the P3 claim promotion) for
// THAT tenant. Nothing else: no membership, no scope, no billing, no Sign, no
// administrative access, and no token rotation — when the tenant has no P2b token
// yet, the first one is minted (the owner delegated the verification; an existing
// token is never replaced). Unknown / expired / revoked / over-budget all give the
// same 404.
//
// REVOKE: DELETE by id, scoped to the caller's tenant.
//
// AUDIT: issue / use / revoke are recorded (identity.domain.verification.
// delegation.{issued,used,revoked}; subject_id = the delegation id). Owner-driven
// events carry the owner as actor; delegate-driven events are actor_type 'system'
// with no actor id (the delegate is not an Aramo user) and carry delegation_id.

export const MAX_ACTIVE_DELEGATIONS = 5;
const EMAIL_MAX = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface DelegationView {
  readonly id: string;
  readonly delegate_email: string;
  readonly expires_at: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}

// What the delegate sees: the domain, the record to publish, the status — and
// whether the domain is held by another organization after verification.
export interface DelegateView {
  readonly domain: string;
  readonly record: { readonly name: string | null; readonly value: string | null };
  readonly status: DomainVerificationView['status'];
  readonly domain_claim_conflict: boolean;
}

function toDelegationView(r: DelegationRow): DelegationView {
  return {
    id: r.id,
    delegate_email: r.delegate_email,
    expires_at: r.expires_at.toISOString(),
    created_at: r.created_at.toISOString(),
    last_used_at: r.last_used_at?.toISOString() ?? null,
    revoked_at: r.revoked_at?.toISOString() ?? null,
  };
}

function toDelegateView(domain: string, v: DomainVerificationView): DelegateView {
  return {
    domain,
    record: { name: v.record_name, value: v.record_value },
    status: v.status,
    domain_claim_conflict: v.domain_claim_conflict,
  };
}

// The ONE answer for every failed delegate request (no oracle).
export function delegationNotFound(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'This link is invalid or has expired', 404, { requestId });
}

export function normalizeDelegateEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const e = value.trim().toLowerCase();
  if (e.length === 0 || e.length > EMAIL_MAX || !EMAIL_RE.test(e)) return null;
  return e;
}

export function extractDelegateToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const t = (body as Record<string, unknown>)['token'];
  if (typeof t !== 'string') return null;
  const trimmed = t.trim();
  // 32 random bytes in base64url = 43 chars; refuse anything wildly off.
  if (trimmed.length < 16 || trimmed.length > 128) return null;
  return trimmed;
}

@Injectable()
export class DomainVerificationDelegationService {
  private readonly logger: AramoLogger = createAramoLogger('DomainVerificationDelegationService');

  constructor(
    private readonly delegations: DomainVerificationDelegationRepository,
    private readonly tenants: TenantRepository,
    private readonly verification: DomainVerificationService,
    private readonly identity: IdentityService,
    private readonly audit: IdentityAuditService,
    private readonly auditRepo: IdentityAuditRepository,
    private readonly budget: DelegateBudget,
    @Inject(MAILER_PORT) private readonly mailer: MailerPort,
  ) {}

  // ── tenant side (JWT; tenant_id from authContext) ───────────────────────────

  async issue(args: {
    tenant_id: string;
    actor_user_id: string;
    delegate_email: unknown;
    request_id: string;
    now?: Date;
  }): Promise<DelegationView> {
    const now = args.now ?? new Date();
    const email = normalizeDelegateEmail(args.delegate_email);
    if (email === null) {
      throw new AramoError('VALIDATION_ERROR', 'Enter a valid email address', 400, {
        requestId: args.request_id,
        details: { reason: 'invalid_delegate_email' },
      });
    }
    const row = await this.tenants.findDomainVerificationById(args.tenant_id);
    if (row === null) {
      throw new AramoError('NOT_FOUND', 'Tenant not found', 404, { requestId: args.request_id });
    }
    const domain = row.allowed_domain;
    if (domain === null || domain.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'This tenant has no locked domain to verify', 400, {
        requestId: args.request_id,
        details: { reason: 'no_allowed_domain' },
      });
    }
    if (row.domain_verification_status === 'VERIFIED') throw alreadyVerifiedError(args.request_id);
    if ((await this.delegations.countActive(args.tenant_id, now)) >= MAX_ACTIVE_DELEGATIONS) {
      throw new AramoError('VALIDATION_ERROR', `At most ${MAX_ACTIVE_DELEGATIONS} verification links can be active at once. Revoke one first.`, 400, {
        requestId: args.request_id,
        details: { reason: 'too_many_active_delegations', limit: MAX_ACTIVE_DELEGATIONS },
      });
    }

    const raw = generateDelegationToken();
    const created = await this.delegations.create({
      id: uuidv7(),
      tenant_id: args.tenant_id,
      delegate_email: email,
      token_hash: hashDelegationToken(raw),
      issued_by_user_id: args.actor_user_id,
      expires_at: new Date(now.getTime() + DELEGATION_TTL_MS),
      created_at: now,
    });

    // BEST-EFFORT mail (the invite precedent): the grant is persisted; a send
    // failure is logged loud, and the owner can revoke and issue a new link.
    try {
      const organizationLabel = await this.identity.getTenantLabel(args.tenant_id);
      const mail = renderDelegationEmail({
        organizationLabel,
        domain,
        link: buildDelegateLink(delegateLinkBase(), raw),
        expiresAt: created.expires_at,
      });
      await this.mailer.send({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
    } catch (err) {
      this.logger.warn({
        event: 'domain_delegation_email_failed',
        tenant_id: args.tenant_id,
        delegation_id: created.id,
        error_message: (err as Error).message,
      });
    }

    await this.audit.writeEvent({
      event_type: 'identity.domain.verification.delegation.issued',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: created.id,
      payload: { domain, delegation_id: created.id, expires_at: created.expires_at.toISOString() },
    });
    return toDelegationView(created);
  }

  async listActive(tenant_id: string, now: Date = new Date()): Promise<{ items: DelegationView[] }> {
    const rows = await this.delegations.listActive(tenant_id, now);
    return { items: rows.map(toDelegationView) };
  }

  async revoke(args: {
    tenant_id: string;
    actor_user_id: string;
    id: string;
    request_id: string;
    now?: Date;
  }): Promise<DelegationView> {
    const now = args.now ?? new Date();
    const existing = await this.delegations.findForTenant(args.tenant_id, args.id);
    if (existing === null) {
      throw new AramoError('NOT_FOUND', 'Delegation not found', 404, { requestId: args.request_id });
    }
    const revokedNow = await this.delegations.revoke(args.tenant_id, args.id, now);
    if (revokedNow) {
      await this.audit.writeEvent({
        event_type: 'identity.domain.verification.delegation.revoked',
        actor_type: 'user',
        actor_id: args.actor_user_id,
        tenant_id: args.tenant_id,
        subject_id: existing.id,
        payload: { delegation_id: existing.id },
      });
    }
    const after = await this.delegations.findForTenant(args.tenant_id, args.id);
    return toDelegationView(after ?? existing);
  }

  // ── delegate side (session-less; token in the body) ─────────────────────────

  // Resolve a LIVE grant from the raw token after the per-IP and per-token
  // budgets. Every failure is the same 404.
  async resolve(rawToken: string | null, ip: string, requestId: string, now: Date): Promise<DelegationRow> {
    if (!this.budget.allow(`ip:${ip}`, DELEGATE_BUDGET_MAX_PER_IP, now.getTime())) {
      throw delegationNotFound(requestId);
    }
    if (rawToken === null) throw delegationNotFound(requestId);
    const hash = hashDelegationToken(rawToken);
    if (!this.budget.allow(`tok:${hash}`, DELEGATE_BUDGET_MAX_PER_TOKEN, now.getTime())) {
      throw delegationNotFound(requestId);
    }
    const row = await this.delegations.findByTokenHash(hash);
    if (row === null || row.revoked_at !== null || row.expires_at.getTime() <= now.getTime()) {
      throw delegationNotFound(requestId);
    }
    return row;
  }

  async delegateView(body: unknown, ip: string, requestId: string, now: Date = new Date()): Promise<DelegateView> {
    const grant = await this.resolve(extractDelegateToken(body), ip, requestId, now);
    const { view, issued, domain } = await this.verification.ensureTokenForDelegate(grant.tenant_id, requestId);
    await this.delegations.touch(grant.id, now);
    if (issued) {
      await this.delegateAudit(grant, 'identity.domain.verification.requested', grant.tenant_id, { domain, via: 'delegation', delegation_id: grant.id });
    }
    await this.delegateAudit(grant, 'identity.domain.verification.delegation.used', grant.id, { delegation_id: grant.id, action: 'view' });
    return toDelegateView(domain, view);
  }

  async delegateCheck(body: unknown, ip: string, requestId: string, now: Date = new Date()): Promise<DelegateView> {
    const grant = await this.resolve(extractDelegateToken(body), ip, requestId, now);
    const { view, verified, domain, claim_outcome } = await this.verification.checkVerification(grant.tenant_id, requestId);
    await this.delegations.touch(grant.id, now);
    if (verified) {
      await this.delegateAudit(grant, 'identity.domain.verified', grant.tenant_id, { domain, via: 'delegation', delegation_id: grant.id });
    }
    await this.delegateAudit(grant, 'identity.domain.verification.delegation.used', grant.id, {
      delegation_id: grant.id,
      action: 'check',
      status: view.status,
      ...(claim_outcome === null ? {} : { claim_outcome }),
    });
    return toDelegateView(domain, view);
  }

  // Best-effort (the IdentityAuditService posture), written with no actor id: the
  // delegate is not an Aramo user.
  private async delegateAudit(
    grant: DelegationRow,
    event_type: EventType,
    subject_id: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditRepo.writeEvent({
        event_type,
        actor_type: 'system',
        actor_id: null,
        tenant_id: grant.tenant_id,
        subject_id,
        event_payload: payload,
      });
    } catch (err) {
      this.logger.warn({
        event: 'identity_audit_write_failed',
        event_type,
        tenant_id: grant.tenant_id,
        delegation_id: grant.id,
        error_message: (err as Error).message,
      });
    }
  }
}
