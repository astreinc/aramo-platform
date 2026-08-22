import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RequisitionSubmittalEligibilityReader } from '../lib/requisition-eligibility-reader.js';

// L8-B2 — the requisition-grain Client Status reader proof (real Postgres 17). Derives
// OPEN / PAUSED / CLOSED (+ reason) per requisition from the SubmittalEligibility truth
// (policy window + consumed count), SET-oriented, excluding the per-Talent restriction.

const INIT = resolve(
  __dirname,
  '../../prisma/migrations/20260822120000_init_submittal_eligibility_model/migration.sql',
);

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let dollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) { dollar = !dollar; cur += '$$'; i += 1; continue; }
    if (sql[i] === ';' && !dollar) { out.push(cur); cur = ''; } else { cur += sql[i]; }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const NOW = new Date('2026-08-22T12:00:00.000Z');
const PAST = new Date('2026-08-01T00:00:00.000Z');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RequisitionSubmittalEligibilityReader — requisition-grain Client Status (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let reader: RequisitionSubmittalEligibilityReader;
    const tenant = randomUUID();
    const reqNoPolicy = randomUUID();
    const reqOpen = randomUUID();
    const reqPaused = randomUUID();
    const reqDeadline = randomUUID();
    const reqLimit = randomUUID();
    const reqManualClosed = randomUUID();

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const s of splitDdl(readFileSync(INIT, 'utf8'))) {
        if (s.trim()) await setup.$executeRawUnsafe(s.trim());
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
      reader = new RequisitionSubmittalEligibilityReader(prisma);

      const policy = (requisition_id: string, data: Record<string, unknown>) =>
        prisma.requisitionSubmittalPolicy.create({
          data: { tenant_id: tenant, requisition_id, submittal_authority: 'ARAMO', ...data },
        });
      await policy(reqOpen, { manual_override: 'OPEN' });
      await policy(reqPaused, { manual_override: 'PAUSED' });
      await policy(reqDeadline, { submittal_deadline: PAST });
      await policy(reqLimit, { submittal_limit: 1 });
      await policy(reqManualClosed, { manual_override: 'CLOSED' });
      // reqLimit is at its cap: one consumption row already exists.
      await prisma.submittalConsumption.create({
        data: { tenant_id: tenant, requisition_id: reqLimit, talent_record_id: randomUUID(), submittal_id: randomUUID() },
      });
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    it('derives OPEN/PAUSED/CLOSED (+ reason) per requisition; no-policy ⇒ OPEN', async () => {
      // BEFORE (non-vacuous): the policy substrate really is seeded.
      expect(await prisma.requisitionSubmittalPolicy.count({ where: { tenant_id: tenant } })).toBe(5);
      expect(await prisma.submittalConsumption.count({ where: { tenant_id: tenant, requisition_id: reqLimit } })).toBe(1);

      const m = await reader.deriveByRequisitionIds(
        tenant,
        [reqNoPolicy, reqOpen, reqPaused, reqDeadline, reqLimit, reqManualClosed],
        NOW,
      );

      // AFTER (exact): every requisition resolves to its authoritative status + reason.
      expect(m.get(reqNoPolicy)).toEqual({ status: 'open', reason: null }); // R-DEFAULT-OPEN
      expect(m.get(reqOpen)).toEqual({ status: 'open', reason: null });
      expect(m.get(reqPaused)).toEqual({ status: 'paused', reason: 'paused' });
      expect(m.get(reqDeadline)).toEqual({ status: 'closed', reason: 'deadline_passed' });
      expect(m.get(reqLimit)).toEqual({ status: 'closed', reason: 'limit_reached' });
      expect(m.get(reqManualClosed)).toEqual({ status: 'closed', reason: 'manual_hold' });
    });

    it('empty id set ⇒ empty map (no query)', async () => {
      expect((await reader.deriveByRequisitionIds(tenant, [], NOW)).size).toBe(0);
    });
  },
);
