import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { makeMockLogger } from '@aramo/common';

import { TalentSubmittalEventRepository } from '../lib/talent-submittal-event.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// Lane 2 / L2-E (SB-5) — the AUTHORITATIVE submitted-history read + the decay-hazard
// proof that makes retiring the Pipeline mirror safe. `findFirstSubmittedByGrain`
// keys on the immutable `state_transition → submitted_to_ats` EVENT, so a grain
// stays "submitted" across the record's later confirmed/revoked transitions —
// exactly reproducing the mirror (which never un-set Pipeline.status). The negative
// control proves a current-state (`record.state='submitted_to_ats'`) query DROPS the
// confirmed/revoked grains, i.e. the decay hazard the event-history read closes.

const MIGRATIONS = [
  '20260523120000_init_submittal_model',
  '20260523200000_add_submittal_revoke',
  '20260526140602_add_submittal_event_log',
  '20260527000000_rename_submittal_state_canonical',
  '20260812120000_t2p1_relocate_submittal_to_submittal_schema',
  '20260822130000_l8b1_submittal_pipeline_link',
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

const TENANT = '11111111-1111-7111-8111-111111111111';
const REQ_1 = 'b0000000-0000-7000-8000-000000000001';
const REQ_2 = 'b0000000-0000-7000-8000-000000000002';
const TALENT_1 = 'a0000000-0000-7000-8000-000000000001';
const TALENT_2 = 'a0000000-0000-7000-8000-000000000002';
const TALENT_3 = 'a0000000-0000-7000-8000-000000000003';
const EVIDENCE = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const EXAM = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const RECRUITER = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';

let seq = 0;
const uuid = () =>
  `00000000-0000-7000-8000-${(seq += 1).toString(16).padStart(12, '0')}`;

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      cur += '$$';
      i += 1;
      continue;
    }
    if (sql[i] === ';' && !inDollar) {
      out.push(cur);
      cur = '';
    } else cur += sql[i];
  }
  if (cur.trim()) out.push(cur);
  return out;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L2-E first-submitted-by-grain (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let client: PrismaService;
    let repo: TalentSubmittalEventRepository;

    // Seed a submittal record at a given final state + a submitted_to_ats event at
    // `submittedAt` (the immutable transition, regardless of the record's final
    // state). Returns the submittal id.
    async function seedSubmitted(opts: {
      talent_id: string;
      job_id: string;
      pipeline_id: string;
      final_state: 'submitted_to_ats' | 'confirmed' | 'revoked';
      submittedAt: string;
    }): Promise<string> {
      const submittalId = uuid();
      await client.$executeRawUnsafe(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, pipeline_id, evidence_package_id,
            pinned_examination_id, state, created_by)
         VALUES ('${submittalId}'::uuid, '${TENANT}'::uuid, '${opts.talent_id}'::uuid,
            '${opts.job_id}'::uuid, '${opts.pipeline_id}'::uuid, '${EVIDENCE}'::uuid,
            '${EXAM}'::uuid, '${opts.final_state}'::submittal."SubmittalState", '${RECRUITER}'::uuid)`,
      );
      // The immutable submitted_to_ats transition event (durable across later states).
      await client.$executeRawUnsafe(
        `INSERT INTO submittal."TalentSubmittalEvent"
           (id, tenant_id, submittal_id, event_type, event_payload, created_at)
         VALUES ('${uuid()}'::uuid, '${TENANT}'::uuid, '${submittalId}'::uuid,
            'state_transition'::submittal."SubmittalEventType",
            '{"from_state":"handoff_draft","to_state":"submitted_to_ats"}'::jsonb,
            '${opts.submittedAt}'::timestamptz)`,
      );
      return submittalId;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      client = new PrismaService(container.getConnectionUri());
      await client.$connect();
      for (const m of MIGRATIONS) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          if (s.trim()) await client.$executeRawUnsafe(s.trim());
        }
      }
      repo = new TalentSubmittalEventRepository(client, makeMockLogger());
    }, 180_000);

    afterAll(async () => {
      await client?.$disconnect();
      await container?.stop();
    });

    // -----------------------------------------------------------------------
    // AC-1 (foundation) — DURABILITY: the event-history read counts a submitted
    // grain even after the record decays to confirmed/revoked; a current-state
    // query drops it. This is why the mirror can be retired without value loss.
    // -----------------------------------------------------------------------
    it('DURABILITY: event-history includes confirmed/revoked grains; current-state drops them', async () => {
      const pStill = uuid();
      const pConfirmed = uuid();
      const pRevoked = uuid();
      await seedSubmitted({ talent_id: TALENT_1, job_id: REQ_1, pipeline_id: pStill, final_state: 'submitted_to_ats', submittedAt: '2026-08-10T10:00:00Z' });
      await seedSubmitted({ talent_id: TALENT_2, job_id: REQ_1, pipeline_id: pConfirmed, final_state: 'confirmed', submittedAt: '2026-08-10T11:00:00Z' });
      await seedSubmitted({ talent_id: TALENT_3, job_id: REQ_1, pipeline_id: pRevoked, final_state: 'revoked', submittedAt: '2026-08-10T12:00:00Z' });

      // Event-history read: ALL THREE grains (durable).
      const grains = await repo.findFirstSubmittedByGrain({ tenant_id: TENANT, requisition_ids: [REQ_1] });
      expect(grains).toHaveLength(3);
      expect(grains.map((g) => g.talent_id).sort()).toEqual([TALENT_1, TALENT_2, TALENT_3].sort());

      // NEGATIVE CONTROL: a current-state query drops confirmed + revoked → only 1.
      const currentState = await client.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM submittal."TalentSubmittalRecord"
           WHERE tenant_id = '${TENANT}'::uuid AND job_id = '${REQ_1}'::uuid
             AND state = 'submitted_to_ats'::submittal."SubmittalState"`,
      );
      expect(currentState[0]!.n).toBe(1); // the decay hazard, proven closed by the 3-vs-1 gap
    });

    // -----------------------------------------------------------------------
    // FIRST-per-grain: two submitted events on one grain → the EARLIEST wins,
    // carrying that submittal's pipeline_id + instant (for time-to-submit joins).
    // -----------------------------------------------------------------------
    it('FIRST-per-grain: earliest submitted_to_ats event wins; pipeline_id + instant carried', async () => {
      const pEarly = uuid();
      const pLate = uuid();
      await seedSubmitted({ talent_id: TALENT_1, job_id: REQ_2, pipeline_id: pEarly, final_state: 'revoked', submittedAt: '2026-08-05T09:00:00Z' });
      await seedSubmitted({ talent_id: TALENT_1, job_id: REQ_2, pipeline_id: pLate, final_state: 'submitted_to_ats', submittedAt: '2026-08-06T09:00:00Z' });

      const grains = await repo.findFirstSubmittedByGrain({ tenant_id: TENANT, requisition_ids: [REQ_2] });
      expect(grains).toHaveLength(1); // one (talent, req) grain
      expect(grains[0]!.talent_id).toBe(TALENT_1);
      expect(grains[0]!.pipeline_id).toBe(pEarly); // earliest event's submittal
      expect(grains[0]!.first_submitted_at.toISOString()).toBe('2026-08-05T09:00:00.000Z');
    });

    // -----------------------------------------------------------------------
    // `since` filters on the FIRST transition instant, not any later event.
    // -----------------------------------------------------------------------
    it('since: filters grains by their FIRST submitted instant', async () => {
      // REQ_1 grains were submitted 2026-08-10; REQ_2 grain 2026-08-05.
      const sinceAug8 = await repo.findFirstSubmittedByGrain({
        tenant_id: TENANT,
        since: new Date('2026-08-08T00:00:00Z'),
      });
      // Only the three REQ_1 grains (Aug 10) qualify; the REQ_2 grain (Aug 5) is excluded.
      expect(sinceAug8.every((g) => g.requisition_id === REQ_1)).toBe(true);
      expect(sinceAug8).toHaveLength(3);
    });

    // -----------------------------------------------------------------------
    // Tenant scope + non-submitted events excluded.
    // -----------------------------------------------------------------------
    it('excludes non-submitted transitions and other tenants', async () => {
      // A record with only a handoff_draft transition (never submitted) → excluded.
      const sub = uuid();
      await client.$executeRawUnsafe(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, pipeline_id, evidence_package_id, pinned_examination_id, state, created_by)
         VALUES ('${sub}'::uuid, '${TENANT}'::uuid, '${TALENT_2}'::uuid, '${REQ_2}'::uuid, '${uuid()}'::uuid,
            '${EVIDENCE}'::uuid, '${EXAM}'::uuid, 'handoff_draft'::submittal."SubmittalState", '${RECRUITER}'::uuid)`,
      );
      await client.$executeRawUnsafe(
        `INSERT INTO submittal."TalentSubmittalEvent"
           (id, tenant_id, submittal_id, event_type, event_payload, created_at)
         VALUES ('${uuid()}'::uuid, '${TENANT}'::uuid, '${sub}'::uuid, 'state_transition'::submittal."SubmittalEventType",
            '{"from_state":"created","to_state":"handoff_draft"}'::jsonb, now())`,
      );
      const grains = await repo.findFirstSubmittedByGrain({ tenant_id: TENANT, talent_ids: [TALENT_2], requisition_ids: [REQ_2] });
      expect(grains).toHaveLength(0); // TALENT_2 on REQ_2 never reached submitted_to_ats
    });
  },
);
