import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import {
  PolicyStore,
  PrismaService,
  type PublishPolicyVersionInput,
} from '@aramo/policy-store';

import { TenantPolicyProvisioningService } from '../app/platform/tenant-policy-provisioning.service.js';

// ADR-0024 PR-4a-2 — the provisioning-time template copy against real Postgres.
// Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const SYSTEM_PUBLISHER = '00000000-0000-0000-0000-000000000000';
const PKG_NAME = 'requisition-lifecycle';

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = migrationsFor('policy-store');

// The six-ALLOW template. This app cannot import the apps/api ATS-layer package
// DATA across the scope wall, so the fixture reconstructs it; the copy path is
// what's under test. Mirrors apps/api/src/policy/requisition-lifecycle.package.ts.
const TEMPLATE: PublishPolicyVersionInput['definition'] = {
  name: PKG_NAME,
  version: '1.0.0',
  registry: { resources: ['REQUISITION_TALENT'], actions: ['ADD'] },
  default_disposition: {
    decision: 'ALLOW',
    reason_code: 'LIFECYCLE_ADD_ALLOWED_DEFAULT',
  },
  rules: ['active', 'on_hold', 'full', 'closed', 'canceled', 'lead'].map(
    (status) => ({
      id: `add-talent-${status}`,
      resource: 'REQUISITION_TALENT',
      action: 'ADD',
      when: [{ source: 'declared', key: 'status', op: 'eq', value: status }],
      decision: 'ALLOW',
      reason_code: 'LIFECYCLE_ADD_ALLOWED',
    }),
  ),
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TenantPolicyProvisioningService — template copy (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let store: PolicyStore;
    let svc: TenantPolicyProvisioningService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      store = new PolicyStore(prisma);
      svc = new TenantPolicyProvisioningService(store);
    }, 120_000);

    afterAll(async () => {
      await prisma?.onModuleDestroy();
      await db?.end();
      await container?.stop();
    }, 60_000);

    // Runs BEFORE the template is published (nested block below publishes it).
    it('fails LOUD (INTERNAL_ERROR, policy_template_missing) when no template is published', async () => {
      await expect(
        svc.publishDefaultLifecyclePackage(
          '01900000-0000-7000-8000-0000000000a0',
        ),
      ).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        context: { details: { reason: 'policy_template_missing' } },
      });
    });

    describe('once the platform template is published', () => {
      beforeAll(async () => {
        await store.publish({
          tenant_id: PLATFORM_TENANT_SENTINEL_ID,
          definition: TEMPLATE,
          published_by: SYSTEM_PUBLISHER,
        });
      });

      it('copies the template BYTE-IDENTICAL into a new tenant (checksum == template) with NAMED rules', async () => {
        const tenant = '01900000-0000-7000-8000-0000000000a1';
        await svc.publishDefaultLifecyclePackage(tenant);

        const template = await store.getActiveVersion(
          PLATFORM_TENANT_SENTINEL_ID,
          PKG_NAME,
        );
        const copy = await store.getActiveVersion(tenant, PKG_NAME);
        expect(copy).not.toBeNull();
        expect(template).not.toBeNull();
        // Byte-identical: publish() recomputes the checksum from the definition,
        // so an identical definition is checksum-equal to the template.
        expect(copy?.checksum).toBe(template?.checksum);
        expect(copy?.version).toBe('1.0.0');
        // NAMED rules preserved (never a fresh __default__-only package) — a
        // decision on this tenant will name a rule, not the __default__ marker.
        const ruleIds = (copy?.definition.rules ?? [])
          .map((r) => r.id)
          .sort();
        expect(ruleIds).toEqual([
          'add-talent-active',
          'add-talent-canceled',
          'add-talent-closed',
          'add-talent-full',
          'add-talent-lead',
          'add-talent-on_hold',
        ]);
      });

      it('is idempotent — re-provisioning does NOT publish a second version', async () => {
        const tenant = '01900000-0000-7000-8000-0000000000a2';
        await svc.publishDefaultLifecyclePackage(tenant);
        await svc.publishDefaultLifecyclePackage(tenant); // second call = no-op

        const { rows } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM policy_store."StoredPolicyVersion" WHERE tenant_id=$1 AND package_name=$2`,
          [tenant, PKG_NAME],
        );
        expect(rows[0]?.n).toBe(1);
      });
    });
  },
);
