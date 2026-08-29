import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PipelineRepository } from '../lib/pipeline.repository.js';
import type { PipelineStatus } from '../lib/pipeline-state.js';

// Track 4 / T4-B2 §7 — PIPELINE CAPACITY-AUTHORITY REMOVAL. RED-first (chronological
// per boundary): authored and observed RED under the CURRENT decrement/restore/409
// mechanism, GREEN after the two pipeline writers are removed. After B2 the
// ContractAssignment lifecycle is the SOLE consumption authority; a Pipeline write
// (placed / delete) MUST NOT independently mutate requisition capacity, and the
// former REQUISITION_NO_OPENINGS 409 over-capacity block is GONE (over-capacity is a
// representable derived truth — §5 — not a pipeline-time hard gate).

const MIGRATIONS = [
  '../../../../libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
  '../../../../libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  '../../prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  // L2-A — additive `version` column (optimistic-concurrency).
  '../../prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  // L2-B — append-only history trigger; nullable status_from + ended_at/ended_by_id cols; pipeline OutboxEvent table.
  '../../prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  '../../prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  '../../prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
  '../../prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
  '../../prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
  '../../prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
  '../../prisma/migrations/20260828160000_l2d_pipeline_entry_provenance/migration.sql',
].map((p) => resolve(__dirname, p));

const PATH_TO_OFFERED: readonly PipelineStatus[] = [
  'contacted',
  'talent_responded',
  'qualifying',
  'submitted',
  'interviewing',
  'offered',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T4-B2 §7 — Pipeline no longer writes requisition capacity [real Postgres 17]',
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

    async function seedRequisition(tenant: string, openings: number, available: number): Promise<string> {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, openings, openings_available) ` +
          `VALUES ('${id}', '${tenant}', 'B2 requisition', '${randomUUID()}', ${openings}, ${available})`,
      );
      return id;
    }
    async function openingsAvailable(reqId: string): Promise<number> {
      const rows = await prisma.$queryRawUnsafe<{ openings_available: number }[]>(
        `SELECT openings_available FROM requisition."Requisition" WHERE id = '${reqId}'`,
      );
      return Number(rows[0]!.openings_available);
    }
    // L2-A — transition now requires expected_version + the actor's visible set.
    // Read version immediately before each transition; see-all visibility (null).
    async function casTransition(
      tenant: string,
      id: string,
      to: PipelineStatus,
      requestId: string,
    ) {
      const cur = await repo.findById({ tenant_id: tenant, id });
      return repo.transition({
        tenant_id: tenant,
        id,
        to_status: to,
        changed_by_id: randomUUID(),
        requestId,
        expected_version: cur!.version,
        visible_requisition_ids: null,
      });
    }

    async function drive(tenant: string, id: string, path: readonly PipelineStatus[]): Promise<void> {
      for (const to of path) {
        // L8-B1 R-TIGHTEN — `submitted` is the submit-to-ats orchestrator's mirror,
        // not an engine hop. L2-F3 — `interviewing` is likewise legacy-only (the
        // interview truth is owned by InterviewSession; no engine edge reaches it).
        // Both are set with a direct write (as legacy rows exist), then the KEPT
        // source edges (interviewing → offered → placed) carry the walk forward.
        if (to === 'submitted' || to === 'interviewing') {
          await prisma.$executeRawUnsafe(`UPDATE pipeline."Pipeline" SET status = '${to}' WHERE id = '${id}'`);
          continue;
        }
        await casTransition(tenant, id, to, 'b2');
      }
    }

    it('transition -> placed does NOT decrement requisition.openings_available (capacity untouched)', async () => {
      const tenant = randomUUID();
      const req = await seedRequisition(tenant, 3, 3);
      const talent = randomUUID();
      const p = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req }, entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' } });
      await drive(tenant, p.id, PATH_TO_OFFERED);
      const before = await openingsAvailable(req);
      expect(before).toBe(3);
      await casTransition(tenant, p.id, 'placed', 'b2');
      // POST-B2: capacity is owned by ContractAssignment, not pipeline. Unchanged.
      expect(await openingsAvailable(req)).toBe(3);
    });

    it('transition -> placed with zero available does NOT throw REQUISITION_NO_OPENINGS (409 gate removed; over-capacity is representable)', async () => {
      const tenant = randomUUID();
      const req = await seedRequisition(tenant, 1, 0); // legacy "no openings" state
      const talent = randomUUID();
      const p = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req }, entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' } });
      await drive(tenant, p.id, PATH_TO_OFFERED);
      // Pre-B2 this threw 409 and rolled back. Post-B2 it succeeds; capacity untouched.
      await expect(
        casTransition(tenant, p.id, 'placed', 'b2'),
      ).resolves.toBeDefined();
      expect(await openingsAvailable(req)).toBe(0);
    });

    // L2-B — the former "delete of a placed pipeline does NOT restore capacity"
    // test is retired: PipelineRepository.delete no longer exists (L2-B makes
    // the episode durable / append-only — withdrawal is a terminal transition,
    // never a destructive row delete). The B2 capacity invariant it guarded —
    // capacity is owned by ContractAssignment, pipeline has no inverse capacity
    // writer — is already proven by the two transition-to-`placed` tests above
    // (openings unchanged on placement; over-capacity representable).
  },
);

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let dollar = false;
  let line = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (line) {
      cur += ch;
      if (ch === '\n') line = false;
      continue;
    }
    if (!dollar && ch === '-' && sql[i + 1] === '-') {
      line = true;
      cur += ch;
      continue;
    }
    if (sql.startsWith('$$', i)) {
      dollar = !dollar;
      cur += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !dollar) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}
