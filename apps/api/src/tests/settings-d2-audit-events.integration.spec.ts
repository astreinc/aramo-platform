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

// Settings Rebuild Directive 2 — GET /v1/tenant/audit-events endpoint proof.
//
// The application-boundary proofs the lib-level specs cannot reach: the
// audit:read scope-gate (200/403/401), tenant-scoping (no cross-tenant leak),
// every filter (actor / event_type / date-range / subject), keyset pagination,
// and end-to-end redaction. Migrations kept minimal: entitlement (the
// EntitlementGuard's `core` read) + identity (User + IdentityAuditEvent).

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
const IDENTITY_INVITATION_MIG = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
);
// Settings Rebuild D3 — additive tenant-profile columns (Prisma SELECTs them).
const IDENTITY_PROFILE = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-settings-d2-spec';
const ALG = 'RS256';

const TENANT_A = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const TENANT_B = '22222222-0000-7000-8000-bbbbbbbbbbbb';
const ADMIN_A = '00000000-0000-7000-8000-00000000aaa1';
const RECRUITER_A = '00000000-0000-7000-8000-00000000aaa2';
const ADMIN_B = '00000000-0000-7000-8000-00000000bbb1';

// Actors (Users) — actor display resolution reads identity."User".
const U1 = '30000000-0000-7000-8000-000000000001';
const U2 = '30000000-0000-7000-8000-000000000002';
const UB = '30000000-0000-7000-8000-0000000000b1';

// Subjects.
const S1 = '40000000-0000-7000-8000-000000000001';
const S2 = '40000000-0000-7000-8000-000000000002';
const S3 = '40000000-0000-7000-8000-000000000003';

// Events (ids are time-ordered; created_at ascending E1..E5).
const E1 = '50000000-0000-7000-8000-000000000001';
const E2 = '50000000-0000-7000-8000-000000000002';
const E3 = '50000000-0000-7000-8000-000000000003';
const E4 = '50000000-0000-7000-8000-000000000004';
const E5 = '50000000-0000-7000-8000-000000000005';
const EB1 = '50000000-0000-7000-8000-0000000000b1';

interface ViewRow {
  id: string;
  event_type: string;
  actor: { id: string | null; type: string; display: string };
  subject_id: string;
  detail: string;
  category: string;
  created_at: string;
}
interface ViewBody {
  items: ViewRow[];
  next_cursor: string | null;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Settings Rebuild D2 — GET /v1/tenant/audit-events',
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

