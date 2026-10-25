import { describe, expect, it } from 'vitest';

import {
  displayFromDescription,
  ROLE_CATALOG_META,
} from '../lib/role-catalog/role-catalog.view.js';
import { RoleCatalogService } from '../lib/role-catalog/role-catalog.service.js';
import { ESIGN_PRODUCT_ROLE_KEYS, PLATFORM_ROLE_KEYS, SEED_ROLE_KEYS } from '../lib/dto/index.js';

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
  it('every tenant SEED_ROLE_KEY (except the platform tier) has catalog metadata — the E-Sign product roles included (IC-3 PR-8)', () => {
    for (const key of SEED_ROLE_KEYS) {
      // Platform tier (PLATFORM_ROLE_KEYS: super_admin + the 6 CCP A1 platform roles) — excluded.
      if ((PLATFORM_ROLE_KEYS as readonly string[]).includes(key)) continue;
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
      roleRow('tenant_admin', 'Tenant Admin — org', ['tenant:admin:user-manage']),
      roleRow('recruiter', 'Recruiter — op', ['talent:read']),
      roleRow('super_admin', 'Super Admin — platform', ['platform:tenant:provision']),
    ];
    const signOnly = await makeService(rows, ['core', 'sign']).getCatalog({ tenant_id: TENANT });
    expect(signOnly.map((r) => r.key)).toEqual(['tenant_admin', 'recruiter', 'sign_sender', 'sign_viewer']);
    expect(signOnly.find((r) => r.key === 'sign_sender')).toMatchObject({ tier: 'Sign', display: 'Sign Sender', scopes: ['sign:envelope:send'] });
    const both = await makeService(rows, ['core', 'ats', 'sign']).getCatalog({ tenant_id: TENANT });
    expect(both.map((r) => r.key)).toEqual(['tenant_admin', 'recruiter', 'sign_sender', 'sign_viewer']);
    // The platform tier stays excluded regardless of entitlement.
    expect(both.some((r) => r.key === 'super_admin')).toBe(false);
  });

  // ROLES-1 PR-2 (§3.5) — the organization roles hold Sign scopes but are never hidden
  // by the Sign partition rule; for a tenant without `sign` their projected scope list
  // omits sign:* (display mirrors the session filters).
  it('never hides the organization roles (they hold Sign scopes) — ATS-only tenants see them without sign:* scopes', async () => {
    const rows = [
      roleRow('tenant_owner', 'Tenant Owner — owner', ['tenant:admin:user-manage', 'talent:read', 'sign:billing:manage', 'sign:envelope:send']),
      roleRow('tenant_admin', 'Tenant Admin — admin', ['tenant:admin:user-manage', 'talent:read', 'sign:envelope:send']),
      roleRow('ats_admin', 'ATS Admin — ats', ['talent:read']),
      roleRow('sign_admin', 'Sign Admin — sign', ['sign:member:manage']),
    ];
    const atsOnly = await makeService(rows, ['core', 'ats']).getCatalog({ tenant_id: TENANT });
    expect(atsOnly.map((r) => r.key).sort()).toEqual(['ats_admin', 'tenant_admin', 'tenant_owner']);
    expect(atsOnly.find((r) => r.key === 'tenant_owner')?.scopes).toEqual(['talent:read', 'tenant:admin:user-manage']);
    const signOnly = await makeService(rows, ['core', 'sign']).getCatalog({ tenant_id: TENANT });
    expect(signOnly.find((r) => r.key === 'tenant_owner')?.scopes).toEqual(['sign:billing:manage', 'sign:envelope:send', 'talent:read', 'tenant:admin:user-manage']);
    expect(signOnly.map((r) => r.key)).toContain('sign_admin');
  });

  it('reads ACTIVE roles only (the deactivated sign_owner row is never projected)', async () => {
    let where: unknown;
    const svc = new RoleCatalogService(
      { role: { findMany: async (args: { where?: unknown }) => ((where = args.where), []) } } as never,
      { getCapabilities: async () => new Set<string>(['core', 'sign']) } as never,
    );
    await svc.getCatalog({ tenant_id: TENANT });
    expect(where).toEqual({ is_active: true });
  });

  // ROLES-1 PR-3 — the catalog omits the retired sign_owner by key as well (an
  // environment where the row were somehow still active never offers it).
  it('omits the retired sign_owner key even if its row were active; the Sign tier is Admin / Sender / Viewer', async () => {
    const out = await makeService(
      [
        roleRow('sign_owner', 'Sign Owner — retired', ['sign:billing:manage', 'sign:member:manage']),
        roleRow('sign_admin', 'Sign Admin — sign', ['sign:member:manage']),
        roleRow('sign_viewer', 'Sign Viewer — read', ['sign:envelope:read']),
      ],
      ['core', 'sign'],
    ).getCatalog({ tenant_id: TENANT });
    expect(out.map((r) => r.key).sort()).toEqual(['sign_admin', 'sign_viewer']);
    expect(ROLE_CATALOG_META['sign_owner']).toBeUndefined();
    expect([...ESIGN_PRODUCT_ROLE_KEYS].sort()).toEqual(['sign_admin', 'sign_sender', 'sign_viewer']);
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
