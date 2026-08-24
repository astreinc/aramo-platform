import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementProcessEventRepository } from '../lib/placement-process-event.repository.js';

// T9-B2 — placement fallthrough cohort aggregate (real Postgres 17), the read
// authority for the reporting fallthrough report. Governed by
// Aramo-T9-B2-Directive-v1_0-LOCKED. Proves the SQL semantics:
//   - denominator = distinct PlacementProcess whose FIRST OFFER_ACCEPTED
//     transition ∈ [from,to) (D-2/D-4);
//   - numerator = those that later terminate in FELL_THROUGH or NO_SHOW only
//     (D-1) — OFFER_DECLINED/OFFER_RESCINDED/STARTED/still-live excluded;
//   - reason = the terminal event's reason_code + reason_label_snapshot (D-3);
//   - cohort boundary [from,to) inclusive-from/exclusive-to;
//   - duplicate history never double-counts (first OFFER_ACCEPTED / one terminal);
//   - requisition_ids filter (A3) + tenant isolation.

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260807120000_placement_fallthrough_reason',
  '20260808120000_placement_replacement_link',
  '20260809120000_placement_contract_assignment',
  '20260825120000_assignment_extension_horizon',
  '20260810100000_placement_assignment_ended_value',
  '20260810110000_placement_assignment_aware_guard',
  '20260810120000_placement_assignment_end_reason',
  '20260810130000_t5_assignment_rate_version',
  '20260812140000_t6_b1_effective_window_substrate',
  '20260813130000_t6_b3_commercial_cancellation',
  '20260814120000_t7_permanent_placement',
  '20260824120000_init_offer_model',
  '20260824130000_placement_offer_id',
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

