import { Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, IdentityProviderPolicyService, IdentityRepository, TenantRepository, normalizeIdp, type TenantDto } from '@aramo/identity';

import { PersonalSendGate } from '../personal/personal-send.gate.js';
import { SIGN_TEMPLATES_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';

// PX-1 — the authenticated sender's context, resolved ENTIRELY server-side from
// the verified auth context (Lead Host & Workspace Ruling v1.0): tenant identity,
// tenant kind, workspace, and action authority never come from the URL path.
//
//   BUSINESS tenant → workspace `sign`     (esign.aramo.ai/sign/)
//   PERSONAL tenant → workspace `personal` (esign.aramo.ai/personal/)
//
// PERSONAL sending is NOT enabled (ruling): a PERSONAL tenant may read its own
// envelopes but every authoring / lifecycle write is refused here, on the
// backend, regardless of the scopes the principal holds.
//
// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §4 / §10 — lifted ONLY for
// a bound (ACTIVE) PERSONAL tenant while SIGN_PERSONAL_SIGNUP_MODE is not `off`;
// the send itself then passes the Personal sending gate (PersonalSendGate). With
// the mode off (the shipped default) the refusal is exactly the one above.

export const ESIGN_READ_SCOPE = 'sign:envelope:read';
export const ESIGN_CREATE_SCOPE = 'sign:envelope:create';
export const ESIGN_SEND_SCOPE = 'sign:envelope:send';
// DOC-TEMPLATE-LIB-1 T-5 — the Documents-owned template "use" permission Sign checks.
export const DOCUMENT_TEMPLATE_READ_SCOPE = 'document_template:read';

export type SenderWorkspace = 'sign' | 'personal';
export type SignInProvider = 'google' | 'microsoft';

export interface SenderContextView {
  // Sign Mobile B-11 — identity_provider: the federated provider the user signs in
  // with ('google' | 'microsoft'), for "Signed in with Google/Microsoft"; null when
  // not recorded (a legacy link) or not one provider.
  user: { id: string; email: string | null; display_name: string | null; identity_provider: SignInProvider | null };
  tenant: { id: string; name: string; kind: string };
  workspace: SenderWorkspace;
  // Sign Unified Product S-1 — the caller's effective Sign permissions (the UI
  // shows only what these allow; sign-service enforces every one server-side).
  permissions: {
    read: boolean;
    read_all: boolean;
    create: boolean;
    send: boolean;
    manage_all: boolean;
    contacts: boolean;
    members: boolean;
    billing: boolean;
    // DOC-TEMPLATE-LIB-1 T-5 — document_template:read (start envelopes from templates).
    templates: boolean;
  };
  // DOC-TEMPLATE-LIB-1 T-5 — plan capabilities by launch availability (sign.templates).
  features: { templates: boolean };
  // True only for a BUSINESS tenant whose principal holds create + send.
  can_send: boolean;
  // Personal Free v1.1 — true only for a bound PERSONAL tenant while Personal
  // sending is switched on (SIGN_PERSONAL_SIGNUP_MODE not `off`).
  personal_sending_enabled: boolean;
  // The tenant host's Organization administration (shared authority for the
  // tenant profile and users), or null when the tenant has no host label.
  organization_url: string | null;
  // ORG-UX-1 (Directive v1.0 LOCKED §4.3/§6, Lead Correction A) — the caller holds an
  // organization role (tenant_owner / tenant_admin) in this BUSINESS tenant: the ONLY
  // principals Organization → Users & product access lets assign roles. Role-based,
  // never derived from scope possession. Navigation only (Org enforces every command).
  org_admin: boolean;
  // ORG-UX-1 §6 — Organization → Users & product access, or null (no host label / personal).
  organization_roles_url: string | null;
  // The tenant host's App Home (account preferences live there), or null.
  app_home_url: string | null;
}

@Injectable()
export class SenderContextService {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly identity: IdentityRepository,
    // DOC-TEMPLATE-LIB-1 T-5 — optional so existing compositions/tests keep working; absent
    // ⇒ the production registry (sign.templates NOT_AVAILABLE until activation).
    @Optional() private readonly features?: SignFeatureGate,
    // Personal Free v1.1 — optional so existing compositions/tests keep working;
    // absent ⇒ Personal authoring stays refused (today's behaviour).
    @Optional() private readonly personal?: PersonalSendGate,
    // Sign Mobile B-11 — the provider recorded for the user's sign-in link.
    @Optional() private readonly idps?: IdentityProviderPolicyService,
  ) {}

  // Sign Mobile B-11 (directive §4) — "Signed in with Google/Microsoft". The source
  // is the provider recorded on the user's identity link (AUTH-SIGNIN-1 R2,
  // ExternalIdentityIdp): exactly one recorded provider names it. A user with no
  // recorded provider (a link made before R2) in a tenant that ENFORCES its pin
  // (R1) can only have signed in through that pin. Anything else is null — never
  // a guess.
  async identityProviderOf(user_id: string, tenant_id: string): Promise<SignInProvider | null> {
    if (this.idps === undefined) return null;
    try {
      const recorded = [...new Set((await this.idps.recordedIdpsOf(user_id)).map((x) => normalizeIdp(x)))];
      if (recorded.length === 1) {
        const only = recorded[0];
        return only === 'google' || only === 'microsoft' ? only : null;
      }
      if (recorded.length > 1) return null;
      const policy = await this.idps.policyOf(tenant_id);
      const pin = policy.enforced ? normalizeIdp(policy.pin) : null;
      return pin === 'google' || pin === 'microsoft' ? pin : null;
    } catch {
      return null;
    }
  }

  async tenantOf(tenant_id: string, requestId: string): Promise<TenantDto> {
    const tenant = await this.tenants.findById(tenant_id);
    if (tenant === null) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Tenant not found for this session', 403, { requestId, details: { reason: 'tenant_unknown' } });
    }
    return tenant;
  }

  async tenantKind(tenant_id: string, requestId: string): Promise<string> {
    return (await this.tenantOf(tenant_id, requestId)).kind;
  }

  /** Personal Free v1.1 — a bound PERSONAL tenant while Personal sending is switched on. */
  personalAuthoringOpen(tenant: Pick<TenantDto, 'kind' | 'status'>): boolean {
    return this.personal !== undefined && this.personal.authoringOpen(tenant);
  }

  // Backend refusal for authoring / lifecycle writes from a PERSONAL tenant
  // (lifted only per personalAuthoringOpen).
  async assertCanAuthor(auth: AuthContextType, requestId: string): Promise<void> {
    await this.assertCanAuthorTenant(auth, requestId);
  }

  /** assertCanAuthor, returning the tenant (the send / remind paths need its kind). */
  async assertCanAuthorTenant(auth: AuthContextType, requestId: string): Promise<TenantDto> {
    const tenant = await this.tenantOf(auth.tenant_id, requestId);
    if (tenant.kind === 'BUSINESS') return tenant;
    if (!this.personalAuthoringOpen(tenant)) throw personalSendingNotEnabled(requestId);
    // Personal Free v1.1 §4 — the FREE subscription is in place before any upload / send.
    await this.personal?.ensureFreeSubscription(tenant);
    return tenant;
  }

  // Business-only actions (e.g. a paid checkout): refused for every non-BUSINESS
  // tenant whatever the Personal mode — the Free Personal plan is never purchased.
  async assertBusiness(auth: AuthContextType, requestId: string): Promise<void> {
    if ((await this.tenantKind(auth.tenant_id, requestId)) !== 'BUSINESS') throw personalSendingNotEnabled(requestId);
  }

  async context(auth: AuthContextType, requestId: string): Promise<SenderContextView> {
    const tenant = await this.tenants.findById(auth.tenant_id);
    if (tenant === null) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Tenant not found for this session', 403, { requestId, details: { reason: 'tenant_unknown' } });
    }
    const user = await this.identity.findUserById(auth.sub);
    const slug = await this.tenants.findSlugById(auth.tenant_id);
    const scopes = new Set(auth.scopes);
    const business = tenant.kind === 'BUSINESS';
    const personalOpen = !business && this.personalAuthoringOpen(tenant);
    // Personal Free v1.1 §4 — the FREE subscription opens lazily on first read.
    if (personalOpen) await this.personal?.ensureFreeSubscription(tenant);
    const permissions = {
      read: scopes.has(ESIGN_READ_SCOPE),
      read_all: business && scopes.has(ESIGN_SCOPE.ENVELOPE_READ_ALL),
      create: scopes.has(ESIGN_CREATE_SCOPE),
      send: scopes.has(ESIGN_SEND_SCOPE),
      manage_all: business && scopes.has(ESIGN_SCOPE.ENVELOPE_MANAGE_ALL),
      contacts: scopes.has(ESIGN_SCOPE.CONTACT_READ),
      members: business && scopes.has(ESIGN_SCOPE.MEMBER_MANAGE),
      // ROLES-1 PR-2 (§3.4) — sign:billing:manage only (the tenant_owner bundle).
      billing: business && scopes.has(ESIGN_SCOPE.BILLING_MANAGE),
      templates: scopes.has(DOCUMENT_TEMPLATE_READ_SCOPE),
    };
    const tenantBase = tenantHostBase(slug);
    const membership = business ? await this.identity.findMembership({ user_id: auth.sub, tenant_id: auth.tenant_id }) : null;
    const roleKeys = membership !== null && membership.is_active ? await this.identity.findRoleKeysForMembership(membership.id) : [];
    const org_admin = business && roleKeys.some((k) => k === 'tenant_owner' || k === 'tenant_admin');
    return {
      user: { id: auth.sub, email: user?.email ?? null, display_name: user?.display_name ?? null, identity_provider: await this.identityProviderOf(auth.sub, auth.tenant_id) },
      tenant: { id: tenant.id, name: (await this.tenants.findOrganizationNameById(tenant.id)) ?? tenant.name, kind: tenant.kind },
      workspace: business ? 'sign' : 'personal',
      permissions,
      features: { templates: (this.features ?? new SignFeatureGate()).isAvailable(SIGN_TEMPLATES_FEATURE) },
      can_send: (business || personalOpen) && permissions.create && permissions.send,
      personal_sending_enabled: personalOpen,
      organization_url: business && tenantBase !== null ? `${tenantBase}/org/profile` : null,
      org_admin,
      organization_roles_url: business && tenantBase !== null ? `${tenantBase}/org/roles` : null,
      app_home_url: tenantBase !== null ? `${tenantBase}/` : null,
    };
  }
}

function personalSendingNotEnabled(requestId: string): AramoError {
  return new AramoError('INSUFFICIENT_PERMISSIONS', 'Sending from a personal account is not enabled', 403, {
    requestId,
    details: { reason: 'personal_sending_not_enabled' },
  });
}

// The tenant host base URL. `SIGN_TENANT_HOST_URL_TEMPLATE` (e.g.
// `https://{slug}.aramo.ai`, or `http://localhost:4205` for the local App Home
// topology); default `https://{slug}.aramo.ai`. Null without a slug.
export function tenantHostBase(slug: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const template = env['SIGN_TENANT_HOST_URL_TEMPLATE'] ?? 'https://{slug}.aramo.ai';
  if (!template.includes('{slug}')) return template.replace(/\/+$/, '');
  if (slug === null || slug.length === 0) return null;
  return template.replace('{slug}', slug).replace(/\/+$/, '');
}
