import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { APP_FILTER } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SignJWT, importPKCS8 } from 'jose';
import { Client } from 'pg';
import request from 'supertest';
import { ARAMO_POSTGRES_TEST_IMAGE, AramoExceptionFilter, RequestIdMiddleware } from '@aramo/common';
import {
  AuthModule,
  EFFECTIVE_AUTHORIZATION_RESOLVER,
  PLATFORM_TENANT_SENTINEL_ID,
  type EffectiveAuthorizationInput,
  type EffectiveAuthorizationResolution,
  type EffectiveAuthorizationResolver,
} from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { filterScopesForConsumer } from '@aramo/identity';
import { SubscriptionPrismaService, UsageRollupService } from '@aramo/subscription';

import { PlatformCommercialUsageController } from '../app/platform/platform-commercial-usage.controller.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription CCP specs
import { CCP_BUNDLES, TENANT_1, TENANT_2 } from '../../../../libs/subscription/src/tests/support/ccp-a3-database.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- test-only real-Postgres support shared with the libs/subscription CCP specs
import { applyCcpD1Schema, seedUsageTenant } from '../../../../libs/subscription/src/tests/support/ccp-d1-database.js';

import { generateTestKeyPair } from './test-keys.js';

// CCP-D1 (PBD §5.4 row D1) — both usage routes for each CCP role and super_admin through the
// REAL guard chain AND the REAL UsageRollupService on real Postgres (identity + subscription
// chain through A4, A5, A9 and D1). Covers: NOT_RUN refused, a run, RECONCILED allowed per role,
// a tampered roll-up refused 409 for every allowed role, recovery by REBUILD.

const ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor', 'super_admin'] as const;
const ALLOWED = new Set(['platform_owner', 'finance_admin', 'commercial_ops', 'support_admin', 'read_only_auditor']);
const REC = '/platform/commercial/usage/reconciliation';
const PERIODS = '/platform/commercial/usage/periods';
const SUB_1 = '0190d1d2-0000-7000-8000-0000000000a1';
const SUB_2 = '0190d1d2-0000-7000-8000-0000000000a2';

class RoleBundleResolver implements EffectiveAuthorizationResolver {
  readonly roleOf = new Map<string, string>();
  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const role = this.roleOf.get(input.principal_id);
    const scopes = role === undefined ? [] : [...(CCP_BUNDLES[role] ?? [])];
    return { status: 'ok', scopes: filterScopesForConsumer({ consumer: input.consumer_type, scopes, tenantHasEsign: false }) };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-D1 — usage routes per role (real guards + real service + real Postgres)', { timeout: 120_000 }, () => {
  let container: StartedPostgreSqlContainer;
  let pg: Client;
  let prisma: SubscriptionPrismaService;
  let usage: UsageRollupService;
  let app: INestApplication;
  let privatePem: string;
  const audience = 'aramo-platform-ccp-d1-int';
  const saved: Record<string, string | undefined> = {};
  const resolver = new RoleBundleResolver();

