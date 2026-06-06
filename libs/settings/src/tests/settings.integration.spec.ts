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

// Settings S2 — integration spec (real Postgres 17).
//
// Carries the S1 substrate proofs forward AND adds the S2 write-path
// proofs against real DB rows:
//   (a) the model migrates                                      → beforeAll
//   (b) get returns the code-default `both` when no row          → S2
//   (c) get returns the row-value when a row exists             → S2
//   (d) set first-set returns previous_value: null              → S2
//   (e) set re-set captures the prior row value atomically      → S2
//   (f) the typed-accessor LIGHTS UP — get<'compensation.       → S2
//        display_default'> compiles + returns the set value
//   (g) bad value → VALIDATION_ERROR; DB is not touched         → S2
//   (h) per-tenant isolation on the write path                  → S2

const SETTINGS_INIT_MIGRATION = resolve(
  __dirname,
  '../../prisma/migrations/20260605000000_init_settings_model/migration.sql',
);

const TENANT_A = '11111111-0000-7000-8000-aaaaaaaaaaaa';
const TENANT_B = '22222222-0000-7000-8000-bbbbbbbbbbbb';
const ACTOR = '00000000-0000-7000-8000-000000000bb1';
const REQ = 'integration-test';

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
      svc = new TenantSettingService(repo, prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma.$disconnect();
      await container.stop();
    });

    // ------------------------------------------------------------------
    // foundation proof (a) — the model migrates
    // ------------------------------------------------------------------
    it('the TenantSetting table exists post-migration', async () => {
      const rows = await prisma.tenantSetting.findMany({ take: 1 });
      expect(Array.isArray(rows)).toBe(true);
    });

    // ------------------------------------------------------------------
    // foundation proof (b) — read of missing key returns the default
    // ------------------------------------------------------------------
    it('get returns the code-default `both` when no row exists', async () => {
      const value = await svc.get(TENANT_A, 'compensation.display_default');
      expect(value).toBe('both');
    });

    // ------------------------------------------------------------------
    // S2 proof (d) — first-set returns previous_value: null + inserts the row
    // ------------------------------------------------------------------
    it('set first-set inserts the row + returns previous_value: null', async () => {
      const result = await svc.set(
        TENANT_A,
        'compensation.display_default',
        'spread',
        ACTOR,
        REQ,
      );
      expect(result).toEqual({
        key: 'compensation.display_default',
        value: 'spread',
        previous_value: null,
      });
      // The row exists with last_modified_by recorded.
      const row = await prisma.tenantSetting.findUnique({
        where: {
          tenant_id_key: {
            tenant_id: TENANT_A,
            key: 'compensation.display_default',
          },
        },
      });
      expect(row).not.toBeNull();
      expect(row?.value).toBe('spread');
      expect(row?.last_modified_by).toBe(ACTOR);
    });

    // ------------------------------------------------------------------
    // S2 proof (c)+(f) — get returns the set value via the typed accessor
    // ------------------------------------------------------------------
    it('get returns the row-value `spread` after the set (typed-accessor lights up)', async () => {
      // The K-parametric signature compiles AGAINST the first registered
      // key — the S1 "lights up in S2" claim made concrete.
      const value: 'spread' | 'markup' | 'both' = await svc.get(
        TENANT_A,
        'compensation.display_default',
      );
      expect(value).toBe('spread');
    });

    // ------------------------------------------------------------------
    // S2 proof (e) — re-set captures the prior row value atomically
    // ------------------------------------------------------------------
    it('set re-set returns the prior value as previous_value', async () => {
      const result = await svc.set(
        TENANT_A,
        'compensation.display_default',
        'markup',
        ACTOR,
        REQ,
      );
      expect(result).toEqual({
        key: 'compensation.display_default',
        value: 'markup',
        previous_value: 'spread',
      });
    });

    // ------------------------------------------------------------------
    // S2 proof (g) — bad value rejected; DB is not touched
    // ------------------------------------------------------------------
    it('set rejects a bad value with VALIDATION_ERROR — DB unchanged', async () => {
      // Capture the pre-state to assert no write happened.
      const before = await prisma.tenantSetting.findUnique({
        where: {
          tenant_id_key: {
            tenant_id: TENANT_A,
            key: 'compensation.display_default',
          },
        },
      });

      await expect(
        svc.set(
          TENANT_A,
          'compensation.display_default',
          'margin_percent',
          ACTOR,
          REQ,
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
      });

      const after = await prisma.tenantSetting.findUnique({
        where: {
          tenant_id_key: {
            tenant_id: TENANT_A,
            key: 'compensation.display_default',
          },
        },
      });
      expect(after?.value).toEqual(before?.value);
      expect(after?.updated_at).toEqual(before?.updated_at);
    });

    // ------------------------------------------------------------------
    // S2 proof (h) — per-tenant isolation on the write path
    // ------------------------------------------------------------------
    it('tenant A and tenant B writes are isolated', async () => {
      const tenantBSetup = await svc.set(
        TENANT_B,
        'compensation.display_default',
        'both',
        uuidv7(),
        REQ,
      );
      expect(tenantBSetup.previous_value).toBeNull();

      // Tenant A still sees 'markup' from the prior test.
      const aValue = await svc.get(TENANT_A, 'compensation.display_default');
      expect(aValue).toBe('markup');

      // Tenant B sees 'both'.
      const bValue = await svc.get(TENANT_B, 'compensation.display_default');
      expect(bValue).toBe('both');

      // Cross-tenant findOne returns null defensively.
      const cross = await repo.findOne(
        '33333333-0000-7000-8000-cccccccccccc',
        'compensation.display_default',
      );
      expect(cross).toBeNull();
    });

    // ------------------------------------------------------------------
    // S1 forward-compat carryover — unknown DB rows are filtered by getAll
    // ------------------------------------------------------------------
    it('getAll filters DB rows for unknown-to-this-version keys', async () => {
      await prisma.tenantSetting.create({
        data: {
          tenant_id: TENANT_A,
          key: 'future.unknown_key',
          value: 'noise',
          last_modified_by: ACTOR,
        },
      });
      const view = await svc.getAll(TENANT_A);
      // S4 added audit.financials_enabled (boolean, default false) to the
      // closed-set registry; getAll materializes every known-key with its
      // row-value-or-default, so the view shape grew by one entry.
      expect(view).toEqual({
        'compensation.display_default': 'markup',
        'audit.financials_enabled': false,
      });
    });
  },
);
