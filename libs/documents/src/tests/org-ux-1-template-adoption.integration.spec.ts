import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PrismaService,
  TemplateNotFoundError,
  TemplateResolutionService,
  TemplateSelectionInvalidError,
  TemplatesRepository,
} from '../index.js';

// ORG-UX-1 — Implementation Directive v1.0 (LOCKED) §5.1 (Lead Correction B) and §5.3
// (P2 T-A) on real Postgres 17. Skipped unless ARAMO_RUN_INTEGRATION=1.
//
//   ADOPT  — an Aramo default becomes an INDEPENDENT tenant draft (full content + field
//            copy), provenance recorded for audit only; nothing resolves until approved;
//            a later change to the Aramo default never reaches the tenant's copy.
//   T-A    — the 20261022130000 data block grandfathers every tenant that resolved to an
//            Aramo default (a legacy selection), marks existing PLATFORM selections legacy,
//            leaves tenants with their own choice untouched, never guesses between two
//            defaults, skips the platform sentinel, and is idempotent. Exercised by
//            re-applying the migration after a minimal identity.Tenant table exists (the
//            documents-only container applies it first as a NOTICE no-op).

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION = resolve(ROOT, 'libs/documents/prisma/migrations/20261022130000_org_ux_1_template_adoption_and_legacy_selection/migration.sql');
const SENTINEL = '01900000-0000-7000-8000-000000000100';

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ORG-UX-1 — template adoption + T-A grandfather — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let templates: TemplatesRepository;
    let resolution: TemplateResolutionService;
    const ACTOR = randomUUID();
    const notices: string[] = [];

    async function newDocumentType(): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
         VALUES ($1, NULL, $2, 'Doc', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
        [id, `UX1_TYPE_${id.slice(0, 8)}`],
      );
      return id;
    }

    async function platformDefault(typeId: string, opts?: { withdrawEffective?: Date; body?: string }): Promise<{ templateId: string; versionId: string }> {
      const templateId = randomUUID();
      const versionId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate"
           (id, owner_scope, tenant_id, document_type_id, name, description, template_kind, status, created_by, withdraw_notice_at, withdraw_effective_at)
         VALUES ($1,'PLATFORM',NULL,$2,'Aramo starting point','Gallery entry','GENERATED','ACTIVE',$3,$4,$5)`,
        [
          templateId,
          typeId,
          ACTOR,
          opts?.withdrawEffective !== undefined ? new Date(opts.withdrawEffective.getTime() - 7 * 86_400_000) : null,
          opts?.withdrawEffective ?? null,
        ],
      );
      await db.query(
        `INSERT INTO "documents"."TemplateVersion"
           (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
         VALUES ($1,NULL,$2,1,'DRAFT','v1',$3::jsonb,$4,NULL)`,
        [versionId, templateId, JSON.stringify({ blocks: [{ type: 'TEXT', text: opts?.body ?? 'Aramo wording v1' }] }), ACTOR],
      );
      // M-A6 §3.4 — field definitions are written while the version is DRAFT (the
      // 20261028110000 trigger refuses them on an ACTIVE version), then it is activated.
      await db.query(
        `INSERT INTO "documents"."TemplateFieldDefinition" (id, template_version_id, field_key, field_type, binding_key, required, ordinal)
         VALUES ($1,$2,'talent_signature','SIGNATURE',NULL,true,1)`,
        [randomUUID(), versionId],
      );
      await db.query(`UPDATE "documents"."TemplateVersion" SET status = 'ACTIVE', activated_at = now() WHERE id = $1`, [versionId]);
      await db.query(`UPDATE "documents"."DocumentTemplate" SET current_version_id = $1 WHERE id = $2`, [versionId, templateId]);
      return { templateId, versionId };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      db.on('notice', (n) => notices.push(n.message ?? ''));
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      templates = new TemplatesRepository(prisma);
      resolution = new TemplateResolutionService(templates);
    }, 300_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    // ── ADOPT (§5.1, Correction B) ──────────────────────────────────────────────
    it('adopt creates an independent tenant DRAFT: full content + field copy, provenance recorded, nothing resolvable until approved', async () => {
      const type = await newDocumentType();
      const tenant = randomUUID();
      const def = await platformDefault(type);
      const { template, version } = await templates.adoptPlatformTemplate({ tenant_id: tenant, library_template_id: def.templateId, created_by: ACTOR });

      expect(template).toMatchObject({
        tenant_id: tenant,
        owner_scope: 'TENANT',
        document_type_id: type,
        status: 'DRAFT',
        name: 'Aramo starting point',
        adopted_from_template_id: def.templateId,
        adopted_from_version_id: def.versionId,
      });
      expect(version).toMatchObject({ tenant_id: tenant, template_id: template.id, version_number: 1, status: 'DRAFT' });
      expect(version.field_schema).toEqual({ blocks: [{ type: 'TEXT', text: 'Aramo wording v1' }] });
      const fields = await db.query(`SELECT field_key, field_type, required FROM "documents"."TemplateFieldDefinition" WHERE template_version_id = $1`, [version.id]);
      expect(fields.rows).toEqual([{ field_key: 'talent_signature', field_type: 'SIGNATURE', required: true }]);
      // Nothing is used until approved.
      expect(await resolution.resolve({ tenant_id: tenant, document_type_id: type })).toEqual({ outcome: 'SELECTION_REQUIRED', withdrawn_template_ids: [] });
    });

    it('Correction B — a later change to the Aramo default never reaches the adopted draft or the approved tenant version', async () => {
      const type = await newDocumentType();
      const tenant = randomUUID();
      const def = await platformDefault(type);
      const { template, version } = await templates.adoptPlatformTemplate({ tenant_id: tenant, library_template_id: def.templateId, created_by: ACTOR });
      await templates.updateDraftVersion({ tenant_id: tenant, version_id: version.id, field_schema: { blocks: [{ type: 'TEXT', text: 'Our customized wording' }] } });
      const approved = await templates.activateVersion({ tenant_id: tenant, version_id: version.id, actor_id: ACTOR, require_preview: false });
      const before = await db.query(`SELECT field_schema, status FROM "documents"."TemplateVersion" WHERE id = $1`, [approved.id]);

      // Aramo publishes a new version of its default and retires the old one.
      const v2 = randomUUID();
      await db.query(
        `INSERT INTO "documents"."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
         VALUES ($1,NULL,$2,2,'ACTIVE','v1','{"blocks":[{"type":"TEXT","text":"Aramo wording v2"}]}'::jsonb,$3,now())`,
        [v2, def.templateId, ACTOR],
      );
      await db.query(`UPDATE "documents"."TemplateVersion" SET status='RETIRED', retired_at=now() WHERE id=$1`, [def.versionId]);
      await db.query(`UPDATE "documents"."DocumentTemplate" SET current_version_id=$1 WHERE id=$2`, [v2, def.templateId]);

      const after = await db.query(`SELECT field_schema, status FROM "documents"."TemplateVersion" WHERE id = $1`, [approved.id]);
      expect(JSON.stringify(after.rows[0])).toBe(JSON.stringify(before.rows[0]));
      const r = await resolution.resolve({ tenant_id: tenant, document_type_id: type });
      expect(r).toMatchObject({ outcome: 'RESOLVED', source: 'TENANT_SELECTION', owner_scope: 'TENANT' });
      if (r.outcome === 'RESOLVED') {
        expect(r.template.id).toBe(template.id);
        expect(r.version.field_schema).toEqual({ blocks: [{ type: 'TEXT', text: 'Our customized wording' }] });
      }
      // Provenance is unchanged audit data, never re-pointed.
      const t = await db.query(`SELECT adopted_from_template_id, adopted_from_version_id FROM "documents"."DocumentTemplate" WHERE id = $1`, [template.id]);
      expect(t.rows[0]).toEqual({ adopted_from_template_id: def.templateId, adopted_from_version_id: def.versionId });
    });

    it('adopt refuses a withdrawn default, a tenant template, and an unknown id', async () => {
      const type = await newDocumentType();
      const tenant = randomUUID();
      const gone = await platformDefault(type, { withdrawEffective: new Date(Date.now() - 60_000) });
      await expect(templates.adoptPlatformTemplate({ tenant_id: tenant, library_template_id: gone.templateId, created_by: ACTOR })).rejects.toBeInstanceOf(
        TemplateSelectionInvalidError,
      );
      const own = await templates.createTemplate({ tenant_id: tenant, document_type_id: type, name: 'Own', template_kind: 'GENERATED', created_by: ACTOR });
      await expect(templates.adoptPlatformTemplate({ tenant_id: tenant, library_template_id: own.id, created_by: ACTOR })).rejects.toBeInstanceOf(
        TemplateNotFoundError,
      );
      await expect(templates.adoptPlatformTemplate({ tenant_id: tenant, library_template_id: randomUUID(), created_by: ACTOR })).rejects.toBeInstanceOf(
        TemplateNotFoundError,
      );
    });

    // ── T-A grandfather (§5.3) ─────────────────────────────────────────────────
    it('T-A: the documents-only first run skipped the data block (NOTICE) after adding the columns', async () => {
      expect(notices.some((n) => n.includes('ORG-UX-1 T-A grandfather skipped'))).toBe(true);
      const cols = await db.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'documents' AND column_name IN ('adopted_from_template_id','adopted_from_version_id','legacy_platform') ORDER BY 1, 2`,
      );
      expect(cols.rows).toEqual([
        { table_name: 'DocumentTemplate', column_name: 'adopted_from_template_id' },
        { table_name: 'DocumentTemplate', column_name: 'adopted_from_version_id' },
        { table_name: 'TenantTemplateSelection', column_name: 'legacy_platform' },
      ]);
    });

    it('T-A: grandfathers tenants relying on a default, marks PLATFORM selections legacy, leaves own choices, never guesses, skips the sentinel; idempotent', async () => {
      // Isolate from the documents created by the earlier cases: only the types below carry
      // live defaults (earlier defaults are retired here).
      await db.query(`UPDATE "documents"."DocumentTemplate" SET status = 'RETIRED' WHERE owner_scope = 'PLATFORM'`);
      await db.query(`CREATE SCHEMA IF NOT EXISTS "identity"`);
      await db.query(`CREATE TABLE IF NOT EXISTS "identity"."Tenant" (id uuid PRIMARY KEY)`);

      const single = await newDocumentType();
      const ambiguous = await newDocumentType();
      const def = await platformDefault(single);
      await platformDefault(ambiguous, { withdrawEffective: new Date(Date.now() + 86_400_000) });
      await platformDefault(ambiguous, { withdrawEffective: new Date(Date.now() + 2 * 86_400_000) });

      const relying = randomUUID(); // no selection → gets a legacy selection
      const owning = randomUUID(); // own approved template → untouched
      const pointed = randomUUID(); // pre-ORG-UX-1 explicit PLATFORM selection → marked legacy
      for (const id of [relying, owning, pointed, SENTINEL]) await db.query(`INSERT INTO "identity"."Tenant" (id) VALUES ($1)`, [id]);
      const own = await templates.createTemplate({ tenant_id: owning, document_type_id: single, name: 'Own', template_kind: 'GENERATED', created_by: ACTOR });
      const ownV = await templates.createVersion({ tenant_id: owning, template_id: own.id, render_schema_version: 'v1', field_schema: { blocks: [] }, created_by: ACTOR });
      await templates.activateVersion({ tenant_id: owning, version_id: ownV.id, actor_id: ACTOR, require_preview: false });
      await db.query(
        `INSERT INTO "documents"."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by, updated_at)
         VALUES ($1,$2,$3,NULL,$4,$5,now())`,
        [randomUUID(), pointed, single, def.templateId, ACTOR],
      );
      // Before the block, the relying tenant cannot send.
      expect((await resolution.resolve({ tenant_id: relying, document_type_id: single })).outcome).toBe('SELECTION_REQUIRED');

      notices.length = 0;
      await db.query(readFileSync(MIGRATION, 'utf8'));
      expect(notices.some((n) => n.includes('1 existing PLATFORM selections marked legacy, 1 legacy tenant-wide selections inserted'))).toBe(true);

      const sel = async (tenant: string, type: string) =>
        (await db.query(`SELECT template_id, legacy_platform, client_id FROM "documents"."TenantTemplateSelection" WHERE tenant_id = $1 AND document_type_id = $2`, [tenant, type])).rows;
      expect(await sel(relying, single)).toEqual([{ template_id: def.templateId, legacy_platform: true, client_id: null }]);
      expect(await sel(pointed, single)).toEqual([{ template_id: def.templateId, legacy_platform: true, client_id: null }]);
      expect(await sel(owning, single)).toEqual([{ template_id: own.id, legacy_platform: null, client_id: null }]);
      expect(await sel(SENTINEL, single)).toEqual([]);
      for (const t of [relying, owning, pointed]) expect(await sel(t, ambiguous)).toEqual([]);

      // Existing behaviour preserved: the relying tenant still resolves the Aramo default.
      const r = await resolution.resolve({ tenant_id: relying, document_type_id: single });
      expect(r).toMatchObject({ outcome: 'RESOLVED', owner_scope: 'PLATFORM' });
      if (r.outcome === 'RESOLVED') expect(r.template.id).toBe(def.templateId);

      // Idempotent.
      const snap = async () => JSON.stringify((await db.query(`SELECT id, tenant_id, document_type_id, template_id, legacy_platform FROM "documents"."TenantTemplateSelection" ORDER BY id`)).rows);
      const before = await snap();
      notices.length = 0;
      await db.query(readFileSync(MIGRATION, 'utf8'));
      expect(await snap()).toBe(before);
      expect(notices.some((n) => n.includes('0 existing PLATFORM selections marked legacy, 0 legacy tenant-wide selections inserted'))).toBe(true);

      // A tenant created AFTER the migration gets no fallback.
      const later = randomUUID();
      await db.query(`INSERT INTO "identity"."Tenant" (id) VALUES ($1)`, [later]);
      expect((await resolution.resolve({ tenant_id: later, document_type_id: single })).outcome).toBe('SELECTION_REQUIRED');
    });
  },
);
