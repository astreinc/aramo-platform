import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EmailTemplateRepository } from '../lib/email-template.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// D-EMAIL-TPL-1 (ET-2) — reusable-email-template store: tenant isolation +
// D-1 Option C fallback precedence, against real Postgres 17. Skipped unless
// ARAMO_RUN_INTEGRATION=1. Globs the module's own migrations (self-contained
// schema, UUID-only cross-schema refs), so the ET-1 email_template migration is
// picked up automatically. At the pin (130bfb65) neither the table nor this repo
// existed — every assertion below was unrunnable/failing (the honest RED).

const ROOT = resolve(__dirname, '../../../..');

function communicationsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/communications/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

const KEY = 'requisition-contact';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'D-EMAIL-TPL-1 (ET-2) email-template store — tenant isolation + fallback (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let repo: EmailTemplateRepository;

    const TENANT_A = randomUUID();
    const TENANT_B = randomUUID();
    const AUTHOR = randomUUID();

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of communicationsMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new EmailTemplateRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('tenant A override is FOUND when queried as A, and NOT FOUND as B (isolation + fallback precedence)', async () => {
      const created = await repo.create({
        tenant_id: TENANT_A,
        template_key: KEY,
        category: 'requisition_initial_contact',
        name: 'Astre contact',
        subject_template: 'Re: {{requisition.title}}',
        body_template: 'Hi {{talent.first_name}},',
        created_by_id: AUTHOR,
      });

      // Tenant A → override exists → use override.
      const asA = await repo.findActiveByKey(TENANT_A, KEY);
      expect(asA).not.toBeNull();
      expect(asA?.id).toBe(created.id);
      expect(asA?.tenant_id).toBe(TENANT_A);

      // Tenant B → cross-tenant override is NEVER visible → system default applies.
      // (null from the store is the caller's signal to use the code-owned default.)
      const asB = await repo.findActiveByKey(TENANT_B, KEY);
      expect(asB).toBeNull();
    });

    it('each tenant sees only its own row; neither leaks across', async () => {
      const bRow = await repo.create({
        tenant_id: TENANT_B,
        template_key: KEY,
        category: 'requisition_initial_contact',
        name: 'B contact',
        subject_template: 'B: {{requisition.title}}',
        body_template: 'Hello {{talent.first_name}}.',
        created_by_id: AUTHOR,
      });

      const asA = await repo.findActiveByKey(TENANT_A, KEY);
      const asB = await repo.findActiveByKey(TENANT_B, KEY);
      expect(asA?.tenant_id).toBe(TENANT_A);
      expect(asB?.id).toBe(bRow.id);
      expect(asA?.id).not.toBe(asB?.id);

      // findByIdForTenant is tenant-scoped: A's id is invisible to B.
      expect(await repo.findByIdForTenant(TENANT_B, asA!.id)).toBeNull();
    });

    it('a deactivated override is not returned → the tenant falls back to the default', async () => {
      const t = randomUUID();
      const row = await repo.create({
        tenant_id: t,
        template_key: KEY,
        category: 'requisition_initial_contact',
        name: 'to be deactivated',
        subject_template: 'x',
        body_template: 'y',
        created_by_id: AUTHOR,
      });
      // Deactivate directly (the deactivate API lands in ET-4).
      await prisma.emailTemplate.update({ where: { id: row.id }, data: { is_active: false } });
      expect(await repo.findActiveByKey(t, KEY)).toBeNull();
    });

    it('the (tenant_id, template_key) unique constraint prevents a duplicate override', async () => {
      const t = randomUUID();
      await repo.create({
        tenant_id: t,
        template_key: KEY,
        category: 'requisition_initial_contact',
        name: 'first',
        subject_template: 's',
        body_template: 'b',
        created_by_id: AUTHOR,
      });
      await expect(
        repo.create({
          tenant_id: t,
          template_key: KEY,
          category: 'requisition_initial_contact',
          name: 'dupe',
          subject_template: 's2',
          body_template: 'b2',
          created_by_id: AUTHOR,
        }),
      ).rejects.toThrow();
    });
  },
);
