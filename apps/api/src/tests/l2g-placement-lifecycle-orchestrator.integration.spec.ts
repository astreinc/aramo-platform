import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { PipelineRepository, PipelinePrismaService } from '@aramo/pipeline';
import {
  PlacementPipelineInboxRepository,
  PlacementPipelineBridgePrismaService,
  PLACEMENT_STATE_CHANGED_EVENT_TYPE,
  type PlacementStateChangedPayload,
} from '@aramo/placement-pipeline-bridge';

import { PlacementLifecycleOrchestratorService } from '../placement-pipeline-orchestration/placement-lifecycle-orchestrator.service.js';

// Lane 2 / L2-G (Part 3, R-PROC/R-LINEAGE/R-NOTX) — the Placement→Pipeline lifecycle
// orchestrator, end-to-end against real Postgres 17. Proves the durable idempotent
// consumer contract: consume placement.process.state_changed → reserve (the UNIQUE
// placement_event_id is the idempotency authority) → resolve the EXACT episode by
// STORED LINEAGE (event.submittal_id → Submittal.pipeline_id, NEVER a (tenant,talent,
// req) guess) → drive the system-only Pipeline command → markProcessed(outcome) ONLY
// after success/recognized-satisfied; a TRANSIENT CAS conflict leaves the row pending
// (retry-safe). No distributed transaction spans the bridge and pipeline schemas.
//
// Schema participation: the WRITE TARGETS under test — pipeline (state/history/outbox/
// disposition) + placement_pipeline_bridge (inbox) — use their REAL migrations;
// requisition/activity/metering back the pipeline command's cross-schema legs. The two
// READ-ONLY SOURCES the orchestrator consumes (placement.OutboxEvent, submittal.
// TalentSubmittalRecord) are stood up minimally at exactly the columns the orchestrator
// reads — their full schema + producer are proven by libs/placement + libs/submittal.

const ROOT = resolve(__dirname, '../../../..');

const MIGRATIONS = [
  'libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  'libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  'libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
  'libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  'libs/pipeline/prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  'libs/pipeline/prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  'libs/pipeline/prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  'libs/pipeline/prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  'libs/pipeline/prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
  'libs/pipeline/prisma/migrations/20260828130000_l2c_pipeline_qualified_completed_enum/migration.sql',
  'libs/pipeline/prisma/migrations/20260828140000_l2c_pipeline_live_episode_recreate/migration.sql',
  'libs/pipeline/prisma/migrations/20260828150000_l2c_pipeline_disposition/migration.sql',
  'libs/pipeline/prisma/migrations/20260828160000_l2d_pipeline_entry_provenance/migration.sql',
  'libs/pipeline/prisma/migrations/20260831120000_pipeline_canonicalize_status_enum/migration.sql',
  'libs/placement-pipeline-bridge/prisma/migrations/20260831120000_l2g_init_placement_pipeline_bridge/migration.sql',
].map((p) => resolve(ROOT, p));

// Dollar-quote- AND line-comment-aware DDL splitter (the pipeline append-only + disposition
// migrations carry `$$` bodies and `--` prose lines with embedded `;`).
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

// The minimal SOURCE tables the orchestrator READS (exact columns only).
const SOURCE_TABLES = [
  `CREATE SCHEMA IF NOT EXISTS "placement"`,
  `CREATE SCHEMA IF NOT EXISTS "submittal"`,
  `CREATE TABLE "placement"."OutboxEvent" (
     "id" UUID NOT NULL PRIMARY KEY,
     "tenant_id" UUID NOT NULL,
     "event_type" TEXT NOT NULL,
     "event_payload" JSONB NOT NULL,
     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "published_at" TIMESTAMPTZ(6)
   )`,
  `CREATE TABLE "submittal"."TalentSubmittalRecord" (
     "id" UUID NOT NULL PRIMARY KEY,
     "tenant_id" UUID NOT NULL,
     "pipeline_id" UUID
   )`,
];

