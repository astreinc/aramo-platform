import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AramoError, ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { TechnicalScreeningRepository } from '../lib/technical-screening.repository.js';
import { TechnicalScreeningService } from '../lib/technical-screening.service.js';
import type {
  ScreeningEvidencePublisher,
  ScreeningEvidencePublishInput,
} from '../lib/screening-publisher.port.js';

// TIP-E2E INC-3 (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED) — the screening domain against
// real Postgres 17: DRAFT lifecycle under a version CAS held in the write
// predicate, atomic confirmation with pinned intents, DB immutability triggers,
// the publication state machine (PUBLISHED / CONFLICT / PENDING-on-failure,
// serialized attempts, lost-ack convergence) and the merge re-key.
// Directive §13 rows 8–15, 36–39, 46, 48, 50 (domain layer; HTTP in apps/api).

const MIGRATIONS = [
  resolve(__dirname, '../../prisma/migrations/20261016120000_inc3_technical_screening_init/migration.sql'),
  // INC-3 A1 — AI-assisted screening (additive).
  resolve(__dirname, '../../prisma/migrations/20261016130000_inc3_a1_ai_assisted_screening/migration.sql'),
];
const TENANT = '0192f111-aaaa-7000-8000-00000000000a';
const OTHER_TENANT = '0192f111-bbbb-7000-8000-00000000000b';
const ACTOR = '0192f111-cccc-7000-8000-00000000000c';
const RID = 'req-inc3';

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

// A scriptable fake of the Talent Trust adapter: records calls; each call is
// answered by the next queued behaviour (default: written).
class FakePublisher implements ScreeningEvidencePublisher {
  calls: ScreeningEvidencePublishInput[] = [];
  queue: Array<'written' | 'replay' | 'conflict' | 'fail' | 'slow'> = [];
  async publish(input: ScreeningEvidencePublishInput): Promise<{ written: boolean }> {
    this.calls.push(input);
    const next = this.queue.shift() ?? 'written';
    if (next === 'conflict') {
      throw new AramoError('IDEMPOTENCY_KEY_CONFLICT', 'conflict', 409, { requestId: 'fake' });
    }
    if (next === 'fail') throw new Error('trust unavailable');
    if (next === 'slow') await new Promise((r) => setTimeout(r, 300));
    return { written: next !== 'replay' };
  }
}

