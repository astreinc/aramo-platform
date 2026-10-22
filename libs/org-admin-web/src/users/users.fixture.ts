import type { ProductAvailabilityView, Session } from '@aramo/fe-foundation';

import type { RoleCatalogView } from '../roles/roles-catalog-api';

import type { TenantUserView } from './types';

// ORG-UX-1 — shared fixtures for the Users & invitations / Roles & access / modal specs.

export const CATALOG: readonly RoleCatalogView[] = [
  { key: 'tenant_owner', display: 'Tenant Owner', description: 'Full control', tier: 'Administration', scopes: [] },
  { key: 'tenant_admin', display: 'Tenant Admin', description: 'Manage people', tier: 'Administration', scopes: [] },
  { key: 'ats_admin', display: 'ATS Admin', description: 'Configure ATS', tier: 'Administration', scopes: [] },
  { key: 'recruiter', display: 'Recruiter', description: 'Works requisitions', tier: 'Operations', scopes: [] },
  { key: 'sourcer', display: 'Sourcer', description: 'Finds talent', tier: 'Operations', scopes: [] },
  { key: 'sign_sender', display: 'Sign Sender', description: 'Sends envelopes', tier: 'Sign', scopes: [] },
  { key: 'sign_viewer', display: 'Sign Viewer', description: 'Views envelopes', tier: 'Sign', scopes: [] },
  // A non-tenant (portal-tier) role — filtered by tier, never by key.
  { key: 'portal_principal_fixture', display: 'Portal person', description: '', tier: 'Portal', scopes: [] },
];

export function user(id: string, over: Partial<TenantUserView> = {}): TenantUserView {
  return {
    user_id: id,
    email: `${id}@acme.test`,
    display_name: id.toUpperCase(),
    is_active: true,
    invite_status: 'ACTIVE',
    deactivated_at: null,
    site_id: null,
    role_keys: ['recruiter'],
    invited_at: null,
    ...over,
  };
}

export const PRODUCTS: ProductAvailabilityView = {
  tenant_id: 't-1',
  products: [
    { key: 'ats', subscribed: true, authorized: true, available: true, entry_path: '/ats/', reason: null },
    { key: 'sign', subscribed: true, authorized: true, available: true, entry_path: 'https://sign.aramo.test/', reason: null },
    { key: 'org', subscribed: true, authorized: true, available: true, entry_path: '/org/', reason: null, org_access: 'admin' },
  ],
};

export const ATS_ONLY: ProductAvailabilityView = {
  tenant_id: 't-1',
  products: [
    { key: 'ats', subscribed: true, authorized: true, available: true, entry_path: '/ats/', reason: null },
    { key: 'sign', subscribed: false, authorized: false, available: false, entry_path: null, reason: 'not_subscribed' },
  ],
};

export function session(sub: string): Session {
  return { sub, consumer_type: 'org', tenant_id: 't-1', scopes: ['tenant:admin:user-manage'], iat: 0, exp: 0 };
}

export function apiError(status: number, code: string, details?: Record<string, unknown>) {
  return { status, body: { error: { code, message: code, details } } };
}
