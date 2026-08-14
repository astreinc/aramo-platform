import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey, type KeyObject } from 'jose';

import { AppModule } from '../app.module.js';

// Track 3 / E1-d — the placement READ surface at the HTTP guard layer (real
// Postgres 17 + the real AppModule guard chain). Proves D-3 (guard alignment to
// the ATS house pattern) and D-5 (portal-bundle exclusion) at the axes the
// controller-direct spec cannot exercise: tenant-capability, scope, and the
// least-visibility 404. See-all tokens (requisition:read:all + company:read:all)
// avoid seeding requisition/company visibility tables.
type SignKey = CryptoKey | KeyObject;

const ROOT = resolve(__dirname, '../../../..');
const ENTITLEMENT_INIT = resolve(ROOT, 'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql');
const PLACEMENT_INIT = resolve(ROOT, 'libs/placement/prisma/migrations/20260803180000_init_placement_model/migration.sql');
const PLACEMENT_OFFER = resolve(ROOT, 'libs/placement/prisma/migrations/20260805120000_placement_offer_and_outbox/migration.sql');
const PLACEMENT_REASON = resolve(ROOT, 'libs/placement/prisma/migrations/20260807120000_placement_fallthrough_reason/migration.sql');
// E4 — additive replacement-lineage column; the Prisma client now selects it.
const PLACEMENT_REPLACEMENT = resolve(ROOT, 'libs/placement/prisma/migrations/20260808120000_placement_replacement_link/migration.sql');
// T7-P1: adds PlacementProcess.placement_kind — the regenerated client SELECTs it on
// every PlacementProcess read, so this read-path spec must apply it or CI 500s
// (SEPARATE const — never a 2nd resolve() arg on the single-path ROOT const, ENOTDIR).
const PLACEMENT_PERMANENT = resolve(ROOT, 'libs/placement/prisma/migrations/20260814120000_t7_permanent_placement/migration.sql');

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-placement-read-http-spec';
const ALG = 'RS256';

const TENANT_ATS = randomUUID();
const TENANT_NOT_ATS = randomUUID();
const PLACEMENT_ID = randomUUID();
const PLACEMENT_REQ_ID = randomUUID();

