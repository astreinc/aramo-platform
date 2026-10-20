import { describe, expect, it } from 'vitest';

import {
  displayFromDescription,
  ROLE_CATALOG_META,
} from '../lib/role-catalog/role-catalog.view.js';
import { RoleCatalogService } from '../lib/role-catalog/role-catalog.service.js';
import { ESIGN_PRODUCT_ROLE_KEYS, SEED_ROLE_KEYS } from '../lib/dto/index.js';

// Settings Rebuild Directive 5 — roles-catalog service + metadata.

function roleRow(key: string, description: string | null, scopes: string[]) {
  return {
    key,
    description,
    role_scopes: scopes.map((k) => ({ scope: { key: k } })),
  };
}

// `capabilities` — the caller tenant's live capability set (IC-3 PR-8); the
// Sign partition is projected only when it holds `sign`.
function makeService(rows: ReturnType<typeof roleRow>[], capabilities: readonly string[] = ['core', 'ats']) {
  const findMany = async () => rows;
  const entitlements = { getCapabilities: async () => new Set<string>(capabilities) };
  return new RoleCatalogService({ role: { findMany } } as never, entitlements as never);
}

const TENANT = '01900000-0000-7000-8000-000000000001';

describe('roles-catalog metadata', () => {
  it('every tenant SEED_ROLE_KEY (except super_admin) has catalog metadata — the E-Sign product roles included (IC-3 PR-8)', () => {
    for (const key of SEED_ROLE_KEYS) {
      if (key === 'super_admin') continue; // platform tier — excluded
      expect(ROLE_CATALOG_META[key], `meta for ${key}`).toBeDefined();
    }
    for (const key of ESIGN_PRODUCT_ROLE_KEYS) expect(ROLE_CATALOG_META[key]?.tier).toBe('Sign');
  });

  it('derives the display name from the description lead phrase', () => {
    expect(displayFromDescription('Tenant Admin — administrative operator', 'tenant_admin')).toBe(
      'Tenant Admin',
    );
    // Falls back to a humanized key when the description is missing/unshaped.
    expect(displayFromDescription(null, 'lead_recruiter')).toBe('Lead Recruiter');
  });
});

describe('RoleCatalogService', () => {
  it('projects roles to the catalog view (scopes deduped + sorted)', async () => {
    const svc = makeService([
      roleRow('recruiter', 'Recruiter — core operator', ['talent:read', 'talent:create', 'talent:read']),
    ]);
    const out = await svc.getCatalog();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      key: 'recruiter',
      display: 'Recruiter',
      tier: 'Operations',
      scopes: ['talent:create', 'talent:read'],
    });
  });

  it('EXCLUDES the platform tier (any platform:* scope = super_admin)', async () => {
    const svc = makeService([
      roleRow('tenant_admin', 'Tenant Admin — admin', ['tenant:admin:user-manage']),
      roleRow('super_admin', 'Super Admin — platform', ['platform:tenant:provision']),
    ]);
    const out = await svc.getCatalog();
    expect(out.map((r) => r.key)).toEqual(['tenant_admin']);
  });

  it('attaches the S4 settings-gate to auditor_with_financials only', async () => {
    const svc = makeService([
      roleRow('auditor_with_financials', 'Auditor with Financials — comp', ['audit:read']),
      roleRow('auditor', 'Auditor — read-only', ['audit:read']),
    ]);
    const out = await svc.getCatalog();
    const awf = out.find((r) => r.key === 'auditor_with_financials');
    const aud = out.find((r) => r.key === 'auditor');
    expect(awf?.requires_setting?.setting_key).toBe('audit.financials_enabled');
    expect(aud?.requires_setting).toBeUndefined();
  });

  // IC-3 PR-8 — the E-Sign PRODUCT partition (PX-V1 PX-3 roles) is projected
  // ONLY for a tenant that holds `sign`; no tenant / unentitled → excluded.
  it('EXCLUDES the E-Sign product roles for an ATS-only tenant and when no tenant is given (pre-PR-8 projection)', async () => {
    const rows = [
      roleRow('tenant_admin', 'Tenant Admin — admin', ['tenant:admin:user-manage']),
      roleRow('sign_sender', 'Sign Sender — sends', ['sign:envelope:create', 'sign:envelope:send', 'sign:envelope:read']),
    ];
    expect((await makeService(rows, ['core', 'ats']).getCatalog({ tenant_id: TENANT })).map((r) => r.key)).toEqual(['tenant_admin']);
    expect((await makeService(rows, ['core', 'sign']).getCatalog()).map((r) => r.key)).toEqual(['tenant_admin']);
  });

  it('INCLUDES the E-Sign product roles (tier "E-Sign", after every ATS tier) for an esign-entitled tenant — Sign-only and ATS + Sign alike', async () => {
    const rows = [
      roleRow('sign_viewer', 'Sign Viewer — reads', ['sign:envelope:read']),
      roleRow('sign_sender', 'Sign Sender — sends', ['sign:envelope:send']),
      roleRow('org_admin', 'Organization Admin — org', ['tenant:admin:user-manage']),
      roleRow('recruiter', 'Recruiter — op', ['talent:read']),
      roleRow('super_admin', 'Super Admin — platform', ['platform:tenant:provision']),
    ];
    const signOnly = await makeService(rows, ['core', 'sign']).getCatalog({ tenant_id: TENANT });
    expect(signOnly.map((r) => r.key)).toEqual(['org_admin', 'recruiter', 'sign_sender', 'sign_viewer']);
    expect(signOnly.find((r) => r.key === 'sign_sender')).toMatchObject({ tier: 'Sign', display: 'Sign Sender', scopes: ['sign:envelope:send'] });
    const both = await makeService(rows, ['core', 'ats', 'sign']).getCatalog({ tenant_id: TENANT });
    expect(both.map((r) => r.key)).toEqual(['org_admin', 'recruiter', 'sign_sender', 'sign_viewer']);
    // The platform tier stays excluded regardless of entitlement.
    expect(both.some((r) => r.key === 'super_admin')).toBe(false);
  });

  it('orders by presentation tier then display', async () => {
    const svc = makeService([
      roleRow('recruiter', 'Recruiter — op', ['talent:read']),
      roleRow('tenant_owner', 'Tenant Owner — top', ['tenant:admin:user-manage']),
      roleRow('candidate', 'Candidate — portal', ['portal:profile:read']),
    ]);
    const out = await svc.getCatalog();
    expect(out.map((r) => r.key)).toEqual(['tenant_owner', 'recruiter', 'candidate']);
  });
});
