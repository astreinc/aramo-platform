import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_ROLES, CCP_ROLES, startD4, type D4Harness } from './support/ccp-d4-harness.js';
import { tenant } from './support/ccp-d4-scenarios.js';

// CCP-D4 (PBD §5.4 row D4) — the RE-RUN of the CCP-A1 per-role `platform:tenant:read`
// allowed/refused matrix (A1 schedule §4.2.1; A0-C5), at program level: the same 6 allowed and 10
// refused routes as apps/platform-admin/src/tests/ccp-a1-platform-role-authorization.spec.ts, but
// through the REAL platform-admin AppModule on the fully migrated program schema with NO resolver
// and NO service stubs — each principal's scopes come from the seeded identity RBAC rows, and the
// allowed routes are answered by the real services. super_admin is the control.

const ENTRY = 'platform:tenant:read';
let T = '';
type Route = { id: string; method: 'GET' | 'POST'; path: string; scope: string };
const at = (r: Route): string => r.path.replace(':tenant_id', T);
const ALLOWED: Route[] = [
  { id: 'R-1', method: 'GET', path: '/platform/me', scope: ENTRY },
  { id: 'R-2', method: 'GET', path: '/platform/tenants', scope: ENTRY },
  { id: 'R-3', method: 'GET', path: '/platform/dashboard', scope: ENTRY },
  { id: 'R-4', method: 'GET', path: '/platform/tenants/:tenant_id', scope: ENTRY },
  { id: 'R-5', method: 'GET', path: '/platform/tenants/:tenant_id/audit', scope: ENTRY },
  { id: 'R-6', method: 'GET', path: '/platform/tenants/:tenant_id/sign', scope: ENTRY },
];
const REFUSED: Route[] = [
  { id: 'provision-1', method: 'POST', path: '/platform/tenants', scope: 'platform:tenant:provision' },
  { id: 'provision-2', method: 'POST', path: '/platform/tenants/:tenant_id/invitations', scope: 'platform:tenant:provision' },
  { id: 'provision-3', method: 'POST', path: '/platform/tenants/:tenant_id/resend-owner-invite', scope: 'platform:tenant:provision' },
  { id: 'lifecycle-1', method: 'POST', path: '/platform/tenants/:tenant_id/suspend', scope: 'platform:tenant:lifecycle:manage' },
  { id: 'lifecycle-2', method: 'POST', path: '/platform/tenants/:tenant_id/reactivate', scope: 'platform:tenant:lifecycle:manage' },
  { id: 'lifecycle-3', method: 'POST', path: '/platform/tenants/:tenant_id/start-offboarding', scope: 'platform:tenant:lifecycle:manage' },
  { id: 'lifecycle-4', method: 'POST', path: '/platform/tenants/:tenant_id/close', scope: 'platform:tenant:lifecycle:manage' },
  { id: 'lifecycle-5', method: 'GET', path: '/platform/tenants/:tenant_id/domain', scope: 'platform:tenant:lifecycle:manage' },
  { id: 'lifecycle-6', method: 'GET', path: '/platform/personal-review', scope: 'platform:tenant:lifecycle:manage' },
  { id: 'admin-invite', method: 'POST', path: '/platform/admins/invitations', scope: 'platform:admin:invite' },
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-D4 re-run of the CCP-A1 per-role platform:tenant:read matrix (real AppModule, real RBAC, real Postgres)', { timeout: 120_000 }, () => {
  let h: D4Harness;
  const tenantState = async () => JSON.stringify((await h.pg.query(`SELECT * FROM identity."Tenant" WHERE id = $1`, [T])).rows);

  beforeAll(async () => {
    h = await startD4();
    T = await tenant(h, 'A1 matrix tenant');
  }, 600_000);
  afterAll(async () => {
    await h?.stop();
  }, 120_000);

  it('the live role catalog: each of the 6 CCP roles holds platform:tenant:read and none of provision / lifecycle / admin invite; super_admin holds all of them', async () => {
    for (const role of ALL_ROLES) {
      const scopes = (
        await h.pg.query(`SELECT s.key FROM identity."RoleScope" rs JOIN identity."Role" r ON r.id = rs.role_id JOIN identity."Scope" s ON s.id = rs.scope_id WHERE r.key = $1`, [role])
      ).rows.map((r) => r.key as string);
      expect(scopes, role).toContain(ENTRY);
      for (const r of REFUSED) expect(scopes.includes(r.scope), `${role} ${r.scope}`).toBe(role === 'super_admin');
    }
  });

  for (const role of CCP_ROLES) {
    describe(`${role} (exactly one role)`, () => {
      for (const r of ALLOWED) {
        it(`allowed — ${r.id} ${r.method} ${r.path} → 200`, async () => {
          const res = await h.call(role, r.method, at(r));
          expect(res.status, JSON.stringify(res.body)).toBe(200);
        });
      }
      for (const r of REFUSED) {
        it(`refused — ${r.id} ${r.method} ${r.path} → 403 (missing ${r.scope}); nothing changes`, async () => {
          const before = await tenantState();
          const res = await h.call(role, r.method, at(r), {});
          expect(res.status).toBe(403);
          expect(res.body?.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
          expect(res.body?.error?.details?.missing_scopes).toEqual([r.scope]);
          expect(await tenantState()).toBe(before);
        });
      }
    });
  }

  describe('super_admin (control — unchanged by CCP)', () => {
    for (const r of ALLOWED) {
      it(`allowed — ${r.id} ${r.method} → 200`, async () => {
        const res = await h.call('super_admin', r.method, at(r));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      });
    }
    for (const r of REFUSED) {
      it(`admitted by the guard — ${r.id} ${r.method} (holds ${r.scope}; not refused at the gate)`, async () => {
        // Bodies are empty, so the handler may refuse 400/404/409; the gate must not (no missing_scopes).
        const res = await h.call('super_admin', r.method, at(r), {});
        expect(res.body?.error?.details?.missing_scopes, JSON.stringify(res.body)).toBeUndefined();
      });
    }
  });
});
