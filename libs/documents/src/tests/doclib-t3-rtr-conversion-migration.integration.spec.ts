import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// DOC-TEMPLATE-LIB-1 T-3 (§5) — the guarded RTR conversion migration
// (20261021140100_doclib_t3_rtr_platform_default) on real Postgres 17. Skipped unless
// ARAMO_RUN_INTEGRATION=1. Each scenario gets its OWN database: an identity."Tenant" stub
// (the only identity object the documents migrations read) with the scenario's tenants,
// then every documents migration BEFORE the conversion (so the RTR-TEMPLATE-1 backfill
// seeds the sentinel + tenant RTR templates exactly as it did in production), then the
// conversion itself.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = resolve(ROOT, 'libs/documents/prisma/migrations');
const CONVERSION = '20261021140100_doclib_t3_rtr_platform_default';
const CONVERSION_SQL = readFileSync(resolve(MIGRATIONS, CONVERSION, 'migration.sql'), 'utf8');
const SENTINEL = '01900000-0000-7000-8000-000000000100';
const RTR = 'd0c50005-0000-7000-8000-000000000001';
const SYSTEM = '00000000-0000-0000-0000-000000000000';

function migrationsBeforeConversion(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((n) => /^\d/.test(n) && n < CONVERSION)
    .sort()
    .map((n) => resolve(MIGRATIONS, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-TEMPLATE-LIB-1 T-3 — RTR conversion migration — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let admin: Client;
    const open: Client[] = [];
    let seq = 0;

    // A fresh database: optional identity."Tenant" stub (+ rows), then the pre-conversion
    // documents migrations.
    async function freshDb(opts: { identity: boolean; tenants?: string[] }): Promise<Client> {
      const name = `t3_conv_${++seq}`;
      await admin.query(`CREATE DATABASE ${name}`);
      const url = new URL(container.getConnectionUri());
      url.pathname = `/${name}`;
      const db = new Client({ connectionString: url.toString() });
      await db.connect();
      open.push(db);
      if (opts.identity) {
        await db.query(`CREATE SCHEMA "identity"`);
        await db.query(`CREATE TABLE "identity"."Tenant" ("id" UUID PRIMARY KEY, "is_active" BOOLEAN NOT NULL DEFAULT true)`);
        for (const t of opts.tenants ?? []) await db.query(`INSERT INTO "identity"."Tenant" ("id") VALUES ($1)`, [t]);
      }
      for (const p of migrationsBeforeConversion()) await db.query(readFileSync(p, 'utf8'));
      return db;
    }

    async function rtrTemplates(db: Client) {
      const r = await db.query(
        `SELECT id::text, owner_scope, tenant_id::text, status, current_version_id::text, name
           FROM "documents"."DocumentTemplate" WHERE document_type_id = $1 ORDER BY created_at, id`,
        [RTR],
      );
      return r.rows as Array<{ id: string; owner_scope: string; tenant_id: string | null; status: string; current_version_id: string | null; name: string }>;
    }

    // The backfill leaves current_version_id NULL (see the migration header), so the
    // version is read by template.
    async function onlyVersion(db: Client, templateId: string): Promise<string> {
      const r = await db.query(`SELECT id::text FROM "documents"."TemplateVersion" WHERE template_id = $1`, [templateId]);
      expect(r.rows).toHaveLength(1);
      return r.rows[0].id as string;
    }

    async function triggersEnabled(db: Client): Promise<Record<string, string>> {
      const r = await db.query(
        `SELECT tgname, tgenabled FROM pg_trigger
          WHERE tgrelid = '"documents"."TemplateVersion"'::regclass
            AND tgname IN ('template_version_immutability', 'template_version_tenant_matches_template')`,
      );
      return Object.fromEntries(r.rows.map((x: { tgname: string; tgenabled: string }) => [x.tgname, x.tgenabled]));
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      admin = new Client({ connectionString: container.getConnectionUri() });
      await admin.connect();
    }, 300_000);

    afterAll(async () => {
      for (const c of open) await c.end().catch(() => undefined);
      await admin?.end();
      await container?.stop();
    }, 120_000);

    it('converts the sentinel RTR template + versions to the Aramo default, selects each tenant’s own RTR template, re-enables triggers, and is idempotent', async () => {
      const a = randomUUID();
      const b = randomUUID();
      const db = await freshDb({ identity: true, tenants: [SENTINEL, a, b] });
      const before = await rtrTemplates(db);
      expect(before).toHaveLength(3); // the backfill seeded sentinel + a + b
      const sentinelTpl = before.find((t) => t.tenant_id === SENTINEL)!;
      const sentinelVersion = await onlyVersion(db, sentinelTpl.id);
      // The backfill pinned nothing (same-statement CTE visibility) — the conversion repairs it.
      expect(sentinelTpl.current_version_id).toBeNull();

      await db.query(CONVERSION_SQL);

      const after = await rtrTemplates(db);
      const platform = after.filter((t) => t.owner_scope === 'PLATFORM');
      expect(platform).toHaveLength(1);
      expect(platform[0]).toMatchObject({ id: sentinelTpl.id, tenant_id: null, status: 'ACTIVE', current_version_id: sentinelVersion });
      expect(after.filter((t) => t.tenant_id === SENTINEL)).toHaveLength(0);
      const versions = await db.query(`SELECT tenant_id, status FROM "documents"."TemplateVersion" WHERE template_id = $1`, [sentinelTpl.id]);
      expect(versions.rows).toEqual([{ tenant_id: null, status: 'ACTIVE' }]);

      // Tenant templates untouched; each tenant's own template is its explicit selection.
      const sels = await db.query(
        `SELECT tenant_id::text, client_id, template_id::text, selected_by::text FROM "documents"."TenantTemplateSelection" ORDER BY tenant_id`,
      );
      const own = Object.fromEntries(after.filter((t) => t.owner_scope === 'TENANT').map((t) => [t.tenant_id, t.id]));
      expect(sels.rows).toHaveLength(2);
      for (const s of sels.rows) {
        expect(s.template_id).toBe(own[s.tenant_id]);
        expect(s.client_id).toBeNull();
        expect(s.selected_by).toBe(SYSTEM);
      }

      // Triggers back on, and the T-1 freeze still holds for the converted versions.
      expect(await triggersEnabled(db)).toEqual({ template_version_immutability: 'O', template_version_tenant_matches_template: 'O' });
      await expect(
        db.query(`UPDATE "documents"."TemplateVersion" SET tenant_id = $1 WHERE template_id = $2`, [a, sentinelTpl.id]),
      ).rejects.toThrow(/immutable/);

      // Idempotent re-run: no error, nothing changes.
      await db.query(CONVERSION_SQL);
      expect(await rtrTemplates(db)).toEqual(after);
      expect((await db.query(`SELECT count(*)::int AS n FROM "documents"."TenantTemplateSelection"`)).rows[0].n).toBe(2);
      expect(await triggersEnabled(db)).toEqual({ template_version_immutability: 'O', template_version_tenant_matches_template: 'O' });
    });

    it('fails closed — listing the ids — when another tenant’s Document / DocumentRevision references a sentinel version, and changes nothing', async () => {
      const a = randomUUID();
      const db = await freshDb({ identity: true, tenants: [SENTINEL, a] });
      const sentinelTpl = (await rtrTemplates(db)).find((t) => t.tenant_id === SENTINEL)!;
      const sentinelVersion = await onlyVersion(db, sentinelTpl.id);
      const doc = randomUUID();
      const rev = randomUUID();
      await db.query(
        `INSERT INTO "documents"."Document" (id, tenant_id, document_type_id, template_version_id, title, status, execution_mode, source_kind, created_by)
         VALUES ($1,$2,$3,$4,'RTR','DRAFT','SINGLE_SIGNATURE','TEMPLATE_GENERATED',$5)`,
        [doc, a, RTR, sentinelVersion, SYSTEM],
      );
      await db.query(
        `INSERT INTO "documents"."DocumentRevision" (id, tenant_id, document_id, revision_number, template_version_id, status, created_by)
         VALUES ($1,$2,$3,1,$4,'FROZEN',$5)`,
        [rev, a, doc, sentinelVersion, SYSTEM],
      );
      const before = await rtrTemplates(db);
      const err = await db.query(CONVERSION_SQL).then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/other tenants reference the sentinel RTR template/);
      expect(err?.message).toContain(`Document ${doc}`);
      expect(err?.message).toContain(`DocumentRevision ${rev}`);
      expect(await rtrTemplates(db)).toEqual(before);
      expect((await db.query(`SELECT count(*)::int AS n FROM "documents"."TenantTemplateSelection"`)).rows[0].n).toBe(0);
      expect(await triggersEnabled(db)).toEqual({ template_version_immutability: 'O', template_version_tenant_matches_template: 'O' });
    });

    it('fails closed — listing the tenant — when a tenant holds more than one ACTIVE tenant-wide RTR template, and converts nothing', async () => {
      const a = randomUUID();
      const db = await freshDb({ identity: true, tenants: [SENTINEL, a] });
      const second = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate" (id, tenant_id, document_type_id, name, template_kind, status, created_by)
         VALUES ($1,$2,$3,'Second RTR','GENERATED','ACTIVE',$4)`,
        [second, a, RTR, SYSTEM],
      );
      const before = await rtrTemplates(db);
      const err = await db.query(CONVERSION_SQL).then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/more than one ACTIVE tenant-wide RTR template/);
      expect(err?.message).toContain(`tenant ${a}`);
      expect(err?.message).toContain(second);
      // Atomic: the sentinel conversion earlier in the same block rolled back too.
      expect(await rtrTemplates(db)).toEqual(before);
      expect(await triggersEnabled(db)).toEqual({ template_version_immutability: 'O', template_version_tenant_matches_template: 'O' });
    });

    it('fails closed when the sentinel holds more than one RTR template', async () => {
      const db = await freshDb({ identity: true, tenants: [SENTINEL] });
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate" (id, tenant_id, document_type_id, name, template_kind, status, created_by)
         VALUES ($1,$2,$3,'Extra','GENERATED','DRAFT',$4)`,
        [randomUUID(), SENTINEL, RTR, SYSTEM],
      );
      await expect(db.query(CONVERSION_SQL)).rejects.toThrow(/sentinel tenant holds 2 RTR templates/);
    });

    it('fails closed when the sentinel RTR template has no current version and no single ACTIVE version to pin', async () => {
      const db = await freshDb({ identity: true, tenants: [SENTINEL] });
      const sentinelTpl = (await rtrTemplates(db)).find((t) => t.tenant_id === SENTINEL)!;
      await db.query(`UPDATE "documents"."TemplateVersion" SET status = 'RETIRED', retired_at = now() WHERE template_id = $1`, [sentinelTpl.id]);
      await expect(db.query(CONVERSION_SQL)).rejects.toThrow(/has no current version and 0 ACTIVE versions/);
      expect((await rtrTemplates(db)).find((t) => t.id === sentinelTpl.id)?.owner_scope).toBe('TENANT');
    });

    it('fails closed when the sentinel tenant exists but holds no RTR template and no Aramo default exists', async () => {
      const db = await freshDb({ identity: true, tenants: [] });
      await db.query(`INSERT INTO "identity"."Tenant" ("id") VALUES ($1)`, [SENTINEL]);
      await expect(db.query(CONVERSION_SQL)).rejects.toThrow(/sentinel tenant exists but holds no RTR template/);
    });

    it('fresh environment (sentinel Tenant row not yet seeded): creates the Aramo RTR default with the default content', async () => {
      const db = await freshDb({ identity: true, tenants: [] });
      await db.query(CONVERSION_SQL);
      const rows = await rtrTemplates(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ owner_scope: 'PLATFORM', tenant_id: null, status: 'ACTIVE', name: 'Standard Right to Represent' });
      const v = await db.query(
        `SELECT tenant_id, status, version_number, render_schema_version, field_schema FROM "documents"."TemplateVersion" WHERE id = $1`,
        [rows[0]?.current_version_id],
      );
      expect(v.rows[0]).toMatchObject({ tenant_id: null, status: 'ACTIVE', version_number: 1, render_schema_version: 'rtr-generated-v1' });
      expect(v.rows[0].field_schema.blocks[1].text).toContain('{{talent.full_name}}');
      // Re-run is a no-op.
      await db.query(CONVERSION_SQL);
      expect(await rtrTemplates(db)).toEqual(rows);
    });

    it('documents-only container (no identity."Tenant"): a NOTICE no-op', async () => {
      const db = await freshDb({ identity: false });
      await db.query(CONVERSION_SQL);
      expect(await rtrTemplates(db)).toHaveLength(0);
    });
  },
);
