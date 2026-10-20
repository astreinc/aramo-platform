import { Injectable, Logger } from '@nestjs/common';
import {
  AuthorizationVersionService,
  IdentityAuditService,
  IdentityService,
  RoleService,
  TenantEntitlementReader,
  TenantService,
  requiredCapabilityForConsumer,
  SYSTEM_SERVICE_ACCOUNT_ID,
  TENANT_ACTIVATING_OWNER_ROLE_KEYS,
  IdentityProviderPolicyService,
  normalizeIdp,
} from '@aramo/identity';
import {
  allowUnboundHost,
  evaluateHostBinding,
  readHostBindingMode,
  type PrincipalDirectory,
  type ResolveScopesInput,
  type ResolveScopesResult,
  type ResolveSessionInput,
  type ResolveSessionResult,
} from '@aramo/auth-core';

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
//
// IC-2 PR-4 (Auth-Decoupling PR-4 Amendment A1): the result union is
// resolved | denied — a defensive multi-tenant read (unreachable against the
// IC-1 PR-3 database) is `denied tenant_resolution_ambiguous`, never a chooser;
// and the HOST BINDING check (F-5) runs AFTER tenant selection and BEFORE the
// status gate, comparing selectedTenant.id (F-2 — equal to User.tenant_id by the
// PR-3 composite FK) with the host context sealed at login. Under
// AUTH_HOST_TENANT_BINDING=log (default) a failure is logged and the outcome is
// unchanged; under enforce it is denied and no session is minted.
@Injectable()
export class IdentityPrincipalDirectoryAdapter implements PrincipalDirectory {
  private readonly logger = new Logger(IdentityPrincipalDirectoryAdapter.name);

  constructor(
    private readonly identity: IdentityService,
    private readonly tenant: TenantService,
    private readonly role: RoleService,
    private readonly audit: IdentityAuditService,
    // HF-AUTH-1 — the current authorization revision to stamp into the compact
    // token (login + refresh mint paths).
    private readonly authzVersions: AuthorizationVersionService,
    // IC-2 PR-6 — live product-entitlement read for the consumer→capability gate.
    private readonly entitlements: TenantEntitlementReader,
    // AUTH-SIGNIN-1 R1/R2 — provider policy (pin cohort, no cross-provider merge).
    private readonly idpPolicy: IdentityProviderPolicyService,
  ) {}

  // IC-2 PR-6 (IC-0 §F.2 rule 3) — a consumer credential is minted or
  // re-minted ONLY when the tenant holds the consumer's product capability:
  // recruiter/ingestion → `ats`, esign → `sign`, platform → exempt (sentinel),
  // portal/unknown → unsupported on this path. Re-proven at EVERY mint and
  // refresh from the entitlement store (never from the token), so a removed
  // entitlement cannot be resurrected by refresh. A valid identity is not
  // evidence of product entitlement. Fail closed on an unreadable store.
  private async assertConsumerEntitled(
    consumer: string | undefined,
    tenant_id: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'consumer_not_entitled' | 'consumer_not_supported' }> {
    const requirement = requiredCapabilityForConsumer(consumer);
    if (requirement.kind === 'exempt') return { ok: true };
    if (requirement.kind === 'unsupported') return { ok: false, reason: 'consumer_not_supported' };
    let capabilities: ReadonlySet<string>;
    try {
      capabilities = await this.entitlements.getCapabilities(tenant_id);
    } catch (err) {
      this.logger.warn(`entitlement read failed (fail closed): ${(err as Error).message}`);
      return { ok: false, reason: 'consumer_not_entitled' };
    }
    return capabilities.has(requirement.capability)
      ? { ok: true }
      : { ok: false, reason: 'consumer_not_entitled' };
  }

