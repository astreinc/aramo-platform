import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';

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
  '../../prisma/migrations/20260930120000_calint_b_interview_scheduling_fields/migration.sql',
  '../../prisma/migrations/20260930130000_calint_c_interview_meeting_link/migration.sql',
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
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
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
    // Slice 0 (Calendar/Interview LOCKED §4) — DETERMINISTIC concurrency proof of the
    // version-in-write CAS. A `SELECT ... FOR UPDATE` row-lock barrier, held on a SEPARATE
    // connection, forces BOTH transitions to complete their advisory pre-read (each reads
    // version 0) and then PARK at their guarded write. We release the barrier only once
    // pg_stat_activity proves both writers are blocked on the lock — so determinism comes
    // from the lock, NOT from which task the pool happens to run first. Under the fixed
    // (updateMany WHERE version) write exactly one commits; the previous unguarded
    // `update({ where: { id } })` let BOTH commit (version 2, two transition events).
    async function blockedInterviewWriters(): Promise<number> {
      const rows = await setup.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n
           FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND state = 'active'
            AND query ILIKE '%InterviewSession%'
            AND query ILIKE '%UPDATE%'`,
      );
      return Number(rows[0]!.n);
    }

    it('F2.2: two same-version transitions race past a row-lock barrier — exactly one commits (+1), one conflicts, no extra event', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const s = await repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'video', scheduled_at: new Date(), requestId: 'x', visible_requisition_ids: null });

      // Barrier: hold the row FOR UPDATE (no data change → committed version stays 0) so
      // both writers pass their pre-read and block at the write.
      let releaseBarrier!: () => void;
      const barrierReleased = new Promise<void>((r) => { releaseBarrier = r; });
      let signalHeld!: () => void;
      const barrierHeld = new Promise<void>((r) => { signalHeld = r; });
      const holder = setup.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT id FROM "client_selection"."InterviewSession" WHERE id = $1::uuid FOR UPDATE`,
          s.id,
        );
        signalHeld();
        await barrierReleased;
      }, { timeout: 30_000, maxWait: 30_000 });

      try {
        await barrierHeld; // lock is held before we launch the writers

        const a = repo.transitionInterview({ tenant_id: tenant, id: s.id, to_state: 'COMPLETED', expected_version: 0, changed_by_id: randomUUID(), requestId: 'a', visible_requisition_ids: null });
        const b = repo.transitionInterview({ tenant_id: tenant, id: s.id, to_state: 'CANCELED', expected_version: 0, changed_by_id: randomUUID(), requestId: 'b', visible_requisition_ids: null });

        // Wait until BOTH writers are provably parked on the row lock (past their pre-read).
        for (let i = 0; i < 400 && (await blockedInterviewWriters()) < 2; i++) {
          await new Promise((r) => setTimeout(r, 25));
        }
        expect(await blockedInterviewWriters()).toBe(2);

        releaseBarrier();
        await holder;

        const results = await Promise.allSettled([a, b]);
        const ok = results.filter((r) => r.status === 'fulfilled');
        const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        expect(ok).toHaveLength(1);
        expect(bad).toHaveLength(1);
        expect(bad[0]!.reason?.code).toBe('INTERVIEW_SESSION_TRANSITION_CONFLICT');
        expect(bad[0]!.reason?.statusCode).toBe(409);
      } finally {
        releaseBarrier();
        await holder.catch(() => undefined);
      }

      const after = await repo.findSessionById({ tenant_id: tenant, id: s.id, visible_requisition_ids: null });
      expect(after!.version).toBe(1); // old + 1, NOT +2
      // birth (scheduled) + EXACTLY ONE transition — the loser's tx rolled back (no event).
      expect(await sessionEvents(s.id)).toHaveLength(2);
    }, 60_000);

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
    // F2-CAL (Slice A, Calendar/Interview §6) — the bounded interview CALENDAR
    // read projection sourced from InterviewSession. Window-bounded, visibility-
    // scoped, optional ANDed filters (requisition / talent / interviewer / state).
    // ----------------------------------------------------------------------
    it('F2-CAL: listForCalendar bounds by [from,to), filters by requisition/talent/interviewer/state, and conceals non-visible requisitions', async () => {
      const tenant = randomUUID();
      const reqA = randomUUID();
      const reqB = randomUUID();
      const pA = await seedProcess(tenant, reqA);
      const pB = await seedProcess(tenant, reqB);
      const ivrX = randomUUID();
      const ivrY = randomUUID();

      // In-window sessions.
      const a1 = await repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: pA.id, interview_type: 'video', round: 1, scheduled_at: new Date('2026-10-05T15:00:00Z'), interviewer_user_ids: [ivrX], requestId: 'c1', visible_requisition_ids: null });
      const b1 = await repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: pB.id, interview_type: 'phone', round: 1, scheduled_at: new Date('2026-10-06T09:00:00Z'), interviewer_user_ids: [ivrY], requestId: 'c2', visible_requisition_ids: null });
      // Out-of-window session (excluded by the half-open window).
      await repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: pA.id, interview_type: 'onsite', round: 2, scheduled_at: new Date('2026-10-20T10:00:00Z'), interviewer_user_ids: [ivrX], requestId: 'c3', visible_requisition_ids: null });

      const from = new Date('2026-10-01T00:00:00Z');
      const to = new Date('2026-10-10T00:00:00Z');

      // Window + see-all (null visibility) → both in-window sessions, earliest first.
      const all = await repo.listForCalendar({ tenant_id: tenant, from, to, visible_requisition_ids: null });
      expect(all.map((r) => r.id)).toEqual([a1.id, b1.id]);

      // Visibility set restricts to reqA only.
      const visA = await repo.listForCalendar({ tenant_id: tenant, from, to, visible_requisition_ids: new Set([reqA]) });
      expect(visA.map((r) => r.id)).toEqual([a1.id]);

      // requisition_id filter.
      expect((await repo.listForCalendar({ tenant_id: tenant, from, to, visible_requisition_ids: null, requisition_id: reqB })).map((r) => r.id)).toEqual([b1.id]);

      // A requisition_id OUTSIDE the visible set is concealed (empty).
      expect(await repo.listForCalendar({ tenant_id: tenant, from, to, visible_requisition_ids: new Set([reqA]), requisition_id: reqB })).toEqual([]);

      // talent filter.
      expect((await repo.listForCalendar({ tenant_id: tenant, from, to, visible_requisition_ids: null, talent_record_id: pB.talent_id })).map((r) => r.id)).toEqual([b1.id]);

      // interviewer filter (array membership).
      expect((await repo.listForCalendar({ tenant_id: tenant, from, to, visible_requisition_ids: null, interviewer_user_id: ivrX })).map((r) => r.id)).toEqual([a1.id]);

      // state filter — drive b1 to CANCELED, then filter SCHEDULED (only a1) vs CANCELED (only b1).
      await repo.transitionInterview({ tenant_id: tenant, id: b1.id, to_state: 'CANCELED', expected_version: 0, changed_by_id: randomUUID(), requestId: 'c4', visible_requisition_ids: null });
      expect((await repo.listForCalendar({ tenant_id: tenant, from, to, visible_requisition_ids: null, state: 'SCHEDULED' })).map((r) => r.id)).toEqual([a1.id]);
      expect((await repo.listForCalendar({ tenant_id: tenant, from, to, visible_requisition_ids: null, state: 'CANCELED' })).map((r) => r.id)).toEqual([b1.id]);

      // Empty visible set → nothing visible.
      expect(await repo.listForCalendar({ tenant_id: tenant, from, to, visible_requisition_ids: new Set() })).toEqual([]);
    }, 60_000);

    // ----------------------------------------------------------------------
    // F2-B (Slice B) — additive scheduled_end_at + timezone: persisted on schedule,
    // null for legacy-style rows (never fabricated), updated on RESCHEDULE.
    // ----------------------------------------------------------------------
    it('F2-B: schedule persists end/timezone; a schedule without them leaves both null; reschedule updates start+end+timezone', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);

      const withEnd = await repo.scheduleInterview({
        tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'onsite', round: 1,
        scheduled_at: new Date('2026-10-05T15:00:00Z'),
        scheduled_end_at: new Date('2026-10-05T16:00:00Z'),
        timezone: 'America/New_York',
        requestId: 'b1', visible_requisition_ids: null,
      });
      expect(withEnd.scheduled_end_at).toBe('2026-10-05T16:00:00.000Z');
      expect(withEnd.timezone).toBe('America/New_York');

      // No end/tz → both null (backward-compatible with legacy rows).
      const noEnd = await repo.scheduleInterview({
        tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'phone', round: 2,
        scheduled_at: new Date('2026-10-06T09:00:00Z'),
        requestId: 'b2', visible_requisition_ids: null,
      });
      expect(noEnd.scheduled_end_at).toBeNull();
      expect(noEnd.timezone).toBeNull();

      // Reschedule updates start + end + timezone atomically (version +1).
      const r = await repo.transitionInterview({
        tenant_id: tenant, id: withEnd.id, to_state: 'RESCHEDULED', expected_version: 0,
        scheduled_at: new Date('2026-10-07T10:00:00Z'),
        scheduled_end_at: new Date('2026-10-07T11:30:00Z'),
        timezone: 'America/Los_Angeles',
        changed_by_id: randomUUID(), requestId: 'b3', visible_requisition_ids: null,
      });
      expect(r.scheduled_at).toBe('2026-10-07T10:00:00.000Z');
      expect(r.scheduled_end_at).toBe('2026-10-07T11:30:00.000Z');
      expect(r.timezone).toBe('America/Los_Angeles');
      expect(r.version).toBe(1);
    }, 60_000);

    // ----------------------------------------------------------------------
    // F2-C (Slice C) — provider-neutral meeting association + participant update, both
    // CAS-guarded; association never changes lifecycle; terminal panel is frozen.
    // ----------------------------------------------------------------------
    it('F2-C(meeting): associateMeeting sets meeting_interaction_id (+1), does NOT change state; stale version conflicts; concealment 404', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const s = await repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'video', scheduled_at: new Date(), requestId: 'm0', visible_requisition_ids: null });
      const meetingId = randomUUID();

      const linked = await repo.associateMeeting({ tenant_id: tenant, id: s.id, expected_version: 0, meeting_interaction_id: meetingId, changed_by_id: randomUUID(), requestId: 'm1', visible_requisition_ids: null });
      expect(linked.meeting_interaction_id).toBe(meetingId);
      expect(linked.state).toBe('SCHEDULED'); // lifecycle unchanged
      expect(linked.version).toBe(1);

      // Stale version → conflict.
      await expect(
        repo.associateMeeting({ tenant_id: tenant, id: s.id, expected_version: 0, meeting_interaction_id: randomUUID(), changed_by_id: randomUUID(), requestId: 'm2', visible_requisition_ids: null }),
      ).rejects.toMatchObject({ code: 'INTERVIEW_SESSION_TRANSITION_CONFLICT', statusCode: 409 });

      // Concealment — not visible → 404.
      await expect(
        repo.associateMeeting({ tenant_id: tenant, id: s.id, expected_version: 1, meeting_interaction_id: randomUUID(), changed_by_id: randomUUID(), requestId: 'm3', visible_requisition_ids: new Set([randomUUID()]) }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    }, 60_000);

    it('F2-C(participants): updateInterviewers replaces the panel (+1) on a non-terminal session; a terminal session is frozen (422); stale version conflicts', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const p = await seedProcess(tenant, req);
      const s = await repo.scheduleInterview({ tenant_id: tenant, client_selection_process_id: p.id, interview_type: 'video', scheduled_at: new Date(), interviewer_user_ids: [randomUUID()], requestId: 'pu0', visible_requisition_ids: null });
      const newPanel = [randomUUID(), randomUUID()];

      const updated = await repo.updateInterviewers({ tenant_id: tenant, id: s.id, expected_version: 0, interviewer_user_ids: newPanel, changed_by_id: randomUUID(), requestId: 'pu1', visible_requisition_ids: null });
      expect(updated.interviewer_user_ids).toEqual(newPanel);
      expect(updated.version).toBe(1);
      expect(updated.state).toBe('SCHEDULED');

      // Stale version → conflict.
      await expect(
        repo.updateInterviewers({ tenant_id: tenant, id: s.id, expected_version: 0, interviewer_user_ids: [randomUUID()], changed_by_id: randomUUID(), requestId: 'pu2', visible_requisition_ids: null }),
      ).rejects.toMatchObject({ code: 'INTERVIEW_SESSION_TRANSITION_CONFLICT', statusCode: 409 });

      // Drive terminal, then the panel is frozen.
      const done = await repo.transitionInterview({ tenant_id: tenant, id: s.id, to_state: 'COMPLETED', expected_version: 1, changed_by_id: randomUUID(), requestId: 'pu3', visible_requisition_ids: null });
      await expect(
        repo.updateInterviewers({ tenant_id: tenant, id: s.id, expected_version: done.version, interviewer_user_ids: [randomUUID()], changed_by_id: randomUUID(), requestId: 'pu4', visible_requisition_ids: null }),
      ).rejects.toMatchObject({ code: 'INVALID_INTERVIEW_SESSION_TRANSITION', statusCode: 422 });
    }, 60_000);

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
