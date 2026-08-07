import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PipelineRepository } from '../lib/pipeline.repository.js';
import type { PipelineStatus } from '../lib/pipeline-state.js';

// L1 (pre-E6 coverage) — libs/pipeline's FIRST lib-local integration spec.
//
// PURPOSE: give the pipeline write surface a lane that CI actually runs, so the
// E6 removal of @@unique([talent_record_id, requisition_id]) lands into a lane
// that SEES it. Today libs/pipeline is absent from ci/integration-roots.json and
// owns no lib-local integration spec (its behaviour is only exercised, if at
// all, through apps/api batch specs). A silent seam must not ship into a lane
// that cannot see it.
//
// SCOPE DISCIPLINE (Lead ruling): this spec CHARACTERIZES the CURRENT substrate.
// Every row here is LEGAL under the current unique constraint — it does NOT
// manufacture duplicate (talent, requisition) rows and does NOT touch the index.
// The genuine E6 RED-first capacity proof (two historical episodes both
// consuming capacity) belongs to E6's B-drop -> B-capacity sequence, not here.
//
// PROOF CLASSIFICATION (exact, per Lead):
//   P-dup           — BOUNDARY CHARACTERIZATION WITH KNOWN E6 FLIP.
//                     GREEN today; RED after a bare E6 DROP of the unique index.
//                     Proves the mechanism caller-level idempotency rests on.
//   P-capacity      — CHARACTERIZATION ONLY. GREEN today; REMAINS GREEN under a
//                     bare single-row drop. Pins the single-row capacity side
//                     effect; does NOT by itself prove protection against two
//                     episodes both consuming capacity.
//   P-restore       — CHARACTERIZATION ONLY. Exact inverse of P-capacity.
//   P-current-stage — CHARACTERIZATION ONLY. Pins today's deterministic
//                     most-advanced selection + lowest-requisition tie-break,
//                     using data legal under the current unique.

// Four schemas participate in a pipeline transition: pipeline (state + history),
// activity + metering (cross-schema raw INSERT in legs 4c/4d), requisition
// (openings_available decrement in leg 4e on `placed`).
const MIGRATIONS = [
  '../../../../libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
  '../../../../libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  // E6 — swaps the total unique for the live-scoped partial unique.
  '../../prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
].map((p) => resolve(__dirname, p));

// The legal edge chain no_contact -> ... -> placed (offered is the only source
// of `placed`). Every hop is a legal transition in LEGAL_TRANSITIONS.
const PATH_TO_PLACED: readonly PipelineStatus[] = [
  'contacted',
  'talent_responded',
  'qualifying',
  'submitted',
  'interviewing',
  'offered',
  'placed',
];

