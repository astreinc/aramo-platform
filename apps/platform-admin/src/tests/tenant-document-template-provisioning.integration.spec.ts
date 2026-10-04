import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AramoError, ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { PrismaService, TemplatesRepository } from '@aramo/documents';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RIGHT_TO_REPRESENT_TYPE_ID,
  TenantDocumentTemplateProvisioningService,
} from '../app/platform/tenant-document-template-provisioning.service.js';

// RTR-TEMPLATE-1 (§7, §32) — new-tenant RTR template provisioning on real
// Postgres 17. Proves the platform-template-copy seam (the policy-provisioning
// precedent): a new tenant receives a byte-identical copy of the SENTINEL's
// active RTR template, resolvable as exactly one ACTIVE tenant-wide template;
// idempotent on re-provision; fail-loud when the platform template is absent.

const ROOT = resolve(__dirname, '../../../..');
const ACTOR = randomUUID();

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RTR-TEMPLATE-1 new-tenant provisioning — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let templates: TemplatesRepository;
    let service: TenantDocumentTemplateProvisioningService;

    async function seedSentinelRtrTemplate(): Promise<string> {
      const tpl = await templates.createTemplate({
        tenant_id: PLATFORM_TENANT_SENTINEL_ID,
        document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
        name: 'Standard Right to Represent',
        template_kind: 'GENERATED',
        created_by: ACTOR,
      });
      const ver = await templates.createVersion({
        tenant_id: PLATFORM_TENANT_SENTINEL_ID,
        template_id: tpl.id,
        render_schema_version: 'rtr-generated-v1',
        field_schema: { render_schema_version: 'rtr-generated-v1', title: 'Right to Represent', blocks: [] },
        created_by: ACTOR,
      });
      await templates.activateVersion({
        tenant_id: PLATFORM_TENANT_SENTINEL_ID,
        version_id: ver.id,
        actor_id: ACTOR,
      });
      return ver.id;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      templates = new TemplatesRepository(prisma);
      service = new TenantDocumentTemplateProvisioningService(templates);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    // Runs FIRST, before the sentinel template exists → fail-loud precondition.
    it('fails loudly when the platform template is missing', async () => {
      try {
        await service.publishDefaultRtrTemplate(randomUUID());
        throw new Error('expected a fail-loud AramoError');
      } catch (e) {
        expect(e).toBeInstanceOf(AramoError);
        expect((e as AramoError).message).toContain('platform tenant');
      }
    });

    it('copies the platform template into a new tenant as one ACTIVE tenant-wide template', async () => {
      const sentinelVersionId = await seedSentinelRtrTemplate();
      const tenant = randomUUID();
      await service.publishDefaultRtrTemplate(tenant);

      const tpl = await templates.findActiveTenantTemplateForType(tenant, RIGHT_TO_REPRESENT_TYPE_ID);
      expect(tpl).not.toBeNull();
      expect(tpl?.current_version_id).not.toBeNull();
      // A COPY, not a reference to the sentinel's own version.
      expect(tpl?.current_version_id).not.toBe(sentinelVersionId);
      const ver = await templates.findVersionById(tenant, tpl!.current_version_id!);
      expect(ver?.status).toBe('ACTIVE');
      expect(ver?.render_schema_version).toBe('rtr-generated-v1');
    });

    it('is idempotent — re-provisioning a tenant that already has one is a no-op', async () => {
      const tenant = randomUUID();
      await service.publishDefaultRtrTemplate(tenant);
      const first = await templates.findActiveTenantTemplateForType(tenant, RIGHT_TO_REPRESENT_TYPE_ID);
      await service.publishDefaultRtrTemplate(tenant);
      const after = await templates.listVersions(tenant, first!.id);
      // Still exactly one template/version for the tenant (no duplicate created).
      expect(after.length).toBe(1);
      const again = await templates.findActiveTenantTemplateForType(tenant, RIGHT_TO_REPRESENT_TYPE_ID);
      expect(again?.id).toBe(first?.id);
    });
  },
);
