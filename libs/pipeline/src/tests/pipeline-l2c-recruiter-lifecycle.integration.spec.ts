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
import { isLiveStatus } from '../lib/pipeline-state.js';

// L2-C — Recruiter Lifecycle (Aramo-Talent-Pipeline-Lane2-C-Recruiter-Lifecycle-
// Directive). The lib-local acceptance proofs for the RECRUITER command surface:
// the affirmative `qualified` milestone, the named-action /actions translation
// (applyAction), the authority-partitioned immutable PipelineDisposition, the
// SYSTEM-only COMPLETE command (scope-gated + provenance-bearing), and the
// live-slot exclusion recreate that lets a `completed` episode free the slot.
//
// Every criterion carries the directive's non-vacuous BEFORE/AFTER (Rule F): the
// prior state is asserted to exist before the flip is asserted exact. Matrix-shape
// (qualified edges, exclusion-set parity vs the migration) is proven at the unit
// tier (pipeline-state + pipeline-index-parity); this spec proves the DB-enforced
// runtime behaviour end to end through the repository.
//
// Schema participation mirrors pipeline-l2b-durable-episode: pipeline (state +
// history + outbox + disposition), activity + metering (cross-schema raw INSERT in
// the transition legs), requisition (seed target for the created episode).
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
  // L2-C — enum add (qualified/completed); live-slot exclusion recreate; disposition.
  '../../prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
  '../../prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
  '../../prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
  '../../prisma/migrations/20260828160000_l2d_pipeline_entry_provenance/migration.sql',
  '../../prisma/migrations/20260831120000_pipeline_canonicalize_status_enum/migration.sql',
].map((p) => resolve(__dirname, p));

