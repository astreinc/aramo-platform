import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PipelineRepository } from '../lib/pipeline.repository.js';
import type { EntryProvenanceInput } from '../lib/pipeline-entry-provenance.js';

// L2-D — Source / Entry Provenance (Aramo-Talent-Pipeline-Lane2-D + Amendment v1.1).
// Lib-local acceptance proofs for the source-of-hire substrate: every episode birth
// captures exactly one immutable PipelineEntryProvenance atomically; the
// pipeline.created event is ENRICHED from the SAME validated input (v1.1 ruling);
// the reversal re-create stamps SYSTEM_RECONCILIATION; the row is DB-immutable; and
// initiated_by_kind is validated against ACTOR_KINDS at the write boundary.
//
// AC-2 (sourcing HTTP), AC-8 (pact no-drift), AC-9 (no regression) are proven in
// apps/api + pact; this spec proves the repository-level invariants end to end.
const MIGRATIONS = [
  '../../../../libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
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
].map((p) => resolve(__dirname, p));

// Dollar-quote- AND line-comment-aware DDL splitter (same as the L2-B/L2-C specs).
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
  'L2-D entry provenance (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setup: PrismaService;
    let prisma: PrismaService;
    let repo: PipelineRepository;

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
      repo = new PipelineRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setup?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function seedRequisition(tenant: string): Promise<string> {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, openings, openings_available) ` +
          `VALUES ('${id}', '${tenant}', 'L2-D requisition', '${randomUUID()}', 3, 3)`,
      );
      return id;
    }

    async function provenanceRows(pipelineId: string) {
      return prisma.pipelineEntryProvenance.findMany({
        where: { pipeline_id: pipelineId },
      });
    }

    async function createEpisode(
      tenant: string,
      entry: EntryProvenanceInput,
      actor?: string,
    ) {
      const req = await seedRequisition(tenant);
      const talent = randomUUID();
      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: talent, requisition_id: req },
        ...(actor === undefined ? {} : { created_by_id: actor }),
        entry_provenance: entry,
      });
      return { req, talent, created };
    }

    // -----------------------------------------------------------------------
    // AC-1 — recruiter origin captured: exactly one MANUAL_RECRUITER provenance.
    // -----------------------------------------------------------------------
    it('AC-1: a recruiter create writes exactly one MANUAL_RECRUITER provenance', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();

      // BEFORE (non-vacuous): a fresh requisition has no pipeline, no provenance.
      const req = await seedRequisition(tenant);
      const talent = randomUUID();

      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: talent, requisition_id: req },
        created_by_id: actor,
        entry_provenance: {
          origin_type: 'MANUAL_RECRUITER',
          initiated_by_kind: 'user',
          initiated_by_id: actor,
        },
      });

      const rows = await provenanceRows(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.origin_type).toBe('MANUAL_RECRUITER');
      expect(rows[0]!.initiated_by_kind).toBe('user');
      expect(rows[0]!.initiated_by_id).toBe(actor);
      expect(rows[0]!.source_system).toBeNull();
      expect(rows[0]!.source_connection_id).toBeNull();
    });

    // -----------------------------------------------------------------------
    // AC-2(repo) — sourcing origin captured: exactly one ARAMO_SOURCING provenance.
    // -----------------------------------------------------------------------
    it('AC-2: an Aramo-sourcing create writes exactly one ARAMO_SOURCING provenance', async () => {
      const tenant = randomUUID();
      const { created } = await createEpisode(tenant, {
        origin_type: 'ARAMO_SOURCING',
        initiated_by_kind: 'user',
      });
      const rows = await provenanceRows(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.origin_type).toBe('ARAMO_SOURCING');
      expect(rows[0]!.source_system).toBeNull();
    });

    // -----------------------------------------------------------------------
    // AC-3 — every birth is provenanced (invariant): count(Pipeline) ==
    //        count(provenance); the reversal row carries SYSTEM_RECONCILIATION.
    // -----------------------------------------------------------------------
    it('AC-3: recruiter + sourcing + reversal births all provenanced; reversal = SYSTEM_RECONCILIATION', async () => {
      const tenant = randomUUID();
      await createEpisode(tenant, { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' });
      await createEpisode(tenant, { origin_type: 'ARAMO_SOURCING', initiated_by_kind: 'user' });

      // A reversal reversal re-create BIRTHS an episode: it must write provenance +
      // the enriched event too (v1.1 — both births obey the rule).
      const req = await seedRequisition(tenant);
      const restoredId = randomUUID();
      await repo.restoreRemovedRows([
        {
          id: restoredId,
          tenant_id: tenant,
          site_id: null,
          talent_record_id: randomUUID(),
          requisition_id: req,
          status: 'no_contact',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]);

      const reconProv = await provenanceRows(restoredId);
      expect(reconProv).toHaveLength(1);
      expect(reconProv[0]!.origin_type).toBe('SYSTEM_RECONCILIATION');
      expect(reconProv[0]!.initiated_by_kind).toBe('system');

      // Invariant: one provenance per episode, tenant-wide.
      const pipelineCount = await prisma.pipeline.count({ where: { tenant_id: tenant } });
      const provCount = await prisma.pipelineEntryProvenance.count({ where: { tenant_id: tenant } });
      expect(pipelineCount).toBe(3);
      expect(provCount).toBe(3);
    });

    // -----------------------------------------------------------------------
    // AC-4 — one provenance per episode: a second insert for an existing
    //        pipeline_id violates @@unique([pipeline_id]).
    // -----------------------------------------------------------------------
    it('AC-4: a second provenance for the same pipeline_id is refused (unique)', async () => {
      const tenant = randomUUID();
      const { created } = await createEpisode(tenant, {
        origin_type: 'MANUAL_RECRUITER',
        initiated_by_kind: 'user',
      });
      // BEFORE: exactly one provenance (non-vacuous).
      expect(await provenanceRows(created.id)).toHaveLength(1);

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO pipeline."PipelineEntryProvenance" (id, tenant_id, pipeline_id, origin_type, initiated_by_kind) ` +
            `VALUES ('${randomUUID()}', '${tenant}', '${created.id}', 'REFERRAL', 'user')`,
        ),
      ).rejects.toThrow();
      expect(await provenanceRows(created.id)).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // AC-5 — initiated_by_kind validated against ACTOR_KINDS at the boundary;
    //        out-of-set rejected, no episode + no provenance written (atomic).
    // -----------------------------------------------------------------------
    it('AC-5: an out-of-set initiated_by_kind is refused 400; nothing is written', async () => {
      const tenant = randomUUID();
      const req = await seedRequisition(tenant);
      const talent = randomUUID();

      await expect(
        repo.create({
          tenant_id: tenant,
          input: { talent_record_id: talent, requisition_id: req },
          // Cast past the ActorKind type to simulate a bad boundary caller.
          entry_provenance: {
            origin_type: 'MANUAL_RECRUITER',
            initiated_by_kind: 'robot' as unknown as EntryProvenanceInput['initiated_by_kind'],
          },
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });

      // Atomic: the rolled-back tx left NO pipeline and NO provenance.
      const pipelines = await prisma.pipeline.findMany({
        where: { tenant_id: tenant, talent_record_id: talent, requisition_id: req },
      });
      expect(pipelines).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // EVENT-ENRICHMENT (v1.1) — pipeline.created carries the entry provenance,
    // projected from the SAME validated input as the durable row (never divergent).
    // -----------------------------------------------------------------------
    it('v1.1: pipeline.created is enriched with the entry-provenance fields', async () => {
      const tenant = randomUUID();
      const connId = randomUUID();
      const entry: EntryProvenanceInput = {
        origin_type: 'JOB_BOARD',
        initiated_by_kind: 'service_account',
        source_system: 'indeed',
        source_connection_id: connId,
      };
      const { created } = await createEpisode(tenant, entry);

      const events = await prisma.outboxEvent.findMany({
        where: { tenant_id: tenant, event_type: 'pipeline.created' },
      });
      const mine = events.find(
        (e) => (e.event_payload as { pipeline_id: string }).pipeline_id === created.id,
      )!;
      const payload = mine.event_payload as Record<string, unknown>;
      // Base L2-B fields still present.
      expect(payload['pipeline_id']).toBe(created.id);
      expect(payload['requisition_id']).toBeDefined();
      // v1.1 enrichment — projected from the SAME input as the durable row.
      expect(payload['origin_type']).toBe('JOB_BOARD');
      expect(payload['source_system']).toBe('indeed');
      expect(payload['source_connection_id']).toBe(connId);
      expect(payload['initiated_by_kind']).toBe('service_account');

      // The event is a PROJECTION of the durable record — the two agree exactly.
      const durable = (await provenanceRows(created.id))[0]!;
      expect(payload['origin_type']).toBe(durable.origin_type);
      expect(payload['source_system']).toBe(durable.source_system);
      expect(payload['source_connection_id']).toBe(durable.source_connection_id);
      expect(payload['initiated_by_kind']).toBe(durable.initiated_by_kind);
    });

    // -----------------------------------------------------------------------
    // AC-IMMUT — PipelineEntryProvenance is DB-immutable: ordinary UPDATE and
    //            DELETE are refused; the governed tenant-reset escape may DELETE.
    // -----------------------------------------------------------------------
    it('AC-IMMUT: a committed provenance rejects UPDATE + DELETE; tenant-reset escape may DELETE', async () => {
      const tenant = randomUUID();
      const { created } = await createEpisode(tenant, {
        origin_type: 'MANUAL_RECRUITER',
        initiated_by_kind: 'user',
      });
      const prov = (await provenanceRows(created.id))[0]!;

      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE pipeline."PipelineEntryProvenance" SET source_system = 'tampered' WHERE id = '${prov.id}'`,
        ),
      ).rejects.toThrow();
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM pipeline."PipelineEntryProvenance" WHERE id = '${prov.id}'`,
        ),
      ).rejects.toThrow();
      // Unchanged after both refusals.
      expect((await provenanceRows(created.id))[0]!.source_system).toBeNull();

      // The governed exact-value tenant-reset escape is the ONLY path that deletes.
      await prisma.$executeRawUnsafe(
        `DO $do$ BEGIN PERFORM set_config('app.tenant_reset', 'authorized', true); ` +
          `DELETE FROM pipeline."PipelineEntryProvenance" WHERE id = '${prov.id}'; END $do$;`,
      );
      expect(await provenanceRows(created.id)).toHaveLength(0);
    });
  },
);
