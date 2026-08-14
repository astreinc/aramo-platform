import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { VisibilityContextShape } from '@aramo/common';
import { PrismaService, PlacementProcessEventRepository } from '@aramo/placement';

import { ReportingService } from '../lib/reporting.service.js';

// T9-B2 — bearing libs/reporting integration proof (real Postgres 17): the
// ReportingService.getFallthrough FOLD over the REAL placement cohort read.
// The placement aggregate SQL is exhaustively proven in libs/placement's
// fallthrough-cohort.integration.spec; here we tie the service fold (rate +
// reason group-by + null→"Unspecified" bucket) to real placement data end to
// end. see-all actor → requisitionRepository is never called (stub).

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260807120000_placement_fallthrough_reason',
  '20260808120000_placement_replacement_link',
  '20260809120000_placement_contract_assignment',
  '20260810100000_placement_assignment_ended_value',
  '20260810110000_placement_assignment_aware_guard',
  '20260810120000_placement_assignment_end_reason',
  '20260810130000_t5_assignment_rate_version',
  '20260812140000_t6_b1_effective_window_substrate',
  '20260813130000_t6_b3_commercial_cancellation',
  '20260814120000_t7_permanent_placement',
].map((d) =>
  resolve(__dirname, `../../../placement/prisma/migrations/${d}/migration.sql`),
);

const FROM = new Date('2026-05-01T00:00:00.000Z');
const TO = new Date('2026-06-01T00:00:00.000Z');
const at = (base: Date, days: number): Date =>
  new Date(base.getTime() + days * 86_400_000);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T9-B2 reporting fallthrough fold (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let svc: ReportingService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      const placementEventRepository = new PlacementProcessEventRepository(prisma);
      svc = new ReportingService(
        {} as never, // company
        {} as never, // contact
        {} as never, // talentRecord
        {} as never, // savedList
        {} as never, // calendar
        {} as never, // activity
        {} as never, // requisition (see-all → never called)
        {} as never, // pipeline
        {} as never, // tenantSetting
        {} as never, // capacity
        placementEventRepository,
      );
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function seed(args: {
      tenant_id: string;
      requisition_id: string;
      acceptedAt?: Date;
      terminal?: 'FELL_THROUGH' | 'NO_SHOW' | 'STARTED';
      reason_code?: string | null;
      reason_label?: string | null;
    }): Promise<void> {
      const ppId = randomUUID();
      await prisma.placementProcess.create({
        data: {
          id: ppId,
          tenant_id: args.tenant_id,
          submittal_id: randomUUID(),
          requisition_id: args.requisition_id,
          talent_record_id: randomUUID(),
          state: (args.terminal ?? 'OFFER_ACCEPTED') as never,
          offered_at: FROM,
        },
      });
      const ev = async (to: string, when: Date, code?: string | null, label?: string | null): Promise<void> => {
        await prisma.placementProcessEvent.create({
          data: {
            id: randomUUID(),
            tenant_id: args.tenant_id,
            placement_process_id: ppId,
            event_type: 'state_transition' as never,
            event_payload: { from: 'x', to },
            created_at: when,
            ...(code === undefined ? {} : { reason_code: code }),
            ...(label === undefined ? {} : { reason_label_snapshot: label }),
          },
        });
      };
      if (args.acceptedAt !== undefined) await ev('OFFER_ACCEPTED', args.acceptedAt);
      if (args.terminal !== undefined) await ev(args.terminal, at(FROM, 10), args.reason_code, args.reason_label);
    }

    it('folds real placement data into rate + grouped reasons incl. Unspecified', async () => {
      const t = randomUUID();
      const req = randomUUID();
      // 4 accepted: 2 fall through (1 coded, 1 null-reason), 1 no-show (coded), 1 started
      await seed({ tenant_id: t, requisition_id: req, acceptedAt: at(FROM, 1), terminal: 'FELL_THROUGH', reason_code: 'start_date_failed', reason_label: 'Start date failed' });
      await seed({ tenant_id: t, requisition_id: req, acceptedAt: at(FROM, 1), terminal: 'FELL_THROUGH', reason_code: null, reason_label: null });
      await seed({ tenant_id: t, requisition_id: req, acceptedAt: at(FROM, 2), terminal: 'NO_SHOW', reason_code: 'talent_unreachable', reason_label: 'Talent unreachable' });
      await seed({ tenant_id: t, requisition_id: req, acceptedAt: at(FROM, 2), terminal: 'STARTED' });

      const actor = {
        tenant_id: t,
        user_id: 'u',
        scopes: ['report:read'],
        visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
      };
      const v = await svc.getFallthrough(actor, { from: FROM, to: TO });

      expect(v.accepted_attempts).toBe(4);
      expect(v.fallthrough_attempts).toBe(3); // 2 fell through + 1 no-show
      expect(v.fallthrough_rate).toBe(75); // round(3/4*100)
      // three buckets, each count 1 → 33% each; Unspecified present, sorts last
      expect(v.reasons).toHaveLength(3);
      const labels = v.reasons.map((r) => r.reason_label);
      expect(labels).toContain('Unspecified');
      expect(labels).toContain('Start date failed');
      expect(labels).toContain('Talent unreachable');
      // No reason_detail key anywhere in the serialized response (§16).
      expect(JSON.stringify(v)).not.toContain('reason_detail');
    });
  },
);

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
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
