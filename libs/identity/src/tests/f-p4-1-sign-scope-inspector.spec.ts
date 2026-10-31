import { describe, expect, it, vi } from 'vitest';

import { IdentityDependencyInspector } from '../lib/privacy/identity-dependency-inspector.service.js';
import type { IdentityRetirementPort } from '../lib/privacy/identity-retirement.port.js';

// Retention and Purge directive (ebd41d99) W9 / finding F-P4-1 — the Sign deletion path
// never reads an ATS schema. Under the aramo_sign database role even to_regclass on
// documents."DocumentArtifact" raises "permission denied for schema documents", so the
// Sign scope must issue no query naming the documents schema at all. The default scope
// (platform-admin) is unchanged.

const USER = 'u-1';
const TENANT = 't-1';

function build(opts: { tenantHold: boolean; docHolds: number }) {
  const sqls: string[] = [];
  const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    sqls.push(`${sql} ${values.map(String).join(' ')}`);
    if (sql.includes('to_regclass')) return [{ present: true }];
    if (sql.includes('DocumentArtifact')) return [{ n: BigInt(opts.docHolds) }];
    return [{ n: 0n }];
  });
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ email: 'pat@gmail.com', tenant_id: TENANT })) },
    tenant: { findUnique: vi.fn(async () => ({ legal_hold: opts.tenantHold })) },
    userTenantMembership: { count: vi.fn(async () => 0) },
    externalIdentity: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    userTenantMembershipRole: { findMany: vi.fn(async () => []) },
    $queryRaw: queryRaw,
  };
  const entitlements = { getCapabilities: vi.fn(async () => new Set(['core', 'sign'])) };
  const pool: IdentityRetirementPort = {
    lookup: vi.fn(async () => ({ status: 'ok' as const, subject_found: true, linked_providers: 0, other_users_same_email: 0 })),
    retire: vi.fn(),
  };
  return { inspector: new IdentityDependencyInspector(prisma as never, entitlements as never, pool), sqls };
}

describe('F-P4-1 — IdentityDependencyInspector Sign scope', () => {
  it('sign scope issues no query against the documents schema', async () => {
    const { inspector, sqls } = build({ tenantHold: false, docHolds: 3 });
    const r = await inspector.inspect(USER, TENANT, { scope: 'sign' });
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.filter((s) => s.includes('documents'))).toEqual([]);
    expect(r.f_legal_hold).toEqual({ tenant: false, document_artifacts: 0 });
    expect(r.legal_hold).toBe(false);
  });

  it('sign scope still honors the identity Tenant legal hold', async () => {
    const { inspector, sqls } = build({ tenantHold: true, docHolds: 0 });
    const r = await inspector.inspect(USER, TENANT, { scope: 'sign' });
    expect(sqls.filter((s) => s.includes('documents'))).toEqual([]);
    expect(r).toMatchObject({ legal_hold: true, retire_identity: false, f_legal_hold: { tenant: true, document_artifacts: 0 } });
  });

  it('default scope is unchanged: it still reads the documents legal-hold count', async () => {
    const { inspector, sqls } = build({ tenantHold: false, docHolds: 2 });
    const r = await inspector.inspect(USER, TENANT);
    expect(sqls.some((s) => s.includes('documents'))).toBe(true);
    expect(r).toMatchObject({ legal_hold: true, f_legal_hold: { tenant: false, document_artifacts: 2 } });
  });

  it("explicit 'platform' scope behaves as the default", async () => {
    const { inspector, sqls } = build({ tenantHold: false, docHolds: 1 });
    const r = await inspector.inspect(USER, TENANT, { scope: 'platform' });
    expect(sqls.some((s) => s.includes('documents'))).toBe(true);
    expect(r.f_legal_hold.document_artifacts).toBe(1);
  });
});