  async resolveSession(input: ResolveSessionInput): Promise<ResolveSessionResult> {
    // Reconcile by federated sub; on miss, reconcile-by-verified-email.
    let user = await this.identity.resolveUser({
      provider: input.provider,
      provider_subject: input.provider_subject,
    });
    // AUTH-SIGNIN-1 — set once the provider policy has run for this sign-in.
    let idpChecked = false;
    if (user === null) {
      // Reconcile by the IdP-VERIFIED email — normalized-exact (lowercase + trim)
      // — to an EXISTING identity, then LINK the federated sub. NO open JIT
      // (invariant 4): a non-matching email denies and creates nothing.
      const normalizedEmail = input.verified_email.trim().toLowerCase();
      const existing = await this.identity.findUserByEmail(normalizedEmail);
      if (existing === null) {
        return { kind: 'denied', reason: 'user_not_provisioned' };
      }
      // AUTH-SIGNIN-1 R1/R2 — the provider policy runs BEFORE the link is
      // written: no second provider merged into this user on email equality,
      // and an enforced-pin tenant (Sign signup cohort) accepts only its pinned
      // provider; its owner's first federation sets the pin exactly once.
      // (The policy reads the user's single membership tenant itself, so the
      // load-bearing link → activate → tenants order below is unchanged.)
      const decision = await this.idpPolicy.evaluate({ user_id: existing.id, idp: input.idp ?? null, linking: true });
      if (!decision.ok) {
        this.logger.warn(JSON.stringify({ event: 'auth.idp_policy', stage: 'link', outcome: decision.reason, idp: input.idp ?? null }));
        return { kind: 'denied', reason: decision.reason };
      }
      const pinnedNow = decision.pinned_now;
      idpChecked = true;
      // Account-takeover guard (invariant 3): reached ONLY on a by-sub MISS, so
      // the (provider, sub) row is absent and only the upsert create branch runs
      // — the link is created, never moved.
      const link = await this.identity.linkExternalIdentity({
        user_id: existing.id,
        provider: input.provider,
        provider_subject: input.provider_subject,
        email_snapshot: input.verified_email,
      });
      const linkIdp = normalizeIdp(input.idp ?? null);
      if (linkIdp === 'google' || linkIdp === 'microsoft') await this.idpPolicy.recordLinkIdp(link.id, linkIdp);
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
          // AUTH-SIGNIN-1 — which federated provider, and whether this sign-in
          // established the tenant's provider pin (Sign signup cohort).
          idp: input.idp ?? null,
          ...(pinnedNow ? { idp_pinned: true } : {}),
        },
      });
      user = existing;
    }

    // IC-2 PR-5 (N-6 wired) — the GLOBAL User.is_active flag is an eligibility
    // gate at mint: a deactivated identity never mints, whatever its
    // membership rows say. Checked before activation/selection so nothing is
    // written for it.
    if (user.is_active === false) {
      return { kind: 'denied', reason: 'user_inactive' };
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
      // IC-1 made this unreachable at the database (UNIQUE membership per User);
      // kept as a FAIL-CLOSED guard (Amendment A1 §2 item 1). No tenant named.
      return { kind: 'denied', reason: 'tenant_resolution_ambiguous' };
    }
    const selectedTenant = tenants[0]!;

    // AUTH-SIGNIN-1 R1 — every later sign-in into an enforced-pin tenant must
    // come from its pinned provider (a returning user resolves by sub, so the
    // link-time check above did not run).
    if (!idpChecked) {
      const decision = await this.idpPolicy.evaluate({ user_id: user.id, tenant_id: selectedTenant.id, idp: input.idp ?? null, linking: false });
      if (!decision.ok) {
        this.logger.warn(JSON.stringify({ event: 'auth.idp_policy', stage: 'session', outcome: decision.reason, idp: input.idp ?? null }));
        return { kind: 'denied', reason: decision.reason };
      }
    }

    // IC-2 PR-4 (F-5) — host binding: AFTER tenant selection, BEFORE the status
    // gate, so a mismatched host never learns another tenant's lifecycle state.
    const binding = evaluateHostBinding({
      host_class: input.host_class,
      context_id: input.context_id,
      consumer: input.consumer,
      resolved_context_id: selectedTenant.id,
      allow_unbound: allowUnboundHost(),
    });
    if (!binding.ok) {
      const mode = readHostBindingMode();
      // Structured diagnostic (F-6 log mode). Deliberately carries NO tenant or
      // user identifiers — nothing here can disclose a foreign tenant.
      this.logger.warn(
        JSON.stringify({
          event: 'auth.host_binding',
          stage: 'principal_resolution',
          mode,
          outcome: binding.reason,
          consumer: input.consumer,
          host_class: input.host_class ?? null,
          legacy_pkce: input.host_class === undefined,
        }),
      );
      if (mode === 'enforce') {
        return { kind: 'denied', reason: binding.reason };
      }
    }

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

    // IC-2 PR-6 (rule 3) — product capability gate AFTER the status gate, BEFORE
    // any scope resolution: no session for a product the tenant is not entitled to.
    const entitled = await this.assertConsumerEntitled(input.consumer, selectedTenant.id);
    if (!entitled.ok) {
      return { kind: 'denied', reason: entitled.reason };
    }

    const { scopes, site_id } = await this.resolveScopesInternal({
      user_id: user.id,
      tenant_id: selectedTenant.id,
    });
    // HF-AUTH-1 — the authorization revision to stamp into the compact token.
    const authz_version = await this.authzVersions.getCurrentVersion({
      tenant_id: selectedTenant.id,
      principal_id: user.id,
    });

    // IC-4 PR-9 / IC-0 J-9 (Platform-Console Inc-2 PR-1 Amendment Inc-2-PR-1-A1)
    // — OWNER FIRST-SESSION ACTIVATION. A Pattern-A owner (Cognito-invited at
    // provisioning) has no Invitation row, so the acceptance-time hook never
    // fires and the tenant would sit PROVISIONED forever. Here, AFTER every
    // gate has passed (host binding, status, entitlement, scopes) and ONLY for
    // a tenant consumer whose tenant is still PROVISIONED and whose membership
    // holds an activating owner role (tenant_owner / org_admin), the tenant is
    // transitioned PROVISIONED → ACTIVE by the system actor. Best-effort and
    // idempotent (transitionTenantStatus no-ops on an already-ACTIVE tenant):
    // an activation failure NEVER fails an otherwise-valid sign-in — the mint
    // gate already allows PROVISIONED. Nothing here widens scopes or changes
    // the minted session.
    if (input.consumer !== 'platform' && selectedTenant.status === 'PROVISIONED') {
      await this.activateOnOwnerFirstSession({ user_id: user.id, tenant_id: selectedTenant.id });
    }

    return {
      kind: 'resolved',
      principal_id: user.id,
      context_id: selectedTenant.id,
      scopes,
      authz_version,
      ...(site_id !== null ? { claims: { site_id } } : {}),
    };
  }

  private async activateOnOwnerFirstSession(args: { user_id: string; tenant_id: string }): Promise<void> {
    try {
      const membership = await this.identity.findMembership(args);
      if (membership === null) return;
      const roleKeys = await this.identity.findRoleKeysForMembership(membership.id);
      if (!roleKeys.some((k) => TENANT_ACTIVATING_OWNER_ROLE_KEYS.includes(k))) return;
      await this.tenant.transitionTenantStatus({
        tenant_id: args.tenant_id,
        to: 'ACTIVE',
        actor_id: SYSTEM_SERVICE_ACCOUNT_ID,
        actor_type: 'system',
        source: 'owner_first_session',
        related: { membershipId: membership.id, userId: args.user_id },
      });
    } catch (err) {
      this.logger.warn(
        `owner first-session activation failed (non-blocking; tenant stays PROVISIONED, mint-gate allows it): ${(err as Error).message}`,
      );
    }
  }

  async resolveScopes(input: ResolveScopesInput): Promise<ResolveScopesResult> {
    // IC-2 PR-5 (Auth-Decoupling PR-4 Amendment A2) — ELIGIBILITY is re-proven
    // at every refresh, at the authoritative identity boundary, BEFORE anything
    // is re-minted:
    //  (1) the User exists and is globally active (N-6 wired);
    //  (2) the principal holds an ACTIVE membership in an ACTIVE tenant and that
    //      tenant IS the stored context — one User, one tenant (IC-1): the
    //      stored token can never re-mint a tenant the principal does not own;
    //  (3) the tenant status gate (SUSPENDED/CLOSED deny; `platform` exempt),
    //      the same gate resolveSession applies.
    const user = await this.identity.findUserById(input.principal_id);
    if (user === null || user.is_active === false) {
      return { kind: 'denied', reason: 'user_inactive' };
    }
    const tenants = await this.tenant.getTenantsByUser({ user_id: input.principal_id });
    const stored = tenants.find((t) => t.id === input.context_id);
    if (stored === undefined) {
      return { kind: 'denied', reason: 'membership_inactive' };
    }
    if (input.consumer !== 'platform') {
      if (stored.status === 'SUSPENDED') {
        return { kind: 'denied', reason: 'tenant_suspended' };
      }
      if (stored.status === 'CLOSED') {
        return { kind: 'denied', reason: 'tenant_closed' };
      }
    }

    // IC-2 PR-6 (rule 3) — the consumer's product capability is re-proven at
    // every refresh; a refresh cannot resurrect a revoked product capability.
    const entitled = await this.assertConsumerEntitled(input.consumer, input.context_id);
    if (!entitled.ok) {
      return { kind: 'denied', reason: entitled.reason };
    }

    const { scopes, site_id } = await this.resolveScopesInternal({
      user_id: input.principal_id,
      tenant_id: input.context_id,
    });
    // HF-AUTH-1 — re-resolve the current authorization revision for the compact
    // re-mint (refresh path).
    const authz_version = await this.authzVersions.getCurrentVersion({
      tenant_id: input.context_id,
      principal_id: input.principal_id,
    });
    return {
      kind: 'resolved',
      scopes,
      authz_version,
      ...(site_id !== null ? { claims: { site_id } } : {}),
    };
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
