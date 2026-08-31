import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PipelineRepository } from '../lib/pipeline.repository.js';

// Lane 2 / L2-A — Pipeline INTEGRITY proofs (real Postgres 17).
//
// Two integrity guarantees, each proven non-vacuously (assert the BEFORE value,
// then the EXACT after value) with its negative control described inline:
//
//   1. Optimistic-concurrency CAS. transition() requires expected_version; a
//      stale value is refused with PIPELINE_TRANSITION_CONFLICT (409) carrying
//      current_status + current_version, and the losing write commits NOTHING
//      (no status change, no history row). Version increments by exactly 1 per
//      committed transition. NEGATIVE CONTROL: before L2-A there was no CAS —
//      the second (stale) transition would commit a second history row and
//      advance the status; this spec is RED against that pin behaviour.
//
//   2. Write-visibility concealment. transition / delete / listHistory of a
//      pipeline whose requisition is OUTSIDE the actor's visible set are
//      concealed as 404 (identical to a missing row) and mutate nothing; a
//      see-all actor (visible_requisition_ids = null) succeeds. NEGATIVE
//      CONTROL: before L2-A these three paths were tenant-only (no visibility
//      predicate) — a non-visible actor would transition/delete/read the row;
//      this spec is RED against that pin behaviour.
//
// Pipeline references its requisition by UUID only (no FK, Architecture §7.3),
// so no requisition schema is seeded — the requisition_id is any UUID the test
// controls, which is exactly what the visible-set predicate keys on.

