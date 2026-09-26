import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaService } from '@aramo/policy-store';
import {
  ClientSubmittalPolicyService,
  type ClientSubmittalPolicyDefinition,
} from '@aramo/client-submittal-policy';

import { ClientSubmittalPolicyGatewayAdapter } from '../../client-submittal-policy/client-submittal-policy-gateway.adapter.js';

// CSP PR-2 — real policy-store integration proof for the Client Submittal Policy
// admin path: the apps/api raw-SQL adapter over the governed StoredPolicyVersion
// table (publish -> resolve round-trip), plus divergence, FLOOR publish-reject and
// version immutability. DARK: no submit-command reference.

const MIGRATION_PATH = resolve(
  __dirname,
  '../../../../../libs/policy-store/prisma/migrations/20260730120000_init_policy_store/migration.sql',
);

const def = (...requirements: ClientSubmittalPolicyDefinition['requirements']): ClientSubmittalPolicyDefinition => ({
  requirements,
});

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'client-submittal-policy — adapter + policy-store integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let svc: ClientSubmittalPolicyService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const stmt of readFileSync(MIGRATION_PATH, 'utf8').split(';')) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setup.$executeRawUnsafe(trimmed);
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
      const adapter = new ClientSubmittalPolicyGatewayAdapter(prisma as never);
      svc = new ClientSubmittalPolicyService(adapter);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "policy_store"."StoredPolicyVersion"');
    });

    it('publish -> resolve round-trip over real StoredPolicyVersion, with client A vs B divergence', async () => {
      const tenant = randomUUID();
      const clientA = randomUUID();
      const clientB = randomUUID();
      await svc.publish({
        tenant_id: tenant,
        scope: 'TENANT',
        scope_ref: null,
        version: 'v1',
        definition: def({ key: 'resume_selected', disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' }),
        published_by: randomUUID(),
      });
      await svc.publish({
        tenant_id: tenant,
        scope: 'CLIENT',
        scope_ref: clientA,
        version: 'v1',
        definition: def({ key: 'work_authorization_present', disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' }),
        published_by: randomUUID(),
      });
      const effA = await svc.resolveEffective(tenant, { company_id: clientA, requisition_id: null });
      const effB = await svc.resolveEffective(tenant, { company_id: clientB, requisition_id: null });
      expect(effA?.requirements.map((r) => r.key).sort()).toEqual(['resume_selected', 'work_authorization_present']);
      expect(effB?.requirements.map((r) => r.key)).toEqual(['resume_selected']);
      const facts = { resume_selected: true, work_authorization_present: false };
      expect(svc.decide(tenant, effA!, facts, 'c').decision).toBe('DENY');
      expect(svc.decide(tenant, effB!, facts, 'c').decision).toBe('ALLOW');
    });

    it('FLOOR — a CLIENT publish weakening a TENANT FLOOR is rejected (publish-time, 422)', async () => {
      const tenant = randomUUID();
      const client = randomUUID();
      await svc.publish({
        tenant_id: tenant,
        scope: 'TENANT',
        scope_ref: null,
        version: 'v1',
        definition: def({ key: 'work_authorization_present', disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'FLOOR' }),
        published_by: randomUUID(),
      });
      await expect(
        svc.publish({
          tenant_id: tenant,
          scope: 'CLIENT',
          scope_ref: client,
          version: 'v1',
          definition: def({ key: 'work_authorization_present', disposition: 'NOT_REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' }),
          published_by: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_SUBMITTAL_POLICY_INVALID', statusCode: 422 });
    });

    it('a published version is immutable — a duplicate (tenant, package, version) is rejected', async () => {
      const tenant = randomUUID();
      const publish = () =>
        svc.publish({
          tenant_id: tenant,
          scope: 'TENANT',
          scope_ref: null,
          version: 'v1',
          definition: def({ key: 'resume_selected', disposition: 'REQUIRED', override_class: 'HARD_DENY', override_policy: 'DEFAULT' }),
          published_by: randomUUID(),
        });
      await publish();
      await expect(publish()).rejects.toMatchObject({ code: 'CLIENT_SUBMITTAL_POLICY_INVALID', statusCode: 422 });
    });
  },
);