    async function signJwt(
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

    async function get(
      jwt: string,
      query = '',
    ): Promise<{ status: number; body: ViewBody }> {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/audit-events${query}`,
        { headers: { Authorization: `Bearer ${jwt}` } },
      );
      const body = res.status === 200 ? ((await res.json()) as ViewBody) : ({ items: [], next_cursor: null } as ViewBody);
      return { status: res.status, body };
    }

    async function insertUser(id: string, name: string): Promise<void> {
      await db.query(
        `INSERT INTO identity."User" (id, email, display_name, is_active, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, true, now(), now()) ON CONFLICT (id) DO NOTHING`,
        [id, `${name.replace(/\s/g, '.').toLowerCase()}@x.com`, name],
      );
    }

    async function insertEvent(args: {
      id: string;
      tenant_id: string | null;
      actor_id: string | null;
      actor_type: string;
      event_type: string;
      subject_id: string;
      payload: Record<string, unknown>;
      created_at: string;
    }): Promise<void> {
      await db.query(
        `INSERT INTO identity."IdentityAuditEvent"
           (id, tenant_id, actor_id, actor_type, event_type, subject_id, event_payload, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::jsonb, $8::timestamptz)`,
        [
          args.id,
          args.tenant_id,
          args.actor_id,
          args.actor_type,
          args.event_type,
          args.subject_id,
          JSON.stringify(args.payload),
          args.created_at,
        ],
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();

      for (const p of [ENTITLEMENT_INIT, IDENTITY_INIT, IDENTITY_ALLOWED_DOMAIN, IDENTITY_DOMAIN_VERIFICATION, IDENTITY_INVITATION_MIG, IDENTITY_PROFILE]) {
        await db.query(readFileSync(p, 'utf8'));
      }
      // Both tenants hold `core` (the audit controller's class capability).
      for (const t of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
           VALUES ($1::uuid, 'core') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [t],
        );
      }

      await insertUser(U1, 'Alice Admin');
      await insertUser(U2, 'Bob Owner');
      await insertUser(UB, 'Carol Other');

      // TENANT_A trail (E1..E5, ascending created_at → most-recent-first = E5..E1).
      await insertEvent({ id: E1, tenant_id: TENANT_A, actor_id: U1, actor_type: 'user', event_type: 'identity.session.issued', subject_id: S1, payload: {}, created_at: '2026-06-01T00:00:00.000Z' });
      await insertEvent({ id: E2, tenant_id: TENANT_A, actor_id: U1, actor_type: 'user', event_type: 'identity.tenant_user.role_assigned', subject_id: S2, payload: { role_keys: ['recruiter'] }, created_at: '2026-06-02T00:00:00.000Z' });
      await insertEvent({ id: E3, tenant_id: TENANT_A, actor_id: U2, actor_type: 'user', event_type: 'identity.tenant_setting.updated', subject_id: TENANT_A, payload: { key: 'audit.financials_enabled', value: true, previous_value: false }, created_at: '2026-06-03T00:00:00.000Z' });
      await insertEvent({ id: E4, tenant_id: TENANT_A, actor_id: U2, actor_type: 'user', event_type: 'identity.team.created', subject_id: S3, payload: {}, created_at: '2026-06-04T00:00:00.000Z' });
      await insertEvent({ id: E5, tenant_id: TENANT_A, actor_id: U1, actor_type: 'user', event_type: 'identity.session.issued', subject_id: S1, payload: {}, created_at: '2026-06-05T00:00:00.000Z' });
      // TENANT_B event — newer than all of A; must NEVER appear for A.
      await insertEvent({ id: EB1, tenant_id: TENANT_B, actor_id: UB, actor_type: 'user', event_type: 'identity.session.issued', subject_id: S1, payload: {}, created_at: '2026-06-10T00:00:00.000Z' });

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      const privateKey = kp.privateKey as SignKey;

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      // admin A holds audit:read but NOT compensation:view:bill → financial
      // setting values are redacted for them (the redaction proof).
      adminAJwt = await signJwt(privateKey, { sub: ADMIN_A, tenant_id: TENANT_A, scopes: ['audit:read'] });
      recruiterAJwt = await signJwt(privateKey, { sub: RECRUITER_A, tenant_id: TENANT_A, scopes: ['requisition:read'] });
      adminBJwt = await signJwt(privateKey, { sub: ADMIN_B, tenant_id: TENANT_B, scopes: ['audit:read'] });

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
    it('401 — no bearer token', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/tenant/audit-events`);
      expect(res.status).toBe(401);
    });
    it('403 — principal lacking audit:read', async () => {
      const { status } = await get(recruiterAJwt);
      expect(status).toBe(403);
    });
    it('200 — tenant_admin holding audit:read', async () => {
      const { status } = await get(adminAJwt);
      expect(status).toBe(200);
    });

    // ── tenant-scoping (no cross-tenant leak) ──
    it('returns ONLY the caller tenant trail, most-recent-first', async () => {
      const { body } = await get(adminAJwt);
      expect(body.items.map((r) => r.id)).toEqual([E5, E4, E3, E2, E1]);
      // tenant B's (newer) event is absent.
      expect(body.items.some((r) => r.id === EB1)).toBe(false);
    });
    it('a tenant_admin in B never sees tenant A events', async () => {
      const { body } = await get(adminBJwt);
      expect(body.items.map((r) => r.id)).toEqual([EB1]);
    });

    // ── filters (compose AND) ──
    it('filters by event_type', async () => {
      const { body } = await get(adminAJwt, '?event_type=identity.session.issued');
      expect(body.items.map((r) => r.id)).toEqual([E5, E1]);
    });
    it('filters by actor', async () => {
      const { body } = await get(adminAJwt, `?actor_id=${U2}`);
      expect(body.items.map((r) => r.id)).toEqual([E4, E3]);
    });
    it('filters by date range (from/to)', async () => {
      const from = await get(adminAJwt, '?from=2026-06-03T00:00:00.000Z');
      expect(from.body.items.map((r) => r.id)).toEqual([E5, E4, E3]);
      const to = await get(adminAJwt, '?to=2026-06-02T23:59:59.000Z');
      expect(to.body.items.map((r) => r.id)).toEqual([E2, E1]);
    });
    it('filters by subject/entity', async () => {
      const { body } = await get(adminAJwt, `?subject_id=${S1}`);
      expect(body.items.map((r) => r.id)).toEqual([E5, E1]);
    });
    it('rejects an unknown event_type filter with 400', async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/tenant/audit-events?event_type=not.real`,
        { headers: { Authorization: `Bearer ${adminAJwt}` } },
      );
      expect(res.status).toBe(400);
    });

    // ── keyset pagination ──
    it('paginates by keyset cursor without skips or duplicates', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let guard = 10;
      do {
        const q = `?limit=2${cursor !== null ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const { body }: { body: ViewBody } = await get(adminAJwt, q);
        seen.push(...body.items.map((r) => r.id));
        cursor = body.next_cursor;
      } while (cursor !== null && guard-- > 0);
      expect(seen).toEqual([E5, E4, E3, E2, E1]);
      expect(new Set(seen).size).toBe(5);
    });

    // ── readable detail + redaction ──
    it('renders a human-readable detail (not raw JSON)', async () => {
      const { body } = await get(adminAJwt, `?event_type=identity.tenant_user.role_assigned`);
      expect(body.items[0]?.detail).toBe('Assigned role(s): recruiter');
      expect(body.items[0]?.actor.display).toBe('Alice Admin');
    });
    it('REDACTS financial setting values from a viewer lacking the gating scope', async () => {
      const { body } = await get(adminAJwt, '?event_type=identity.tenant_setting.updated');
      expect(body.items[0]?.detail).toContain('values hidden');
      expect(body.items[0]?.detail).not.toContain('true');
    });
  },
);
