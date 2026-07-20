import { Injectable, Logger } from '@nestjs/common';
import {
  IdentityAuditService,
  IdentityService,
  RoleService,
  TenantService,
} from '@aramo/identity';

import type {
  PrincipalDirectory,
  ResolveScopesInput,
  ResolveScopesResult,
  ResolveSessionInput,
  ResolveSessionResult,
} from './principal-directory.port.js';

type AuditEventType = Parameters<IdentityAuditService['writeGlobalEvent']>[0]['event_type'];

// Auth-Decoupling PR-4 (ADR-0021 §2) — the Aramo-side adapter implementing auth's
// PrincipalDirectory. It performs the FULL identity→session resolution the
// SessionOrchestrator used to do inline (R-P4-1): reconcile-by-sub, reconcile-by-
// verified-email + sub-link, membership activation, tenant selection, status
// gating, site stamping, scope resolution. This is the ONLY code that imports
// IdentityService / TenantService / RoleService (+ IdentityAuditService for the
// internal linked event); the orchestrators no longer do (the §3.4 proof).
//
// §2.4 INVARIANTS reproduced EXACTLY (behaviour preservation, R-P4-3):
//  (1) activation runs AFTER reconcile/link, BEFORE tenant resolution — a just-
//      accepted membership must flip ACTIVE before getTenantsByUser, or it
//      resolves no_active_tenant (silent lockout). Load-bearing ordering.
//  (2) activation is BEST-EFFORT (try/catch, warn) — must not fail sign-in.
//  (3) linkExternalIdentity is reached ONLY on a resolve-by-sub MISS; its
//      repository is a no-op that refuses to re-point an already-linked sub
//      (account-takeover guard) — never "simplified".
//  (4) NO open JIT — a verified email with no existing identity is denied and
//      creates nothing.
//  (5) status gate applies to TENANT consumers only; `platform` is exempt
//      (sentinel tenant has no lifecycle). PROVISIONED/ACTIVE/OFFBOARDING mint.
//  (6) site_id === null → tenant-wide scopes; otherwise → site-scoped scopes.
@Injectable()
export class IdentityPrincipalDirectoryAdapter implements PrincipalDirectory {
  private readonly logger = new Logger(IdentityPrincipalDirectoryAdapter.name);

  constructor(
    private readonly identity: IdentityService,
    private readonly tenant: TenantService,
    private readonly role: RoleService,
    private readonly audit: IdentityAuditService,
  ) {}

  async resolveSession(input: ResolveSessionInput): Promise<ResolveSessionResult> {
    // Reconcile by federated sub; on miss, reconcile-by-verified-email.
    let user = await this.identity.resolveUser({
      provider: input.provider,
      provider_subject: input.provider_subject,
    });
    if (user === null) {
      // Reconcile by the IdP-VERIFIED email — normalized-exact (lowercase + trim)
      // — to an EXISTING identity, then LINK the federated sub. NO open JIT
      // (invariant 4): a non-matching email denies and creates nothing.
      const normalizedEmail = input.verified_email.trim().toLowerCase();
      const existing = await this.identity.findUserByEmail(normalizedEmail);
      if (existing === null) {
        return { kind: 'denied', reason: 'user_not_provisioned' };
      }
      // Account-takeover guard (invariant 3): reached ONLY on a by-sub MISS, so
      // the (provider, sub) row is absent and only the upsert create branch runs
      // — the link is created, never moved.
      await this.identity.linkExternalIdentity({
        user_id: existing.id,
        provider: input.provider,
        provider_subject: input.provider_subject,
        email_snapshot: input.verified_email,
      });
      // Canonical linked audit — INSIDE the adapter (§2.3): internal to resolution,
      // best-effort (the underlying writeGlobalEvent swallows failures).
      await this.audit.writeGlobalEvent({
        event_type: 'identity.external_identity.linked' as AuditEventType,
        actor_type: 'user',
        actor_id: existing.id,
        subject_id: existing.id,
        payload: {
          provider: input.provider,
          provider_subject: input.provider_subject,
          reason: 'reconcile_by_verified_email',
        },
      });
      user = existing;
    }

    // Invariant 1+2: the SINGLE membership-activation seam. AFTER reconcile/link,
    // BEFORE tenant resolution; best-effort (an activation write must not break an
    // otherwise-valid sign-in).
    try {
      await this.identity.activateAcceptedMembershipsOnSession({ user_id: user.id });
    } catch (err) {
      this.logger.warn(
        `accepted-membership activation failed (non-blocking): ${(err as Error).message}`,
      );
    }

    const tenants = await this.tenant.getTenantsByUser({ user_id: user.id });
    if (tenants.length === 0) {
      return { kind: 'denied', reason: 'no_active_tenant' };
    }
    if (tenants.length > 1) {
      return {
        kind: 'ambiguous',
        choices: tenants.map((t) => ({ id: t.id, name: t.name })),
      };
    }
    const selectedTenant = tenants[0]!;

    // Invariant 5: tenant-status mint gate — TENANT consumers only. The platform
    // consumer's sentinel tenant has no lifecycle and is exempt. SUSPENDED/CLOSED
    // deny; PROVISIONED/ACTIVE/OFFBOARDING mint (PROVISIONED MUST mint or owner
    // first-login deadlocks).
    if (input.consumer !== 'platform') {
      if (selectedTenant.status === 'SUSPENDED') {
        return { kind: 'denied', reason: 'tenant_suspended' };
      }
      if (selectedTenant.status === 'CLOSED') {
        return { kind: 'denied', reason: 'tenant_closed' };
      }
    }

    const { scopes, site_id } = await this.resolveScopesInternal({
      user_id: user.id,
      tenant_id: selectedTenant.id,
    });

    return {
      kind: 'resolved',
      principal_id: user.id,
      context_id: selectedTenant.id,
      scopes,
      ...(site_id !== null ? { claims: { site_id } } : {}),
    };
  }

  async resolveScopes(input: ResolveScopesInput): Promise<ResolveScopesResult> {
    const { scopes, site_id } = await this.resolveScopesInternal({
      user_id: input.principal_id,
      tenant_id: input.context_id,
    });
    return { scopes, ...(site_id !== null ? { claims: { site_id } } : {}) };
  }

  // Invariant 6: site-stamp scope selection, shared by resolveSession and
  // resolveScopes. site_id === null → tenant-wide (byte-identical to the pre-port
  // tenant-wide path); otherwise → site-scoped (tenant-wide ∪ site-X).
  private async resolveScopesInternal(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<{ scopes: string[]; site_id: string | null }> {
    const site_id = await this.role.findActiveMembershipSite({
      user_id: args.user_id,
      tenant_id: args.tenant_id,
    });
    const scopes =
      site_id === null
        ? await this.role.getScopesByUserAndTenant({
            user_id: args.user_id,
            tenant_id: args.tenant_id,
          })
        : await this.role.getScopesByUserTenantAndSite({
            user_id: args.user_id,
            tenant_id: args.tenant_id,
            site_id,
          });
    return { scopes, site_id };
  }
}
