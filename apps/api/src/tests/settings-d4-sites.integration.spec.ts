import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';

import { AppModule } from '../app.module.js';

// Settings Rebuild Directive 4 — CRUD /v1/tenant/sites endpoint proof.
//
// Application-boundary proofs: the tenant:admin:sites scope-gate (200/403/401),
// tenant-scoping (no cross-tenant read/list/update/deactivate/delete), the full
// CRUD round-trip, the parent/child hierarchy + its guards (self / cycle /
// foreign-tenant parent / depth), validation (400 not 500), the hard-delete
// in-use guard (membership-referenced AND child-referenced both refuse), and
// the identity.site.{created,updated,deactivated} audit emits (no-op-no-audit).
// Migrations: entitlement (core) + identity init + site axis + site hierarchy.

type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');
const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const IDENTITY_INIT = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
);
// Domain-Enforcement P1 — additive Tenant.allowed_domain column.
const IDENTITY_ALLOWED_DOMAIN = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
);
// Domain-Enforcement P2b — additive Tenant domain-verification columns.
const IDENTITY_DOMAIN_VERIFICATION = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260626000000_add_tenant_domain_verification/migration.sql',
);
const IDENTITY_SLUG = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260626120000_add_tenant_slug/migration.sql',
);
// Subdomain-Identity Directive B — additive Tenant.identity_provider column.
const IDENTITY_IDP = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
);
const IDENTITY_INVITATION_MIG = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
);
const IDENTITY_SITE_AXIS = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
);
const IDENTITY_SITE_HIERARCHY = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260620000000_add_site_hierarchy/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-settings-d4-spec';
const ALG = 'RS256';

const TENANT_A = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const TENANT_B = '22222222-0000-7000-8000-bbbbbbbbbbbb';
const ADMIN_A = '00000000-0000-7000-8000-00000000aaa1';
const RECRUITER_A = '00000000-0000-7000-8000-00000000aaa2';
const ADMIN_B = '00000000-0000-7000-8000-00000000bbb1';
const MEMBER_USER = '00000000-0000-7000-8000-00000000aaa3';

interface SiteBody {
  id: string;
  name: string;
  is_active: boolean;
  parent_site_id: string | null;
  created_at: string;
  updated_at: string;
  [k: string]: unknown;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Settings Rebuild D4 — CRUD /v1/tenant/sites',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let db: Client;
    let adminAJwt: string;
    let recruiterAJwt: string;
    let adminBJwt: string;

    function signJwt(
      key: SignKey,
      args: { sub: string; tenant_id: string; scopes: string[] },
    ): Promise<string> {
      return new SignJWT({
        sub: args.sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: args.tenant_id,
        scopes: args.scopes,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(key);
    }

    async function req(
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      path: string,
      jwt: string,
      body?: unknown,
    ): Promise<{ status: number; body: SiteBody }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${jwt}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const parsed =
        res.status >= 200 && res.status < 300 && res.status !== 204
          ? ((await res.json()) as SiteBody)
          : ({} as SiteBody);
      return { status: res.status, body: parsed };
    }

    async function list(jwt: string): Promise<SiteBody[]> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/sites`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const json = (await res.json()) as { items: SiteBody[] };
      return json.items;
    }

    async function auditCount(
      tenantId: string,
      eventType: string,
    ): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM identity."IdentityAuditEvent"
         WHERE event_type = $2 AND tenant_id = $1::uuid`,
        [tenantId, eventType],
      );
      return r.rows[0].n as number;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();