const MIGRATIONS = [
  '../../../../libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
  '../../../../libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  '../../prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  '../../prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  // L2-B — append-only history trigger; nullable status_from + ended_at/ended_by_id cols; pipeline OutboxEvent table.
  '../../prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  '../../prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  '../../prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
  '../../prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
  '../../prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
  '../../prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
  '../../prisma/migrations/20260828160000_l2d_pipeline_entry_provenance/migration.sql',
  '../../prisma/migrations/20260831120000_pipeline_canonicalize_status_enum/migration.sql',
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
  'Pipeline integrity — L2-A CAS + write-visibility (real Postgres 17)',
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

    async function historyCount(pipelineId: string): Promise<number> {
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pipeline."PipelineStatusHistory" WHERE pipeline_id = '${pipelineId}'`,
      );
      return Number(rows[0]!.n);
    }

    // ---- CAS-1 — a stale expected_version is refused; the losing write commits nothing ----
    it('CAS: a stale expected_version is refused with PIPELINE_TRANSITION_CONFLICT; nothing is written', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: randomUUID(), requisition_id: req }, entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
      });
      expect(created.version).toBe(0); // BEFORE — fresh episode at version 0

      // A committed transition advances the version 0 -> 1.
      const first = await repo.transition({
        tenant_id: tenant,
        id: created.id,
        to_status: 'contacted',
        changed_by_id: randomUUID(),
        requestId: 'cas-1a',
        expected_version: 0,
        visible_requisition_ids: null,
      });
      expect(first.version).toBe(1); // EXACT after
      // Two history rows now: the L2-B birth row + this committed transition.
      expect(await historyCount(created.id)).toBe(2);

      // The second transition presents the STALE version 0 (it should be 1 now).
      await expect(
        repo.transition({
          tenant_id: tenant,
          id: created.id,
          to_status: 'talent_responded',
          changed_by_id: randomUUID(),
          requestId: 'cas-1b',
          expected_version: 0,
          visible_requisition_ids: null,
        }),
      ).rejects.toMatchObject({
        code: 'PIPELINE_TRANSITION_CONFLICT',
        statusCode: 409,
        context: { details: { current_status: 'contacted', current_version: 1 } },
      });

      // The losing write committed NOTHING: still contacted, still version 1,
      // still just the two rows (birth + the one committed transition).
      const after = await repo.findById({ tenant_id: tenant, id: created.id });
      expect(after?.status).toBe('contacted');
      expect(after?.version).toBe(1);
      expect(await historyCount(created.id)).toBe(2);
    });

    // ---- CAS-2 — version increments by exactly 1 per committed transition ----
    it('CAS: version increments by exactly 1 per committed transition (monotonic)', async () => {
      const tenant = randomUUID();
      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: randomUUID(), requisition_id: randomUUID() }, entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
      });
      let v = created.version; // 0
      for (const to of ['contacted', 'talent_responded', 'qualifying'] as const) {
        const res = await repo.transition({
          tenant_id: tenant,
          id: created.id,
          to_status: to,
          changed_by_id: randomUUID(),
          requestId: `mono-${to}`,
          expected_version: v,
          visible_requisition_ids: null,
        });
        expect(res.version).toBe(v + 1); // EXACT +1 each hop
        v = res.version;
      }
      expect(v).toBe(3);
    });

    // ---- VIS-1 — transition on a non-visible pipeline is concealed as 404, mutates nothing ----
    it('VISIBILITY: a transition on a pipeline outside the visible set conceals as 404 and mutates nothing', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: randomUUID(), requisition_id: req }, entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
      });
      // Visible set that EXCLUDES this pipeline's requisition.
      const excludes = new Set<string>([randomUUID()]);

      await expect(
        repo.transition({
          tenant_id: tenant,
          id: created.id,
          to_status: 'contacted',
          changed_by_id: randomUUID(),
          requestId: 'vis-1',
          expected_version: 0,
          visible_requisition_ids: excludes,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });

      // Unmutated: still no_contact, version 0, and no NEW history — only the
      // L2-B birth row (NULL -> no_contact) written by create() is present; the
      // concealed transition added nothing.
      const after = await repo.findById({ tenant_id: tenant, id: created.id });
      expect(after?.status).toBe('no_contact');
      expect(after?.version).toBe(0);
      expect(await historyCount(created.id)).toBe(1);

      // Control: see-all (null) transitions successfully — the row IS mutable when visible.
      const ok = await repo.transition({
        tenant_id: tenant,
        id: created.id,
        to_status: 'contacted',
        changed_by_id: randomUUID(),
        requestId: 'vis-1-ok',
        expected_version: 0,
        visible_requisition_ids: null,
      });
      expect(ok.status).toBe('contacted');
    });

    // ---- VIS-2 — L2-B RETIRES the delete-visibility case ----
    // PipelineRepository.delete no longer exists (L2-B: the episode is durable /
    // append-only — there is no destructive delete write path to conceal). The
    // write-visibility parity invariant is fully carried by VIS-1 above (a
    // transition on a pipeline outside the visible set conceals as 404 and does
    // not mutate); the transition path is now the ONLY mutating write, so no
    // separate delete case remains to prove.

    // ---- VIS-3 — listHistory of a non-visible pipeline is concealed as 404 ----
    it('VISIBILITY: listHistory of a pipeline outside the visible set conceals as 404', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: randomUUID(), requisition_id: req }, entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
      });
      await repo.transition({
        tenant_id: tenant,
        id: created.id,
        to_status: 'contacted',
        changed_by_id: randomUUID(),
        requestId: 'vis-3-seed',
        expected_version: 0,
        visible_requisition_ids: null,
      });
      const excludes = new Set<string>([randomUUID()]);

      await expect(
        repo.listHistory({
          tenant_id: tenant,
          pipeline_id: created.id,
          requestId: 'vis-3',
          visible_requisition_ids: excludes,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });

      // Control: see-all returns BOTH history rows — the L2-B birth row
      // (NULL -> no_contact) and the seeded transition (no_contact -> contacted).
      const rows = await repo.listHistory({
        tenant_id: tenant,
        pipeline_id: created.id,
        requestId: 'vis-3-ok',
        visible_requisition_ids: null,
      });
      expect(rows).toHaveLength(2);
      const birth = rows.find((r) => r.status_from === null)!;
      expect(birth.status_to).toBe('no_contact');
      expect(rows.map((r) => r.status_to)).toContain('contacted');
    });
  },
);
