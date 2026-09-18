import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

// TALENT-INTEL-1 TI-1D-D (Layer B) — the DB-layer proofs for the frozen send-time
// résumé snapshot on TalentSubmittalRecord: the ready_for_review → submitted_to_ats
// send transition is the ONE place resume_edition_id may be pinned (from NULL);
// any later mutation of resume_edition_id is rejected; and the previously-leaky
// pipeline_id is now frozen too. The record is raw-INSERTed (bypassing the
// evidence-package machinery) to isolate the immutability trigger.
const MIGRATIONS = [
  '../../prisma/migrations/20260523120000_init_submittal_model/migration.sql',
  '../../prisma/migrations/20260523200000_add_submittal_revoke/migration.sql',
  '../../prisma/migrations/20260526140602_add_submittal_event_log/migration.sql',
  '../../prisma/migrations/20260527000000_rename_submittal_state_canonical/migration.sql',
  '../../prisma/migrations/20260531000000_add_outbox_event/migration.sql',
  '../../prisma/migrations/20260812120000_t2p1_relocate_submittal_to_submittal_schema/migration.sql',
  '../../prisma/migrations/20260822130000_l8b1_submittal_pipeline_link/migration.sql',
  '../../prisma/migrations/20260920130000_talent_intel_1d_d_submittal_resume_edition/migration.sql',
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

const TENANT = '11111111-1111-7111-8111-111111111111';
const ACTOR = '55555555-5555-7555-8555-555555555555';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TI-1D-D submittal résumé-edition freeze (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let c: Client;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      c = new Client({ connectionString: container.getConnectionUri() });
      await c.connect();
      for (const m of MIGRATIONS) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          if (s.trim()) await c.query(s.trim());
        }
      }
    }, 120_000);

    afterAll(async () => {
      await c?.end();
      await container?.stop();
    });

    async function seedCreated(pipelineId: string | null): Promise<string> {
      const id = randomUUID();
      await c.query(
        `INSERT INTO submittal."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, evidence_package_id, pinned_examination_id,
            pipeline_id, state, created_by, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
                 $7, 'created'::submittal."SubmittalState", $8::uuid, NOW())`,
        [id, TENANT, randomUUID(), randomUUID(), randomUUID(), randomUUID(), pipelineId, ACTOR],
      );
      // Advance to ready_for_review (state-only legal transitions).
      await c.query(`UPDATE submittal."TalentSubmittalRecord" SET state = 'handoff_draft'::submittal."SubmittalState" WHERE id = $1::uuid`, [id]);
      await c.query(`UPDATE submittal."TalentSubmittalRecord" SET state = 'ready_for_review'::submittal."SubmittalState" WHERE id = $1::uuid`, [id]);
      return id;
    }

    it('the send transition (ready_for_review → submitted_to_ats) pins resume_edition_id', async () => {
      const id = await seedCreated(randomUUID());
      const edition = randomUUID();
      await c.query(
        `UPDATE submittal."TalentSubmittalRecord"
           SET state = 'submitted_to_ats'::submittal."SubmittalState", confirmed_at = NOW(), resume_edition_id = $2::uuid
         WHERE id = $1::uuid`,
        [id, edition],
      );
      const { rows } = await c.query(`SELECT resume_edition_id FROM submittal."TalentSubmittalRecord" WHERE id = $1::uuid`, [id]);
      expect(rows[0].resume_edition_id).toBe(edition);
    });

    it('resume_edition_id is FROZEN after the send — a later change is rejected', async () => {
      const id = await seedCreated(randomUUID());
      const edition = randomUUID();
      await c.query(
        `UPDATE submittal."TalentSubmittalRecord" SET state = 'submitted_to_ats'::submittal."SubmittalState", confirmed_at = NOW(), resume_edition_id = $2::uuid WHERE id = $1::uuid`,
        [id, edition],
      );
      // submitted_to_ats → confirmed while ALSO changing resume_edition_id → rejected.
      await expect(
        c.query(
          `UPDATE submittal."TalentSubmittalRecord" SET state = 'confirmed'::submittal."SubmittalState", resume_edition_id = $2::uuid WHERE id = $1::uuid`,
          [id, randomUUID()],
        ),
      ).rejects.toThrow(/state machine|check_violation|immutable/i);
      // The legitimate carry-forward (state only) is still allowed.
      await c.query(`UPDATE submittal."TalentSubmittalRecord" SET state = 'confirmed'::submittal."SubmittalState" WHERE id = $1::uuid`, [id]);
      const { rows } = await c.query(`SELECT resume_edition_id, state FROM submittal."TalentSubmittalRecord" WHERE id = $1::uuid`, [id]);
      expect(rows[0].resume_edition_id).toBe(edition);
      expect(rows[0].state).toBe('confirmed');
    });

    it('pipeline_id is now FROZEN (the pre-existing immutability gap is closed)', async () => {
      const id = await seedCreated(randomUUID());
      // A legal state transition that ALSO mutates pipeline_id → rejected.
      await expect(
        c.query(
          `UPDATE submittal."TalentSubmittalRecord" SET state = 'submitted_to_ats'::submittal."SubmittalState", confirmed_at = NOW(), pipeline_id = $2::uuid WHERE id = $1::uuid`,
          [id, randomUUID()],
        ),
      ).rejects.toThrow(/state machine|check_violation|immutable/i);
    });
  },
);
