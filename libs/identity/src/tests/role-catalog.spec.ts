import { describe, expect, it } from 'vitest';

import {
  displayFromDescription,
  ROLE_CATALOG_META,
} from '../lib/role-catalog/role-catalog.view.js';
import { RoleCatalogService } from '../lib/role-catalog/role-catalog.service.js';
import { SEED_ROLE_KEYS } from '../lib/dto/index.js';

// Settings Rebuild Directive 5 — roles-catalog service + metadata.

function roleRow(key: string, description: string | null, scopes: string[]) {
  return {
    key,
    description,
    role_scopes: scopes.map((k) => ({ scope: { key: k } })),
  };
}

function makeService(rows: ReturnType<typeof roleRow>[]) {
  const findMany = async () => rows;
  return new RoleCatalogService({ role: { findMany } } as never);
}

describe('roles-catalog metadata', () => {
  it('every tenant SEED_ROLE_KEY (except super_admin) has catalog metadata', () => {
    for (const key of SEED_ROLE_KEYS) {
      if (key === 'super_admin') continue; // platform tier — excluded
      expect(ROLE_CATALOG_META[key], `meta for ${key}`).toBeDefined();
    }
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
