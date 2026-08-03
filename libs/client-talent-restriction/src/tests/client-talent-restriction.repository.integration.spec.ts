import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { makeMockLogger } from '@aramo/common';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { ClientTalentRestrictionRepository } from '../lib/client-talent-restriction.repository.js';
import type { CreateRestrictionInput } from '../lib/dto/client-talent-restriction.view.js';

// Track 3 / E7 — integration spec (real Postgres 17). One migration
// applies the whole module (record half only — no cross-lib deps). Asserts
// the ADR-0027 + Option-B tripwires end-to-end: the effective-window model,
// idempotency on the assertion identity, and the column-scoped BEFORE
// UPDATE / BEFORE DELETE immutability trigger (no reopen, no partial close,
// no scheduled_end_at mutation, no delete).

const INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260803163000_init_client_talent_restriction_model/migration.sql',
);

const DAY = 24 * 60 * 60 * 1000;

function baseInput(overrides: Partial<CreateRestrictionInput> = {}): CreateRestrictionInput {
  return {
    tenant_id: randomUUID(),
    client_company_id: randomUUID(),
    talent_record_id: randomUUID(),
    restriction_type: 'CLIENT_DO_NOT_RESUBMIT',
    asserted_by_type: 'CLIENT',
    asserting_organization_reference: null,
    asserting_contact_reference: null,
    source_system: 'FIELDGLASS',
    source_reference: `FIELDGLASS:${randomUUID()}`,
    raw_source_value: 'Do not resubmit this person.',
    reason_code: 'CLIENT_POLICY',
    recorded_by: randomUUID(),
    effective_from: new Date(Date.now() - DAY),
    scheduled_end_at: null,
    ...overrides,
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'ClientTalentRestrictionRepository — schema + immutability integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PrismaService;
    let prisma: PrismaService;
    let repo: ClientTalentRestrictionRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      setupClient = new PrismaService(url);
      await setupClient.$connect();
      const sql = readFileSync(INIT_MIGRATION_PATH, 'utf8');
      for (const stmt of splitDdl(sql)) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new ClientTalentRestrictionRepository(prisma, makeMockLogger());
    }, 120_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    // ---- creation + effective window ----

    it('creates an open-ended restriction with no closure provenance; reads active', async () => {
      const v = await repo.recordRestriction(baseInput(), 'req-1');
      expect(v.effective_to).toBeNull();
      expect(v.closed_at).toBeNull();
      expect(v.close_reason_code).toBeNull();
      expect(v.scheduled_end_at).toBeNull();
      expect(v.active).toBe(true);
    });

    it('creates with NO raw_source_value (VMS webhook — optional, PO ruling)', async () => {
      const v = await repo.recordRestriction(baseInput({ raw_source_value: null }), 'req-vms');
      expect(v.raw_source_value).toBeNull();
      expect(v.active).toBe(true);
    });

    it('creates with a future scheduled_end_at (Option B) — active, provenance-free', async () => {
      const input = baseInput({ scheduled_end_at: new Date(Date.now() + 30 * DAY) });
      const v = await repo.recordRestriction(input, 'req-2');
      expect(v.scheduled_end_at).not.toBeNull();
      expect(v.effective_to).toBeNull();
      expect(v.closed_at).toBeNull();
      expect(v.active).toBe(true);
    });

    it('a restriction past its scheduled_end_at reads inactive naturally (no close needed)', async () => {
      const input = baseInput({
        effective_from: new Date(Date.now() - 10 * DAY),
        scheduled_end_at: new Date(Date.now() - DAY),
      });
      const v = await repo.recordRestriction(input, 'req-3');
      expect(v.active).toBe(false);
      expect(v.effective_to).toBeNull(); // never closed — expired naturally
    });

    // ---- idempotency on the assertion identity ----

    it('same assertion identity returns the existing record (idempotent replay)', async () => {
      const input = baseInput();
      const first = await repo.recordRestriction(input, 'req-4a');
      const second = await repo.recordRestriction(input, 'req-4b');
      expect(second.id).toBe(first.id);
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::int AS n FROM client_talent_restriction."ClientTalentRestriction" WHERE tenant_id = $1 AND source_reference = $2`,
        input.tenant_id,
        input.source_reference,
      );
      expect(Number(rows[0].n)).toBe(1);
    });

    it('different-source duplicates of the same type for the same client+talent are PERMITTED', async () => {
      const shared = { tenant_id: randomUUID(), client_company_id: randomUUID(), talent_record_id: randomUUID() };
      const a = await repo.recordRestriction(
        baseInput({ ...shared, source_system: 'FIELDGLASS', source_reference: `FIELDGLASS:${randomUUID()}` }),
        'req-5a',
      );
      const b = await repo.recordRestriction(
        baseInput({ ...shared, source_system: 'BEELINE', source_reference: `BEELINE:${randomUUID()}` }),
        'req-5b',
      );
      expect(b.id).not.toBe(a.id);
      const current = await repo.findCurrentForClientTalent(shared);
      expect(current.length).toBe(2);
      expect(current.every((r) => r.active)).toBe(true);
    });

    // ---- explicit close ----

    it('closes early (before scheduled end); preserves scheduled_end_at; writes all six fields', async () => {
      const scheduled = new Date(Date.now() + 30 * DAY);
      const created = await repo.recordRestriction(baseInput({ scheduled_end_at: scheduled }), 'req-6');
      const closed = await repo.closeRestriction(
        {
          tenant_id: created.tenant_id,
          client_company_id: created.client_company_id,
          talent_record_id: created.talent_record_id,
          restriction_id: created.id,
          effective_to: new Date(Date.now() - 1000),
          closed_by: randomUUID(),
          close_reason_code: 'CLIENT_WITHDRAWN',
          close_source_system: 'CLIENT_EMAIL',
          close_source_reference: 'CLIENT_EMAIL:lift-123',
        },
        'req-6c',
      );
      expect(closed.effective_to).not.toBeNull();
      expect(closed.closed_at).not.toBeNull();
      expect(closed.closed_by).not.toBeNull();
      expect(closed.close_reason_code).toBe('CLIENT_WITHDRAWN');
      expect(closed.close_source_system).toBe('CLIENT_EMAIL');
      expect(closed.close_source_reference).toBe('CLIENT_EMAIL:lift-123');
      // The original scheduled end is PRESERVED, not overwritten.
      expect(closed.scheduled_end_at?.getTime()).toBe(scheduled.getTime());
      expect(closed.active).toBe(false);
    });

    it('rejects a second close (RESTRICTION_ALREADY_CLOSED)', async () => {
      const created = await repo.recordRestriction(baseInput(), 'req-7');
      const closeInput = {
        tenant_id: created.tenant_id,
        client_company_id: created.client_company_id,
        talent_record_id: created.talent_record_id,
        restriction_id: created.id,
        effective_to: new Date(),
        closed_by: randomUUID(),
        close_reason_code: 'CLIENT_WITHDRAWN' as const,
        close_source_system: 'CLIENT_EMAIL' as const,
        close_source_reference: 'CLIENT_EMAIL:x',
      };
      await repo.closeRestriction(closeInput, 'req-7a');
      await expect(repo.closeRestriction(closeInput, 'req-7b')).rejects.toMatchObject({
        code: 'RESTRICTION_ALREADY_CLOSED',
        statusCode: 409,
      });
    });

    it('rejects closing an already naturally-expired restriction (RESTRICTION_INVALID)', async () => {
      const created = await repo.recordRestriction(
        baseInput({ effective_from: new Date(Date.now() - 10 * DAY), scheduled_end_at: new Date(Date.now() - DAY) }),
        'req-8',
      );
      await expect(
        repo.closeRestriction(
          {
            tenant_id: created.tenant_id,
            client_company_id: created.client_company_id,
            talent_record_id: created.talent_record_id,
            restriction_id: created.id,
            effective_to: new Date(Date.now() - 2 * DAY),
            closed_by: randomUUID(),
            close_reason_code: 'CLIENT_WITHDRAWN',
            close_source_system: 'CLIENT_EMAIL',
            close_source_reference: 'CLIENT_EMAIL:y',
          },
          'req-8c',
        ),
      ).rejects.toMatchObject({ code: 'RESTRICTION_INVALID', statusCode: 422 });
    });

    it('rejects a close whose effective_to precedes effective_from (RESTRICTION_INVALID)', async () => {
      const created = await repo.recordRestriction(baseInput({ effective_from: new Date() }), 'req-9');
      await expect(
        repo.closeRestriction(
          {
            tenant_id: created.tenant_id,
            client_company_id: created.client_company_id,
            talent_record_id: created.talent_record_id,
            restriction_id: created.id,
            effective_to: new Date(Date.now() - 5 * DAY),
            closed_by: randomUUID(),
            close_reason_code: 'CLIENT_WITHDRAWN',
            close_source_system: 'CLIENT_EMAIL',
            close_source_reference: 'CLIENT_EMAIL:z',
          },
          'req-9c',
        ),
      ).rejects.toMatchObject({ code: 'RESTRICTION_INVALID' });
    });

    // ---- immutability trigger (raw SQL) ----

    async function seedClosedRow(): Promise<{ id: string; tenant_id: string }> {
      const created = await repo.recordRestriction(baseInput(), 'seed');
      await repo.closeRestriction(
        {
          tenant_id: created.tenant_id,
          client_company_id: created.client_company_id,
          talent_record_id: created.talent_record_id,
          restriction_id: created.id,
          effective_to: new Date(),
          closed_by: randomUUID(),
          close_reason_code: 'CLIENT_WITHDRAWN',
          close_source_system: 'CLIENT_EMAIL',
          close_source_reference: 'CLIENT_EMAIL:seed',
        },
        'seed-c',
      );
      return { id: created.id, tenant_id: created.tenant_id };
    }

    it('trigger rejects REOPENING a closed restriction (R4b)', async () => {
      const { id } = await seedClosedRow();
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE client_talent_restriction."ClientTalentRestriction" SET effective_to = NULL, closed_at = NULL, closed_by = NULL, close_reason_code = NULL, close_source_system = NULL, close_source_reference = NULL WHERE id = '${id}'`,
        ),
      ).rejects.toThrow(/append-and-close-only/);
    });

    it('trigger rejects a PARTIAL close (effective_to without provenance)', async () => {
      const created = await repo.recordRestriction(baseInput(), 'partial');
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE client_talent_restriction."ClientTalentRestriction" SET effective_to = now() WHERE id = '${created.id}'`,
        ),
      ).rejects.toThrow(/append-and-close-only/);
    });

    it('trigger rejects mutating scheduled_end_at (immutable, Option B)', async () => {
      const created = await repo.recordRestriction(
        baseInput({ scheduled_end_at: new Date(Date.now() + 30 * DAY) }),
        'sched',
      );
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE client_talent_restriction."ClientTalentRestriction" SET scheduled_end_at = now() + interval '90 days' WHERE id = '${created.id}'`,
        ),
      ).rejects.toThrow(/append-and-close-only/);
    });

    it('trigger rejects mutating effective_from and assertion provenance', async () => {
      const created = await repo.recordRestriction(baseInput(), 'prov');
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE client_talent_restriction."ClientTalentRestriction" SET effective_from = now() WHERE id = '${created.id}'`,
        ),
      ).rejects.toThrow(/append-and-close-only/);
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE client_talent_restriction."ClientTalentRestriction" SET source_system = 'BEELINE' WHERE id = '${created.id}'`,
        ),
      ).rejects.toThrow(/append-and-close-only/);
    });

    it('trigger rejects DELETE (R4 — reversal is by effective_to, never DELETE)', async () => {
      const created = await repo.recordRestriction(baseInput(), 'del');
      await expect(
        setupClient.$executeRawUnsafe(
          `DELETE FROM client_talent_restriction."ClientTalentRestriction" WHERE id = '${created.id}'`,
        ),
      ).rejects.toThrow(/not deletable/);
    });

    // ---- scoping ----

    it('current reads are tenant-isolated', async () => {
      const input = baseInput();
      await repo.recordRestriction(input, 'iso');
      const otherTenant = await repo.findCurrentForClientTalent({
        tenant_id: randomUUID(),
        client_company_id: input.client_company_id,
        talent_record_id: input.talent_record_id,
      });
      expect(otherTenant.length).toBe(0);
    });

    it('current reads are client-scoped (no cross-client leakage, R2)', async () => {
      const input = baseInput();
      await repo.recordRestriction(input, 'clientscope');
      const otherClient = await repo.findCurrentForClientTalent({
        tenant_id: input.tenant_id,
        client_company_id: randomUUID(),
        talent_record_id: input.talent_record_id,
      });
      expect(otherClient.length).toBe(0);
    });

    it('"currently restricted" = ANY active; closing one active leaves the other', async () => {
      const shared = { tenant_id: randomUUID(), client_company_id: randomUUID(), talent_record_id: randomUUID() };
      const a = await repo.recordRestriction(
        baseInput({ ...shared, source_system: 'FIELDGLASS', source_reference: `FIELDGLASS:${randomUUID()}` }),
        'cur-a',
      );
      await repo.recordRestriction(
        baseInput({ ...shared, source_system: 'BEELINE', source_reference: `BEELINE:${randomUUID()}` }),
        'cur-b',
      );
      expect((await repo.findCurrentForClientTalent(shared)).length).toBe(2);
      await repo.closeRestriction(
        { ...shared, restriction_id: a.id, effective_to: new Date(), closed_by: randomUUID(), close_reason_code: 'CLIENT_WITHDRAWN', close_source_system: 'CLIENT_EMAIL', close_source_reference: 'CLIENT_EMAIL:cur' },
        'cur-c',
      );
      const stillActive = await repo.findCurrentForClientTalent(shared);
      expect(stillActive.length).toBe(1);
      // History still shows BOTH source-attributed records within the one client context.
      expect((await repo.findHistoryForClientTalent(shared)).length).toBe(2);
    });
  },
);

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
