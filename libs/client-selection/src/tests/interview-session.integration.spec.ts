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

// Lane 2 / L2-F (F2) — the InterviewSession child acceptance proofs (F2.1 schedule +
// precondition, F2.2 session CAS + legality + reschedule, F2.3 durable events on the
// SHARED log + immutability + 404-visibility). Applies the F1 init migration (the parent
// process + shared event log + triggers) THEN the F2 InterviewSession migration.
const MIGRATIONS = [
  '../../prisma/migrations/20260829120000_l2f_init_client_selection/migration.sql',
  '../../prisma/migrations/20260830120000_l2f2_interview_session/migration.sql',
  '../../prisma/migrations/20260831130000_l3d_interview_round_unique/migration.sql',
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
  'L2-F F2 InterviewSession (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setup: PrismaService;
    let prisma: PrismaService;
    let processRepo: ClientSelectionProcessRepository;
    let repo: InterviewSessionRepository;

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
      repo = new InterviewSessionRepository(prisma);
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
    async function sessionEvents(sessionId: string) {
      return prisma.clientSelectionEvent.findMany({
        where: { subject_id: sessionId, subject_type: 'session' },
        orderBy: { created_at: 'asc' },
      });
    }

    // ----------------------------------------------------------------------
    // F2.1 — schedule under a valid non-terminal process.
    // ----------------------------------------------------------------------
    it('F2.1: schedule yields a SCHEDULED session with denormalized keys + a session-subject event + outbox', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const interviewer = randomUUID();

      const s = await repo.scheduleInterview({
        tenant_id: tenant,
        client_selection_process_id: p.id,
        interview_type: 'onsite',
        round: 2,
        scheduled_at: new Date('2026-09-01T15:00:00Z'),
        interviewer_user_ids: [interviewer],
        created_by_id: randomUUID(),
        requestId: 'sch',
        visible_requisition_ids: null,
      });
      expect(s.state).toBe('SCHEDULED');
      expect(s.version).toBe(0);
      expect(s.client_selection_process_id).toBe(p.id);
      expect(s.requisition_id).toBe(req); // denormalized from parent
      expect(s.talent_record_id).toBe(p.talent_id);
      expect(s.round).toBe(2);
      expect(s.interviewer_user_ids).toEqual([interviewer]);

      const events = await sessionEvents(s.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe('client_selection.interview.scheduled');
      expect(events[0]!.subject_type).toBe('session');
      const outbox = await prisma.outboxEvent.findMany({
        where: { tenant_id: tenant, event_type: 'client_selection.interview.scheduled' },
      });
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.published_at).toBeNull();
    });

    // L3-D — (process, round) uniqueness. A second schedule at the SAME round is refused
    // deterministically (INTERVIEW_ROUND_EXISTS 409); the first session stays the only row
    // for that round. A different round is allowed. (Reschedule transitions the existing
    // session in place; a re-attempt uses the next round — D-3 keeps process state manual.)
    it('L3-D: a duplicate schedule at the same (process, round) is refused INTERVIEW_ROUND_EXISTS (409); one row per round', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      await repo.scheduleInterview({
        tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'phone',
        round: 1, scheduled_at: new Date(), requestId: 'd1', visible_requisition_ids: null,
      });
      await expect(
        repo.scheduleInterview({
          tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'phone',
          round: 1, scheduled_at: new Date(), requestId: 'd2', visible_requisition_ids: null,
        }),
      ).rejects.toMatchObject({ code: 'INTERVIEW_ROUND_EXISTS', statusCode: 409 });
      // A different round is allowed.
      const second = await repo.scheduleInterview({
        tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'phone',
        round: 2, scheduled_at: new Date(), requestId: 'd3', visible_requisition_ids: null,
      });
      expect(second.round).toBe(2);
      const count = await prisma.interviewSession.count({
        where: { client_selection_process_id: p.id },
      });
      expect(count).toBe(2);
    }, 60_000);

    it('F2.1(neg): scheduling under a non-existent process is CLIENT_SELECTION_PROCESS_INVALID (409)', async () => {
      await expect(
        repo.scheduleInterview({
          tenant_id: randomUUID(),
          client_selection_process_id: randomUUID(),
          interview_type: 'phone',
          scheduled_at: new Date(),
          requestId: 'n1',
          visible_requisition_ids: null,
        }),
      ).rejects.toMatchObject({ code: 'CLIENT_SELECTION_PROCESS_INVALID', statusCode: 409 });
    });

    it('F2.1(neg): scheduling under a TERMINAL process is CLIENT_SELECTION_PROCESS_INVALID (409), no session written', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      // Drive the process terminal.
      await processRepo.transition({ tenant_id: tenant, id: p.id, to_state: 'WITHDRAWN', expected_version: 0, changed_by_id: randomUUID(), requestId: 't', visible_requisition_ids: null });
      await expect(
        repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'phone', scheduled_at: new Date(), requestId: 'n2', visible_requisition_ids: null }),
      ).rejects.toMatchObject({ code: 'CLIENT_SELECTION_PROCESS_INVALID', statusCode: 409 });
      const count = await prisma.interviewSession.count({ where: { client_selection_process_id: p.id } });
      expect(count).toBe(0);
    });

    it('F2.1(neg): scheduling under a NOT-VISIBLE process is CLIENT_SELECTION_PROCESS_INVALID (409)', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      await expect(
        repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'phone', scheduled_at: new Date(), requestId: 'n3', visible_requisition_ids: new Set([randomUUID()]) }),
      ).rejects.toMatchObject({ code: 'CLIENT_SELECTION_PROCESS_INVALID', statusCode: 409 });
    });

    // ----------------------------------------------------------------------
    // F2.2 — session CAS + legality + reschedule.
    // ----------------------------------------------------------------------
    it('F2.2: two session transitions with the same expected_version — one commits (+1), one conflicts, no extra event', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const s = await repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'video', scheduled_at: new Date(), requestId: 'x', visible_requisition_ids: null });

      const results = await Promise.allSettled([
        repo.transitionInterview({ tenant_id: tenant, id: s.id, to_state: 'COMPLETED', expected_version: 0, changed_by_id: randomUUID(), requestId: 'a', visible_requisition_ids: null }),
        repo.transitionInterview({ tenant_id: tenant, id: s.id, to_state: 'CANCELED', expected_version: 0, changed_by_id: randomUUID(), requestId: 'b', visible_requisition_ids: null }),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect(bad[0]!.reason?.code).toBe('INTERVIEW_SESSION_TRANSITION_CONFLICT');

      const after = await repo.findSessionById({ tenant_id: tenant, id: s.id, visible_requisition_ids: null });
      expect(after!.version).toBe(1);
      // birth (scheduled) + exactly one transition.
      expect(await sessionEvents(s.id)).toHaveLength(2);
    });

    it('F2.2(legality): a terminal session refuses any transition (INVALID_INTERVIEW_SESSION_TRANSITION 422)', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const s = await repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'phone', scheduled_at: new Date(), requestId: 'y', visible_requisition_ids: null });
      const done = await repo.transitionInterview({ tenant_id: tenant, id: s.id, to_state: 'NO_SHOW', expected_version: 0, changed_by_id: randomUUID(), requestId: 'y2', visible_requisition_ids: null });
      expect(done.state).toBe('NO_SHOW');
      await expect(
        repo.transitionInterview({ tenant_id: tenant, id: s.id, to_state: 'COMPLETED', expected_version: done.version, changed_by_id: randomUUID(), requestId: 'y3', visible_requisition_ids: null }),
      ).rejects.toMatchObject({ code: 'INVALID_INTERVIEW_SESSION_TRANSITION', statusCode: 422 });
    });

    it('F2.2(reschedule): RESCHEDULED updates scheduled_at and self-loops', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const s = await repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'onsite', scheduled_at: new Date('2026-09-01T10:00:00Z'), requestId: 'r', visible_requisition_ids: null });
      const newAt = new Date('2026-09-05T12:00:00Z');
      const r1 = await repo.transitionInterview({ tenant_id: tenant, id: s.id, to_state: 'RESCHEDULED', expected_version: 0, scheduled_at: newAt, changed_by_id: randomUUID(), requestId: 'r1', visible_requisition_ids: null });
      expect(r1.state).toBe('RESCHEDULED');
      expect(r1.scheduled_at).toBe(newAt.toISOString());
      // re-reschedule (self-loop) is legal.
      const r2 = await repo.transitionInterview({ tenant_id: tenant, id: s.id, to_state: 'RESCHEDULED', expected_version: r1.version, scheduled_at: new Date('2026-09-06T09:00:00Z'), changed_by_id: randomUUID(), requestId: 'r2', visible_requisition_ids: null });
      expect(r2.state).toBe('RESCHEDULED');
      expect(r2.version).toBe(2);
    });

    // ----------------------------------------------------------------------
    // F2.3 — session events on the SHARED log are immutable; visibility 404.
    // ----------------------------------------------------------------------
    it('F2.3: a session event rejects UPDATE + DELETE; the tenant-reset escape may DELETE', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const s = await repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'phone', scheduled_at: new Date(), requestId: 'i', visible_requisition_ids: null });
      const ev = (await sessionEvents(s.id))[0]!;

      await expect(
        prisma.$executeRawUnsafe(`UPDATE client_selection."ClientSelectionEvent" SET event_type = 'x' WHERE id = '${ev.id}'`),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe(`DELETE FROM client_selection."ClientSelectionEvent" WHERE id = '${ev.id}'`),
      ).rejects.toThrow();
      expect(await sessionEvents(s.id)).toHaveLength(1);

      await prisma.$executeRawUnsafe(
        `DO $do$ BEGIN PERFORM set_config('app.tenant_reset', 'authorized', true); ` +
          `DELETE FROM client_selection."ClientSelectionEvent" WHERE id = '${ev.id}'; END $do$;`,
      );
      expect(await sessionEvents(s.id)).toHaveLength(0);
    });

    it('F2.3(visibility): findSessionById conceals a session whose requisition is outside the visible set (null → 404)', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const s = await repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'phone', scheduled_at: new Date(), requestId: 'v', visible_requisition_ids: null });
      const hidden = await repo.findSessionById({ tenant_id: tenant, id: s.id, visible_requisition_ids: new Set([randomUUID()]) });
      expect(hidden).toBeNull();
      const shown = await repo.findSessionById({ tenant_id: tenant, id: s.id, visible_requisition_ids: new Set([req]) });
      expect(shown!.id).toBe(s.id);
    });
  },
);
