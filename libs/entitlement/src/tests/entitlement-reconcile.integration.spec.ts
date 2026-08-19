import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import type { Capability } from '../lib/capability.js';
import { DEFAULT_TENANT_CAPABILITIES } from '../lib/capability.js';
import { EntitlementRepository } from '../lib/entitlement.repository.js';
import {
  reconcileTenantEntitlements,
  type EntitlementReconcileDeps,
} from '../lib/reconcile-entitlements.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// T2-E1-HF2 — reconciliation integration (real Postgres 17). Applies the
// entitlement init migration, provisions a minimal identity."Tenant" (the
// cross-schema existence check reads it), and proves: idempotent additive grant
// to the ACTUAL target id, no duplicates on rerun, partial repair, tenant
// isolation, and fail-closed on a non-existent tenant.

const MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);

const TENANT_A = '11111111-1111-7111-8111-111111111111';
const TENANT_B = '22222222-2222-7222-8222-222222222222';
const ABSENT = '33333333-3333-7333-8333-333333333333';

function makeDeps(prisma: PrismaService): EntitlementReconcileDeps {
  const repo = new EntitlementRepository(prisma);
  return {
    async tenantExists(id: string): Promise<boolean> {
      const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`
        SELECT EXISTS(SELECT 1 FROM identity."Tenant" WHERE id = ${id}::uuid) AS present`;
      return rows[0]?.present === true;
    },
    getCapabilities: (id) => repo.getCapabilities(id),
    grantCapabilities: (a) => repo.grantCapabilities(a),
  };
}

async function capCount(prisma: PrismaService, tenantId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::int AS n FROM entitlement."TenantEntitlement"
    WHERE tenant_id = ${tenantId}::uuid AND capability IN ('core','ats','portal')`;
  return Number(rows[0]?.n ?? 0);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Entitlement reconcile — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let deps: EntitlementReconcileDeps;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      // Apply the entitlement init migration (skip full-line comments so a ';'
      // inside a comment can never split a statement).
      const sql = readFileSync(MIGRATION_PATH, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*--/.test(l))
        .join('\n');
      for (const stmt of sql.split(';')) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setup.$executeRawUnsafe(trimmed);
      }
      // Minimal identity.Tenant for the cross-schema existence check.
      await setup.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS identity');
      await setup.$executeRawUnsafe(
        'CREATE TABLE identity."Tenant" (id uuid PRIMARY KEY)',
      );
      await setup.onModuleDestroy();

      prisma = new PrismaService(url);
      await prisma.$connect();
      deps = makeDeps(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.onModuleDestroy();
      await container?.stop();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM entitlement."TenantEntitlement" WHERE tenant_id IN ('${TENANT_A}','${TENANT_B}')`,
      );
      await prisma.$executeRawUnsafe('DELETE FROM identity."Tenant"');
      await prisma.$executeRawUnsafe(
        `INSERT INTO identity."Tenant" (id) VALUES ('${TENANT_A}'),('${TENANT_B}')`,
      );
    });

    it('grants the full canonical bundle to the ACTUAL target id (test 6)', async () => {
      const r = await reconcileTenantEntitlements(deps, {
        tenantId: TENANT_A,
        required: DEFAULT_TENANT_CAPABILITIES,
      });
      expect([...r.granted].sort()).toEqual(['ats', 'core', 'portal']);
      expect(await capCount(prisma, TENANT_A)).toBe(3);
    });

    it('is idempotent — rerun creates no duplicates (test 7 / H)', async () => {
      await reconcileTenantEntitlements(deps, {
        tenantId: TENANT_A,
        required: DEFAULT_TENANT_CAPABILITIES,
      });
      expect(await capCount(prisma, TENANT_A)).toBe(3);
      const second = await reconcileTenantEntitlements(deps, {
        tenantId: TENANT_A,
        required: DEFAULT_TENANT_CAPABILITIES,
      });
      expect(second.granted).toHaveLength(0);
      // still exactly 3 — no duplicate rows (composite PK + skipDuplicates)
      expect(await capCount(prisma, TENANT_A)).toBe(3);
      const total = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::int AS n FROM entitlement."TenantEntitlement" WHERE tenant_id = ${TENANT_A}::uuid`;
      expect(Number(total[0]?.n ?? 0)).toBe(3);
    });

    it('adds only the missing members on a partial bundle (test 8 / D)', async () => {
      const repo = new EntitlementRepository(prisma);
      await repo.grantCapabilities({
        tenant_id: TENANT_A,
        capabilities: ['core'] as Capability[],
      });
      const r = await reconcileTenantEntitlements(deps, {
        tenantId: TENANT_A,
        required: DEFAULT_TENANT_CAPABILITIES,
      });
      expect([...r.granted].sort()).toEqual(['ats', 'portal']);
      expect(await capCount(prisma, TENANT_A)).toBe(3);
    });

    it('fails closed on a non-existent tenant and writes nothing (test 5 / E)', async () => {
      await expect(
        reconcileTenantEntitlements(deps, {
          tenantId: ABSENT,
          required: DEFAULT_TENANT_CAPABILITIES,
        }),
      ).rejects.toThrow(/does not exist/i);
      expect(await capCount(prisma, ABSENT)).toBe(0);
    });

    it('reconciling tenant A never writes tenant B (isolation — test 9 / I)', async () => {
      await reconcileTenantEntitlements(deps, {
        tenantId: TENANT_A,
        required: DEFAULT_TENANT_CAPABILITIES,
      });
      expect(await capCount(prisma, TENANT_A)).toBe(3);
      expect(await capCount(prisma, TENANT_B)).toBe(0);
    });
  },
);