// Dollar-quote- AND line-comment-aware DDL splitter (same as the L2-B spec — the
// L2-B append-only migration carries `$$` bodies + `--` prose lines).
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
  'L2-C recruiter lifecycle (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setup: PrismaService;
    let prisma: PrismaService;
    let repo: PipelineRepository;

    const SYSTEM_SCOPES = ['pipeline:complete'] as const;

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
          `VALUES ('${id}', '${tenant}', 'L2-C requisition', '${randomUUID()}', 3, 3)`,
      );
      return id;
    }

    async function currentVersion(tenant: string, id: string): Promise<number> {
      const v = await repo.findById({ tenant_id: tenant, id });
      return v!.version;
    }

    // Drive an episode up the recruiter funnel to `qualified` via the named-action
    // surface (applyAction), reading the CAS token before each step. Returns the
    // episode ids for the test to assert against.
    async function walkToQualified(tenant: string, actor: string) {
      const req = await seedRequisition(tenant);
      const talent = randomUUID();
      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: talent, requisition_id: req }, entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
        created_by_id: actor,
      });
      for (const action of [
        'CONTACT',
        'MARK_RESPONDED',
        'START_QUALIFICATION',
        'QUALIFY',
      ] as const) {
        await repo.applyAction({
          tenant_id: tenant,
          id: created.id,
          action,
          expected_version: await currentVersion(tenant, created.id),
          changed_by_id: actor,
          requestId: `walk-${action}`,
          visible_requisition_ids: null,
        });
      }
      return { req, talent, id: created.id };
    }

    async function dispositionRows(pipelineId: string) {
      return prisma.pipelineDisposition.findMany({
        where: { pipeline_id: pipelineId },
      });
    }

    // -----------------------------------------------------------------------
    // AC-1 — `qualified` is reachable via QUALIFY and OCCUPIES the live slot.
    // -----------------------------------------------------------------------
    it('AC-1: QUALIFY advances qualifying -> qualified; the episode stays LIVE', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);

      const row = await repo.findById({ tenant_id: tenant, id });
      expect(row!.status).toBe('qualified');
      // Runtime partition: `qualified` is NOT in the exclusion set (still live).
      expect(isLiveStatus('qualified')).toBe(true);
      expect(isLiveStatus('qualifying')).toBe(true);
    });

    // -----------------------------------------------------------------------
    // AC-2 — QUALIFY writes the qualifying->qualified history edge, no disposition.
    // -----------------------------------------------------------------------
    it('AC-2: QUALIFY records a qualifying->qualified history row and writes NO disposition', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);

      const history = await prisma.pipelineStatusHistory.findMany({
        where: { pipeline_id: id },
        orderBy: { changed_at: 'asc' },
      });
      const last = history[history.length - 1]!;
      expect(last.status_from).toBe('qualifying');
      expect(last.status_to).toBe('qualified');
      // A recruiter QUALIFY is a plain transition — no disposition is written.
      expect(await dispositionRows(id)).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // AC-3 — DISPOSITION (valid RECRUITER reason) closes to not_in_consideration
    //         and writes exactly one authority-partitioned disposition row.
    // -----------------------------------------------------------------------
    it('AC-3: a valid recruiter DISPOSITION closes the episode + writes ONE disposition', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);

      // BEFORE: live, no disposition (non-vacuous).
      expect(await dispositionRows(id)).toHaveLength(0);

      await repo.applyAction({
        tenant_id: tenant,
        id,
        action: 'DISPOSITION',
        expected_version: await currentVersion(tenant, id),
        changed_by_id: actor,
        requestId: 'ac3',
        visible_requisition_ids: null,
        authority_class: 'RECRUITER',
        reason: 'not_a_fit',
      });

      const row = await repo.findById({ tenant_id: tenant, id });
      expect(row!.status).toBe('not_in_consideration');
      const dispo = await dispositionRows(id);
      expect(dispo).toHaveLength(1);
      expect(dispo[0]!.authority_class).toBe('RECRUITER');
      expect(dispo[0]!.reason).toBe('not_a_fit');
      expect(dispo[0]!.created_by_id).toBe(actor);
      expect(dispo[0]!.source_provenance).toBeNull();
    });

    // -----------------------------------------------------------------------
    // AC-4 — DISPOSITION with a mismatched (authority, reason) is refused 422 and
    //         leaves BOTH the status and the disposition table untouched (atomic).
    // -----------------------------------------------------------------------
    it('AC-4: a mismatched disposition reason is refused 422 with no transition, no row', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);
      const before = await repo.findById({ tenant_id: tenant, id });

      await expect(
        repo.applyAction({
          tenant_id: tenant,
          id,
          action: 'DISPOSITION',
          expected_version: before!.version,
          changed_by_id: actor,
          requestId: 'ac4',
          visible_requisition_ids: null,
          // RECRUITER authority cannot carry a DOWNSTREAM_OUTCOME reason.
          authority_class: 'RECRUITER',
          reason: 'placement_completed',
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_DISPOSITION_REASON_INVALID', statusCode: 422 });

      const after = await repo.findById({ tenant_id: tenant, id });
      expect(after!.status).toBe('qualified'); // unchanged
      expect(after!.version).toBe(before!.version); // no write
      expect(await dispositionRows(id)).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // AC-5 — a recruiter can never wield the DOWNSTREAM_OUTCOME authority class.
    // -----------------------------------------------------------------------
    it('AC-5: recruiter DISPOSITION with DOWNSTREAM_OUTCOME authority is refused 422', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);

      await expect(
        repo.applyAction({
          tenant_id: tenant,
          id,
          action: 'DISPOSITION',
          expected_version: await currentVersion(tenant, id),
          changed_by_id: actor,
          requestId: 'ac5',
          visible_requisition_ids: null,
          authority_class: 'DOWNSTREAM_OUTCOME',
          reason: 'placement_completed',
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_DISPOSITION_REASON_INVALID', statusCode: 422 });
      expect(await dispositionRows(id)).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // AC-6 — the one-disposition-per-episode UNIQUE is exact-name translated to
    //         PIPELINE_ALREADY_DISPOSITIONED, never a generic P2002 leak; the
    //         conflicting transition rolls back wholesale (atomic).
    // -----------------------------------------------------------------------
    it('AC-6: a second disposition write raises PIPELINE_ALREADY_DISPOSITIONED (409), tx rolled back', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);

      // Pre-seed a disposition for this episode (simulating a prior close), so the
      // COMPLETE command's in-tx disposition.create trips the UNIQUE index.
      await prisma.$executeRawUnsafe(
        `INSERT INTO pipeline."PipelineDisposition" (id, tenant_id, pipeline_id, authority_class, reason) ` +
          `VALUES ('${randomUUID()}', '${tenant}', '${id}', 'RECRUITER', 'not_a_fit')`,
      );
      const before = await repo.findById({ tenant_id: tenant, id });

      await expect(
        repo.complete({
          tenant_id: tenant,
          id,
          expected_version: before!.version,
          changed_by_id: actor,
          requestId: 'ac6',
          visible_requisition_ids: null,
          scopes: SYSTEM_SCOPES,
          source_provenance: randomUUID(),
          reason: 'placement_completed',
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_ALREADY_DISPOSITIONED', statusCode: 409 });

      // The whole terminal transition rolled back: status + version unchanged, and
      // the pre-seeded row is still the ONLY disposition (no partial write).
      const after = await repo.findById({ tenant_id: tenant, id });
      expect(after!.status).toBe('qualified');
      expect(after!.version).toBe(before!.version);
      expect(await dispositionRows(id)).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // AC-7 — COMPLETE is SYSTEM-only: a caller lacking pipeline:complete is 403.
    // -----------------------------------------------------------------------
    it('AC-7: COMPLETE without the pipeline:complete capability is refused 403, no transition', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);
      const before = await repo.findById({ tenant_id: tenant, id });

      await expect(
        repo.complete({
          tenant_id: tenant,
          id,
          expected_version: before!.version,
          changed_by_id: actor,
          requestId: 'ac7',
          visible_requisition_ids: null,
          scopes: ['pipeline:change-status'], // NOT pipeline:complete
          source_provenance: randomUUID(),
          reason: 'placement_completed',
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_COMPLETE_SYSTEM_ONLY', statusCode: 403 });

      const after = await repo.findById({ tenant_id: tenant, id });
      expect(after!.status).toBe('qualified'); // unchanged
      expect(await dispositionRows(id)).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // AC-8 — COMPLETE requires source_provenance + a valid DOWNSTREAM_OUTCOME
    //         reason (lineage-bearing); missing/invalid is 422.
    // -----------------------------------------------------------------------
    it('AC-8: COMPLETE without source_provenance is refused 422', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);

      await expect(
        repo.complete({
          tenant_id: tenant,
          id,
          expected_version: await currentVersion(tenant, id),
          changed_by_id: actor,
          requestId: 'ac8',
          visible_requisition_ids: null,
          scopes: SYSTEM_SCOPES,
          source_provenance: '', // missing lineage
          reason: 'placement_completed',
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_DISPOSITION_REASON_INVALID', statusCode: 422 });
    });

    // -----------------------------------------------------------------------
    // AC-9 — COMPLETE happy path: qualified -> completed, DOWNSTREAM_OUTCOME
    //         disposition carrying source_provenance; the episode is terminal.
    // -----------------------------------------------------------------------
    it('AC-9: COMPLETE drives qualified -> completed with a provenance-bearing disposition', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const provenance = randomUUID();
      const { id } = await walkToQualified(tenant, actor);

      // BEFORE: qualified, no disposition (non-vacuous).
      const before = await repo.findById({ tenant_id: tenant, id });
      expect(before!.status).toBe('qualified');
      expect(await dispositionRows(id)).toHaveLength(0);

      await repo.complete({
        tenant_id: tenant,
        id,
        expected_version: before!.version,
        changed_by_id: actor,
        requestId: 'ac9',
        visible_requisition_ids: null,
        scopes: SYSTEM_SCOPES,
        source_provenance: provenance,
        reason: 'placement_completed',
      });

      const after = await repo.findById({ tenant_id: tenant, id });
      expect(after!.status).toBe('completed');
      const dispo = await dispositionRows(id);
      expect(dispo).toHaveLength(1);
      expect(dispo[0]!.authority_class).toBe('DOWNSTREAM_OUTCOME');
      expect(dispo[0]!.reason).toBe('placement_completed');
      expect(dispo[0]!.source_provenance).toBe(provenance);
      // `completed` is a terminal in the runtime partition (no live-slot occupancy).
      expect(isLiveStatus('completed')).toBe(false);
    });

    // -----------------------------------------------------------------------
    // L2-G (v1.2 R-CMD) — dispositionDownstream: the SYSTEM-only DOWNSTREAM DISPOSITION
    // command → not_in_consideration (fall-through/no-show before STARTED). Same gates as
    // complete() but NEVER `completed` (SB-0). apps/api calls THIS, not raw transition().
    // -----------------------------------------------------------------------
    it('L2-G: dispositionDownstream drives a live episode -> not_in_consideration with a DOWNSTREAM_OUTCOME disposition (never completed)', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const provenance = randomUUID();
      const { id } = await walkToQualified(tenant, actor);
      const before = await repo.findById({ tenant_id: tenant, id });
      expect(before!.status).toBe('qualified');
      expect(await dispositionRows(id)).toHaveLength(0);

      const after = await repo.dispositionDownstream({
        tenant_id: tenant,
        id,
        expected_version: before!.version,
        changed_by_id: actor,
        requestId: 'dd-ok',
        visible_requisition_ids: null,
        scopes: SYSTEM_SCOPES,
        source_provenance: provenance,
        reason: 'placement_fell_through',
      });
      expect(after.status).toBe('not_in_consideration'); // NEVER completed (SB-0)
      expect(after.version).toBe(before!.version + 1);
      const dispo = await dispositionRows(id);
      expect(dispo).toHaveLength(1);
      expect(dispo[0]!.authority_class).toBe('DOWNSTREAM_OUTCOME');
      expect(dispo[0]!.reason).toBe('placement_fell_through');
      expect(dispo[0]!.source_provenance).toBe(provenance);
    });

    it('L2-G: dispositionDownstream without pipeline:complete is refused 403 (system-only)', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);
      await expect(
        repo.dispositionDownstream({
          tenant_id: tenant, id,
          expected_version: await currentVersion(tenant, id),
          changed_by_id: actor, requestId: 'dd-403', visible_requisition_ids: null,
          scopes: ['pipeline:change-status'], // NOT pipeline:complete
          source_provenance: randomUUID(), reason: 'placement_fell_through',
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_COMPLETE_SYSTEM_ONLY', statusCode: 403 });
      expect((await repo.findById({ tenant_id: tenant, id }))!.status).toBe('qualified');
    });

    it('L2-G: dispositionDownstream with an invalid DOWNSTREAM_OUTCOME reason is refused 422', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);
      await expect(
        repo.dispositionDownstream({
          tenant_id: tenant, id,
          expected_version: await currentVersion(tenant, id),
          changed_by_id: actor, requestId: 'dd-422', visible_requisition_ids: null,
          scopes: SYSTEM_SCOPES,
          source_provenance: randomUUID(), reason: 'not_a_downstream_reason',
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_DISPOSITION_REASON_INVALID', statusCode: 422 });
    });

    it('L2-G: dispositionDownstream on an ALREADY-dispositioned live episode → PIPELINE_ALREADY_DISPOSITIONED (409), tx rolled back', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);
      // Pre-seed a disposition (a prior close) so the in-tx disposition.create trips the
      // one-per-episode UNIQUE while the episode is still live (qualified -> nic, from!=to).
      await prisma.$executeRawUnsafe(
        `INSERT INTO pipeline."PipelineDisposition" (id, tenant_id, pipeline_id, authority_class, reason) ` +
          `VALUES ('${randomUUID()}', '${tenant}', '${id}', 'RECRUITER', 'not_a_fit')`,
      );
      const before = await repo.findById({ tenant_id: tenant, id });
      await expect(
        repo.dispositionDownstream({
          tenant_id: tenant, id,
          expected_version: before!.version,
          changed_by_id: actor, requestId: 'dd-already', visible_requisition_ids: null,
          scopes: SYSTEM_SCOPES, source_provenance: randomUUID(), reason: 'placement_fell_through',
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_ALREADY_DISPOSITIONED', statusCode: 409 });
      const after = await repo.findById({ tenant_id: tenant, id });
      expect(after!.status).toBe('qualified'); // rolled back — unchanged
      expect(after!.version).toBe(before!.version);
      expect(await dispositionRows(id)).toHaveLength(1); // still the ONE pre-seeded
    });

    it('L2-G(idempotency): a re-delivered dispositionDownstream on the SAME episode no-ops (from===to), no second disposition', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);
      await repo.dispositionDownstream({
        tenant_id: tenant, id,
        expected_version: (await repo.findById({ tenant_id: tenant, id }))!.version,
        changed_by_id: actor, requestId: 'dd-first', visible_requisition_ids: null,
        scopes: SYSTEM_SCOPES, source_provenance: randomUUID(), reason: 'placement_fell_through',
      });
      const mid = await repo.findById({ tenant_id: tenant, id });
      expect(mid!.status).toBe('not_in_consideration');
      // Re-delivery: episode already at not_in_consideration → transition no-op (from===to),
      // returns current, NO second disposition, NO error, NO version bump. (Recognized-satisfied.)
      const again = await repo.dispositionDownstream({
        tenant_id: tenant, id,
        expected_version: mid!.version,
        changed_by_id: actor, requestId: 'dd-again', visible_requisition_ids: null,
        scopes: SYSTEM_SCOPES, source_provenance: randomUUID(), reason: 'placement_fell_through',
      });
      expect(again.status).toBe('not_in_consideration');
      expect(again.version).toBe(mid!.version); // unchanged (no-op)
      expect(await dispositionRows(id)).toHaveLength(1); // still exactly one
    });

    // -----------------------------------------------------------------------
    // AC-10 — COMPLETE is illegal from any non-`qualified` state (the matrix only
    //          admits qualified -> completed); refused 422, no disposition.
    // -----------------------------------------------------------------------
    it('AC-10: COMPLETE from contacted is refused INVALID_PIPELINE_TRANSITION (422)', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const req = await seedRequisition(tenant);
      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: randomUUID(), requisition_id: req }, entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
        created_by_id: actor,
      });
      await repo.applyAction({
        tenant_id: tenant,
        id: created.id,
        action: 'CONTACT',
        expected_version: await currentVersion(tenant, created.id),
        changed_by_id: actor,
        requestId: 'ac10-contact',
        visible_requisition_ids: null,
      });

      await expect(
        repo.complete({
          tenant_id: tenant,
          id: created.id,
          expected_version: await currentVersion(tenant, created.id),
          changed_by_id: actor,
          requestId: 'ac10',
          visible_requisition_ids: null,
          scopes: SYSTEM_SCOPES,
          source_provenance: randomUUID(),
          reason: 'placement_completed',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PIPELINE_TRANSITION', statusCode: 422 });
      expect(await dispositionRows(created.id)).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // AC-11 — `completed` JOINS the live-slot exclusion set: a completed episode
    //          frees the (tenant, talent, req) slot so a fresh episode admits. This
    //          is the end-to-end proof of the index-recreate migration.
    // -----------------------------------------------------------------------
    it('AC-11: a live episode blocks a re-create; after COMPLETE the slot is freed', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id, talent, req } = await walkToQualified(tenant, actor);

      // BEFORE: qualified is LIVE — a second episode on the same key is refused.
      await expect(
        repo.create({
          tenant_id: tenant,
          input: { talent_record_id: talent, requisition_id: req }, entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
          created_by_id: actor,
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_EPISODE_ALREADY_LIVE' });

      // COMPLETE the episode (qualified -> completed, a terminal in the exclusion set).
      await repo.complete({
        tenant_id: tenant,
        id,
        expected_version: await currentVersion(tenant, id),
        changed_by_id: actor,
        requestId: 'ac11',
        visible_requisition_ids: null,
        scopes: SYSTEM_SCOPES,
        source_provenance: randomUUID(),
        reason: 'placement_completed',
      });

      // AFTER: the slot is freed — a fresh episode on the same key now admits.
      const reentry = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: talent, requisition_id: req }, entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
        created_by_id: actor,
      });
      expect(reentry.status).toBe('no_contact');
    });

    // -----------------------------------------------------------------------
    // AC-12 — COMPLETE performs the live->terminal `ended_at` flip and emits the
    //          canonical transition outbox event; NO sibling-domain write (SB-3 —
    //          L2-G wires the Placement trigger, not this slice).
    // -----------------------------------------------------------------------
    it('AC-12: COMPLETE flips ended_at and emits one pipeline.state_transition to completed', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);

      await repo.complete({
        tenant_id: tenant,
        id,
        expected_version: await currentVersion(tenant, id),
        changed_by_id: actor,
        requestId: 'ac12',
        visible_requisition_ids: null,
        scopes: SYSTEM_SCOPES,
        source_provenance: randomUUID(),
        reason: 'placement_completed',
      });

      const row = await prisma.pipeline.findUniqueOrThrow({ where: { id } });
      expect(row.ended_at).not.toBeNull();
      expect(row.ended_by_id).toBe(actor);

      const events = await prisma.outboxEvent.findMany({
        where: { tenant_id: tenant },
        orderBy: { created_at: 'asc' },
      });
      const last = events[events.length - 1]!;
      expect(last.event_type).toBe('pipeline.state_transition');
      expect((last.event_payload as { to_status: string }).to_status).toBe('completed');
    });

    // -----------------------------------------------------------------------
    // AC-13 — D-5 IMMUTABILITY. A committed PipelineDisposition is immutable at
    //          the DB layer: ordinary UPDATE and DELETE are both rejected
    //          (check_violation), mirroring the L2-B PipelineStatusHistory
    //          append-only precedent. The governed tenant-reset escape (exact-value
    //          app.tenant_reset='authorized') is the ONLY path that may DELETE.
    // -----------------------------------------------------------------------
    it('AC-13: a committed disposition rejects ordinary UPDATE and DELETE; tenant-reset escape may DELETE', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { id } = await walkToQualified(tenant, actor);
      // Commit a real disposition (RECRUITER close) — the row now exists.
      await repo.applyAction({
        tenant_id: tenant,
        id,
        action: 'DISPOSITION',
        expected_version: await currentVersion(tenant, id),
        changed_by_id: actor,
        requestId: 'ac13',
        visible_requisition_ids: null,
        authority_class: 'RECRUITER',
        reason: 'not_a_fit',
      });
      const dispo = (await dispositionRows(id))[0]!;

      // Ordinary UPDATE is rejected WHOLESALE (no escape on UPDATE).
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE pipeline."PipelineDisposition" SET reason = 'skills_mismatch' WHERE id = '${dispo.id}'`,
        ),
      ).rejects.toThrow();
      // Ordinary DELETE is rejected (no tenant-reset GUC on this connection).
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM pipeline."PipelineDisposition" WHERE id = '${dispo.id}'`,
        ),
      ).rejects.toThrow();

      // The row is unchanged after both refusals (reason still the committed value).
      const stillThere = (await dispositionRows(id))[0]!;
      expect(stillThere.reason).toBe('not_a_fit');

      // The governed tenant-reset escape (exact-value) is the ONLY path that deletes.
      // Run in one tx: SET LOCAL the exact authorized value, then DELETE succeeds.
      await prisma.$executeRawUnsafe(
        `DO $do$ BEGIN PERFORM set_config('app.tenant_reset', 'authorized', true); ` +
          `DELETE FROM pipeline."PipelineDisposition" WHERE id = '${dispo.id}'; END $do$;`,
      );
      expect(await dispositionRows(id)).toHaveLength(0);
    });
  },
);