const finding = (over: Record<string, unknown> = {}) => ({
  skill_raw: 'Go',
  basis: 'RECRUITER_OBSERVED',
  observation_raw: 'Described goroutine leak diagnosis with pprof.',
  ...over,
});

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TIP-E2E INC-3 — technical screening domain (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: TechnicalScreeningRepository;
    let publisher: FakePublisher;
    let service: TechnicalScreeningService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const m of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(m, 'utf8'))) {
          if (stmt.trim().length > 0) await setup.$executeRawUnsafe(stmt.trim());
        }
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new TechnicalScreeningRepository(prisma);
      publisher = new FakePublisher();
      service = new TechnicalScreeningService(repo, publisher);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function draft(talentRecordId: string = uuidv7()) {
      return service.createSession({
        tenant_id: TENANT,
        site_id: null,
        talent_record_id: talentRecordId,
        interaction_id: null,
        actor_id: ACTOR,
      });
    }

    async function confirmedWith(n: number) {
      const s = await draft();
      let version = s.version;
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const r = await service.addFinding({
          tenant_id: TENANT, session_id: s.id, version, actor_id: ACTOR,
          finding: finding({ skill_raw: `Skill ${i}` }), requestId: RID,
        });
        version = r.version;
        ids.push(r.finding.id);
      }
      const c = await service.confirm({
        tenant_id: TENANT, session_id: s.id, version, confirmed_finding_ids: ids,
        observations_confirmed: true, actor_id: ACTOR, requestId: RID,
      });
      return { session: c.session, publications: c.publications, findingIds: ids, confirmedVersion: version };
    }

    it('DRAFT lifecycle: add, edit, remove under the version CAS; events are content-free', async () => {
      const s = await draft();
      expect(s.state).toBe('DRAFT');
      const a = await service.addFinding({
        tenant_id: TENANT, session_id: s.id, version: 1, actor_id: ACTOR, finding: finding(), requestId: RID,
      });
      expect(a.version).toBe(2);
      const e = await service.editFinding({
        tenant_id: TENANT, session_id: s.id, finding_id: a.finding.id, version: 2, actor_id: ACTOR,
        finding: finding({ basis: 'DEMONSTRATED', demonstration_raw: 'Fixed a race live.' }), requestId: RID,
      });
      expect(e.finding.basis).toBe('DEMONSTRATED');
      const r = await service.removeFinding({
        tenant_id: TENANT, session_id: s.id, finding_id: a.finding.id, version: 3, actor_id: ACTOR, requestId: RID,
      });
      expect(r.version).toBe(4);
      const events = await service.listEvents(TENANT, s.id);
      expect(events.map((x) => x.event_type)).toEqual([
        'SESSION_CREATED', 'FINDING_ADDED', 'FINDING_EDITED', 'FINDING_REMOVED',
      ]);
      expect(JSON.stringify(events.map((x) => x.payload))).not.toMatch(/goroutine|race live/);
    });

    it('a stale version is 409 SCREENING_SESSION_VERSION_CONFLICT with no change (row 8)', async () => {
      const s = await draft();
      await service.addFinding({ tenant_id: TENANT, session_id: s.id, version: 1, actor_id: ACTOR, finding: finding(), requestId: RID });
      await expect(
        service.addFinding({ tenant_id: TENANT, session_id: s.id, version: 1, actor_id: ACTOR, finding: finding(), requestId: RID }),
      ).rejects.toMatchObject({ code: 'SCREENING_SESSION_VERSION_CONFLICT', statusCode: 409 });
      expect(await repo.listFindings(TENANT, s.id)).toHaveLength(1);
    });

    it('true race: two concurrent edits with the same version — exactly one applies (row 50)', async () => {
      const s = await draft();
      const results = await Promise.allSettled(
        [0, 1, 2, 3].map((i) =>
          service.addFinding({
            tenant_id: TENANT, session_id: s.id, version: 1, actor_id: ACTOR,
            finding: finding({ skill_raw: `Race ${i}` }), requestId: RID,
          }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected.every((r) => (r.reason as AramoError).code === 'SCREENING_SESSION_VERSION_CONFLICT')).toBe(true);
      expect(await repo.listFindings(TENANT, s.id)).toHaveLength(1);
      expect((await repo.findSession(TENANT, s.id))?.version).toBe(2);
    });

    it('validation: basis, DEMONSTRATED text, empty observation (row 16, domain side)', async () => {
      const s = await draft();
      for (const bad of [
        finding({ basis: 'VERIFIED' }),
        finding({ basis: 'DEMONSTRATED' }),
        finding({ observation_raw: '   ' }),
        finding({ demonstration_raw: 'only for DEMONSTRATED' }),
      ]) {
        await expect(
          service.addFinding({ tenant_id: TENANT, session_id: s.id, version: 1, actor_id: ACTOR, finding: bad, requestId: RID }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
      }
    });

    it('confirm refusals: zero ids (400), no attestation (422), finding-set mismatch (409, row 9)', async () => {
      const s = await draft();
      const a = await service.addFinding({ tenant_id: TENANT, session_id: s.id, version: 1, actor_id: ACTOR, finding: finding(), requestId: RID });
      await expect(
        service.confirm({ tenant_id: TENANT, session_id: s.id, version: 2, confirmed_finding_ids: [], observations_confirmed: true, actor_id: ACTOR, requestId: RID }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(
        service.confirm({ tenant_id: TENANT, session_id: s.id, version: 2, confirmed_finding_ids: [a.finding.id], observations_confirmed: false, actor_id: ACTOR, requestId: RID }),
      ).rejects.toMatchObject({ code: 'ATTESTATION_MISSING', statusCode: 422 });
      await expect(
        service.confirm({ tenant_id: TENANT, session_id: s.id, version: 2, confirmed_finding_ids: [uuidv7()], observations_confirmed: true, actor_id: ACTOR, requestId: RID }),
      ).rejects.toMatchObject({ code: 'SCREENING_SESSION_VERSION_CONFLICT' });
      // The failed confirm rolled back: still DRAFT, no intents.
      expect((await repo.findSession(TENANT, s.id))?.state).toBe('DRAFT');
      expect(await repo.listPublications(TENANT, s.id)).toHaveLength(0);
    });

    it('confirm is atomic: CONFIRMED + one pinned PENDING intent per finding + SESSION_CONFIRMED', async () => {
      const { session, publications, findingIds, confirmedVersion } = await confirmedWith(2);
      expect(session.state).toBe('CONFIRMED');
      expect(session.confirmed_by_actor_id).toBe(ACTOR);
      expect(session.confirmed_version).toBe(confirmedVersion);
      expect(session.confirmation_attested).toBe(true);
      expect(publications).toHaveLength(2);
      for (const p of publications) {
        expect(p.state).toBe('PENDING');
        expect(findingIds).toContain(p.finding_id);
        expect(p.talent_record_id_at_confirm).toBe(session.talent_record_id);
        const payload = p.canonical_payload as Record<string, unknown>;
        expect(payload['independently_verified']).toBe(false);
        expect(payload['confirmation']).toEqual({
          confirmed_at: session.confirmed_at?.toISOString(),
          session_version: confirmedVersion,
        });
        expect(JSON.stringify(payload)).not.toContain(ACTOR);
      }
      const types = (await service.listEvents(TENANT, session.id)).map((e) => e.event_type);
      expect(types.at(-1)).toBe('SESSION_CONFIRMED');
    });

    it('concurrent confirms: exactly one wins (row 11)', async () => {
      const s = await draft();
      const a = await service.addFinding({ tenant_id: TENANT, session_id: s.id, version: 1, actor_id: ACTOR, finding: finding(), requestId: RID });
      const results = await Promise.allSettled(
        [0, 1, 2].map(() =>
          service.confirm({ tenant_id: TENANT, session_id: s.id, version: 2, confirmed_finding_ids: [a.finding.id], observations_confirmed: true, actor_id: ACTOR, requestId: RID }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await repo.listPublications(TENANT, s.id)).toHaveLength(1);
    });

    it('after confirm: edit, remove and void are 422 SCREENING_SESSION_STATE_INVALID (row 15)', async () => {
      const { session, findingIds } = await confirmedWith(1);
      const v = session.version;
      await expect(
        service.editFinding({ tenant_id: TENANT, session_id: session.id, finding_id: findingIds[0]!, version: v, actor_id: ACTOR, finding: finding(), requestId: RID }),
      ).rejects.toMatchObject({ code: 'SCREENING_SESSION_STATE_INVALID', statusCode: 422 });
      await expect(
        service.removeFinding({ tenant_id: TENANT, session_id: session.id, finding_id: findingIds[0]!, version: v, actor_id: ACTOR, requestId: RID }),
      ).rejects.toMatchObject({ code: 'SCREENING_SESSION_STATE_INVALID' });
      await expect(
        service.voidSession({ tenant_id: TENANT, session_id: session.id, version: v, reason: 'x', actor_id: ACTOR, requestId: RID }),
      ).rejects.toMatchObject({ code: 'SCREENING_SESSION_STATE_INVALID' });
    });

    it('DB triggers refuse UPDATE on events, on findings of a non-DRAFT session, and on terminal sessions (row 46)', async () => {
      const { session, findingIds } = await confirmedWith(1);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE technical_screening."ScreeningEvent" SET actor_id = 'x' WHERE session_id = '${session.id}'`),
      ).rejects.toThrow(/append-only/);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE technical_screening."ScreeningFinding" SET observation_raw = 'x' WHERE id = '${findingIds[0]}'`),
      ).rejects.toThrow(/immutable once its session leaves DRAFT/);
      await expect(
        prisma.$executeRawUnsafe(`UPDATE technical_screening."ScreeningSession" SET state = 'VOIDED', voided_by_actor_id = '${ACTOR}', voided_at = now() WHERE id = '${session.id}'`),
      ).rejects.toThrow(/immutable once CONFIRMED or VOIDED/);
    });

    it('void is DRAFT-only, recorded with its actor and reason', async () => {
      const s = await draft();
      const v = await service.voidSession({ tenant_id: TENANT, session_id: s.id, version: 1, reason: ' duplicate ', actor_id: ACTOR, requestId: RID });
      expect(v.state).toBe('VOIDED');
      expect(v.void_reason).toBe('duplicate');
      expect(v.voided_by_actor_id).toBe(ACTOR);
    });

    it("another tenant's session is indistinguishable from an absent one (row 1, domain side)", async () => {
      const s = await draft();
      expect(await service.findSession(OTHER_TENANT, s.id)).toBeNull();
      await expect(service.getDetail(OTHER_TENANT, s.id, RID)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
      await expect(
        service.addFinding({ tenant_id: OTHER_TENANT, session_id: s.id, version: 1, actor_id: ACTOR, finding: finding(), requestId: RID }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(service.getDetail(TENANT, uuidv7(), RID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('publish: from the pinned intent only → PUBLISHED + FINDING_PUBLISHED; replay attempt is a no-op (rows 13, 35)', async () => {
      const { session, publications } = await confirmedWith(2);
      publisher.calls = [];
      publisher.queue = [];
      const res = await service.publishPending({ tenant_id: TENANT, session_id: session.id, actor_id: ACTOR, requestId: RID });
      expect(res.map((r) => r.state)).toEqual(['PUBLISHED', 'PUBLISHED']);
      expect(publisher.calls).toHaveLength(2);
      const byEvidence = new Map(publications.map((p) => [p.evidence_record_id, p]));
      for (const call of publisher.calls) {
        const p = byEvidence.get(call.evidence_id);
        expect(p).toBeDefined();
        expect(call.talent_record_id).toBe(p?.talent_record_id_at_confirm);
        expect(call.assertion_payload).toEqual(p?.canonical_payload);
        expect(call.collected_at.getTime()).toBe(p?.collected_at.getTime());
      }
      const again = await service.publishPending({ tenant_id: TENANT, session_id: session.id, actor_id: ACTOR, requestId: RID });
      expect(again).toEqual([]);
      expect(publisher.calls).toHaveLength(2);
    });

    it('transient failure keeps the intent PENDING with attempt bookkeeping; confirmation never rolls back (rows 14, 37)', async () => {
      const { session } = await confirmedWith(1);
      publisher.queue = ['fail'];
      const res = await service.publishPending({ tenant_id: TENANT, session_id: session.id, actor_id: ACTOR, requestId: RID });
      expect(res[0]?.state).toBe('PENDING');
      const [p] = await repo.listPublications(TENANT, session.id);
      expect(p?.attempt_count).toBe(1);
      expect(p?.last_error_code).toBe('PUBLICATION_FAILED');
      expect((await repo.findSession(TENANT, session.id))?.state).toBe('CONFIRMED');
      // Retry converges with no re-attestation.
      publisher.queue = [];
      const retry = await service.publishPending({ tenant_id: TENANT, session_id: session.id, actor_id: ACTOR, requestId: RID });
      expect(retry[0]?.state).toBe('PUBLISHED');
    });

    it('lost acknowledgment: an identical replay (written:false) still marks PUBLISHED (row 38)', async () => {
      const { session } = await confirmedWith(1);
      publisher.queue = ['replay'];
      const res = await service.publishPending({ tenant_id: TENANT, session_id: session.id, actor_id: ACTOR, requestId: RID });
      expect(res[0]?.state).toBe('PUBLISHED');
      const events = await service.listEvents(TENANT, session.id);
      expect(events.at(-1)?.payload).toMatchObject({ written: false });
    });

    it('conflicting replay → terminal CONFLICT + PUBLICATION_CONFLICT; never retried (row 39)', async () => {
      const { session } = await confirmedWith(1);
      publisher.queue = ['conflict'];
      publisher.calls = [];
      const res = await service.publishPending({ tenant_id: TENANT, session_id: session.id, actor_id: ACTOR, requestId: RID });
      expect(res[0]?.state).toBe('CONFLICT');
      expect((await service.listEvents(TENANT, session.id)).at(-1)?.event_type).toBe('PUBLICATION_CONFLICT');
      await service.publishPending({ tenant_id: TENANT, session_id: session.id, actor_id: ACTOR, requestId: RID });
      expect(publisher.calls).toHaveLength(1);
    });

    it('concurrent publish attempts serialize on the intent: one trust call, one PUBLISHED (row 36)', async () => {
      const { session } = await confirmedWith(1);
      publisher.calls = [];
      publisher.queue = ['slow'];
      const results = await Promise.all(
        [0, 1, 2].map(() => service.publishPending({ tenant_id: TENANT, session_id: session.id, actor_id: ACTOR, requestId: RID })),
      );
      expect(publisher.calls).toHaveLength(1);
      expect(results.flat().filter((r) => r.state === 'PUBLISHED' && !r.skipped)).toHaveLength(1);
      const [p] = await repo.listPublications(TENANT, session.id);
      expect(p?.state).toBe('PUBLISHED');
    });

    it('publish refuses a DRAFT session (422)', async () => {
      const s = await draft();
      await expect(
        service.publishPending({ tenant_id: TENANT, session_id: s.id, actor_id: ACTOR, requestId: RID }),
      ).rejects.toMatchObject({ code: 'SCREENING_SESSION_STATE_INVALID' });
    });

    it('merge re-key moves CONFIRMED sessions; pinned intents keep talent_record_id_at_confirm (row 48)', async () => {
      const husk = uuidv7();
      const survivor = uuidv7();
      const s = await draft(husk);
      const a = await service.addFinding({ tenant_id: TENANT, session_id: s.id, version: 1, actor_id: ACTOR, finding: finding(), requestId: RID });
      await service.confirm({ tenant_id: TENANT, session_id: s.id, version: 2, confirmed_finding_ids: [a.finding.id], observations_confirmed: true, actor_id: ACTOR, requestId: RID });
      const other = await draft(husk);
      const moved = await repo.repointTalentRecordRefs({ tenant_id: TENANT, from_record_id: husk, to_record_id: survivor, only_ids: [s.id] });
      expect(moved.repointed_ids).toEqual([s.id]);
      expect((await repo.findSession(TENANT, s.id))?.talent_record_id).toBe(survivor);
      expect((await repo.findSession(TENANT, other.id))?.talent_record_id).toBe(husk); // only_ids compensation scope
      const [p] = await repo.listPublications(TENANT, s.id);
      expect(p?.talent_record_id_at_confirm).toBe(husk);
      // Another tenant's rows are never touched.
      const none = await repo.repointTalentRecordRefs({ tenant_id: OTHER_TENANT, from_record_id: husk, to_record_id: survivor });
      expect(none.repointed_ids).toEqual([]);
    });
  },
);
