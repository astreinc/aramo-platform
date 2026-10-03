import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PipelineRepository } from '../lib/pipeline.repository.js';

// SW-1 (Submittal Workspace, R1-A) — PipelineRepository.findLiveEpisode proofs
// (real Postgres 17). This is the authoritative reader the apps/api
// create-submittal orchestration uses to derive a submittal's pipeline_id
// server-side. The proofs pin, non-vacuously:
//
//   1. A live episode for the (tenant, talent, requisition) triple is returned.
//   2. No episode → null (nothing to link).
//   3. A VOIDED-only triple → null. This is the R1-A canonical-live reconcile:
//      `voided` is a terminal (LIVE_EPISODE_EXCLUSION_STATUSES), so it is NOT
//      live. NEGATIVE CONTROL: the retired two-value submit-side set omitted
//      `voided`, which would have treated a voided episode as live.
//   4. not_in_consideration-only and completed-only triples → null.
//   5. Multiple terminal episodes + exactly one live episode (history preserved)
//      → the single LIVE episode is returned; the terminal rows remain.
//   6. The reader keys on the full triple: a live episode for one talent/
//      requisition/tenant is never returned for a different one.
//
// Pipeline references its requisition/talent by UUID only (no FK), so rows are
// seeded directly — the proof is about the read predicate, not the write path.

const MIGRATIONS = [
  '../../../../libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260921160000_rn1_activity_note_extension/migration.sql',
  '../../../../libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  '../../prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  '../../prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  '../../prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  '../../prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  '../../prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
  '../../prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
  '../../prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
  '../../prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
  '../../prisma/migrations/20260828160000_l2d_pipeline_entry_provenance/migration.sql',
  '../../prisma/migrations/20260831120000_pipeline_canonicalize_status_enum/migration.sql',
  '../../prisma/migrations/20260925120000_pipeline_void_add_enum_value/migration.sql',
  '../../prisma/migrations/20260925120100_pipeline_void_live_index_recreate/migration.sql',
].map((p) => resolve(__dirname, p));

// Dollar-quote- AND line-comment-aware DDL splitter (an older activity migration
// carries a `;` inside a `--` comment).
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
  'SW-1 — PipelineRepository.findLiveEpisode (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setup: PrismaService;
    let prisma: PrismaService;
    let repo: PipelineRepository;

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
      repo = new PipelineRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setup?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    // Seed a Pipeline row directly at an arbitrary status (UUID-only refs, no FK).
    async function seedEpisode(args: {
      tenant_id: string;
      talent_record_id: string;
      requisition_id: string;
      status: string;
    }): Promise<string> {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO pipeline."Pipeline"
           (id, tenant_id, site_id, talent_record_id, requisition_id, status, version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, NULL, $3::uuid, $4::uuid,
                 CAST($5 AS pipeline."PipelineStatus"), 0, now(), now())`,
        id,
        args.tenant_id,
        args.talent_record_id,
        args.requisition_id,
        args.status,
      );
      return id;
    }

    async function episodeCount(tenant: string, talent: string, req: string): Promise<number> {
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pipeline."Pipeline"
          WHERE tenant_id = '${tenant}' AND talent_record_id = '${talent}' AND requisition_id = '${req}'`,
      );
      return Number(rows[0]!.n);
    }

    it('1. returns the live episode for the (tenant, talent, requisition) triple', async () => {
      const tenant = randomUUID();
      const talent = randomUUID();
      const req = randomUUID();
      const id = await seedEpisode({ tenant_id: tenant, talent_record_id: talent, requisition_id: req, status: 'qualifying' });

      const live = await repo.findLiveEpisode({ tenant_id: tenant, talent_record_id: talent, requisition_id: req });
      expect(live).not.toBeNull();
      expect(live?.id).toBe(id);
      expect(live?.status).toBe('qualifying');
    });

    it('2. returns null when no episode exists for the triple', async () => {
      const live = await repo.findLiveEpisode({
        tenant_id: randomUUID(),
        talent_record_id: randomUUID(),
        requisition_id: randomUUID(),
      });
      expect(live).toBeNull();
    });

    it('3. a VOIDED-only triple is NOT live (R1-A canonical reconcile — voided is terminal)', async () => {
      const tenant = randomUUID();
      const talent = randomUUID();
      const req = randomUUID();
      await seedEpisode({ tenant_id: tenant, talent_record_id: talent, requisition_id: req, status: 'voided' });

      const live = await repo.findLiveEpisode({ tenant_id: tenant, talent_record_id: talent, requisition_id: req });
      expect(live).toBeNull();
    });

    it('4. not_in_consideration-only and completed-only triples are NOT live', async () => {
      const t1 = { tenant_id: randomUUID(), talent_record_id: randomUUID(), requisition_id: randomUUID() };
      await seedEpisode({ ...t1, status: 'not_in_consideration' });
      expect(await repo.findLiveEpisode(t1)).toBeNull();

      const t2 = { tenant_id: randomUUID(), talent_record_id: randomUUID(), requisition_id: randomUUID() };
      await seedEpisode({ ...t2, status: 'completed' });
      expect(await repo.findLiveEpisode(t2)).toBeNull();
    });

    it('5. multiple terminal episodes + one live → returns the single live; terminal history preserved', async () => {
      const tenant = randomUUID();
      const talent = randomUUID();
      const req = randomUUID();
      // Two historical terminal episodes (allowed to coexist by the partial index).
      await seedEpisode({ tenant_id: tenant, talent_record_id: talent, requisition_id: req, status: 'not_in_consideration' });
      await seedEpisode({ tenant_id: tenant, talent_record_id: talent, requisition_id: req, status: 'completed' });
      // Exactly one live episode.
      const liveId = await seedEpisode({ tenant_id: tenant, talent_record_id: talent, requisition_id: req, status: 'contacted' });

      const live = await repo.findLiveEpisode({ tenant_id: tenant, talent_record_id: talent, requisition_id: req });
      expect(live?.id).toBe(liveId);
      // History preserved: all three episodes still present for the triple.
      expect(await episodeCount(tenant, talent, req)).toBe(3);
    });

    it('6. keyed on the full triple — a live episode is never returned for a different talent/requisition/tenant', async () => {
      const tenant = randomUUID();
      const talent = randomUUID();
      const req = randomUUID();
      await seedEpisode({ tenant_id: tenant, talent_record_id: talent, requisition_id: req, status: 'qualifying' });

      expect(
        await repo.findLiveEpisode({ tenant_id: tenant, talent_record_id: randomUUID(), requisition_id: req }),
      ).toBeNull();
      expect(
        await repo.findLiveEpisode({ tenant_id: tenant, talent_record_id: talent, requisition_id: randomUUID() }),
      ).toBeNull();
      expect(
        await repo.findLiveEpisode({ tenant_id: randomUUID(), talent_record_id: talent, requisition_id: req }),
      ).toBeNull();
    });
  },
);