const FROM = new Date('2026-05-01T00:00:00.000Z');
const TO = new Date('2026-06-01T00:00:00.000Z');
const DAY = 86_400_000;
const at = (base: Date, days: number): Date =>
  new Date(base.getTime() + days * DAY);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T9-B2 fallthrough cohort (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: PlacementProcessEventRepository;

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
      repo = new PlacementProcessEventRepository(prisma);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    // Seed one placement attempt: a PlacementProcess row + its events. Each event
    // is a state_transition with event_payload {from,to}. `acceptedAt` (if given)
    // writes an OFFER_ACCEPTED event; `terminal`+`terminalAt` writes the terminal
    // transition carrying the reason.
    async function seedAttempt(args: {
      tenant_id: string;
      requisition_id: string;
      acceptedAt?: Date;
      terminal?: 'FELL_THROUGH' | 'NO_SHOW' | 'OFFER_RESCINDED' | 'STARTED';
      terminalAt?: Date;
      reason_code?: string | null;
      reason_label?: string | null;
      declinedOnly?: boolean; // OFFER_EXTENDED -> OFFER_DECLINED, never accepted
    }): Promise<string> {
      const ppId = randomUUID();
      await prisma.placementProcess.create({
        data: {
          id: ppId,
          tenant_id: args.tenant_id,
          submittal_id: randomUUID(),
          requisition_id: args.requisition_id,
          talent_record_id: randomUUID(),
          state: (args.terminal ??
            (args.declinedOnly ? 'OFFER_DECLINED' : 'OFFER_ACCEPTED')) as never,
          offered_at: FROM,
        },
      });
      const ev = async (
        to: string,
        when: Date,
        reason_code?: string | null,
        reason_label?: string | null,
      ): Promise<void> => {
        await prisma.placementProcessEvent.create({
          data: {
            id: randomUUID(),
            tenant_id: args.tenant_id,
            placement_process_id: ppId,
            event_type: 'state_transition' as never,
            event_payload: { from: 'x', to },
            created_at: when,
            ...(reason_code === undefined ? {} : { reason_code }),
            ...(reason_label === undefined ? {} : { reason_label_snapshot: reason_label }),
          },
        });
      };
      if (args.declinedOnly === true) {
        await ev('OFFER_DECLINED', args.terminalAt ?? at(FROM, 2));
        return ppId;
      }
      if (args.acceptedAt !== undefined) await ev('OFFER_ACCEPTED', args.acceptedAt);
      if (args.terminal !== undefined) {
        await ev(
          args.terminal,
          args.terminalAt ?? at(FROM, 10),
          args.reason_code,
          args.reason_label,
        );
      }
      return ppId;
    }

    const tenantWide = { tenant_id: '', from: FROM, to: TO };

    it('FELL_THROUGH + NO_SHOW count numerator; OFFER_RESCINDED/STARTED/live are denominator-only', async () => {
      const t = randomUUID();
      const req = randomUUID();
      // 5 accepted attempts in-window:
      await seedAttempt({ tenant_id: t, requisition_id: req, acceptedAt: at(FROM, 1), terminal: 'FELL_THROUGH', terminalAt: at(FROM, 5), reason_code: 'start_date_failed', reason_label: 'Start date failed' });
      await seedAttempt({ tenant_id: t, requisition_id: req, acceptedAt: at(FROM, 1), terminal: 'NO_SHOW', terminalAt: at(FROM, 6), reason_code: 'talent_unreachable', reason_label: 'Talent unreachable' });
      await seedAttempt({ tenant_id: t, requisition_id: req, acceptedAt: at(FROM, 2), terminal: 'OFFER_RESCINDED', terminalAt: at(FROM, 7), reason_code: 'client_role_cancelled', reason_label: 'Client role cancelled' });
      await seedAttempt({ tenant_id: t, requisition_id: req, acceptedAt: at(FROM, 2), terminal: 'STARTED', terminalAt: at(FROM, 8) });
      await seedAttempt({ tenant_id: t, requisition_id: req, acceptedAt: at(FROM, 3) }); // still live
      // A DECLINED attempt that never reached OFFER_ACCEPTED — excluded from denom:
      await seedAttempt({ tenant_id: t, requisition_id: req, declinedOnly: true });

      const r = await repo.readFallthroughCohort({ ...tenantWide, tenant_id: t });
      expect(r.accepted_attempts).toBe(5); // the 5 accepted (declined-only excluded)
      expect(r.fallthrough).toHaveLength(2); // only FELL_THROUGH + NO_SHOW
      const codes = r.fallthrough.map((f) => f.reason_code).sort();
      expect(codes).toEqual(['start_date_failed', 'talent_unreachable']);
    });

    it('cohort boundary: first OFFER_ACCEPTED inclusive-from, exclusive-to', async () => {
      const t = randomUUID();
      const req = randomUUID();
      await seedAttempt({ tenant_id: t, requisition_id: req, acceptedAt: at(FROM, -1), terminal: 'FELL_THROUGH' }); // before → out
      await seedAttempt({ tenant_id: t, requisition_id: req, acceptedAt: FROM, terminal: 'FELL_THROUGH' }); // at from → in
      await seedAttempt({ tenant_id: t, requisition_id: req, acceptedAt: TO, terminal: 'FELL_THROUGH' }); // at to → out
      const r = await repo.readFallthroughCohort({ tenant_id: t, from: FROM, to: TO });
      expect(r.accepted_attempts).toBe(1);
      expect(r.fallthrough).toHaveLength(1);
    });

    it('duplicate history never double-counts (first OFFER_ACCEPTED, one terminal)', async () => {
      const t = randomUUID();
      const req = randomUUID();
      const ppId = randomUUID();
      await prisma.placementProcess.create({
        data: { id: ppId, tenant_id: t, submittal_id: randomUUID(), requisition_id: req, talent_record_id: randomUUID(), state: 'FELL_THROUGH' as never, offered_at: FROM },
      });
      const raw = async (to: string, when: Date, code?: string): Promise<void> => {
        await prisma.placementProcessEvent.create({ data: { id: randomUUID(), tenant_id: t, placement_process_id: ppId, event_type: 'state_transition' as never, event_payload: { from: 'x', to }, created_at: when, ...(code === undefined ? {} : { reason_code: code, reason_label_snapshot: code }) } });
      };
      await raw('OFFER_ACCEPTED', at(FROM, 3));
      await raw('OFFER_ACCEPTED', at(FROM, 4)); // duplicate accept row
      await raw('FELL_THROUGH', at(FROM, 9), 'client_cancelled');
      await raw('FELL_THROUGH', at(FROM, 10), 'client_cancelled'); // duplicate terminal row
      const r = await repo.readFallthroughCohort({ tenant_id: t, from: FROM, to: TO });
      expect(r.accepted_attempts).toBe(1);
      expect(r.fallthrough).toHaveLength(1);
      expect(r.fallthrough[0]?.reason_code).toBe('client_cancelled');
    });

    it('captures a missing reason (null) on a fallthrough terminal', async () => {
      const t = randomUUID();
      const req = randomUUID();
      await seedAttempt({ tenant_id: t, requisition_id: req, acceptedAt: at(FROM, 1), terminal: 'FELL_THROUGH', terminalAt: at(FROM, 5), reason_code: null, reason_label: null });
      const r = await repo.readFallthroughCohort({ tenant_id: t, from: FROM, to: TO });
      expect(r.accepted_attempts).toBe(1);
      expect(r.fallthrough).toHaveLength(1);
      expect(r.fallthrough[0]?.reason_code).toBeNull();
    });

    it('A3 requisition_ids filter narrows the cohort; tenant isolation holds', async () => {
      const t = randomUUID();
      const other = randomUUID();
      const reqVisible = randomUUID();
      const reqHidden = randomUUID();
      await seedAttempt({ tenant_id: t, requisition_id: reqVisible, acceptedAt: at(FROM, 1), terminal: 'FELL_THROUGH' });
      await seedAttempt({ tenant_id: t, requisition_id: reqHidden, acceptedAt: at(FROM, 1), terminal: 'FELL_THROUGH' });
      // another tenant, same requisition id space — must never leak
      await seedAttempt({ tenant_id: other, requisition_id: reqVisible, acceptedAt: at(FROM, 1), terminal: 'FELL_THROUGH' });

      const scoped = await repo.readFallthroughCohort({ tenant_id: t, from: FROM, to: TO, requisition_ids: [reqVisible] });
      expect(scoped.accepted_attempts).toBe(1);
      expect(scoped.fallthrough).toHaveLength(1);

      const wide = await repo.readFallthroughCohort({ tenant_id: t, from: FROM, to: TO });
      expect(wide.accepted_attempts).toBe(2); // both req of tenant t, not other tenant
    });
  },
);

// DDL splitter — statement boundaries on ';', honoring '$$' bodies and skipping
// '--' line comments (older placement migrations carry '-- …;' lines).
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