// See-all read scopes (requisition:read:all ⇒ visible requisition set = null ⇒
// unrestricted, no visibility-table seeding). The 7 portal:* scopes hold ZERO
// placement grants (identity.integration.spec.ts) — a portal token must be
// refused at the scope axis.
const ATS_READ_SCOPES = ['placement:read', 'requisition:read:all', 'company:read:all'];
const PORTAL_SCOPES = [
  'portal:consent:read', 'portal:consent:write', 'portal:dispute:read', 'portal:dispute:write',
  'portal:profile:edit', 'portal:profile:read', 'portal:verification:read',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('E1-d Placement READ — HTTP guard alignment + portal exclusion (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let setupClient: Client;
  let app: INestApplication;
  let module: TestingModule;
  let port: number;
  let savedEnv: Record<string, string | undefined>;

  let atsReadJwt: string;
  let notAtsReadJwt: string;
  let portalJwt: string;
  // A token whose scope set is mutated by the Proof-7 plant helper.
  let signJwtFn: (args: { sub: string; tenant_id: string; scopes: string[] }) => Promise<string>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
    const url = container.getConnectionUri();
    setupClient = new Client({ connectionString: url });
    await setupClient.connect();

    for (const p of [ENTITLEMENT_INIT, PLACEMENT_INIT, PLACEMENT_OFFER, PLACEMENT_REASON, PLACEMENT_REPLACEMENT, PLACEMENT_PERMANENT]) {
      await setupClient.query(readFileSync(p, 'utf8'));
    }
    // TENANT_ATS is entitled to 'ats' (the intended placement boundary).
    // TENANT_NOT_ATS is entitled to NOTHING → capability axis refusal.
    await setupClient.query(
      `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,'ats') ON CONFLICT DO NOTHING`,
      [TENANT_ATS],
    );
    // One visible placement for TENANT_ATS (see-all actor observes it).
    await setupClient.query(
      `INSERT INTO placement."PlacementProcess"
        (id, tenant_id, submittal_id, requisition_id, talent_record_id, state, offered_at, created_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'OFFER_EXTENDED', now(), now())`,
      [PLACEMENT_ID, TENANT_ATS, randomUUID(), PLACEMENT_REQ_ID, randomUUID()],
    );

    const kp = await generateKeyPair(ALG);
    const publicPem = await exportSPKI(kp.publicKey as never);
    const privateKey: SignKey = kp.privateKey as SignKey;

    savedEnv = {
      DATABASE_URL: process.env['DATABASE_URL'],
      AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
      AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
    };
    process.env['DATABASE_URL'] = url;
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
    process.env['AUTH_PUBLIC_KEY'] = publicPem;

    signJwtFn = (args) =>
      new SignJWT({ sub: args.sub, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: args.tenant_id, scopes: args.scopes })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);

    atsReadJwt = await signJwtFn({ sub: randomUUID(), tenant_id: TENANT_ATS, scopes: ATS_READ_SCOPES });
    notAtsReadJwt = await signJwtFn({ sub: randomUUID(), tenant_id: TENANT_NOT_ATS, scopes: ATS_READ_SCOPES });
    portalJwt = await signJwtFn({ sub: randomUUID(), tenant_id: TENANT_ATS, scopes: PORTAL_SCOPES });

    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
    await app.init();
    const server = await app.listen(0);
    port = (server.address() as AddressInfo).port;
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await setupClient?.end();
    await container?.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 60_000);

  const get = (path: string, jwt: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${jwt}` } });

  // ---- Proof 3 — item/collection/event guard alignment (boundary: the route guards) ----
  it('Proof 3a — an ATS-entitled reader is admitted on collection, item AND events (200) — guards aligned', async () => {
    const coll = await get('/v1/placements', atsReadJwt);
    expect(coll.status).toBe(200);
    const collBody = (await coll.json()) as { items: Array<{ id: string }> };
    expect(collBody.items.some((p) => p.id === PLACEMENT_ID)).toBe(true);

    const item = await get(`/v1/placements/${PLACEMENT_ID}`, atsReadJwt);
    expect(item.status).toBe(200);

    const events = await get(`/v1/placements/${PLACEMENT_ID}/events`, atsReadJwt);
    expect(events.status).toBe(200);
  });

  it('Proof 3b — capability axis is CONSISTENT: a tenant lacking ats is refused on all three (403 TENANT_CAPABILITY_NOT_ENTITLED)', async () => {
    for (const path of ['/v1/placements', `/v1/placements/${PLACEMENT_ID}`, `/v1/placements/${PLACEMENT_ID}/events`]) {
      const res = await get(path, notAtsReadJwt);
      expect(res.status, `capability refusal on ${path}`).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('TENANT_CAPABILITY_NOT_ENTITLED');
    }
  });

  it('Proof 3c — least-visibility: a non-existent placement id is 404 (never 403) on item AND events', async () => {
    const missing = randomUUID();
    for (const path of [`/v1/placements/${missing}`, `/v1/placements/${missing}/events`]) {
      const res = await get(path, atsReadJwt);
      expect(res.status, `not-found on ${path}`).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('NOT_FOUND');
    }
  });

  // ---- Proof 7 — portal-bundle exclusion (boundary: the scope authorization guard) ----
  it('Proof 7 — a portal-scoped token (ZERO placement grants) is refused on collection, item AND events (403 INSUFFICIENT_PERMISSIONS)', async () => {
    for (const path of ['/v1/placements', `/v1/placements/${PLACEMENT_ID}`, `/v1/placements/${PLACEMENT_ID}/events`]) {
      const res = await get(path, portalJwt);
      expect(res.status, `portal refusal on ${path}`).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    }
  });

  it('collection empty-state — an ATS tenant with no placements returns 200 { items: [] }', async () => {
    // A fresh entitled tenant with no placement rows.
    const emptyTenant = randomUUID();
    await setupClient.query(
      `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,'ats') ON CONFLICT DO NOTHING`,
      [emptyTenant],
    );
    const jwt = await signJwtFn({ sub: randomUUID(), tenant_id: emptyTenant, scopes: ATS_READ_SCOPES });
    const res = await get('/v1/placements', jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
