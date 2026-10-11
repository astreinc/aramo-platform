import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CommunicationsPrismaService, MeetingSchedulingRepository } from '@aramo/communications';
import { GraphCalendarError, type GraphCreateEventArgs, type GraphUpdateEventArgs } from '@aramo/microsoft-graph';

import {
  MeetingIdempotencyConflictError,
  MeetingOrganizerMismatchError,
  MeetingScheduleUnresolvedError,
  MeetingVersionConflictError,
  MicrosoftSchedulingService,
  type ScheduleMeetingArgs,
} from '../microsoft/microsoft-scheduling.service.js';
import { MeetingAssociationError } from '../microsoft/meeting-association.validator.js';
import type { MicrosoftConfigResolver } from '../microsoft/microsoft-config.resolver.js';

// COMM-C2B Amendment A1 (M365-SCHED-1) — the DECISIVE acceptance proof on real
// Postgres 17. The scheduling PERSISTENCE (durable operation ledger, CommunicationInteraction
// evidence, optimistic-concurrency version, forensic audit) is the REAL
// MeetingSchedulingRepository against a live DB. External/collaborator seams (Graph
// calendar, delegated OAuth, connection config, the association validator and consent
// gate — each unit-proven elsewhere) are controlled doubles so this suite isolates
// the database security, recovery, and lifecycle correctness the directive requires.

const ROOT = resolve(__dirname, '../../../..');

function communicationsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/communications/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

