import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// DOC-2 boundary 1 — Templates + Requirements + Packets schema/trigger proofs on
// real Postgres 17. Skipped unless ARAMO_RUN_INTEGRATION=1. The documents schema
// is self-contained (cross-schema refs are opaque UUIDs), so this globs ONLY the
// module's own migrations (DOC-1a init + DOC-2), no curated cross-lib list.

const ROOT = resolve(__dirname, '../../../..');

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-2 templates + requirements + packets — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;

    const TENANT = randomUUID();
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

    async function newTemplate(typeId: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate" (id, tenant_id, document_type_id, name, template_kind, status, created_by)
         VALUES ($1, $2, $3, 'Offer Letter', 'GENERATED', 'DRAFT', $4)`,
        [id, TENANT, typeId, ACTOR],
      );
      return id;
    }

    async function newVersion(templateId: string, versionNumber: number, status: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "documents"."TemplateVersion"
           (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
         VALUES ($1,$2,$3,$4,$5,'v1', '{"blocks":[]}'::jsonb, $6, CASE WHEN $5='ACTIVE' THEN now() ELSE NULL END)`,
        [id, TENANT, templateId, versionNumber, status, ACTOR],
      );
      return id;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      db = new Client({ connectionString: container.getConnectionUri() });
      await db.connect();
      for (const m of documentsMigrations()) await db.query(readFileSync(m, 'utf8'));
    }, 120_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
    });

    it('creates the seven DOC-2 tables', async () => {
      const r = await db.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'documents'
            AND table_name IN ('DocumentTemplate','TemplateVersion','TemplateFieldDefinition','TemplateAsset','DocumentRequirement','DocumentPacket','DocumentPacketItem')
          ORDER BY table_name`,
      );
      expect(r.rows.map((x) => x.table_name)).toEqual([
        'DocumentPacket',
        'DocumentPacketItem',
        'DocumentRequirement',
        'DocumentTemplate',
        'TemplateAsset',
        'TemplateFieldDefinition',
        'TemplateVersion',
      ]);
    });

    it('freezes an ACTIVE TemplateVersion content (R-2-3 trigger rejects a content edit)', async () => {
      const typeId = await newDocumentType();
      const templateId = await newTemplate(typeId);
      const versionId = await newVersion(templateId, 1, 'ACTIVE');
      await expect(
        db.query(`UPDATE "documents"."TemplateVersion" SET field_schema = '{"blocks":["x"]}'::jsonb WHERE id = $1`, [
          versionId,
        ]),
      ).rejects.toThrow(/immutable after activation/i);
    });

    it('allows only ACTIVE -> RETIRED on an active version (R-2-3)', async () => {
      const typeId = await newDocumentType();
      const templateId = await newTemplate(typeId);
      const versionId = await newVersion(templateId, 1, 'ACTIVE');
      // DRAFT regression is rejected.
      await expect(
        db.query(`UPDATE "documents"."TemplateVersion" SET status = 'DRAFT' WHERE id = $1`, [versionId]),
      ).rejects.toThrow(/only transition to RETIRED/i);
      // RETIRED is accepted.
      await db.query(`UPDATE "documents"."TemplateVersion" SET status = 'RETIRED', retired_at = now() WHERE id = $1`, [
        versionId,
      ]);
      const r = await db.query(`SELECT status FROM "documents"."TemplateVersion" WHERE id = $1`, [versionId]);
      expect(r.rows[0].status).toBe('RETIRED');
    });

    it('permits a DRAFT version to be edited (immutability applies only once ACTIVE)', async () => {
      const typeId = await newDocumentType();
      const templateId = await newTemplate(typeId);
      const versionId = await newVersion(templateId, 1, 'DRAFT');
      await db.query(`UPDATE "documents"."TemplateVersion" SET field_schema = '{"blocks":["edited"]}'::jsonb WHERE id = $1`, [
        versionId,
      ]);
      const r = await db.query(`SELECT field_schema FROM "documents"."TemplateVersion" WHERE id = $1`, [versionId]);
      expect(r.rows[0].field_schema).toEqual({ blocks: ['edited'] });
    });

    it('allows a DocumentRequirement with NULL satisfied_by_document_id (requirement exists before any document)', async () => {
      const typeId = await newDocumentType();
      const reqId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentRequirement"
           (id, tenant_id, document_type_id, resource_type, resource_id, status, created_by)
         VALUES ($1,$2,$3,'TALENT',$4,'UNSATISFIED',$5)`,
        [reqId, TENANT, typeId, randomUUID(), ACTOR],
      );
      const r = await db.query(
        `SELECT status, satisfied_by_document_id FROM "documents"."DocumentRequirement" WHERE id = $1`,
        [reqId],
      );
      expect(r.rows[0].status).toBe('UNSATISFIED');
      expect(r.rows[0].satisfied_by_document_id).toBeNull();
    });

    it('FKs Document.template_version_id onto TemplateVersion (R-2-2) — a bogus version id is rejected', async () => {
      const typeId = await newDocumentType();
      const docId = randomUUID();
      await expect(
        db.query(
          `INSERT INTO "documents"."Document"
             (id, tenant_id, document_type_id, template_version_id, title, status, execution_mode, source_kind, created_by)
           VALUES ($1,$2,$3,$4,'t','DRAFT','NO_SIGNATURE','TEMPLATE_GENERATED',$5)`,
          [docId, TENANT, typeId, randomUUID(), ACTOR],
        ),
      ).rejects.toThrow(/foreign key|violates/i);
    });

    it('groups Documents in a packet with a unique (packet, document) tuple', async () => {
      const typeId = await newDocumentType();
      const docId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."Document"
           (id, tenant_id, document_type_id, title, status, execution_mode, source_kind, created_by)
         VALUES ($1,$2,$3,'t','DRAFT','NO_SIGNATURE','UPLOADED',$4)`,
        [docId, TENANT, typeId, ACTOR],
      );
      const packetId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentPacket" (id, tenant_id, packet_type, title, status, created_by)
         VALUES ($1,$2,'OFFER_PACKAGE','Offer Package','OPEN',$3)`,
        [packetId, TENANT, ACTOR],
      );
      await db.query(
        `INSERT INTO "documents"."DocumentPacketItem" (id, tenant_id, packet_id, document_id, sequence, required)
         VALUES ($1,$2,$3,$4,1,true)`,
        [randomUUID(), TENANT, packetId, docId],
      );
      // Same document twice in the same packet is rejected.
      await expect(
        db.query(
          `INSERT INTO "documents"."DocumentPacketItem" (id, tenant_id, packet_id, document_id, sequence, required)
           VALUES ($1,$2,$3,$4,2,true)`,
          [randomUUID(), TENANT, packetId, docId],
        ),
      ).rejects.toThrow(/unique|duplicate/i);
    });
  },
);
