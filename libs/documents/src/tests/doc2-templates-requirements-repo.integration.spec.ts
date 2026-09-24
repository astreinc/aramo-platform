import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PrismaService,
  TemplatesRepository,
  RequirementsRepository,
  TemplateImmutableError,
  DocumentRequirementAlreadySatisfiedError,
} from '../index.js';

// DOC-2 boundary 4 — repository/service logic on real Postgres 17. Exercises the
// app-surface immutability guard, the requirement bridge (satisfaction
// INDEPENDENT of any business transition), waiver, and packet grouping.

const ROOT = resolve(__dirname, '../../../..');

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-2 templates/requirements/packets repository — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let templates: TemplatesRepository;
    let requirements: RequirementsRepository;

    const TENANT = randomUUID();
    const OTHER_TENANT = randomUUID();
    const ACTOR = randomUUID();

    async function newDocumentType(): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
         VALUES ($1, NULL, $2, 'RTR', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
        [id, `RIGHT_TO_REPRESENT_${id.slice(0, 8)}`],
      );
      return id;
    }

    async function newDocument(typeId: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "documents"."Document" (id, tenant_id, document_type_id, title, status, execution_mode, source_kind, created_by)
         VALUES ($1,$2,$3,'doc','DRAFT','NO_SIGNATURE','UPLOADED',$4)`,
        [id, TENANT, typeId, ACTOR],
      );
      return id;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      templates = new TemplatesRepository(prisma);
      requirements = new RequirementsRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('auto-increments version_number and activates a DRAFT version (DRAFT -> ACTIVE)', async () => {
      const typeId = await newDocumentType();
      const t = await templates.createTemplate({
        tenant_id: TENANT,
        document_type_id: typeId,
        name: 'Offer Letter',
        template_kind: 'GENERATED',
        created_by: ACTOR,
      });
      const v1 = await templates.createVersion({ tenant_id: TENANT, template_id: t.id, render_schema_version: 'v1', created_by: ACTOR });
      const v2 = await templates.createVersion({ tenant_id: TENANT, template_id: t.id, render_schema_version: 'v1', created_by: ACTOR });
      expect(v1.version_number).toBe(1);
      expect(v2.version_number).toBe(2);
      const activated = await templates.activateVersion({ tenant_id: TENANT, version_id: v2.id, actor_id: ACTOR });
      expect(activated.status).toBe('ACTIVE');
      const tmpl = await templates.getTemplate(TENANT, t.id);
      expect(tmpl.current_version_id).toBe(v2.id);
      expect(tmpl.status).toBe('ACTIVE');
    });

    it('rejects adding a field to an ACTIVE version (app-surface immutability, R-2-3)', async () => {
      const typeId = await newDocumentType();
      const t = await templates.createTemplate({ tenant_id: TENANT, document_type_id: typeId, name: 'T', template_kind: 'GENERATED', created_by: ACTOR });
      const v = await templates.createVersion({ tenant_id: TENANT, template_id: t.id, render_schema_version: 'v1', created_by: ACTOR });
      // DRAFT: field add allowed.
      await templates.addField({ tenant_id: TENANT, template_version_id: v.id, field_key: 'name', field_type: 'TEXT', ordinal: 1 });
      await templates.activateVersion({ tenant_id: TENANT, version_id: v.id, actor_id: ACTOR });
      // ACTIVE: field add rejected.
      await expect(
        templates.addField({ tenant_id: TENANT, template_version_id: v.id, field_key: 'sig', field_type: 'SIGNATURE', ordinal: 2 }),
      ).rejects.toBeInstanceOf(TemplateImmutableError);
    });

    it('requirement satisfaction flips UNSATISFIED->SATISFIED when a document is linked, independent of any business transition', async () => {
      const typeId = await newDocumentType();
      const req = await requirements.createRequirement({
        tenant_id: TENANT,
        document_type_id: typeId,
        resource_type: 'TALENT',
        resource_id: randomUUID(),
        created_by: ACTOR,
      });
      // Before value existed: verdict is unsatisfied, no linked document.
      const before = await requirements.checkRequirement(TENANT, req.id);
      expect(before).toMatchObject({ satisfied: false, status: 'UNSATISFIED', satisfied_by_document_id: null });
      // Link a Document (Documents-owned action — no submittal/offer transition involved).
      const docId = await newDocument(typeId);
      await requirements.satisfyRequirement({ tenant_id: TENANT, id: req.id, document_id: docId, actor_id: ACTOR });
      const after = await requirements.checkRequirement(TENANT, req.id);
      expect(after).toMatchObject({ satisfied: true, status: 'SATISFIED', satisfied_by_document_id: docId });
    });

    it('rejects satisfying an already-resolved requirement, and supports waiver (document_requirement:manage)', async () => {
      const typeId = await newDocumentType();
      const req = await requirements.createRequirement({ tenant_id: TENANT, document_type_id: typeId, resource_type: 'TALENT', resource_id: randomUUID(), created_by: ACTOR });
      await requirements.waiveRequirement({ tenant_id: TENANT, id: req.id, reason: 'client provided offline', actor_id: ACTOR });
      const v = await requirements.checkRequirement(TENANT, req.id);
      expect(v).toMatchObject({ satisfied: true, status: 'WAIVED' });
      // A waived requirement cannot then be satisfied.
      const docId = await newDocument(typeId);
      await expect(
        requirements.satisfyRequirement({ tenant_id: TENANT, id: req.id, document_id: docId, actor_id: ACTOR }),
      ).rejects.toBeInstanceOf(DocumentRequirementAlreadySatisfiedError);
    });

    it('groups Documents in a packet and reads them back in sequence; cross-tenant is NOT FOUND', async () => {
      const typeId = await newDocumentType();
      const packet = await templates.createPacket({ tenant_id: TENANT, packet_type: 'OFFER_PACKAGE', title: 'Offer Package', created_by: ACTOR });
      const d1 = await newDocument(typeId);
      const d2 = await newDocument(typeId);
      await templates.addPacketItem({ tenant_id: TENANT, packet_id: packet.id, document_id: d2, sequence: 2 });
      await templates.addPacketItem({ tenant_id: TENANT, packet_id: packet.id, document_id: d1, sequence: 1 });
      const loaded = await templates.getPacket(TENANT, packet.id);
      expect(loaded.items.map((i) => i.document_id)).toEqual([d1, d2]); // ordered by sequence
      // Cross-tenant read is NOT FOUND (tenant isolation).
      await expect(templates.getPacket(OTHER_TENANT, packet.id)).rejects.toThrow(/not found/i);
    });
  },
);