      for (const p of [
        ENTITLEMENT_INIT,
        IDENTITY_INIT,
        IDENTITY_ALLOWED_DOMAIN, IDENTITY_DOMAIN_VERIFICATION, IDENTITY_SLUG, IDENTITY_IDP,
        IDENTITY_INVITATION_MIG,
        IDENTITY_SITE_AXIS,
        IDENTITY_SITE_HIERARCHY,
      ]) {
        await db.query(readFileSync(p, 'utf8'));
      }
      for (const t of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
           VALUES ($1::uuid, 'core') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [t],
        );
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, is_active, created_at, updated_at)
           VALUES ($1::uuid, $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
          [t, t === TENANT_A ? 'Astre A' : 'Tenant B'],
        );
      }
      // A user + membership in tenant A — used by the membership-referenced
      // hard-delete guard test.
      await db.query(
        `INSERT INTO identity."User" (id, email, is_active, created_at, updated_at)
         VALUES ($1::uuid, $2, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
        [MEMBER_USER, 'member@astre.test'],
      );

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey = kp.privateKey as SignKey;

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      adminAJwt = await signJwt(privateKey, {
        sub: ADMIN_A,
        tenant_id: TENANT_A,
        scopes: ['tenant:admin:sites'],
      });
      recruiterAJwt = await signJwt(privateKey, {
        sub: RECRUITER_A,
        tenant_id: TENANT_A,
        scopes: ['requisition:read'],
      });
      adminBJwt = await signJwt(privateKey, {
        sub: ADMIN_B,
        tenant_id: TENANT_B,
        scopes: ['tenant:admin:sites'],
      });

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    // ── scope-gate ──
    it('401 — no token', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/sites`);
      expect(res.status).toBe(401);
    });
    it('403 — principal lacking tenant:admin:sites', async () => {
      const { status } = await req('GET', '/v1/tenant/sites', recruiterAJwt);
      expect(status).toBe(403);
    });

    // ── create + list + get + audit ──
    it('POST 201 — creates a root branch and emits exactly one site.created', async () => {
      const before = await auditCount(TENANT_A, 'identity.site.created');
      const { status, body } = await req('POST', '/v1/tenant/sites', adminAJwt, {
        name: 'London HQ',
      });
      expect(status).toBe(201);
      expect(body.name).toBe('London HQ');
      expect(body.is_active).toBe(true);
      expect(body.parent_site_id).toBeNull();
      expect(await auditCount(TENANT_A, 'identity.site.created')).toBe(before + 1);
    });

    it('GET list + GET one — the created site is readable by its tenant', async () => {
      const items = await list(adminAJwt);
      expect(items.map((s) => s.name)).toContain('London HQ');
      const hq = items.find((s) => s.name === 'London HQ') as SiteBody;
      const { status, body } = await req(
        'GET',
        `/v1/tenant/sites/${hq.id}`,
        adminAJwt,
      );
      expect(status).toBe(200);
      expect(body.id).toBe(hq.id);
    });

    it('POST 400 — duplicate name in the same tenant is rejected', async () => {
      const { status } = await req('POST', '/v1/tenant/sites', adminAJwt, {
        name: 'London HQ',
      });
      expect(status).toBe(400);
    });

    // ── hierarchy ──
    it('POST 201 — creates a child branch under the HQ parent', async () => {
      const hq = (await list(adminAJwt)).find(
        (s) => s.name === 'London HQ',
      ) as SiteBody;
      const { status, body } = await req('POST', '/v1/tenant/sites', adminAJwt, {
        name: 'London — Canary Wharf',
        parent_site_id: hq.id,
      });
      expect(status).toBe(201);
      expect(body.parent_site_id).toBe(hq.id);
    });

    it('POST 400 — parent in another tenant is not found (no cross-tenant parent)', async () => {
      // Create a site in tenant B, then try to parent an A-site under it.
      const { body: bSite } = await req('POST', '/v1/tenant/sites', adminBJwt, {
        name: 'B Root',
      });
      const { status } = await req('POST', '/v1/tenant/sites', adminAJwt, {
        name: 'A under B',
        parent_site_id: bSite.id,
      });
      expect(status).toBe(400);
    });

    it('PATCH 400 — a site cannot be its own parent', async () => {
      const hq = (await list(adminAJwt)).find(
        (s) => s.name === 'London HQ',
      ) as SiteBody;
      const { status } = await req(
        'PATCH',
        `/v1/tenant/sites/${hq.id}`,
        adminAJwt,
        { parent_site_id: hq.id },
      );
      expect(status).toBe(400);
    });

    it('PATCH 400 — reparenting a parent under its own child is a cycle', async () => {
      const items = await list(adminAJwt);
      const hq = items.find((s) => s.name === 'London HQ') as SiteBody;
      const child = items.find(
        (s) => s.name === 'London — Canary Wharf',
      ) as SiteBody;
      const { status } = await req(
        'PATCH',
        `/v1/tenant/sites/${hq.id}`,
        adminAJwt,
        { parent_site_id: child.id },
      );
      expect(status).toBe(400);
    });

    // ── update round-trip + no-op-no-audit ──
    it('PATCH 200 — rename persists and emits exactly one site.updated', async () => {
      const items = await list(adminAJwt);
      const child = items.find(
        (s) => s.name === 'London — Canary Wharf',
      ) as SiteBody;
      const before = await auditCount(TENANT_A, 'identity.site.updated');
      const { status, body } = await req(
        'PATCH',
        `/v1/tenant/sites/${child.id}`,
        adminAJwt,
        { name: 'London — Docklands' },
      );
      expect(status).toBe(200);
      expect(body.name).toBe('London — Docklands');
      expect(await auditCount(TENANT_A, 'identity.site.updated')).toBe(before + 1);
    });

    it('PATCH no-op (same name) emits NO new audit event', async () => {
      const child = (await list(adminAJwt)).find(
        (s) => s.name === 'London — Docklands',
      ) as SiteBody;
      const before = await auditCount(TENANT_A, 'identity.site.updated');
      const { status } = await req(
        'PATCH',
        `/v1/tenant/sites/${child.id}`,
        adminAJwt,
        { name: 'London — Docklands' },
      );
      expect(status).toBe(200);
      expect(await auditCount(TENANT_A, 'identity.site.updated')).toBe(before);
    });

    // ── deactivate / reactivate ──
    it('POST deactivate — flips is_active and emits site.deactivated (idempotent)', async () => {
      const child = (await list(adminAJwt)).find(
        (s) => s.name === 'London — Docklands',
      ) as SiteBody;
      const before = await auditCount(TENANT_A, 'identity.site.deactivated');
      const first = await req(
        'POST',
        `/v1/tenant/sites/${child.id}/deactivate`,
        adminAJwt,
      );
      expect(first.status).toBe(200);
      expect(first.body.is_active).toBe(false);
      expect(await auditCount(TENANT_A, 'identity.site.deactivated')).toBe(
        before + 1,
      );
      // Idempotent re-deactivate → no new audit.
      await req('POST', `/v1/tenant/sites/${child.id}/deactivate`, adminAJwt);
      expect(await auditCount(TENANT_A, 'identity.site.deactivated')).toBe(
        before + 1,
      );
      // Reactivate restores it.
      const re = await req(
        'POST',
        `/v1/tenant/sites/${child.id}/reactivate`,
        adminAJwt,
      );
      expect(re.status).toBe(200);
      expect(re.body.is_active).toBe(true);
    });

    // ── hard-delete guard ──
    it('DELETE 400 — a parent with child branches cannot be hard-deleted', async () => {
      const hq = (await list(adminAJwt)).find(
        (s) => s.name === 'London HQ',
      ) as SiteBody;
      const { status } = await req(
        'DELETE',
        `/v1/tenant/sites/${hq.id}`,
        adminAJwt,
      );
      expect(status).toBe(400);
    });

    it('DELETE 400 — a site referenced by a membership cannot be hard-deleted', async () => {
      const { body: site } = await req('POST', '/v1/tenant/sites', adminAJwt, {
        name: 'Referenced Branch',
      });
      await db.query(
        `INSERT INTO identity."UserTenantMembership"
           (id, user_id, tenant_id, site_id, is_active, joined_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, true, now(), now(), now())`,
        [MEMBER_USER, TENANT_A, site.id],
      );
      const { status } = await req(
        'DELETE',
        `/v1/tenant/sites/${site.id}`,
        adminAJwt,
      );
      expect(status).toBe(400);
      // It is still present (not orphaned) and can be deactivated instead.
      const deact = await req(
        'POST',
        `/v1/tenant/sites/${site.id}/deactivate`,
        adminAJwt,
      );
      expect(deact.status).toBe(200);
      expect(deact.body.is_active).toBe(false);
    });

    it('DELETE 204 — an unused site is hard-deleted', async () => {
      const { body: site } = await req('POST', '/v1/tenant/sites', adminAJwt, {
        name: 'Throwaway Branch',
      });
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/sites/${site.id}`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${adminAJwt}` } },
      );
      expect(res.status).toBe(204);
      const after = await req('GET', `/v1/tenant/sites/${site.id}`, adminAJwt);
      expect(after.status).toBe(404);
    });

    // ── validation (400 not 500) ──
    it('400 — empty name', async () => {
      const { status } = await req('POST', '/v1/tenant/sites', adminAJwt, {
        name: '   ',
      });
      expect(status).toBe(400);
    });
    it('400 — unknown field', async () => {
      const { status } = await req('POST', '/v1/tenant/sites', adminAJwt, {
        name: 'X',
        color: 'blue',
      });
      expect(status).toBe(400);
    });
    it('400 — malformed parent_site_id', async () => {
      const { status } = await req('POST', '/v1/tenant/sites', adminAJwt, {
        name: 'Y',
        parent_site_id: 'not-a-uuid',
      });
      expect(status).toBe(400);
    });

    // ── tenant-scoping (no cross-tenant read/list/update) ──
    it('tenant B never sees tenant A sites in its list', async () => {
      const bItems = await list(adminBJwt);
      expect(bItems.map((s) => s.name)).not.toContain('London HQ');
      expect(bItems.map((s) => s.name)).toContain('B Root');
    });
    it('tenant B GET on a tenant A site → 404 (cross-tenant is invisible)', async () => {
      const hq = (await list(adminAJwt)).find(
        (s) => s.name === 'London HQ',
      ) as SiteBody;
      const { status } = await req(
        'GET',
        `/v1/tenant/sites/${hq.id}`,
        adminBJwt,
      );
      expect(status).toBe(404);
    });
    it("tenant B PATCH on a tenant A site → 404 (cannot write across tenants)", async () => {
      const hq = (await list(adminAJwt)).find(
        (s) => s.name === 'London HQ',
      ) as SiteBody;
      const { status } = await req(
        'PATCH',
        `/v1/tenant/sites/${hq.id}`,
        adminBJwt,
        { name: 'hijacked' },
      );
      expect(status).toBe(404);
      // A's site is unchanged.
      const a = await req('GET', `/v1/tenant/sites/${hq.id}`, adminAJwt);
      expect(a.body.name).toBe('London HQ');
    });
  },
);
