import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { ESIGN_SCOPE, IdentityRepository, TenantRepository } from '@aramo/identity';

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

export const ESIGN_READ_SCOPE = 'esign:envelope:read';
export const ESIGN_CREATE_SCOPE = 'esign:envelope:create';
export const ESIGN_SEND_SCOPE = 'esign:envelope:send';

export type SenderWorkspace = 'sign' | 'personal';

export interface SenderContextView {
  user: { id: string; email: string | null; display_name: string | null };
  tenant: { id: string; name: string; kind: string };
  workspace: SenderWorkspace;
  // Sign Unified Product S-1 — the caller's effective Sign permissions (the UI
  // shows only what these allow; esign-service enforces every one server-side).
  permissions: {
    read: boolean;
    read_all: boolean;
    create: boolean;
    send: boolean;
    manage_all: boolean;
    contacts: boolean;
    members: boolean;
    billing: boolean;
  };
  // True only for a BUSINESS tenant whose principal holds create + send.
  can_send: boolean;
  personal_sending_enabled: false;
  // The tenant host's Organization administration (shared authority for the
  // tenant profile and users), or null when the tenant has no host label.
  organization_url: string | null;
  // The tenant host's App Home (account preferences live there), or null.
  app_home_url: string | null;
}

@Injectable()
export class SenderContextService {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly identity: IdentityRepository,
  ) {}

  async tenantKind(tenant_id: string, requestId: string): Promise<string> {
    const tenant = await this.tenants.findById(tenant_id);
    if (tenant === null) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Tenant not found for this session', 403, { requestId, details: { reason: 'tenant_unknown' } });
    }
    return tenant.kind;
  }

  // Backend refusal for authoring / lifecycle writes from a PERSONAL tenant.
  async assertCanAuthor(auth: AuthContextType, requestId: string): Promise<void> {
    const kind = await this.tenantKind(auth.tenant_id, requestId);
    if (kind !== 'BUSINESS') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Sending from a personal account is not enabled', 403, {
        requestId,
        details: { reason: 'personal_sending_not_enabled' },
      });
    }
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
    const permissions = {
      read: scopes.has(ESIGN_READ_SCOPE),
      read_all: business && scopes.has(ESIGN_SCOPE.ENVELOPE_READ_ALL),
      create: scopes.has(ESIGN_CREATE_SCOPE),
      send: scopes.has(ESIGN_SEND_SCOPE),
      manage_all: business && scopes.has(ESIGN_SCOPE.ENVELOPE_MANAGE_ALL),
      contacts: scopes.has(ESIGN_SCOPE.CONTACT_READ),
      members: business && scopes.has(ESIGN_SCOPE.MEMBER_MANAGE),
      billing: business && (scopes.has(ESIGN_SCOPE.BILLING_MANAGE) || scopes.has('tenant:admin:settings')),
    };
    const tenantBase = tenantHostBase(slug);
    return {
      user: { id: auth.sub, email: user?.email ?? null, display_name: user?.display_name ?? null },
      tenant: { id: tenant.id, name: tenant.name, kind: tenant.kind },
      workspace: business ? 'sign' : 'personal',
      permissions,
      can_send: business && permissions.create && permissions.send,
      personal_sending_enabled: false,
      organization_url: business && tenantBase !== null ? `${tenantBase}/org/profile` : null,
      app_home_url: tenantBase !== null ? `${tenantBase}/` : null,
    };
  }
}

// The tenant host base URL. `ESIGN_TENANT_HOST_URL_TEMPLATE` (e.g.
// `https://{slug}.aramo.ai`, or `http://localhost:4205` for the local App Home
// topology); default `https://{slug}.aramo.ai`. Null without a slug.
export function tenantHostBase(slug: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const template = env['ESIGN_TENANT_HOST_URL_TEMPLATE'] ?? 'https://{slug}.aramo.ai';
  if (!template.includes('{slug}')) return template.replace(/\/+$/, '');
  if (slug === null || slug.length === 0) return null;
  return template.replace('{slug}', slug).replace(/\/+$/, '');
}
