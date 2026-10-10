import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AramoError } from '@aramo/common';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { PrismaService, TemplatesRepository } from '@aramo/documents';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { RtrTemplateResolverService } from '../rtr/rtr-template-resolver.service.js';
import { DEFAULT_RTR_TEMPLATE_CONTENT_V1, RTR_GENERATED_SCHEMA_V1 } from '../rtr/rtr-template-content.js';

// RTR-TEMPLATE-1 (§32) — template resolution on real Postgres 17. Proves the
// backend-authoritative resolver: the one tenant-wide ACTIVE RIGHT_TO_REPRESENT
// template resolves + pins its current version; EVERY invalid configuration fails
// CLOSED with the correct typed code (no inline fallback, INV-12); client-scoped
// templates are ignored in V1; current_version_id is the authority (later
// activation moves the resolved version deterministically).

const ROOT = resolve(__dirname, '../../../..');
const OFFER_LETTER_TYPE_ID = 'd0c50006-0000-7000-8000-000000000001'; // doc6-seeded

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected AramoError ${code}, but resolution succeeded`);
  } catch (e) {
    expect(e).toBeInstanceOf(AramoError);
    expect((e as AramoError).code).toBe(code);
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RTR-TEMPLATE-1 resolver — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let templates: TemplatesRepository;
    let resolver: RtrTemplateResolverService;
    const ACTOR = randomUUID();

    // Create an ACTIVE tenant-wide RTR template + version via the repository
    // (createTemplate -> createVersion -> activateVersion), returning ids.
    async function activeRtrTemplate(
      tenant: string,
      opts?: { renderSchemaVersion?: string; content?: unknown; clientId?: string },
    ): Promise<{ templateId: string; versionId: string }> {
      const tpl = await templates.createTemplate({
        tenant_id: tenant,
        document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
        name: 'Standard Right to Represent',
        template_kind: 'GENERATED',
        created_by: ACTOR,
        ...(opts?.clientId !== undefined ? { client_id: opts.clientId } : {}),
      });
      const ver = await templates.createVersion({
        tenant_id: tenant,
        template_id: tpl.id,
        render_schema_version: opts?.renderSchemaVersion ?? RTR_GENERATED_SCHEMA_V1,
        field_schema: opts?.content ?? DEFAULT_RTR_TEMPLATE_CONTENT_V1,
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: ver.id, actor_id: ACTOR, require_preview: false });
      return { templateId: tpl.id, versionId: ver.id };
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
      resolver = new RtrTemplateResolverService(templates);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('resolves the active tenant-wide RTR template and pins its current version', async () => {
      const tenant = randomUUID();
      const { templateId, versionId } = await activeRtrTemplate(tenant);
      const resolved = await resolver.resolveActive({ tenant_id: tenant, requestId: randomUUID() });
      expect(resolved.template_id).toBe(templateId);
      expect(resolved.template_version_id).toBe(versionId);
      expect(resolved.template_name).toBe('Standard Right to Represent');
      expect(resolved.version_number).toBe(1);
      expect(resolved.render_schema_version).toBe(RTR_GENERATED_SCHEMA_V1);
      expect(resolved.content).toEqual(DEFAULT_RTR_TEMPLATE_CONTENT_V1);
    });

    it('pins current_version_id: after activating a new version, resolution returns the NEW version', async () => {
      const tenant = randomUUID();
      const first = await activeRtrTemplate(tenant);
      const v2 = await templates.createVersion({
        tenant_id: tenant,
        template_id: first.templateId,
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
        field_schema: DEFAULT_RTR_TEMPLATE_CONTENT_V1,
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: v2.id, actor_id: ACTOR, require_preview: false });
      const resolved = await resolver.resolveActive({ tenant_id: tenant, requestId: randomUUID() });
      expect(resolved.template_version_id).toBe(v2.id);
      expect(resolved.version_number).toBe(2);
    });

    it('fails closed when no RTR template exists (RTR_TEMPLATE_NOT_CONFIGURED)', async () => {
      await expectCode(
        resolver.resolveActive({ tenant_id: randomUUID(), requestId: randomUUID() }),
        'RTR_TEMPLATE_NOT_CONFIGURED',
      );
    });

    it('ignores another tenant’s template (NOT_CONFIGURED for the requesting tenant)', async () => {
      const owner = randomUUID();
      await activeRtrTemplate(owner);
      await expectCode(
        resolver.resolveActive({ tenant_id: randomUUID(), requestId: randomUUID() }),
        'RTR_TEMPLATE_NOT_CONFIGURED',
      );
    });

    it('ignores a template under a different DocumentType (NOT_CONFIGURED)', async () => {
      const tenant = randomUUID();
      const tpl = await templates.createTemplate({
        tenant_id: tenant,
        document_type_id: OFFER_LETTER_TYPE_ID,
        name: 'Offer',
        template_kind: 'GENERATED',
        created_by: ACTOR,
      });
      const ver = await templates.createVersion({
        tenant_id: tenant,
        template_id: tpl.id,
        render_schema_version: RTR_GENERATED_SCHEMA_V1,
        field_schema: DEFAULT_RTR_TEMPLATE_CONTENT_V1,
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: ver.id, actor_id: ACTOR, require_preview: false });
      await expectCode(
        resolver.resolveActive({ tenant_id: tenant, requestId: randomUUID() }),
        'RTR_TEMPLATE_NOT_CONFIGURED',
      );
    });

    it('ignores a CLIENT-scoped template in V1 (NOT_CONFIGURED)', async () => {
      const tenant = randomUUID();
      await activeRtrTemplate(tenant, { clientId: randomUUID() });
      await expectCode(
        resolver.resolveActive({ tenant_id: tenant, requestId: randomUUID() }),
        'RTR_TEMPLATE_NOT_CONFIGURED',
      );
    });

    it('fails closed when an ACTIVE template has no current version (CONFIGURATION_INVALID)', async () => {
      const tenant = randomUUID();
      const id = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate"
         (id, tenant_id, document_type_id, client_id, name, template_kind, status, current_version_id, created_by)
         VALUES ($1,$2,$3,NULL,'t','GENERATED','ACTIVE',NULL,$4)`,
        [id, tenant, RIGHT_TO_REPRESENT_TYPE_ID, ACTOR],
      );
      await expectCode(
        resolver.resolveActive({ tenant_id: tenant, requestId: randomUUID() }),
        'RTR_TEMPLATE_CONFIGURATION_INVALID',
      );
    });

    it('fails closed when current version is DRAFT (CONFIGURATION_INVALID)', async () => {
      const tenant = randomUUID();
      const tplId = randomUUID();
      const verId = randomUUID();
      // Circular FK (template.current_version_id <-> version.template_id): insert
      // template with NULL current_version_id, insert the DRAFT version, then point.
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate"
         (id, tenant_id, document_type_id, client_id, name, template_kind, status, current_version_id, created_by)
         VALUES ($1,$2,$3,NULL,'t','GENERATED','ACTIVE',NULL,$4)`,
        [tplId, tenant, RIGHT_TO_REPRESENT_TYPE_ID, ACTOR],
      );
      await db.query(
        `INSERT INTO "documents"."TemplateVersion"
         (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by)
         VALUES ($1,$2,$3,1,'DRAFT',$4,$5,$6)`,
        [verId, tenant, tplId, RTR_GENERATED_SCHEMA_V1, DEFAULT_RTR_TEMPLATE_CONTENT_V1, ACTOR],
      );
      await db.query(`UPDATE "documents"."DocumentTemplate" SET current_version_id=$1 WHERE id=$2`, [verId, tplId]);
      await expectCode(
        resolver.resolveActive({ tenant_id: tenant, requestId: randomUUID() }),
        'RTR_TEMPLATE_CONFIGURATION_INVALID',
      );
    });

    it('fails closed on an unrecognised render_schema_version (CONFIGURATION_INVALID)', async () => {
      const tenant = randomUUID();
      await activeRtrTemplate(tenant, { renderSchemaVersion: 'rtr-generated-v999' });
      await expectCode(
        resolver.resolveActive({ tenant_id: tenant, requestId: randomUUID() }),
        'RTR_TEMPLATE_CONFIGURATION_INVALID',
      );
    });

    it('fails closed on structurally invalid content (CONFIGURATION_INVALID)', async () => {
      const tenant = randomUUID();
      await activeRtrTemplate(tenant, { content: { render_schema_version: RTR_GENERATED_SCHEMA_V1, title: 'x' } });
      await expectCode(
        resolver.resolveActive({ tenant_id: tenant, requestId: randomUUID() }),
        'RTR_TEMPLATE_CONFIGURATION_INVALID',
      );
    });
  },
);
