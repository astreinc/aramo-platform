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
import { v7 as uuidv7 } from 'uuid';

import { AppModule } from '../app.module.js';

// TR-2a-3 — the privileged advisory-resolution HTTP surface (real Postgres 17).
// Boots the AppModule + applies the identity/entitlement/talent_trust schemas,
// seeds same-human advisories directly, and drives approve / dismiss / reverse
// over HTTP with signed JWTs. Proves: the identity:resolve authz gate (R6), the
// contradiction override (R3), the lifecycle + audit (R4/R5), and tenant-scoping.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');

const MIGRATIONS = [
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
  'libs/identity/prisma/migrations/20260709130000_add_tenant_lifecycle_status/migration.sql',
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  // Slice-B1 — the regenerated talent_trust client SELECTs ResolutionSubject
  // .last_reconciled_at + reconcile_attempts on every subject read (merge/
  // unmerge), so the columns must exist or the advisory endpoints 500.
  'libs/talent-trust/prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  // TR-2a-B1 — SubjectAnchor.source_class + extended (…, source_class) unique
  // key. The regenerated client SELECTs source_class on anchor reads.
  'libs/talent-trust/prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  // TR-2a-B2 — SubjectMatchAdvisory reopen provenance (client selects reopened_at).
  'libs/talent-trust/prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
  // TR-2a-B3b — SubjectMergeOperation. The /approve endpoint now runs phase 2
  // (the record reconcile) after the subject merge; even the neither-promoted case
  // (these advisories carry no ATS_TALENT_RECORD ref) creates a completed no-op
  // operation record, so the table must exist or reconcile 500s.
  'libs/talent-trust/prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
  'libs/talent-trust/prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
  'libs/talent-trust/prisma/migrations/20260712120000_tr8_b1_verified_control_stale/migration.sql',
  'libs/talent-trust/prisma/migrations/20260713120000_tr12_b1_verification_proposal/migration.sql',
].map((p) => resolve(ROOT, p));

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-tr2a3-advisory-spec';
const ALG = 'RS256';

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';
const ADMIN = '00000000-0000-7000-8000-00000000a001';
const RESOLVE_SCOPE = 'identity:resolve';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-2a-3 — advisory-resolution HTTP surface (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let db: Client;
    let privateKey: SignKey;

    async function signJwt(scopes: string[], tenant = TENANT_A): Promise<string> {
      return new SignJWT({
        sub: ADMIN,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: tenant,
        scopes,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }

    async function post(
      path: string,
      jwt: string,
      body: unknown,
    ): Promise<{ status: number; json: () => Promise<unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, json: () => res.json() };
    }

    async function get(
      path: string,
      jwt: string,
    ): Promise<{ status: number; json: () => Promise<unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      return { status: res.status, json: () => res.json() };
    }

    async function subjectStatus(id: string): Promise<{ status: string; merged_into: string | null }> {
      const r = await db.query(
        `SELECT status, merged_into_subject_id FROM talent_trust."ResolutionSubject" WHERE id = $1::uuid`,
        [id],
      );
      return { status: r.rows[0].status, merged_into: r.rows[0].merged_into_subject_id };
    }

    async function advisoryStatus(id: string): Promise<string> {
      const r = await db.query(
        `SELECT status FROM talent_trust."SubjectMatchAdvisory" WHERE id = $1::uuid`,
        [id],
      );
      return r.rows[0].status;
    }

    // Seed two ACTIVE subjects + a PENDING_REVIEW advisory (canonical a<b). Returns ids.
    async function seedAdvisory(
      tenant: string,
      opts: { contradiction?: boolean } = {},
    ): Promise<{ advisoryId: string; a: string; b: string }> {
      const s1 = uuidv7();
      const s2 = uuidv7();
      const [a, b] = s1 < s2 ? [s1, s2] : [s2, s1];
      for (const id of [a, b]) {
        await db.query(
          `INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at)
           VALUES ($1::uuid, $2::uuid, 'ACTIVE', CURRENT_TIMESTAMP)`,
          [id, tenant],
        );
      }
      const advisoryId = uuidv7();
      await db.query(
        `INSERT INTO talent_trust."SubjectMatchAdvisory"
           (id, tenant_id, subject_a_id, subject_b_id, advise_band, has_contradiction, match_basis, status, created_by, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ADVISE_WEAK', $5, $6::jsonb, 'PENDING_REVIEW', 'seed', CURRENT_TIMESTAMP)`,
        [
          advisoryId,
          tenant,
          a,
          b,
          opts.contradiction ?? false,
          JSON.stringify({ shared: [], contradiction_kinds: opts.contradiction ? ['PHONE'] : [] }),
        ],
      );
      return { advisoryId, a, b };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));

      for (const id of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, updated_at)
           VALUES ($1::uuid, 'TR2a3 Tenant', CURRENT_TIMESTAMP) ON CONFLICT (id) DO NOTHING`,
          [id],
        );
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
           VALUES ($1::uuid, 'core') ON CONFLICT (tenant_id, capability) DO NOTHING`,
          [id],
        );
      }

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      privateKey = kp.privateKey as SignKey;

      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    it('R6 authz — WITHOUT identity:resolve the approve is forbidden (403)', async () => {
      const { advisoryId } = await seedAdvisory(TENANT_A);
      const res = await post(`/v1/talent/identity/advisories/${advisoryId}/approve`, await signJwt([]), {});
      expect(res.status).toBe(403);
      // Untouched — still PENDING_REVIEW.
      expect(await advisoryStatus(advisoryId)).toBe('PENDING_REVIEW');
    });

    it('approve (privileged) → 200, pointer-only merge (b→a), advisory MERGED + audited', async () => {
      const { advisoryId, a, b } = await seedAdvisory(TENANT_A);
      const res = await post(
        `/v1/talent/identity/advisories/${advisoryId}/approve`,
        await signJwt([RESOLVE_SCOPE]),
        {},
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; resolved_by: string; merged_subject_id: string };
      expect(body.status).toBe('MERGED');
      expect(body.resolved_by).toBe(ADMIN);
      expect(body.merged_subject_id).toBe(b);

      expect(await subjectStatus(b)).toEqual({ status: 'MERGED', merged_into: a });
      expect(await subjectStatus(a)).toEqual({ status: 'ACTIVE', merged_into: null });
    });

    it('R3 contradiction gate — approve WITHOUT ack+justification → 400; WITH → 200', async () => {
      const { advisoryId } = await seedAdvisory(TENANT_A, { contradiction: true });
      const bad = await post(
        `/v1/talent/identity/advisories/${advisoryId}/approve`,
        await signJwt([RESOLVE_SCOPE]),
        {},
      );
      expect(bad.status).toBe(400);
      expect(await advisoryStatus(advisoryId)).toBe('PENDING_REVIEW');

      const ok = await post(
        `/v1/talent/identity/advisories/${advisoryId}/approve`,
        await signJwt([RESOLVE_SCOPE]),
        { override_acknowledged: true, justification: 'same person — phone changed' },
      );
      expect(ok.status).toBe(200);
      expect(await advisoryStatus(advisoryId)).toBe('MERGED');
    });

    it('dismiss → 200 DISMISSED, no merge', async () => {
      const { advisoryId, a, b } = await seedAdvisory(TENANT_A);
      const res = await post(
        `/v1/talent/identity/advisories/${advisoryId}/dismiss`,
        await signJwt([RESOLVE_SCOPE]),
        { justification: 'different people' },
      );
      expect(res.status).toBe(200);
      expect(await advisoryStatus(advisoryId)).toBe('DISMISSED');
      expect((await subjectStatus(a)).status).toBe('ACTIVE');
      expect((await subjectStatus(b)).status).toBe('ACTIVE');
    });

    it('reverse a MERGED advisory → 200 REVERSED, both subjects ACTIVE', async () => {
      const { advisoryId, a, b } = await seedAdvisory(TENANT_A);
      await post(`/v1/talent/identity/advisories/${advisoryId}/approve`, await signJwt([RESOLVE_SCOPE]), {});
      const res = await post(
        `/v1/talent/identity/advisories/${advisoryId}/reverse`,
        await signJwt([RESOLVE_SCOPE]),
        { justification: 'reviewer error' },
      );
      expect(res.status).toBe(200);
      expect(await advisoryStatus(advisoryId)).toBe('REVERSED');
      expect(await subjectStatus(a)).toEqual({ status: 'ACTIVE', merged_into: null });
      expect(await subjectStatus(b)).toEqual({ status: 'ACTIVE', merged_into: null });
    });

    it('reverse WITHOUT justification → 400 (R4)', async () => {
      const { advisoryId } = await seedAdvisory(TENANT_A);
      await post(`/v1/talent/identity/advisories/${advisoryId}/approve`, await signJwt([RESOLVE_SCOPE]), {});
      const res = await post(
        `/v1/talent/identity/advisories/${advisoryId}/reverse`,
        await signJwt([RESOLVE_SCOPE]),
        {},
      );
      expect(res.status).toBe(400);
      expect(await advisoryStatus(advisoryId)).toBe('MERGED');
    });

    it('tenant-scoping — a tenant-B caller cannot resolve tenant-A advisory (404)', async () => {
      const { advisoryId } = await seedAdvisory(TENANT_A);
      const res = await post(
        `/v1/talent/identity/advisories/${advisoryId}/dismiss`,
        await signJwt([RESOLVE_SCOPE], TENANT_B),
        {},
      );
      expect(res.status).toBe(404);
      expect(await advisoryStatus(advisoryId)).toBe('PENDING_REVIEW');
    });

    it('idempotency — re-resolving a MERGED advisory → 409', async () => {
      const { advisoryId } = await seedAdvisory(TENANT_A);
      await post(`/v1/talent/identity/advisories/${advisoryId}/approve`, await signJwt([RESOLVE_SCOPE]), {});
      const res = await post(
        `/v1/talent/identity/advisories/${advisoryId}/dismiss`,
        await signJwt([RESOLVE_SCOPE]),
        {},
      );
      expect(res.status).toBe(409);
    });

    // ---- TR-6 B2 (DDR D5 §5a) — keyset pagination -----------------------
    it('(a) pagination: stable keyset across pages; default PENDING_REVIEW; status filter works', async () => {
      const tenant = uuidv7();
      await db.query(
        `INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid,'pg',CURRENT_TIMESTAMP)`,
        [tenant],
      );
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,'core')`,
        [tenant],
      );
      // Seed 3 PENDING + 1 DISMISSED, deterministic created_at order.
      const pendingIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { advisoryId } = await seedAdvisoryFor(tenant, 'PENDING_REVIEW', i);
        pendingIds.push(advisoryId);
      }
      await seedAdvisoryFor(tenant, 'DISMISSED', 9);

      const jwt = await signJwt([RESOLVE_SCOPE], tenant);
      // Default (no status) → PENDING_REVIEW only, limit 2 → page of 2 + next_cursor.
      const p1 = await get(`/v1/talent/identity/advisories?limit=2`, jwt);
      expect(p1.status).toBe(200);
      const page1 = (await p1.json()) as { items: Array<{ id: string; status: string }>; next_cursor: string | null };
      expect(page1.items).toHaveLength(2);
      expect(page1.items.every((i) => i.status === 'PENDING_REVIEW')).toBe(true);
      expect(page1.next_cursor).not.toBeNull();

      // Page 2 via cursor → the remaining 1 PENDING, then next_cursor null.
      const p2 = await get(
        `/v1/talent/identity/advisories?limit=2&cursor=${page1.next_cursor}`,
        jwt,
      );
      const page2 = (await p2.json()) as { items: Array<{ id: string }>; next_cursor: string | null };
      expect(page2.items).toHaveLength(1);
      expect(page2.next_cursor).toBeNull();
      // Stable, non-overlapping keyset (all 3 distinct pending ids across the 2 pages).
      const seen = new Set([...page1.items, ...page2.items].map((i) => i.id));
      expect(seen).toEqual(new Set(pendingIds));

      // Status filter → the DISMISSED tab.
      const d = await get(`/v1/talent/identity/advisories?status=DISMISSED`, jwt);
      const dismissed = (await d.json()) as { items: Array<{ status: string }> };
      expect(dismissed.items).toHaveLength(1);
      expect(dismissed.items[0]!.status).toBe('DISMISSED');
    });

    // ---- TR-6 B2 (DDR D5 §5b) — enrichment: kinds, never values ---------
    it('(b) enrichment: kinds + reopen provenance present; NO values on the wire', async () => {
      const tenant = uuidv7();
      await db.query(
        `INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid,'enr',CURRENT_TIMESTAMP)`,
        [tenant],
      );
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,'core')`,
        [tenant],
      );
      const s1 = uuidv7();
      const s2 = uuidv7();
      const [a, b] = s1 < s2 ? [s1, s2] : [s2, s1];
      for (const id of [a, b]) {
        await db.query(
          `INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at)
           VALUES ($1::uuid,$2::uuid,'ACTIVE',CURRENT_TIMESTAMP)`,
          [id, tenant],
        );
      }
      const advisoryId = uuidv7();
      // match_basis carries KINDS + anchor-row ids (PII-free) — NEVER a value.
      const basis = {
        shared: [{ anchor_kind: 'EMAIL', a_anchor_id: uuidv7(), b_anchor_id: uuidv7() }],
        contradiction_kinds: ['PHONE'],
        confirmed_kinds: ['EMAIL'],
        corroborator_conflict_kinds: ['NAME'],
      };
      await db.query(
        `INSERT INTO talent_trust."SubjectMatchAdvisory"
           (id, tenant_id, subject_a_id, subject_b_id, advise_band, has_contradiction, match_basis,
            status, created_by, created_at, reopened_at, reopened_from_band)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ADVISE_STRONG', true, $5::jsonb,
                 'PENDING_REVIEW','seed',CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'ADVISE_WEAK')`,
        [advisoryId, tenant, a, b, JSON.stringify(basis)],
      );

      const res = await get(`/v1/talent/identity/advisories`, await signJwt([RESOLVE_SCOPE], tenant));
      const bodyText = JSON.stringify(await res.json());
      const body = JSON.parse(bodyText) as {
        items: Array<Record<string, unknown>>;
      };
      const item = body.items.find((i) => i['id'] === advisoryId)!;
      expect(item).toBeDefined();
      expect(item['advise_band']).toBe('ADVISE_STRONG');
      expect(item['has_contradiction']).toBe(true);
      expect(item['confirmed_kinds']).toEqual(['EMAIL']);
      expect(item['contradiction_kinds']).toEqual(['PHONE']);
      expect(item['corroborator_conflict_kinds']).toEqual(['NAME']);
      expect(item['shared_anchor_kinds']).toEqual(['EMAIL']);
      expect(item['reopened_at']).not.toBeNull();
      expect(item['reopened_from_band']).toBe('ADVISE_WEAK');
      // KINDS only — the anchor-row ids and the raw match_basis blob never reach the wire.
      expect(item['match_basis']).toBeUndefined();
      expect(bodyText).not.toContain('a_anchor_id');
      expect(bodyText).not.toContain(basis.shared[0]!.a_anchor_id);
    });

    // ---- TR-6 B2 (DDR D5 §5c) — each refusal returns its DOMAIN code -----
    it('(c) each advisory refusal returns its domain code', async () => {
      const jwt = await signJwt([RESOLVE_SCOPE]);
      const codeOf = async (r: { json: () => Promise<unknown> }): Promise<string> =>
        ((await r.json()) as { error: { code: string } }).error.code;

      // approve an already-resolved advisory → ADVISORY_NOT_PENDING (409).
      const r1 = await seedAdvisory(TENANT_A);
      await post(`/v1/talent/identity/advisories/${r1.advisoryId}/approve`, jwt, {});
      const reApprove = await post(`/v1/talent/identity/advisories/${r1.advisoryId}/approve`, jwt, {});
      expect(reApprove.status).toBe(409);
      expect(await codeOf(reApprove)).toBe('ADVISORY_NOT_PENDING');

      // reverse a not-MERGED (PENDING) advisory → ADVISORY_NOT_MERGED (409).
      const r2 = await seedAdvisory(TENANT_A);
      const rev = await post(`/v1/talent/identity/advisories/${r2.advisoryId}/reverse`, jwt, {
        justification: 'x',
      });
      expect(rev.status).toBe(409);
      expect(await codeOf(rev)).toBe('ADVISORY_NOT_MERGED');

      // approve a contradicted advisory without override → CONTRADICTION_OVERRIDE_REQUIRED (400).
      const r3 = await seedAdvisory(TENANT_A, { contradiction: true });
      const contra = await post(`/v1/talent/identity/advisories/${r3.advisoryId}/approve`, jwt, {});
      expect(contra.status).toBe(400);
      expect(await codeOf(contra)).toBe('CONTRADICTION_OVERRIDE_REQUIRED');

      // reverse without a justification → REVERSAL_JUSTIFICATION_REQUIRED (400).
      const r4 = await seedAdvisory(TENANT_A);
      await post(`/v1/talent/identity/advisories/${r4.advisoryId}/approve`, jwt, {});
      const noJust = await post(`/v1/talent/identity/advisories/${r4.advisoryId}/reverse`, jwt, {});
      expect(noJust.status).toBe(400);
      expect(await codeOf(noJust)).toBe('REVERSAL_JUSTIFICATION_REQUIRED');

      // a missing advisory → NOT_FOUND (404).
      const missing = await post(
        `/v1/talent/identity/advisories/${uuidv7()}/dismiss`,
        jwt,
        {},
      );
      expect(missing.status).toBe(404);
      expect(await codeOf(missing)).toBe('NOT_FOUND');
    });

    // Seed a PENDING/DISMISSED advisory with a tie-broken created_at ordinal.
    async function seedAdvisoryFor(
      tenant: string,
      status: string,
      ordinal: number,
    ): Promise<{ advisoryId: string; a: string; b: string }> {
      const s1 = uuidv7();
      const s2 = uuidv7();
      const [a, b] = s1 < s2 ? [s1, s2] : [s2, s1];
      for (const id of [a, b]) {
        await db.query(
          `INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at)
           VALUES ($1::uuid,$2::uuid,'ACTIVE',CURRENT_TIMESTAMP)`,
          [id, tenant],
        );
      }
      const advisoryId = uuidv7();
      await db.query(
        `INSERT INTO talent_trust."SubjectMatchAdvisory"
           (id, tenant_id, subject_a_id, subject_b_id, advise_band, has_contradiction, match_basis, status, created_by, created_at)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ADVISE_WEAK', false,
                 '{"shared":[],"contradiction_kinds":[],"confirmed_kinds":[]}'::jsonb, $5,
                 'seed', CURRENT_TIMESTAMP + ($6 || ' seconds')::interval)`,
        [advisoryId, tenant, a, b, status, String(ordinal)],
      );
      return { advisoryId, a, b };
    }
  },
);
