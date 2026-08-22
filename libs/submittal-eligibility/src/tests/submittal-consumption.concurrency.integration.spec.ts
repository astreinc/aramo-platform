import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { consumeSlot } from '../lib/submittal-consumption.js';

// L8-B1 — the load-bearing SAFETY PROOF (real Postgres 17). Serialized slot
// consumption under a `SELECT … FOR UPDATE` policy-row lock: limit=1 + two
// SIMULTANEOUS requests ⇒ exactly ONE commit + one LIMIT_REACHED (§6 Approach A,
// A4 / TE-3). Plus the idempotency floor (same Talent never consumes twice).

const INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260822120000_init_submittal_eligibility_model/migration.sql',
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

async function seedPolicy(
  prisma: PrismaService,
  tenant_id: string,
  requisition_id: string,
  submittal_limit: number | null,
): Promise<void> {
  await prisma.requisitionSubmittalPolicy.create({
    data: {
      tenant_id,
      requisition_id,
      submittal_limit,
      submittal_authority: 'ARAMO',
    },
  });
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'SubmittalConsumption — serialized slot consumption (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PrismaService;
    let prisma: PrismaService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setupClient = new PrismaService(url);
      await setupClient.$connect();
      const sql = readFileSync(INIT_MIGRATION_PATH, 'utf8');
      for (const stmt of splitDdl(sql)) {
        if (stmt.trim().length === 0) continue;
        await setupClient.$executeRawUnsafe(stmt.trim());
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
    }, 120_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('limit=1 + two SIMULTANEOUS requests → exactly one CONSUMED, one LIMIT_REACHED', async () => {
      const tenant_id = randomUUID();
      const requisition_id = randomUUID();
      const talentA = randomUUID();
      const talentB = randomUUID();
      await seedPolicy(prisma, tenant_id, requisition_id, 1);

      // BEFORE: zero consumed.
      expect(
        await prisma.submittalConsumption.count({
          where: { tenant_id, requisition_id },
        }),
      ).toBe(0);

      const [a, b] = await Promise.all([
        prisma.$transaction((tx) =>
          consumeSlot(tx, {
            tenant_id,
            requisition_id,
            talent_record_id: talentA,
            submittal_id: randomUUID(),
            limit: 1,
          }),
        ),
        prisma.$transaction((tx) =>
          consumeSlot(tx, {
            tenant_id,
            requisition_id,
            talent_record_id: talentB,
            submittal_id: randomUUID(),
            limit: 1,
          }),
        ),
      ]);

      // EXACTLY one winner (the FOR UPDATE serialization guarantee).
      expect([a.status, b.status].sort()).toEqual([
        'CONSUMED',
        'LIMIT_REACHED',
      ]);
      // AFTER: exactly one consumption row exists — not two.
      expect(
        await prisma.submittalConsumption.count({
          where: { tenant_id, requisition_id },
        }),
      ).toBe(1);
    });

    it('idempotency: the same Talent consuming twice → CONSUMED then ALREADY_CONSUMED, one row', async () => {
      const tenant_id = randomUUID();
      const requisition_id = randomUUID();
      const talent = randomUUID();
      await seedPolicy(prisma, tenant_id, requisition_id, 5);

      const first = await prisma.$transaction((tx) =>
        consumeSlot(tx, {
          tenant_id,
          requisition_id,
          talent_record_id: talent,
          submittal_id: randomUUID(),
          limit: 5,
        }),
      );
      const second = await prisma.$transaction((tx) =>
        consumeSlot(tx, {
          tenant_id,
          requisition_id,
          talent_record_id: talent,
          submittal_id: randomUUID(),
          limit: 5,
        }),
      );

      expect(first.status).toBe('CONSUMED');
      expect(second.status).toBe('ALREADY_CONSUMED');
      if (first.status !== 'LIMIT_REACHED' && second.status !== 'LIMIT_REACHED') {
        expect(second.consumption_id).toBe(first.consumption_id);
      }
      expect(
        await prisma.submittalConsumption.count({
          where: { tenant_id, requisition_id },
        }),
      ).toBe(1);
    });

    it('no limit (unbounded) → distinct Talents both CONSUMED', async () => {
      const tenant_id = randomUUID();
      const requisition_id = randomUUID();
      await seedPolicy(prisma, tenant_id, requisition_id, null);

      const r1 = await prisma.$transaction((tx) =>
        consumeSlot(tx, {
          tenant_id,
          requisition_id,
          talent_record_id: randomUUID(),
          submittal_id: randomUUID(),
          limit: null,
        }),
      );
      const r2 = await prisma.$transaction((tx) =>
        consumeSlot(tx, {
          tenant_id,
          requisition_id,
          talent_record_id: randomUUID(),
          submittal_id: randomUUID(),
          limit: null,
        }),
      );
      expect(r1.status).toBe('CONSUMED');
      expect(r2.status).toBe('CONSUMED');
    });
  },
);