const NOOP_LOGGER = { log: () => undefined, warn: () => undefined, error: () => undefined } as never;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L2-G placement→pipeline lifecycle orchestrator (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setup: PipelinePrismaService;
    let pipelinePrisma: PipelinePrismaService;
    let bridgePrisma: PlacementPipelineBridgePrismaService;
    let repo: PipelineRepository;
    let inbox: PlacementPipelineInboxRepository;
    let orchestrator: PlacementLifecycleOrchestratorService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setup = new PipelinePrismaService(url);
      await setup.$connect();
      for (const m of MIGRATIONS) {
        for (const s of splitDdl(readFileSync(m, 'utf8'))) {
          if (s.trim()) await setup.$executeRawUnsafe(s.trim());
        }
      }
      for (const stmt of SOURCE_TABLES) await setup.$executeRawUnsafe(stmt);

      pipelinePrisma = new PipelinePrismaService(url);
      await pipelinePrisma.$connect();
      bridgePrisma = new PlacementPipelineBridgePrismaService(url);
      await bridgePrisma.$connect();

      repo = new PipelineRepository(pipelinePrisma);
      inbox = new PlacementPipelineInboxRepository(bridgePrisma);
      orchestrator = new PlacementLifecycleOrchestratorService(
        pipelinePrisma as never,
        inbox,
        repo,
        NOOP_LOGGER,
      );
    }, 180_000);

    afterAll(async () => {
      await setup?.$disconnect();
      await pipelinePrisma?.$disconnect();
      await bridgePrisma?.$disconnect();
      await container?.stop();
    });

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    // ---- helpers -----------------------------------------------------------
    async function seedRequisition(tenant: string): Promise<string> {
      const id = randomUUID();
      await pipelinePrisma.$executeRawUnsafe(
        `INSERT INTO requisition."Requisition" (id, tenant_id, title, company_id, openings, openings_available) ` +
          `VALUES ('${id}', '${tenant}', 'L2-G requisition', '${randomUUID()}', 3, 3)`,
      );
      return id;
    }

    async function currentVersion(tenant: string, id: string): Promise<number> {
      const v = await repo.findById({ tenant_id: tenant, id });
      return v!.version;
    }

    // Drive a genuine live episode up to `qualified` through the recruiter surface.
    async function seedLiveEpisode(
      tenant: string,
      actor: string,
      opts: { requisitionId?: string; talent?: string } = {},
    ): Promise<{ id: string; requisition_id: string; talent_record_id: string }> {
      const req = opts.requisitionId ?? (await seedRequisition(tenant));
      const talent = opts.talent ?? randomUUID();
      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: talent, requisition_id: req },
        entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
        created_by_id: actor,
      });
      for (const action of ['CONTACT', 'MARK_RESPONDED', 'START_QUALIFICATION', 'QUALIFY'] as const) {
        await repo.applyAction({
          tenant_id: tenant,
          id: created.id,
          action,
          expected_version: await currentVersion(tenant, created.id),
          changed_by_id: actor,
          requestId: `seed-${action}`,
          visible_requisition_ids: null,
        });
      }
      return { id: created.id, requisition_id: req, talent_record_id: talent };
    }

    async function seedSubmittal(tenant: string, pipelineId: string | null): Promise<string> {
      const id = randomUUID();
      await pipelinePrisma.$executeRawUnsafe(
        `INSERT INTO submittal."TalentSubmittalRecord" (id, tenant_id, pipeline_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        id,
        tenant,
        pipelineId,
      );
      return id;
    }

    async function seedEvent(payload: PlacementStateChangedPayload): Promise<string> {
      const id = randomUUID();
      await pipelinePrisma.$executeRawUnsafe(
        `INSERT INTO placement."OutboxEvent" (id, tenant_id, event_type, event_payload)
           VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)`,
        id,
        payload.tenant_id,
        PLACEMENT_STATE_CHANGED_EVENT_TYPE,
        JSON.stringify(payload),
      );
      return id;
    }

    function payloadFor(
      tenant: string,
      submittalId: string,
      toState: 'STARTED' | 'FELL_THROUGH' | 'NO_SHOW' | 'OFFER_ACCEPTED',
      opts: { requisition_id?: string; talent_record_id?: string } = {},
    ): PlacementStateChangedPayload {
      return {
        placement_process_id: randomUUID(),
        tenant_id: tenant,
        submittal_id: submittalId,
        requisition_id: opts.requisition_id ?? randomUUID(),
        talent_record_id: opts.talent_record_id ?? randomUUID(),
        from_state: 'READY_TO_START',
        to_state: toState,
        occurred_at: '2026-08-29T00:00:00.000Z',
      };
    }

    async function episodeStatus(tenant: string, id: string): Promise<string> {
      return (await repo.findById({ tenant_id: tenant, id }))!.status;
    }
    async function dispositionCount(pipelineId: string): Promise<number> {
      return pipelinePrisma.pipelineDisposition.count({ where: { pipeline_id: pipelineId } });
    }
    async function inboxRow(eventId: string) {
      return inbox.findByEventId(eventId);
    }

    // -----------------------------------------------------------------------
    // AC-1 — STARTED → COMPLETE the EXACT episode named by stored lineage.
    // -----------------------------------------------------------------------
    it('AC-1: STARTED completes the exact live episode (submittal→pipeline lineage) + records the DOWNSTREAM disposition', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const episode = await seedLiveEpisode(tenant, actor);
      const submittal = await seedSubmittal(tenant, episode.id);
      const payload = payloadFor(tenant, submittal, 'STARTED', {
        requisition_id: episode.requisition_id,
        talent_record_id: episode.talent_record_id,
      });
      const eventId = await seedEvent(payload);

      // BEFORE (non-vacuous): live, not completed, no disposition.
      expect(await episodeStatus(tenant, episode.id)).toBe('qualified');
      expect(await dispositionCount(episode.id)).toBe(0);

      const counts = await orchestrator.drainBatch({ limit: 50 });

      // AFTER: exact episode completed; inbox processed 'completed'; ONE downstream disposition.
      expect(counts['completed']).toBe(1);
      expect(await episodeStatus(tenant, episode.id)).toBe('completed');
      expect(await dispositionCount(episode.id)).toBe(1);
      const row = await inboxRow(eventId);
      expect(row!.status).toBe('processed');
      expect(row!.outcome_code).toBe('completed');
    });

    // -----------------------------------------------------------------------
    // AC-2 — Idempotent duplicate delivery = ONE command (re-drain is a no-op).
    // -----------------------------------------------------------------------
    it('AC-2: re-draining the SAME event completes the episode exactly once (idempotent, single inbox row)', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const episode = await seedLiveEpisode(tenant, actor);
      const submittal = await seedSubmittal(tenant, episode.id);
      const eventId = await seedEvent(payloadFor(tenant, submittal, 'STARTED'));

      const first = await orchestrator.drainBatch({ limit: 50 });
      expect(first['completed']).toBe(1);
      expect(await episodeStatus(tenant, episode.id)).toBe('completed');

      // Re-deliver the SAME event: the LEFT JOIN excludes consumed events, so the batch is
      // empty — no second command, exactly one inbox row (the UNIQUE placement_event_id).
      const second = await orchestrator.drainBatch({ limit: 50 });
      expect(second['completed'] ?? 0).toBe(0);
      expect(await dispositionCount(episode.id)).toBe(1);
      const rows = await pipelinePrisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT count(*)::int AS c FROM placement_pipeline_bridge."PlacementPipelineInbox" WHERE placement_event_id = $1::uuid`,
        eventId,
      );
      expect(Number(rows[0]!.c)).toBe(1);
    });

    // -----------------------------------------------------------------------
    // AC-3 — FELL_THROUGH → dispositionDownstream → not_in_consideration.
    // -----------------------------------------------------------------------
    it('AC-3: FELL_THROUGH dispositions the live episode to not_in_consideration (never completed)', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const episode = await seedLiveEpisode(tenant, actor);
      const submittal = await seedSubmittal(tenant, episode.id);
      const eventId = await seedEvent(payloadFor(tenant, submittal, 'FELL_THROUGH'));

      expect(await episodeStatus(tenant, episode.id)).toBe('qualified');

      const counts = await orchestrator.drainBatch({ limit: 50 });

      expect(counts['dispositioned']).toBe(1);
      expect(await episodeStatus(tenant, episode.id)).toBe('not_in_consideration');
      expect(await dispositionCount(episode.id)).toBe(1);
      expect((await inboxRow(eventId))!.outcome_code).toBe('dispositioned');
    });

    // -----------------------------------------------------------------------
    // AC-4 — NO_SHOW reuses the fall-through disposition (no `no_show` reason).
    // -----------------------------------------------------------------------
    it('AC-4: NO_SHOW dispositions the live episode to not_in_consideration (reuses placement_fell_through)', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const episode = await seedLiveEpisode(tenant, actor);
      const submittal = await seedSubmittal(tenant, episode.id);
      const eventId = await seedEvent(payloadFor(tenant, submittal, 'NO_SHOW'));

      const counts = await orchestrator.drainBatch({ limit: 50 });

      expect(counts['dispositioned']).toBe(1);
      expect(await episodeStatus(tenant, episode.id)).toBe('not_in_consideration');
      expect((await inboxRow(eventId))!.outcome_code).toBe('dispositioned');
    });

    // -----------------------------------------------------------------------
    // AC-5 — No stored pipeline lineage → classified skip (episode untouched).
    // -----------------------------------------------------------------------
    it('AC-5: a submittal with NULL pipeline_id is a classified no_pipeline_lineage skip (processed, no command)', async () => {
      const tenant = randomUUID();
      const submittal = await seedSubmittal(tenant, null);
      const eventId = await seedEvent(payloadFor(tenant, submittal, 'STARTED'));

      const counts = await orchestrator.drainBatch({ limit: 50 });

      expect(counts['no_pipeline_lineage']).toBe(1);
      expect((await inboxRow(eventId))!.status).toBe('processed');
      expect((await inboxRow(eventId))!.outcome_code).toBe('no_pipeline_lineage');
    });

    // -----------------------------------------------------------------------
    // AC-6 — A non-actionable to_state is a classified skip (no lineage read).
    // -----------------------------------------------------------------------
    it('AC-6: a non-actionable to_state (OFFER_ACCEPTED) is event_not_actionable (processed, no command)', async () => {
      const tenant = randomUUID();
      const submittal = await seedSubmittal(tenant, randomUUID());
      const eventId = await seedEvent(payloadFor(tenant, submittal, 'OFFER_ACCEPTED'));

      const counts = await orchestrator.drainBatch({ limit: 50 });

      expect(counts['event_not_actionable']).toBe(1);
      expect((await inboxRow(eventId))!.outcome_code).toBe('event_not_actionable');
    });

    // -----------------------------------------------------------------------
    // AC-7 — STARTED on an already-terminal episode never reopens it.
    // -----------------------------------------------------------------------
    it('AC-7: STARTED on an already-completed episode is recognized-satisfied (already_satisfied, no re-complete)', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const episode = await seedLiveEpisode(tenant, actor);
      const submittal = await seedSubmittal(tenant, episode.id);
      // First delivery completes it.
      await seedEvent(payloadFor(tenant, submittal, 'STARTED'));
      await orchestrator.drainBatch({ limit: 50 });
      expect(await episodeStatus(tenant, episode.id)).toBe('completed');
      // A DISTINCT outbox event with the SAME lineage (a replay from a different producer run).
      await seedEvent(payloadFor(tenant, submittal, 'STARTED'));
      const counts = await orchestrator.drainBatch({ limit: 50 });

      expect(counts['already_satisfied']).toBe(1);
      expect(await episodeStatus(tenant, episode.id)).toBe('completed');
      expect(await dispositionCount(episode.id)).toBe(1); // still exactly one — not re-disposed
    });

    // -----------------------------------------------------------------------
    // AC-8 — LINEAGE EXACTNESS: with two live episodes for the SAME (tenant,talent),
    // only the one the submittal points to is acted on — never a (tenant,talent) guess.
    // -----------------------------------------------------------------------
    it('AC-8: resolves the EXACT episode from submittal.pipeline_id — a SAME-talent sibling live episode is untouched', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const talent = randomUUID();
      const target = await seedLiveEpisode(tenant, actor, { talent });
      // The SAME talent + tenant, a DIFFERENT requisition → a second live episode. A
      // (tenant,talent) guess would be ambiguous here; only the stored submittal→pipeline_id
      // names `target`. This is the proof that lineage is READ, never guessed.
      const sibling = await seedLiveEpisode(tenant, actor, { talent });
      const submittal = await seedSubmittal(tenant, target.id);
      await seedEvent(payloadFor(tenant, submittal, 'STARTED', {
        requisition_id: target.requisition_id,
        talent_record_id: target.talent_record_id,
      }));

      const counts = await orchestrator.drainBatch({ limit: 50 });

      expect(counts['completed']).toBe(1);
      expect(await episodeStatus(tenant, target.id)).toBe('completed');
      // The sibling episode the lineage did NOT name is untouched — still live.
      expect(await episodeStatus(tenant, sibling.id)).toBe('qualified');
    });

    // -----------------------------------------------------------------------
    // AC-9 — RETRY-SAFE: a transient CAS conflict leaves the row PENDING; a later
    // tick completes it. markProcessed is NEVER called before the command succeeds.
    // -----------------------------------------------------------------------
    it('AC-9: a transient PIPELINE_TRANSITION_CONFLICT leaves the inbox row pending; the next drain completes it', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const episode = await seedLiveEpisode(tenant, actor);
      const submittal = await seedSubmittal(tenant, episode.id);
      const eventId = await seedEvent(payloadFor(tenant, submittal, 'STARTED'));

      // Inject ONE transient conflict at the command boundary (a real CAS race shape).
      const spy = vi
        .spyOn(repo, 'complete')
        .mockRejectedValueOnce(
          new AramoError('PIPELINE_TRANSITION_CONFLICT', 'stale version', 409, { requestId: 'r' }),
        );

      const first = await orchestrator.drainBatch({ limit: 50 });
      // Transient → NOT an outcome; the row is reserved but still PENDING (retry-safe).
      expect(first['completed'] ?? 0).toBe(0);
      const pending = await inboxRow(eventId);
      expect(pending!.status).toBe('pending');
      expect(pending!.processed_at).toBeNull();
      expect(await episodeStatus(tenant, episode.id)).toBe('qualified'); // untouched

      // The conflict clears; the next drain re-picks the pending event and completes it.
      spy.mockRestore();
      const second = await orchestrator.drainBatch({ limit: 50 });
      expect(second['completed']).toBe(1);
      expect(await episodeStatus(tenant, episode.id)).toBe('completed');
      expect((await inboxRow(eventId))!.status).toBe('processed');
    });
  },
);
