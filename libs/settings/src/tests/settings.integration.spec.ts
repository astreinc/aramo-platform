import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TenantSettingRepository } from '../lib/tenant-setting.repository.js';
import { TenantSettingService } from '../lib/tenant-setting.service.js';

// Settings S1 — integration spec (real Postgres 17).
//
// Covers the directive §4 gate-1 foundation proofs:
//   (a) the model migrates                                      → beforeAll
//   (b) get returns the code-default when no row                → covered at
//       repository level: findOne returns null (the service's default-
//       fallback path is untestable until S2 registers a key; the path
//       through findOne === null IS what produces the default).
//   (c) get returns the row-value when a row exists             → covered
//       at repository level: findOne returns the stored JSONB value.
//   (e) per-tenant isolation — tenant A's row invisible to B    → the
//       load-bearing isolation proof (the WHERE tenant_id invariant).
// Gate-1 (d) (endpoint-level scope-gate) is covered by the apps/api
// integration spec — endpoint behavior needs the full guard chain wired,
// which lives at the application boundary.

const SETTINGS_INIT_MIGRATION = resolve(
  __dirname,
  '../../prisma/migrations/20260605000000_init_settings_model/migration.sql',
);

const TENANT_A = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const TENANT_B = '22222222-0000-7000-8000-bbbbbbbbbbbb';

function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  return noLineComments.split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Settings module — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TenantSettingRepository;
    let svc: TenantSettingService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      // Apply the init migration via the PrismaService raw-exec path
      // (mirrors the libs/identity integration spec pattern).
      const setup = new PrismaService(url);
      await setup.$connect();
      const sql = readFileSync(SETTINGS_INIT_MIGRATION, 'utf8');
      for (const stmt of splitDdl(sql)) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setup.$executeRawUnsafe(trimmed);
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TenantSettingRepository(prisma);
      svc = new TenantSettingService(repo);
    }, 120_000);

    afterAll(async () => {
      await prisma.$disconnect();
      await container.stop();
    });

    // ------------------------------------------------------------------
    // foundation proof (a) — the model migrates
    // ------------------------------------------------------------------
    it('the TenantSetting table exists post-migration', async () => {
      // Direct probe: a select against the table must succeed (the
      // migration created the schema + table + index).
      const rows = await prisma.tenantSetting.findMany({ take: 1 });
      expect(Array.isArray(rows)).toBe(true);
    });

    // ------------------------------------------------------------------
    // foundation proof (b) — read of missing key returns null (the
    // service's default-fallback path; the actual default-fallback at the
    // service layer lights up in S2 when a known-key exists to register
    // a default against).
    // ------------------------------------------------------------------
    it('findOne returns null when no row exists for (tenant, key)', async () => {
      const result = await repo.findOne(TENANT_A, 'no.such.key');
      expect(result).toBeNull();
    });

    // ------------------------------------------------------------------
    // foundation proof (c) — read of an existing row returns the stored
    // JSONB value (the typed-accessor's projection target).
    // ------------------------------------------------------------------
    it('findOne returns the stored JSONB value when a row exists', async () => {
      await prisma.tenantSetting.create({
        data: {
          tenant_id: TENANT_A,
          key: 'test.scalar',
          value: 'string-value',
          last_modified_by: uuidv7(),
        },
      });
      await prisma.tenantSetting.create({
        data: {
          tenant_id: TENANT_A,
          key: 'test.object',
          value: { nested: { deep: 1 }, list: [1, 2, 3] },
          last_modified_by: uuidv7(),
        },
      });

      const scalar = await repo.findOne(TENANT_A, 'test.scalar');
      const object = await repo.findOne(TENANT_A, 'test.object');

      expect(scalar).toEqual({ value: 'string-value' });
      expect(object).toEqual({
        value: { nested: { deep: 1 }, list: [1, 2, 3] },
      });
    });

    // ------------------------------------------------------------------
    // foundation proof (e) — the LOAD-BEARING per-tenant isolation
    // ------------------------------------------------------------------
    it('findAllForTenant returns ONLY the requesting tenant rows', async () => {
      // Seed B with a row; A's prior fixture already inserted two rows.
      await prisma.tenantSetting.create({
        data: {
          tenant_id: TENANT_B,
          key: 'tenant-b.only',
          value: 'b-secret',
          last_modified_by: uuidv7(),
        },
      });

      const aRows = await repo.findAllForTenant(TENANT_A);
      const bRows = await repo.findAllForTenant(TENANT_B);

      // A's view contains only A's rows; tenant-b.only is invisible.
      expect(aRows.map((r) => r.key).sort()).toEqual(
        ['test.object', 'test.scalar'].sort(),
      );
      expect(aRows.find((r) => r.key === 'tenant-b.only')).toBeUndefined();

      // B's view contains only B's rows; A's keys are invisible.
      expect(bRows.map((r) => r.key)).toEqual(['tenant-b.only']);
      expect(bRows.find((r) => r.key === 'test.scalar')).toBeUndefined();
      expect(bRows.find((r) => r.key === 'test.object')).toBeUndefined();
    });

    it('findOne enforces per-tenant isolation (cross-tenant key returns null)', async () => {
      // Tenant B looking up tenant A's key by name MUST NOT see A's row.
      // The composite PK (tenant_id, key) is the schema-level enforcement;
      // the WHERE tenant_id in findOne is the application-level enforcement
      // (defense-in-depth).
      const fromB = await repo.findOne(TENANT_B, 'test.scalar');
      expect(fromB).toBeNull();

      // And tenant A still sees its own row.
      const fromA = await repo.findOne(TENANT_A, 'test.scalar');
      expect(fromA).toEqual({ value: 'string-value' });
    });

    // ------------------------------------------------------------------
    // S1 service-layer proof — getAll returns `{}` (the empty-registry
    // forward-compat behavior). DB rows exist for both tenants but the
    // service filters all of them (S1 registry empty → no key is known).
    // ------------------------------------------------------------------
    it('TenantSettingService.getAll returns `{}` while the registry is empty', async () => {
      const aView = await svc.getAll(TENANT_A);
      const bView = await svc.getAll(TENANT_B);

      // S1 invariant: every key is unknown-to-the-server, so the
      // materialized view is empty regardless of what rows the tenant
      // has. S2's first known-key flips the corresponding entry on.
      expect(aView).toEqual({});
      expect(bView).toEqual({});
    });
  },
);
