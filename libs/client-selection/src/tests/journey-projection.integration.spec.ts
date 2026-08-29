import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { ClientSelectionProcessRepository } from '../lib/client-selection.repository.js';
import { InterviewSessionRepository } from '../lib/interview-session.repository.js';
import { JourneyProjectionRepository } from '../lib/journey-projection.repository.js';

// Lane 2 / L2-F (F3) — the owner-sourced journey-stage projection proofs (F3.2 derive,
// F3.3 neg-control). The projection reads ONLY the ClientSelectionProcess/InterviewSession
// owner, so a stage exists iff the owner substrate exists — proving the interview +
// client-decline stages are owner-sourced, not the retired Pipeline truths.
const MIGRATIONS = [
  '../../prisma/migrations/20260829120000_l2f_init_client_selection/migration.sql',
  '../../prisma/migrations/20260830120000_l2f2_interview_session/migration.sql',
].map((p) => resolve(__dirname, p));

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      cur += ch;
      continue;
    }
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L2-F F3 owner-sourced journey projection (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setup: PrismaService;
    let prisma: PrismaService;
    let processRepo: ClientSelectionProcessRepository;
    let interviews: InterviewSessionRepository;
    let projection: JourneyProjectionRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setup = new PrismaService(url);
      await setup.$connect();
      for (const m of MIGRATIONS) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          if (s.trim()) await setup.$executeRawUnsafe(s.trim());
        }
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      processRepo = new ClientSelectionProcessRepository(prisma);
      interviews = new InterviewSessionRepository(prisma);
      projection = new JourneyProjectionRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setup?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function seedProcess(tenant: string, req: string) {
      return processRepo.create({
        tenant_id: tenant,
        submittal_id: randomUUID(),
        requisition_id: req,
        talent_id: randomUUID(),
        site_id: randomUUID(),
      });
    }

    // F3.2 — INTERVIEW derived from an InterviewSession.
    it('F3.2: an InterviewSession yields an owner-attributed INTERVIEW stage', async () => {
      const tenant = randomUUID();
      const p = await seedProcess(tenant, randomUUID());
      await interviews.scheduleInterview({
        tenant_id: tenant,
        client_selection_process_id: p.id,
        interview_type: 'onsite',
        scheduled_at: new Date('2026-09-01T15:00:00Z'),
        requestId: 's',
        visible_requisition_ids: null,
      });
      const stages = await projection.deriveJourneyStages({
        tenant_id: tenant,
        client_selection_process_id: p.id,
      });
      expect(stages).toHaveLength(1);
      expect(stages[0]).toMatchObject({
        stage: 'INTERVIEW',
        source: 'client-selection',
        client_selection_process_id: p.id,
        occurred_at: '2026-09-01T15:00:00.000Z',
      });
    }, 60_000);

    // F3.2 — CLIENT_DECLINED derived from the process DECLINED state.
    it('F3.2: a DECLINED process yields an owner-attributed CLIENT_DECLINED stage', async () => {
      const tenant = randomUUID();
      const p = await seedProcess(tenant, randomUUID());
      await processRepo.transition({
        tenant_id: tenant,
        id: p.id,
        to_state: 'DECLINED',
        expected_version: 0,
        changed_by_id: randomUUID(),
        requestId: 'd',
        visible_requisition_ids: null,
      });
      const stages = await projection.deriveJourneyStages({
        tenant_id: tenant,
        client_selection_process_id: p.id,
      });
      expect(stages.map((s) => s.stage)).toEqual(['CLIENT_DECLINED']);
      expect(stages[0]!.source).toBe('client-selection');
    }, 60_000);

    // F3.2 — both stages when the process interviewed AND declined.
    it('F3.2: an interviewed-then-declined process yields BOTH stages', async () => {
      const tenant = randomUUID();
      const p = await seedProcess(tenant, randomUUID());
      // Move to INTERVIEW, schedule a session, then DECLINE.
      const iv = await processRepo.transition({ tenant_id: tenant, id: p.id, to_state: 'INTERVIEW', expected_version: 0, changed_by_id: randomUUID(), requestId: 'i', visible_requisition_ids: null });
      await interviews.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'video', scheduled_at: new Date('2026-09-02T10:00:00Z'), requestId: 's', visible_requisition_ids: null });
      await processRepo.transition({ tenant_id: tenant, id: p.id, to_state: 'DECLINED', expected_version: iv.version, changed_by_id: randomUUID(), requestId: 'd', visible_requisition_ids: null });
      const stages = await projection.deriveJourneyStages({ tenant_id: tenant, client_selection_process_id: p.id });
      expect(stages.map((s) => s.stage).sort()).toEqual(['CLIENT_DECLINED', 'INTERVIEW']);
    }, 60_000);

    // F3.3 — neg-control: no owner substrate → no stage (owner-sourced, not pipeline).
    it('F3.3(neg): a non-existent process yields NO stages (owner-sourced)', async () => {
      const stages = await projection.deriveJourneyStages({
        tenant_id: randomUUID(),
        client_selection_process_id: randomUUID(),
      });
      expect(stages).toEqual([]);
    }, 60_000);

    it('F3.3(neg): a process with no InterviewSession and not DECLINED yields NO INTERVIEW/CLIENT_DECLINED stage', async () => {
      const tenant = randomUUID();
      const p = await seedProcess(tenant, randomUUID()); // rests at CLIENT_REVIEW, no sessions
      const stages = await projection.deriveJourneyStages({ tenant_id: tenant, client_selection_process_id: p.id });
      expect(stages).toEqual([]);
    }, 60_000);

    // F3.3 — deleting the owner rows makes the stage disappear (the sharp neg-control).
    it('F3.3(neg): deleting the InterviewSession removes the INTERVIEW stage', async () => {
      const tenant = randomUUID();
      const p = await seedProcess(tenant, randomUUID());
      await interviews.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'phone', scheduled_at: new Date(), requestId: 's', visible_requisition_ids: null });
      expect(await projection.deriveJourneyStages({ tenant_id: tenant, client_selection_process_id: p.id })).toHaveLength(1);
      await prisma.interviewSession.deleteMany({ where: { client_selection_process_id: p.id } });
      expect(await projection.deriveJourneyStages({ tenant_id: tenant, client_selection_process_id: p.id })).toEqual([]);
    }, 60_000);
  },
);