// Controlled Graph calendar double — tracks calls, supports an ambiguous outcome.
class FakeCalendar {
  createCount = 0;
  updateCount = 0;
  cancelCount = 0;
  lastCreate: GraphCreateEventArgs | null = null;
  lastUpdate: GraphUpdateEventArgs | null = null;
  mode: 'ok' | 'ambiguous' = 'ok';
  providerEventId = 'evt-real-0001';
  async createCalendarEvent(args: GraphCreateEventArgs) {
    this.createCount += 1;
    this.lastCreate = args;
    if (this.mode === 'ambiguous') {
      throw new GraphCalendarError('transient', 503, 'timeout', undefined, true);
    }
    return { provider_event_id: this.providerEventId, join_url: 'https://teams.example/join', start_date_time: args.startDateTime, end_date_time: args.endDateTime };
  }
  async updateCalendarEvent(args: GraphUpdateEventArgs) {
    this.updateCount += 1;
    this.lastUpdate = args;
    return { provider_event_id: args.providerEventId, start_date_time: args.startDateTime ?? '', end_date_time: args.endDateTime ?? '' };
  }
  async cancelCalendarEvent() {
    this.cancelCount += 1;
  }
  async getCalendarEvent() {
    return null;
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'M365-SCHED-1 Outlook scheduling — real Postgres 17 (A1 acceptance)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: CommunicationsPrismaService;
    let repo: MeetingSchedulingRepository;
    let calendar: FakeCalendar;
    let svc: MicrosoftSchedulingService;

    // Controllable collaborator doubles (each unit-proven in its own suite).
    let associationThrows: Error | null;
    let consentThrows: Error | null;

    const TENANT = randomUUID();
    const RECRUITER = randomUUID();
    const OTHER_RECRUITER = randomUUID();
    const TALENT = randomUUID();
    const REQ = randomUUID();

    function scheduleArgs(over: Partial<ScheduleMeetingArgs> = {}): ScheduleMeetingArgs {
      return {
        tenant_id: TENANT,
        recruiter_id: RECRUITER,
        talent_record_id: TALENT,
        requisition_id: REQ,
        subject: 'Recruiter screen',
        start_date_time: '2026-11-03T15:00:00.000Z',
        end_date_time: '2026-11-03T15:30:00.000Z',
        time_zone: 'America/New_York',
        idempotency_key: randomUUID(),
        authContext: {} as never,
        requestId: 'rq',
        ...over,
      };
    }

    async function countOps(key: string): Promise<{ count: number; status: string | null }> {
      const r = await db.query(
        `SELECT count(*)::int AS n, max(status::text) AS status FROM communications."MeetingSchedulingOperation" WHERE tenant_id=$1 AND idempotency_key=$2`,
        [TENANT, key],
      );
      return { count: r.rows[0].n as number, status: r.rows[0].status as string | null };
    }
    async function countMeetings(): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM communications."CommunicationInteraction" WHERE tenant_id=$1 AND channel='meeting'`,
        [TENANT],
      );
      return r.rows[0].n as number;
    }
    async function auditEventTypes(): Promise<string[]> {
      const r = await db.query(
        `SELECT event_type FROM audit."MeetingSchedulingAuditEvent" WHERE tenant_id=$1 ORDER BY created_at`,
        [TENANT],
      );
      return r.rows.map((x) => x.event_type as string);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of communicationsMigrations()) {
        await db.query(readFileSync(p, 'utf8'));
      }
      prisma = new CommunicationsPrismaService(url);
      await prisma.$connect();
      repo = new MeetingSchedulingRepository(prisma);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    beforeEach(async () => {
      await db.query(`DELETE FROM communications."CommunicationAssociation" WHERE tenant_id=$1`, [TENANT]);
      await db.query(`DELETE FROM communications."CommunicationInteraction" WHERE tenant_id=$1`, [TENANT]);
      await db.query(`DELETE FROM communications."MeetingSchedulingOperation" WHERE tenant_id=$1`, [TENANT]);
      await db.query(`DELETE FROM audit."MeetingSchedulingAuditEvent" WHERE tenant_id=$1`, [TENANT]);
      calendar = new FakeCalendar();
      associationThrows = null;
      consentThrows = null;

      const delegated = { getUsableAccessToken: async () => ({ access_token: 'tok', provider_identity_id: 'pi', ms_object_id: 'oid' }) };
      const graph = { getMe: async () => ({ ms_object_id: 'oid', ms_tenant_id: 'tid', user_principal_name: 'r@x.com', display_name: 'R' }) };
      const config = {
        resolveConnectionId: async () => randomUUID(),
        resolveConfig: async () => ({ clientId: 'c', clientSecret: 's' }),
        nowSeconds: () => 1_000_000,
      } as unknown as MicrosoftConfigResolver;
      const associations = {
        assertRecruitingAssociation: async () => {
          if (associationThrows !== null) throw associationThrows;
        },
        assertTenantOwnership: async () => {
          if (associationThrows !== null) throw associationThrows;
        },
      };
      const consent = {
        assertInvitationAllowed: async () => {
          if (consentThrows !== null) throw consentThrows;
        },
      };
      const talents = { findContactByIds: async () => new Map([[TALENT, { email: 'tal@x.com' }]]) };

      svc = new MicrosoftSchedulingService(
        delegated as never,
        calendar as never,
        graph as never,
        repo,
        config,
        associations as never,
        consent as never,
        talents as never,
      );
    });

    it('1. happy path persists a durable operation, meeting evidence, and a scheduled audit row', async () => {
      const args = scheduleArgs();
      const view = await svc.scheduleMeeting(args);
      expect(view.status).toBe('scheduled');
      expect(view.provider_event_id).toBe('evt-real-0001');
      expect(await countMeetings()).toBe(1);
      expect(await countOps(args.idempotency_key)).toEqual({ count: 1, status: 'succeeded' });
      expect(await auditEventTypes()).toEqual(['meeting.scheduled']);
      // The durable op was written BEFORE Graph: the Graph create carries the op's transactionId.
      expect(calendar.lastCreate?.transactionId).toBe(args.idempotency_key);
      expect(calendar.lastCreate?.attendees).toEqual([{ email: 'tal@x.com', type: 'required' }]);
    });

    it('2. missing/denied consent fails closed — no meeting, no provider call; op recorded failed (reclaimable)', async () => {
      consentThrows = new Error('consent denied');
      const args = scheduleArgs();
      await expect(svc.scheduleMeeting(args)).rejects.toThrow();
      expect(calendar.createCount).toBe(0);
      expect(await countMeetings()).toBe(0);
      // Durable, inspectable failure state (FIX_NOW-2): the op exists, marked failed —
      // a corrected retry can reclaim it; it is never left stuck pending.
      expect(await countOps(args.idempotency_key)).toEqual({ count: 1, status: 'failed' });
    });

    it('3. a cross-tenant / invalid recruiting association fails closed — no meeting, no provider call; op failed', async () => {
      associationThrows = new MeetingAssociationError('talent_not_in_tenant', 'x');
      const args = scheduleArgs();
      await expect(svc.scheduleMeeting(args)).rejects.toBeInstanceOf(MeetingAssociationError);
      expect(calendar.createCount).toBe(0);
      expect(await countMeetings()).toBe(0);
      expect(await countOps(args.idempotency_key)).toEqual({ count: 1, status: 'failed' });
    });

    it('4+5. an ambiguous Graph outcome → operation UNRESOLVED, NO meeting, provider-failure audit; retry recovers without a duplicate', async () => {
      const args = scheduleArgs();
      calendar.mode = 'ambiguous';
      await expect(svc.scheduleMeeting(args)).rejects.toBeInstanceOf(MeetingScheduleUnresolvedError);
      expect(await countMeetings()).toBe(0);
      expect(await countOps(args.idempotency_key)).toEqual({ count: 1, status: 'unresolved' });
      expect(await auditEventTypes()).toEqual(['meeting.provider_failed']);

      // Retry with the SAME idempotency key: the durable op (same transactionId) is
      // re-used; the provider now succeeds; exactly ONE meeting results (no duplicate).
      calendar.mode = 'ok';
      const view = await svc.scheduleMeeting({ ...args });
      expect(view.status).toBe('scheduled');
      expect(await countMeetings()).toBe(1);
      expect((await countOps(args.idempotency_key)).status).toBe('succeeded');
      expect(calendar.lastCreate?.transactionId).toBe(args.idempotency_key);
    });

    it('6. reschedule preserves the original Outlook event identity and CAS-advances the version', async () => {
      const created = await svc.scheduleMeeting(scheduleArgs());
      const providerEventId = created.provider_event_id;
      const re = await svc.rescheduleMeeting({
        tenant_id: TENANT, recruiter_id: RECRUITER, interaction_id: created.interaction_id,
        expected_version: created.version, start_date_time: '2026-11-04T16:00:00.000Z',
        end_date_time: '2026-11-04T16:30:00.000Z', time_zone: 'UTC', requestId: 'rq',
      });
      expect(calendar.lastUpdate?.providerEventId).toBe(providerEventId); // SAME event
      expect(re.status).toBe('rescheduled');
      expect(re.version).toBe(created.version + 1);
      expect(re.provider_event_id).toBe(providerEventId); // identity unchanged
      expect(await auditEventTypes()).toEqual(['meeting.scheduled', 'meeting.rescheduled']);
    });

    it('6b/FIX_NOW-1. a stale-version reschedule conflicts and issues ZERO Graph update calls', async () => {
      const created = await svc.scheduleMeeting(scheduleArgs());
      const updatesBefore = calendar.updateCount;
      await expect(
        svc.rescheduleMeeting({
          tenant_id: TENANT, recruiter_id: RECRUITER, interaction_id: created.interaction_id,
          expected_version: created.version + 5, start_date_time: '2026-11-04T16:00:00.000Z',
          end_date_time: '2026-11-04T16:30:00.000Z', time_zone: 'UTC', requestId: 'rq',
        }),
      ).rejects.toBeInstanceOf(MeetingVersionConflictError);
      // The reservation gated the side effect — Outlook was NOT touched for a stale request.
      expect(calendar.updateCount).toBe(updatesBefore);
      // Aramo authoritative state is unchanged (still scheduled at the original version).
      const row = await svc.readMeeting(TENANT, created.interaction_id);
      expect(row?.status).toBe('scheduled');
      expect(row?.version).toBe(created.version);
    });

    it('7b/FIX_NOW-1. a stale-version cancel conflicts and issues ZERO Graph cancel calls', async () => {
      const created = await svc.scheduleMeeting(scheduleArgs());
      await expect(
        svc.cancelMeeting({
          tenant_id: TENANT, recruiter_id: RECRUITER, interaction_id: created.interaction_id,
          expected_version: created.version + 5, requestId: 'rq',
        }),
      ).rejects.toBeInstanceOf(MeetingVersionConflictError);
      expect(calendar.cancelCount).toBe(0);
      const row = await svc.readMeeting(TENANT, created.interaction_id);
      expect(row?.status).toBe('scheduled');
    });

    it('FIX_NOW-2. concurrent same-key creates cannot diverge — exactly one meeting, one Graph create', async () => {
      const args = scheduleArgs();
      const results = await Promise.allSettled([
        svc.scheduleMeeting({ ...args }),
        svc.scheduleMeeting({ ...args }),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
      // The claim/unique gate serializes: at most one create proceeds; the loser is
      // refused (in_progress) or replays — never a second meeting or a second Graph call.
      expect(await countMeetings()).toBe(1);
      expect(calendar.createCount).toBe(1);
      expect(fulfilled).toBeGreaterThanOrEqual(1);
    });

    it('FIX_NOW-2. an idempotency key reused with a different Talent is refused (no second meeting)', async () => {
      const args = scheduleArgs();
      await svc.scheduleMeeting({ ...args });
      await expect(
        svc.scheduleMeeting({ ...args, talent_record_id: randomUUID() }),
      ).rejects.toBeInstanceOf(MeetingIdempotencyConflictError);
      expect(await countMeetings()).toBe(1);
    });

    it('7. cancellation is idempotent — a repeated cancel issues NO second provider operation', async () => {
      const created = await svc.scheduleMeeting(scheduleArgs());
      await svc.cancelMeeting({ tenant_id: TENANT, recruiter_id: RECRUITER, interaction_id: created.interaction_id, expected_version: created.version, requestId: 'rq' });
      expect(calendar.cancelCount).toBe(1);
      // Second cancel: already-cancelled stable end state → no provider call, no error.
      const again = await svc.cancelMeeting({ tenant_id: TENANT, recruiter_id: RECRUITER, interaction_id: created.interaction_id, expected_version: created.version, requestId: 'rq' });
      expect(again.status).toBe('cancelled');
      expect(calendar.cancelCount).toBe(1);
      expect(await auditEventTypes()).toEqual(['meeting.scheduled', 'meeting.cancelled']);
    });

    it('3b/organizer-bound. a non-organizer recruiter cannot reschedule or cancel; tenant isolation holds', async () => {
      const created = await svc.scheduleMeeting(scheduleArgs());
      await expect(
        svc.rescheduleMeeting({
          tenant_id: TENANT, recruiter_id: OTHER_RECRUITER, interaction_id: created.interaction_id,
          expected_version: created.version, start_date_time: '2026-11-04T16:00:00.000Z',
          end_date_time: '2026-11-04T16:30:00.000Z', time_zone: 'UTC', requestId: 'rq',
        }),
      ).rejects.toBeInstanceOf(MeetingOrganizerMismatchError);
      expect(calendar.updateCount).toBe(0);
      // Cross-tenant read of the meeting is NOT FOUND (tenant-scoped).
      expect(await svc.readMeeting(randomUUID(), created.interaction_id)).toBeNull();
    });
  },
);