// Dollar-quote- AND line-comment-aware DDL splitter — splits on `;` outside
// `$$` regions and outside `--` line comments (an older activity migration
// carries a `;` inside a `--` comment, which a comment-blind splitter would
// break on). String-literal `;` is not expected in these DDL files.
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
  'Pipeline write invariants (L1 — real Postgres 17)',
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

    // Seed a requisition with a known openings_available; the only NOT-NULL
    // columns without a default are tenant_id, title, company_id.
    async function seedRequisition(tenant: string, openings: number): Promise<string> {
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, openings, openings_available) ` +
          `VALUES ('${id}', '${tenant}', 'L1 requisition', '${randomUUID()}', ${openings}, ${openings})`,
      );
      return id;
    }

    async function openingsAvailable(reqId: string): Promise<number> {
      const rows = await prisma.$queryRawUnsafe<{ openings_available: number }[]>(
        `SELECT openings_available FROM requisition."Requisition" WHERE id = '${reqId}'`,
      );
      return Number(rows[0]!.openings_available);
    }

    async function pipelineRowCount(tenant: string, talent: string, req: string): Promise<number> {
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pipeline."Pipeline" ` +
          `WHERE tenant_id = '${tenant}' AND talent_record_id = '${talent}' AND requisition_id = '${req}'`,
      );
      return Number(rows[0]!.n);
    }

    async function drive(tenant: string, id: string, path: readonly PipelineStatus[]): Promise<void> {
      for (const to of path) {
        await repo.transition({ tenant_id: tenant, id, to_status: to, changed_by_id: randomUUID(), requestId: 'l1' });
      }
    }

    // ---- P-dup [E6-updated] — Q-2 one-live-episode guard at the repo layer ----
    // Post-E6 SEMANTICS (the directive "P-dup flip"): the OLD blanket claim
    // "one row per (talent, req) pair, forever" is now FALSE — terminal episodes
    // coexist (see B-drop). What survives is the Q-2 invariant, and it is now
    // surfaced by the DETERMINISTIC application guard (Boundary 2), not a bare
    // P2002: a second create while a LIVE episode exists is refused with the
    // exact code PIPELINE_EPISODE_ALREADY_LIVE (the Pipeline_live_episode_key
    // partial index is the race floor beneath, proven separately by B-live-unique).
    // This is the mechanism the apps/api controller 409 and the sourcing idempotent
    // no-op rest on.
    it('P-dup [E6]: a second create while a LIVE episode exists is refused with PIPELINE_EPISODE_ALREADY_LIVE; one live row persists', async () => {
      const tenant = randomUUID();
      const req = await seedRequisition(tenant, 1);
      const talent = randomUUID();

      const first = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } });
      expect(first.status).toBe('no_contact'); // first episode is LIVE — it holds the slot

      // Second create for the SAME triple while the first is live — refused by
      // the application guard with the exact one-live code.
      await expect(
        repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } }),
      ).rejects.toMatchObject({ code: 'PIPELINE_EPISODE_ALREADY_LIVE' });

      // Exactly one live row persists.
      expect(await pipelineRowCount(tenant, talent, req)).toBe(1);
    });

    // ==== E6 — INDEX SWAP (Boundary 1). Total unique -> live-scoped partial. ====
    // These proofs are chronological RED-first: authored and observed RED under
    // the CURRENT total unique, then GREEN after the E6 migration swaps the index.

    // ---- B-drop [E6 flip] ----
    // Two rows for the SAME (tenant, talent, requisition), both TERMINAL, must
    // COEXIST after E6. RED under the current total unique (the second create is
    // rejected by Pipeline_talent_record_id_requisition_id_key regardless of
    // status) -> GREEN after the swap (the partial live index no longer covers a
    // terminal row, so a fresh episode is admitted). This is the directive §10
    // B-drop / the L1 P-dup flip: the old blanket "one row per pair, forever" is
    // replaced by "multiple historical episodes may coexist" (Q-1).
    it('B-drop [E6]: two terminal episodes for one (tenant, talent, requisition) coexist (2 rows)', async () => {
      const tenant = randomUUID();
      const req = await seedRequisition(tenant, 5);
      const talent = randomUUID();

      const p1 = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } });
      await repo.transition({ tenant_id: tenant, id: p1.id, to_status: 'not_in_consideration', changed_by_id: randomUUID(), requestId: 'b-drop' });
      // p1 is terminal — under E6's live-scoped index it no longer occupies the live slot.

      // Second episode for the SAME triple. RED today (total unique rejects);
      // GREEN after E6 (admitted, then driven terminal so both are historical).
      const p2 = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } });
      await repo.transition({ tenant_id: tenant, id: p2.id, to_status: 'not_in_consideration', changed_by_id: randomUUID(), requestId: 'b-drop' });

      expect(await pipelineRowCount(tenant, talent, req)).toBe(2); // both historical episodes coexist
    });

    // ---- B-live-unique [E6] ----
    // Q-2 survives the swap: two LIVE rows for one triple are still rejected, and
    // the violated constraint is the live-scoped partial index SPECIFICALLY (not
    // the dropped total unique). The raw insert surfaces the PG constraint name,
    // so the assertion is a real behaviour flip: pre-E6 the message names
    // Pipeline_talent_record_id_requisition_id_key (RED on this assertion);
    // post-E6 it names Pipeline_live_episode_key (GREEN). §4.1 depends on this
    // exact-name identifiability.
    it('B-live-unique [E6]: a second LIVE row for one triple is rejected by Pipeline_live_episode_key; one live row persists', async () => {
      const tenant = randomUUID();
      const req = await seedRequisition(tenant, 5);
      const talent = randomUUID();

      await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } }); // no_contact (live)

      let err: unknown;
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status) ` +
            `VALUES ('${randomUUID()}', '${tenant}', '${talent}', '${req}', 'no_contact')`,
        );
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(String((err as { message?: string })?.message ?? err)).toContain('Pipeline_live_episode_key');

      expect(await pipelineRowCount(tenant, talent, req)).toBe(1); // exactly one live row
    });

    // ---- P-capacity — CHARACTERIZATION ONLY ----
    // One row to `placed` decrements openings_available by EXACTLY one. §14
    // non-vacuity: the BEFORE value is asserted to exist, and the AFTER value is
    // asserted exactly one lower — not merely "decreased".
    it('P-capacity [characterization]: one row transitioning to placed decrements openings_available by exactly one (N -> N-1)', async () => {
      const tenant = randomUUID();
      const N = 3;
      const req = await seedRequisition(tenant, N);
      const talent = randomUUID();

      expect(await openingsAvailable(req)).toBe(N); // BEFORE exists and equals N

      const p = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } });
      await drive(tenant, p.id, PATH_TO_PLACED);

      expect(await openingsAvailable(req)).toBe(N - 1); // exactly one lower
    });

    // ---- P-restore — CHARACTERIZATION ONLY ----
    // Deleting a capacity-consuming placed row restores openings_available by
    // EXACTLY one (the exact inverse of P-capacity).
    it('P-restore [characterization]: deleting a placed row restores openings_available by exactly one (N-1 -> N)', async () => {
      const tenant = randomUUID();
      const N = 2;
      const req = await seedRequisition(tenant, N);
      const talent = randomUUID();

      const p = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } });
      await drive(tenant, p.id, PATH_TO_PLACED);
      expect(await openingsAvailable(req)).toBe(N - 1);

      await repo.delete({ tenant_id: tenant, id: p.id, requestId: 'l1' });
      expect(await openingsAvailable(req)).toBe(N); // exact inverse
    });

    // ==== E6 — Q-3 CAPACITY IDEMPOTENCY (Boundary 3) ====
    // Capacity is a BOOLEAN predicate: openings are consumed iff at least one
    // placed episode EXISTS for (tenant, talent, requisition). Coexisting placed
    // episodes (now possible post-drop) must consume openings EXACTLY ONCE.

    // ---- B-capacity [E6] ----
    // FALSE->TRUE = -1; TRUE->TRUE = no change. Two placed episodes for one triple
    // consume openings EXACTLY ONCE: N -> N-1, NOT N-2.
    it('B-capacity [E6]: two placed episodes for one triple consume openings exactly once (N -> N-1, not N-2)', async () => {
      const tenant = randomUUID();
      const N = 3;
      const req = await seedRequisition(tenant, N);
      const talent = randomUUID();

      expect(await openingsAvailable(req)).toBe(N); // BEFORE exists and equals N

      const p1 = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } });
      await drive(tenant, p1.id, PATH_TO_PLACED);
      expect(await openingsAvailable(req)).toBe(N - 1); // FALSE->TRUE: exactly one lower

      // Second placed episode for the SAME triple — the predicate is already TRUE,
      // so this is TRUE->TRUE: NO further decrement.
      const p2 = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } });
      await drive(tenant, p2.id, PATH_TO_PLACED);
      expect(await openingsAvailable(req)).toBe(N - 1); // still exactly one lower, NOT N-2
    });

    // ---- B-capacity-restore [E6] ----
    // TRUE->TRUE on removal = no change; TRUE->FALSE (last placed removed) = +1
    // exactly once. Symmetric inverse of B-capacity.
    it('B-capacity-restore [E6]: deleting one of two placed leaves capacity unchanged; deleting the last restores +1 exactly once', async () => {
      const tenant = randomUUID();
      const N = 2;
      const req = await seedRequisition(tenant, N);
      const talent = randomUUID();

      const p1 = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } });
      await drive(tenant, p1.id, PATH_TO_PLACED);
      const p2 = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } });
      await drive(tenant, p2.id, PATH_TO_PLACED);
      expect(await openingsAvailable(req)).toBe(N - 1); // one consume total for the triple

      // Delete one placed episode while another placed remains — TRUE->TRUE, no change.
      await repo.delete({ tenant_id: tenant, id: p1.id, requestId: 'b-cap' });
      expect(await openingsAvailable(req)).toBe(N - 1); // unchanged

      // Delete the LAST placed episode — TRUE->FALSE, restore +1 exactly once.
      await repo.delete({ tenant_id: tenant, id: p2.id, requestId: 'b-cap' });
      expect(await openingsAvailable(req)).toBe(N); // restored exactly once
    });

    // ==== E6 — Q-4 PROJECTION COLLAPSE (Boundary 5, repository layer) ====
    // ---- B-projection-repo [E6] ----
    // A (talent, req) with a HISTORICAL placed episode + a CURRENT live episode
    // (legal post-drop) is counted ONCE by the business projections: placements =
    // distinct triple with placed EXISTS (1, not 2); by_status buckets the talent
    // under its CURRENT episode's stage only. Episode/history reads are unaffected.
    it('B-projection-repo [E6]: coexisting episodes collapse — countDistinctPlaced=1, by_status counts the talent once in its current stage', async () => {
      const tenant = randomUUID();
      const req = await seedRequisition(tenant, 5);
      const talent = randomUUID();

      // Episode 1 → placed (terminal). Episode 2 → a fresh live episode at submitted.
      const p1 = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } });
      await drive(tenant, p1.id, PATH_TO_PLACED);
      const p2 = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: req } });
      await drive(tenant, p2.id, ['contacted', 'talent_responded', 'qualifying', 'submitted']);

      // BUSINESS: placements = distinct (talent, req) with placed EXISTS = 1 (not 2).
      expect(await repo.countDistinctPlaced({ tenant_id: tenant, requisition_ids: [req] })).toBe(1);

      // BUSINESS: by_status collapses to the CURRENT episode — the talent appears
      // ONCE, under submitted (the live one), and NOT under placed.
      const byStatus = await repo.countByStatus({ tenant_id: tenant, requisition_ids: [req] });
      const map = Object.fromEntries(byStatus.map((r) => [r.status, r.count]));
      expect(map['submitted']).toBe(1);
      expect(map['placed'] ?? 0).toBe(0);

      // EPISODE view is unaffected: both physical rows still exist.
      expect(await pipelineRowCount(tenant, talent, req)).toBe(2);
    });

    // ---- P-current-stage — CHARACTERIZATION ONLY ----
    // Pins today's deterministic selection over data LEGAL under the current
    // unique (one talent across two DISTINCT requisitions — distinct pairs, not
    // duplicates): (a) most-advanced ACTIVE stage wins; (b) on an equal stage,
    // the lowest requisition_id wins.
    it('P-current-stage [characterization]: most-advanced ACTIVE stage wins', async () => {
      const tenant = randomUUID();
      const talent = randomUUID();
      const reqAdvanced = await seedRequisition(tenant, 5);
      const reqBehind = await seedRequisition(tenant, 5);

      const pAdvanced = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: reqAdvanced } });
      const pBehind = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: reqBehind } });
      await drive(tenant, pAdvanced.id, ['contacted', 'talent_responded', 'qualifying', 'submitted']);
      await drive(tenant, pBehind.id, ['contacted', 'talent_responded', 'qualifying']);

      const map = await repo.findCurrentStageForTalentIds({
        tenant_id: tenant,
        talent_record_ids: [talent],
        visible_requisition_ids: null,
      });
      const cs = map.get(talent);
      expect(cs).toBeDefined();
      expect(cs!.stage).toBe('submitted'); // submitted (ord 4) beats qualifying (ord 3)
      expect(cs!.requisition_id).toBe(reqAdvanced);
    });

    it('P-current-stage [characterization]: equal stage resolves to the lowest requisition_id (deterministic tie-break)', async () => {
      const tenant = randomUUID();
      const talent = randomUUID();
      // Two distinct requisitions at the SAME stage; the lower UUID must win.
      const [reqLow, reqHigh] = [randomUUID(), randomUUID()].sort();
      await prisma.$executeRawUnsafe(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, openings, openings_available) ` +
          `VALUES ('${reqLow}', '${tenant}', 'L1 low', '${randomUUID()}', 5, 5), ` +
          `('${reqHigh}', '${tenant}', 'L1 high', '${randomUUID()}', 5, 5)`,
      );
      const pLow = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: reqLow } });
      const pHigh = await repo.create({ tenant_id: tenant, input: { talent_record_id: talent, requisition_id: reqHigh } });
      const toQualifying: readonly PipelineStatus[] = ['contacted', 'talent_responded', 'qualifying'];
      await drive(tenant, pLow.id, toQualifying);
      await drive(tenant, pHigh.id, toQualifying);

      const map = await repo.findCurrentStageForTalentIds({
        tenant_id: tenant,
        talent_record_ids: [talent],
        visible_requisition_ids: null,
      });
      const cs = map.get(talent);
      expect(cs).toBeDefined();
      expect(cs!.stage).toBe('qualifying');
      expect(cs!.requisition_id).toBe(reqLow); // lowest requisition_id wins the tie
    });
  },
);
