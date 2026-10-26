import type { Catalog, CatalogPlan, CatalogVersion, CatalogVersionTerms } from './catalog-api';

// CCP-B2 — TEST-ONLY catalog data for the unit and RTL specs (never imported by the screen).

export const TERMS: CatalogVersionTerms = {
  list_price_minor: 5900,
  currency: 'USD',
  billing_interval: 'MONTH',
  sales_model: 'SELF_SERVICE',
  contract_priced: false,
  envelopes_per_month: 750,
  envelopes_unlimited: false,
  envelopes_present: true,
  storage_bytes: 50 * 1024 ** 3,
  storage_unlimited: false,
  storage_present: true,
};

export function v(over: Partial<CatalogVersion> & Pick<CatalogVersion, 'id' | 'version_number' | 'status'>): CatalogVersion {
  return {
    plan_id: 'p-team',
    content_checksum: 'c'.repeat(64),
    note: null,
    created_by: 'u',
    created_at: '2026-01-15T00:00:00.000Z',
    published_at: over.status === 'DRAFT' ? null : '2026-07-01T00:00:00.000Z',
    retired_at: over.status === 'RETIRED' ? '2026-08-01T00:00:00.000Z' : null,
    terms: TERMS,
    pinned_subscriptions: 0,
    open_requests: [],
    ...over,
  };
}

export const TEAM: CatalogPlan = {
  id: 'p-team',
  key: 'aramo-sign-team-v1',
  product_key: 'sign',
  name: 'Team',
  status: 'ACTIVE',
  sales_model: 'SELF_SERVICE',
  sellable: true,
  display_order: 20,
  versions: [
    v({ id: 'team-3', version_number: 3, status: 'DRAFT', terms: { ...TERMS, list_price_minor: 6900, envelopes_per_month: 1000 } }),
    v({ id: 'team-2', version_number: 2, status: 'PUBLISHED', pinned_subscriptions: 1 }),
    v({ id: 'team-1', version_number: 1, status: 'RETIRED', pinned_subscriptions: 1, terms: { ...TERMS, list_price_minor: 4900, envelopes_per_month: 500, storage_bytes: 25 * 1024 ** 3 } }),
  ],
};

export const ENTERPRISE: CatalogPlan = {
  id: 'p-ent',
  key: 'aramo-sign-enterprise-v1',
  product_key: 'sign',
  name: 'Enterprise',
  status: 'ACTIVE',
  sales_model: 'CONTACT_SALES',
  sellable: false,
  display_order: 40,
  versions: [
    v({
      id: 'ent-1',
      plan_id: 'p-ent',
      version_number: 1,
      status: 'PUBLISHED',
      pinned_subscriptions: 1,
      terms: { ...TERMS, list_price_minor: null, currency: null, billing_interval: null, sales_model: 'CONTACT_SALES', contract_priced: true, envelopes_present: false, envelopes_per_month: null, storage_present: false, storage_bytes: null },
    }),
  ],
};

export const CATALOG: Catalog = {
  products: [{ product_key: 'sign', plans: [TEAM, ENTERPRISE] }],
  publish_chain: { rule: 'FINANCE_THEN_OWNER', step_role_keys: ['finance_admin', 'platform_owner'], policy_version_id: 'pol-1', policy_version_number: 1, approval_expiry_hours: 72 },
};

const ENTRY = 'platform:tenant:read';
/** The CCP A1 §4.1 bundles (+ super_admin's 10 non-commercial scopes). */
export const ROLE_SCOPES: Readonly<Record<string, readonly string[]>> = {
  platform_owner: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  finance_admin: [ENTRY, 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read'],
  commercial_ops: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read'],
  catalog_manager: [ENTRY, 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: [ENTRY, 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read'],
  super_admin: ['platform:tenant:provision', ENTRY, 'platform:admin:invite', 'platform:tenant:lifecycle:manage', 'platform:skill:read', 'platform:skill:manage', 'platform:document_template:read', 'platform:document_template:manage', 'platform:matching_policy:read', 'platform:matching_policy:write'],
};