  async function token(role: string): Promise<string> {
    const sub = `0190d1d9-0000-7000-8000-${String(ROLES.indexOf(role as (typeof ROLES)[number]) + 1).padStart(12, '0')}`;
    resolver.roleOf.set(sub, role);
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ consumer_type: 'platform', actor_kind: 'user', tenant_id: PLATFORM_TENANT_SENTINEL_ID, authz_version: 1 })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Aramo Core Auth')
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(await importPKCS8(privatePem, 'RS256'));
  }
  const get = async (role: string, path: string) => request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${await token(role)}`);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    pg = new Client({ connectionString: url });
    await pg.connect();
    await applyCcpD1Schema(pg);
    await seedUsageTenant(pg, TENANT_1, SUB_1);
    await seedUsageTenant(pg, TENANT_2, SUB_2);
    prisma = new SubscriptionPrismaService(url);
    await prisma.$connect();
    usage = new UsageRollupService(prisma);
    const keys = generateTestKeyPair();
    privatePem = keys.privatePem;
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = audience;
    process.env['AUTH_PUBLIC_KEY'] = keys.publicPem;
    const moduleRef = await Test.createTestingModule({
      imports: [AuthModule, AuthorizationModule],
      controllers: [PlatformCommercialUsageController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
        { provide: UsageRollupService, useValue: usage },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: never, res: never, next: () => void) => new RequestIdMiddleware().use(req, res, next));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    // Merge train TD-MERGE-41: one bound loopback port for the file (see support/ccp-d4-harness.ts).
    await app.listen(0, '127.0.0.1');
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await pg?.end();
    await container?.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }, 120_000);

  it('D1-RI-1 before any run: reconciliation NOT_RUN (allowed roles); analytics refused 409 for every allowed role', async () => {
    for (const role of ROLES) {
      const r = await get(role, REC);
      const p = await get(role, PERIODS);
      if (ALLOWED.has(role)) {
        expect([r.status, r.body.status]).toEqual([200, 'NOT_RUN']);
        expect([p.status, p.body?.error?.code, p.body?.error?.details?.status]).toEqual([409, 'USAGE_ROLLUP_NOT_RECONCILED', 'NOT_RUN']);
      } else {
        expect([r.status, r.body?.error?.details?.missing_scopes]).toEqual([403, ['platform:subscription:read']]);
        expect([p.status, p.body?.error?.details?.missing_scopes]).toEqual([403, ['platform:subscription:read']]);
      }
    }
  });

  it('D1-RI-2 after a run: RECONCILED; every allowed role reads the periods of both tenants; catalog_manager and super_admin refused', async () => {
    expect((await usage.run()).status).toBe('COMPLETED');
    for (const role of ROLES) {
      const r = await get(role, REC);
      const p = await get(role, `${PERIODS}?tenant_id=${TENANT_1}`);
      if (!ALLOWED.has(role)) {
        expect([r.status, p.status]).toEqual([403, 403]);
        continue;
      }
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('RECONCILED');
      expect(r.body.metrics[0].compared_totals).toEqual({
        allowance_usage: { consumed: 10, consumed_send: 10, consumed_historical: 0, reserved: 2 },
        rollup: { consumed: 10, consumed_send: 10, consumed_historical: 0, reserved: 2 },
      });
      expect(r.body.metrics[0].usage_event).toMatchObject({ tenants: 2, mismatched_tenants: 0, allowance_usage_consumed_send: 10, usage_event_quantity: 10 });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
      expect(p.body.periods.map((x: { period_start: string; period_end: string; counts: unknown; alignment: string; subscription_id: string; included_quantity: number }) => [x.period_start, x.period_end, x.counts, x.alignment, x.subscription_id, x.included_quantity])).toEqual([
        ['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', { consumed: 3, consumed_send: 3, consumed_historical: 0, reserved: 1 }, 'ALIGNED', SUB_1, 100],
        ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', { consumed: 2, consumed_send: 2, consumed_historical: 0, reserved: 0 }, 'ALIGNED', SUB_1, 100],
      ]);
      // Counts only: no money field anywhere in the response.
      expect(JSON.stringify(p.body)).not.toMatch(/price|amount|currency|_minor/);
    }
  });

  it('D1-RI-3 a tampered roll-up: NOT_RECONCILED shown, analytics refused 409 for every allowed role; REBUILD recovers', async () => {
    await pg.query(`UPDATE subscription."UsageRollupPeriod" SET reserved_count = reserved_count + 1 WHERE tenant_id = $1 AND period_start = '2026-10-01T00:00:00Z'`, [TENANT_2]);
    for (const role of ALLOWED) {
      const r = await get(role, REC);
      expect([r.status, r.body.status, r.body.metrics[0].mismatches[0].kind, r.body.metrics[0].mismatches[0].tenant_id]).toEqual([200, 'NOT_RECONCILED', 'PERIOD', TENANT_2]);
      const p = await get(role, PERIODS);
      expect([p.status, p.body?.error?.code, p.body?.error?.details?.status]).toEqual([409, 'USAGE_ROLLUP_NOT_RECONCILED', 'NOT_RECONCILED']);
    }
    expect((await usage.run({ rebuild: true })).metrics[0]?.reconciliation).toBe('RECONCILED');
    expect((await get('read_only_auditor', PERIODS)).status).toBe(200);
  });
});
