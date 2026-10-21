import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PrismaService,
  TemplatePlatformDefaultConflictError,
  TemplateResolutionService,
  TemplatesRepository,
} from '../index.js';

// DOC-TEMPLATE-LIB-1 T-6 (§9; ADR-0034 D9/D10) — withdrawal of an Aramo (PLATFORM) default
// on real Postgres 17: publish / cancel a withdrawal, the resolver before and after the
// effective date (tenant-template fallback, SELECTION_REQUIRED), generated documents keep
// their pin, one live default per type (partial unique index + typed refusals), the tenant
// notice read, and product tags never filter. Skipped unless ARAMO_RUN_INTEGRATION=1.
// Applies the documents module's own migrations (documents-only container: the T-3 RTR
// conversion is a NOTICE no-op, so every default here is created by the test under a
// fresh SYSTEM DocumentType).

const ROOT = resolve(__dirname, '../../../..');
const DAY = 86_400_000;

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-TEMPLATE-LIB-1 T-6 — Aramo default withdrawal — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let templates: TemplatesRepository;
    const ACTOR = randomUUID();

    // Resolver evaluated at an arbitrary instant (the effective date is in the future).
    const resolverAt = (at: Date): TemplateResolutionService => new TemplateResolutionService(templates, () => at);

    async function newDocumentType(): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
         VALUES ($1, NULL, $2, 'Doc', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
        [id, `T6_TYPE_${id.slice(0, 8)}`],
      );
      return id;
    }

    // An Aramo default published through the platform repository path (draft → preview →
    // publish), so the one-live-default check runs exactly as in production.
    async function publishDefault(typeId: string, products: string[] = ['ATS']): Promise<{ templateId: string; versionId: string }> {
      const t = await templates.createPlatformTemplate({
        document_type_id: typeId,
        name: 'Aramo default',
        template_kind: 'GENERATED',
        products,
        created_by: ACTOR,
      });
      const v = await templates.createPlatformVersion({
        template_id: t.id,
        render_schema_version: 'v1',
        field_schema: { blocks: [{ type: 'TEXT', text: 'Aramo wording' }] },
        created_by: ACTOR,
      });
      await templates.recordPlatformPreview(v.id);
      await templates.activatePlatformVersion({ version_id: v.id, actor_id: ACTOR });
      return { templateId: t.id, versionId: v.id };
    }

    // A TENANT template approved through the repository (approval also selects it).
    async function tenantTemplate(tenant: string, typeId: string, clientId?: string): Promise<{ templateId: string; versionId: string }> {
      const tpl = await templates.createTemplate({
        tenant_id: tenant,
        document_type_id: typeId,
        name: 'Own wording',
        template_kind: 'GENERATED',
        created_by: ACTOR,
        ...(clientId !== undefined ? { client_id: clientId } : {}),
      });
      const ver = await templates.createVersion({
        tenant_id: tenant,
        template_id: tpl.id,
        render_schema_version: 'v1',
        field_schema: { blocks: [] },
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: ver.id, actor_id: ACTOR, require_preview: false });
      return { templateId: tpl.id, versionId: ver.id };
    }

    async function conflictReason(p: Promise<unknown>): Promise<string> {
      try {
        await p;
      } catch (e) {
        if (e instanceof TemplatePlatformDefaultConflictError) return e.reason;
        throw e;
      }
      return 'NO_THROW';
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
    }, 300_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    // ── Publish / cancel a withdrawal ─────────────────────────────────────────
    it('withdraw sets notice = now and effective = now + N days; the hook (audit) runs before the write', async () => {
      const type = await newDocumentType();
      const def = await publishDefault(type);
      const now = new Date();
      const seen: Array<{ notice: Date; effective: Date; stateAtHook: Date | null }> = [];
      const t = await templates.withdrawPlatformTemplate({
        id: def.templateId,
        notice_days: 7,
        now,
        beforeWrite: async (p) => {
          const row = await templates.getPlatformTemplate(def.templateId);
          seen.push({ notice: p.withdraw_notice_at, effective: p.withdraw_effective_at, stateAtHook: row.withdraw_effective_at });
        },
      });
      expect(t.withdraw_notice_at?.getTime()).toBe(now.getTime());
      expect(t.withdraw_effective_at?.getTime()).toBe(now.getTime() + 7 * DAY);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.stateAtHook).toBeNull(); // hook ran BEFORE the write
      expect(seen[0]?.effective.getTime()).toBe(now.getTime() + 7 * DAY);
      // A second withdrawal is refused; a failing hook leaves the row untouched.
      expect(await conflictReason(templates.withdrawPlatformTemplate({ id: def.templateId, notice_days: 3 }))).toBe('already_withdrawn');
      const other = await publishDefault(await newDocumentType());
      await expect(
        templates.withdrawPlatformTemplate({
          id: other.templateId,
          notice_days: 7,
          beforeWrite: async () => {
            throw new Error('audit down');
          },
        }),
      ).rejects.toThrow('audit down');
      expect((await templates.getPlatformTemplate(other.templateId)).withdraw_effective_at).toBeNull();
    });

    it('only a published default can be withdrawn', async () => {
      const type = await newDocumentType();
      const draftOnly = await templates.createPlatformTemplate({
        document_type_id: type,
        name: 'Unpublished',
        template_kind: 'GENERATED',
        products: [],
        created_by: ACTOR,
      });
      expect(await conflictReason(templates.withdrawPlatformTemplate({ id: draftOnly.id, notice_days: 7 }))).toBe('template_not_published');
    });

    it('cancel before the effective date clears both dates; not after it; not when none is pending', async () => {
      const type = await newDocumentType();
      const def = await publishDefault(type);
      expect(await conflictReason(templates.cancelPlatformWithdrawal({ id: def.templateId }))).toBe('not_withdrawn');
      await templates.withdrawPlatformTemplate({ id: def.templateId, notice_days: 7 });
      const cancelled = await templates.cancelPlatformWithdrawal({ id: def.templateId });
      expect(cancelled.withdraw_notice_at).toBeNull();
      expect(cancelled.withdraw_effective_at).toBeNull();
      // notice_days 0 ⇒ effective immediately ⇒ can no longer be cancelled.
      await templates.withdrawPlatformTemplate({ id: def.templateId, notice_days: 0 });
      expect(await conflictReason(templates.cancelPlatformWithdrawal({ id: def.templateId }))).toBe('withdrawal_in_effect');
      // Seven days ahead of a 7-day notice: in effect too.
      const def2 = await publishDefault(await newDocumentType());
      await templates.withdrawPlatformTemplate({ id: def2.templateId, notice_days: 7 });
      expect(
        await conflictReason(templates.cancelPlatformWithdrawal({ id: def2.templateId, now: new Date(Date.now() + 8 * DAY) })),
      ).toBe('withdrawal_in_effect');
      // A default whose withdrawal is in effect accepts no new version.
      const v = await templates.createPlatformDraftFromActive({ template_id: def.templateId, created_by: ACTOR });
      await templates.recordPlatformPreview(v.id);
      expect(await conflictReason(templates.activatePlatformVersion({ version_id: v.id, actor_id: ACTOR }))).toBe('withdrawal_in_effect');
    });

    // ── Resolution before / after the effective date (§9, D10) ────────────────
    it('before the effective date the default still resolves; after it the tenant’s own approved template is used', async () => {
      const type = await newDocumentType();
      const def = await publishDefault(type);
      const tenant = randomUUID();
      const own = await tenantTemplate(tenant, type);
      // The tenant switches back to the Aramo default (removes its tenant-wide choice).
      await templates.deleteSelection(tenant, type, null);
      const now = new Date();
      await templates.withdrawPlatformTemplate({ id: def.templateId, notice_days: 7, now });

      const before = await resolverAt(new Date(now.getTime() + 6 * DAY)).resolve({ tenant_id: tenant, document_type_id: type });
      expect(before).toMatchObject({ outcome: 'RESOLVED', source: 'PLATFORM_DEFAULT', owner_scope: 'PLATFORM' });
      if (before.outcome === 'RESOLVED') expect(before.version.id).toBe(def.versionId);

      const after = await resolverAt(new Date(now.getTime() + 7 * DAY + 1)).resolve({ tenant_id: tenant, document_type_id: type });
      expect(after).toMatchObject({ outcome: 'RESOLVED', source: 'WITHDRAWAL_FALLBACK', owner_scope: 'TENANT' });
      if (after.outcome === 'RESOLVED') expect(after.version.id).toBe(own.versionId);
    });

    it('a tenant that SELECTED the withdrawn default falls back to its own approved template (client first, then tenant-wide)', async () => {
      const type = await newDocumentType();
      const def = await publishDefault(type);
      const tenant = randomUUID();
      const client = randomUUID();
      const wide = await tenantTemplate(tenant, type);
      const forClient = await tenantTemplate(tenant, type, client);
      await templates.upsertSelection({ tenant_id: tenant, document_type_id: type, client_id: null, template_id: def.templateId, selected_by: ACTOR });
      await templates.upsertSelection({ tenant_id: tenant, document_type_id: type, client_id: client, template_id: def.templateId, selected_by: ACTOR });
      const now = new Date();
      await templates.withdrawPlatformTemplate({ id: def.templateId, notice_days: 7, now });
      const later = resolverAt(new Date(now.getTime() + 8 * DAY));
      const r1 = await later.resolve({ tenant_id: tenant, document_type_id: type, client_id: client });
      expect(r1).toMatchObject({ outcome: 'RESOLVED', source: 'WITHDRAWAL_FALLBACK' });
      if (r1.outcome === 'RESOLVED') expect(r1.version.id).toBe(forClient.versionId);
      const r2 = await later.resolve({ tenant_id: tenant, document_type_id: type });
      if (r2.outcome === 'RESOLVED') expect(r2.version.id).toBe(wide.versionId);
      expect(r2.outcome).toBe('RESOLVED');
      // Another client of the same tenant: its client template is never used for it.
      const r3 = await later.resolve({ tenant_id: tenant, document_type_id: type, client_id: randomUUID() });
      if (r3.outcome === 'RESOLVED') expect(r3.version.id).toBe(wide.versionId);
    });

    it('no own template ⇒ SELECTION_REQUIRED — never another Aramo default (no silent wording swap)', async () => {
      const type = await newDocumentType();
      const old = await publishDefault(type);
      const tenant = randomUUID();
      await templates.upsertSelection({ tenant_id: tenant, document_type_id: type, client_id: null, template_id: old.templateId, selected_by: ACTOR });
      const now = new Date();
      await templates.withdrawPlatformTemplate({ id: old.templateId, notice_days: 7, now });
      // A replacement default is published during the notice window.
      const replacement = await publishDefault(type);
      const later = resolverAt(new Date(now.getTime() + 8 * DAY));
      expect(await later.resolve({ tenant_id: tenant, document_type_id: type })).toEqual({
        outcome: 'SELECTION_REQUIRED',
        withdrawn_template_ids: [old.templateId],
      });
      // A tenant with NO selection uses the replacement (the current Aramo default)…
      const fresh = await later.resolve({ tenant_id: randomUUID(), document_type_id: type });
      expect(fresh).toMatchObject({ outcome: 'RESOLVED', source: 'PLATFORM_DEFAULT' });
      if (fresh.outcome === 'RESOLVED') expect(fresh.template.id).toBe(replacement.templateId);
      // …and already prefers it during the notice window (the old one is being withdrawn).
      const during = await resolverAt(new Date(now.getTime() + DAY)).resolve({ tenant_id: randomUUID(), document_type_id: type });
      if (during.outcome === 'RESOLVED') expect(during.template.id).toBe(replacement.templateId);
      expect(during.outcome).toBe('RESOLVED');
    });

    it('a generated document keeps its pinned version after the withdrawal takes effect', async () => {
      const type = await newDocumentType();
      const def = await publishDefault(type);
      const tenant = randomUUID();
      const pinned = await resolverAt(new Date()).resolve({ tenant_id: tenant, document_type_id: type });
      expect(pinned.outcome).toBe('RESOLVED');
      const docId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."Document" (id, tenant_id, document_type_id, template_version_id, title, status, execution_mode, source_kind, created_by)
         VALUES ($1,$2,$3,$4,'Generated','DRAFT','SINGLE_SIGNATURE','TEMPLATE_GENERATED',$5)`,
        [docId, tenant, type, def.versionId, ACTOR],
      );
      const versionBefore = await templates.findVersionByIdOwnerAware(tenant, def.versionId);
      await templates.withdrawPlatformTemplate({ id: def.templateId, notice_days: 0 });
      // Resolution no longer offers the default…
      expect((await resolverAt(new Date(Date.now() + 1000)).resolve({ tenant_id: tenant, document_type_id: type })).outcome).toBe(
        'SELECTION_REQUIRED',
      );
      // …but the document's pin and the pinned version are untouched (provenance read works).
      const doc = await db.query(`SELECT template_version_id::text AS v FROM "documents"."Document" WHERE id = $1`, [docId]);
      expect(doc.rows[0].v).toBe(def.versionId);
      const versionAfter = await templates.findVersionByIdOwnerAware(tenant, def.versionId);
      expect(versionAfter).toEqual(versionBefore);
      expect(versionAfter?.status).toBe('ACTIVE');
    });

    // ── One live default per type (T-3 divergence 5) ──────────────────────────
    it('one live default per type: DB index + typed refusals; a replacement is publishable once the old one is withdrawn', async () => {
      const type = await newDocumentType();
      const first = await publishDefault(type);
      // Repository: publishing a second default while the first is live is refused.
      const second = await templates.createPlatformTemplate({ document_type_id: type, name: 'Second', template_kind: 'GENERATED', products: [], created_by: ACTOR });
      const v2 = await templates.createPlatformVersion({ template_id: second.id, render_schema_version: 'v1', field_schema: { blocks: [] }, created_by: ACTOR });
      await templates.recordPlatformPreview(v2.id);
      expect(await conflictReason(templates.activatePlatformVersion({ version_id: v2.id, actor_id: ACTOR }))).toBe('platform_default_live');
      expect((await templates.getPlatformTemplate(second.id)).status).toBe('DRAFT');
      // DB backstop: a raw second live row is rejected by the partial unique index.
      await expect(
        db.query(
          `INSERT INTO "documents"."DocumentTemplate" (id, owner_scope, tenant_id, document_type_id, name, template_kind, status, created_by)
           VALUES ($1,'PLATFORM',NULL,$2,'Raw','GENERATED','ACTIVE',$3)`,
          [randomUUID(), type, ACTOR],
        ),
      ).rejects.toThrow(/DocumentTemplate_one_live_platform_default/);
      // Withdraw the first (notice) → the replacement can be published.
      await templates.withdrawPlatformTemplate({ id: first.templateId, notice_days: 7 });
      expect((await templates.activatePlatformVersion({ version_id: v2.id, actor_id: ACTOR })).status).toBe('ACTIVE');
      // …and the first's withdrawal can no longer be cancelled (two live defaults).
      expect(await conflictReason(templates.cancelPlatformWithdrawal({ id: first.templateId }))).toBe('platform_default_live');
      // A TENANT template of the same type is never constrained.
      await expect(tenantTemplate(randomUUID(), type)).resolves.toBeDefined();
    });

    // ── Tenant notice (§9) ────────────────────────────────────────────────────
    it('notices: only tenants that rely on the default see it, with their own selections only; nothing cross-tenant', async () => {
      const type = await newDocumentType();
      const def = await publishDefault(type, ['SIGN']);
      const selector = randomUUID();
      const client = randomUUID();
      const fallbackOnly = randomUUID();
      const ownChoice = randomUUID();
      await templates.upsertSelection({ tenant_id: selector, document_type_id: type, client_id: client, template_id: def.templateId, selected_by: ACTOR });
      await templateSelectedOwn(ownChoice, type);
      await templates.withdrawPlatformTemplate({ id: def.templateId, notice_days: 7 });

      const forType = async (tenant: string) =>
        (await templates.listWithdrawalNoticesForTenant({ tenant_id: tenant, grace_days: 30 })).filter((n) => n.document_type_id === type);

      // The selecting tenant: its client selection names the default; it has no
      // tenant-wide selection, so it also falls back to it.
      const sel = await forType(selector);
      expect(sel).toHaveLength(1);
      expect(sel[0]).toMatchObject({
        template_id: def.templateId,
        selected_for_client_ids: [client],
        relies_on_default: true,
        has_own_template: false,
        in_effect: false,
        // D9 — product tags are informational: a SIGN-tagged default is listed for every tenant.
        products: ['SIGN'],
      });
      // A tenant with no selection relies on the fallback; it never sees another tenant's client ids.
      const fb = await forType(fallbackOnly);
      expect(fb).toHaveLength(1);
      expect(fb[0]).toMatchObject({ selected_for_client_ids: [], relies_on_default: true });
      // A tenant whose tenant-wide choice is its own template is not affected.
      expect(await forType(ownChoice)).toHaveLength(0);

      // A live replacement means a no-selection tenant no longer relies on the old default.
      await publishDefault(type);
      expect(await forType(fallbackOnly)).toHaveLength(0);
      expect(await forType(selector)).toHaveLength(1); // its client selection still names it
    });

    it('notices: in effect within the grace window, gone after it; cancelled withdrawals disappear', async () => {
      const type = await newDocumentType();
      const def = await publishDefault(type);
      const tenant = randomUUID();
      const forType = async (now: Date) =>
        (await templates.listWithdrawalNoticesForTenant({ tenant_id: tenant, grace_days: 30, now })).filter((n) => n.document_type_id === type);
      await templates.withdrawPlatformTemplate({ id: def.templateId, notice_days: 7 });
      expect((await forType(new Date()))[0]?.in_effect).toBe(false);
      expect((await forType(new Date(Date.now() + 8 * DAY)))[0]?.in_effect).toBe(true);
      expect(await forType(new Date(Date.now() + 38 * DAY))).toHaveLength(0);
      await templates.cancelPlatformWithdrawal({ id: def.templateId });
      expect(await forType(new Date())).toHaveLength(0);
    });

    // ── Product tags (D9) — recorded, editable, never filtering ────────────────
    it('product tags are recorded and editable and never hide a default from resolution', async () => {
      const type = await newDocumentType();
      const def = await publishDefault(type, ['SIGN']);
      expect((await templates.updatePlatformTemplate(def.templateId, { products: ['ATS', 'SIGN'] })).products).toEqual(['ATS', 'SIGN']);
      await templates.updatePlatformTemplate(def.templateId, { products: [] });
      // Any tenant resolves the default whatever its tags (no subscription filtering).
      const r = await resolverAt(new Date()).resolve({ tenant_id: randomUUID(), document_type_id: type });
      expect(r).toMatchObject({ outcome: 'RESOLVED', source: 'PLATFORM_DEFAULT' });
      expect((await templates.listPlatformTemplates()).find((t) => t.id === def.templateId)?.products).toEqual([]);
    });

    async function templateSelectedOwn(tenant: string, type: string): Promise<void> {
      await tenantTemplate(tenant, type);
    }
  },
);
