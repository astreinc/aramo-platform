import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PipelineRepository } from '../lib/pipeline.repository.js';

// L2-B — Durable Episode Substrate (Aramo-Talent-Pipeline-Lane2-B-Durable-
// Episode-Substrate-Directive-v1_0-LOCKED). The lib-local acceptance proofs for
// the substrate half of the slice: DB-enforced append-only status history
// (+governed tenant-reset escape), the live->terminal `ended_at`/`ended_by_id`
// flip, the create() birth history row (NULL -> no_contact), the in-tx canonical
// OutboxEvent emissions, and the reconcile-leaves-history-untouched structural
// invariant. Idempotency (AC-8) and the withdrawn DELETE route (AC-4) are
// HTTP-boundary behaviours proven in apps/api (ats-batch4a); the outbox DRAIN
// (AC-7, publisher side) is proven in the outbox-publisher lane. Every criterion
// carries the directive's negative control (Rule F).
//
// Same schema participation as pipeline-write-invariants: pipeline (state +
// history + outbox), activity + metering (cross-schema raw INSERT in the
// transition legs), requisition (seed target for the created episode).
const MIGRATIONS = [
  '../../../../libs/requisition/prisma/migrations/20260602100000_init_requisition_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  '../../../../libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
  '../../../../libs/metering/prisma/migrations/20260601150000_init_metering_model/migration.sql',
  '../../prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  '../../prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  '../../prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  // L2-B — append-only history trigger; nullable status_from + ended_at/ended_by_id; pipeline OutboxEvent.
  '../../prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  '../../prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  '../../prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
].map((p) => resolve(__dirname, p));

// Dollar-quote- AND line-comment-aware DDL splitter — the L2-B append-only
// migration carries `$$` function bodies AND `--` comment lines with prose that
// must not be split. (Same splitter as pipeline-write-invariants; the L2-B
// migration comments are authored `;`-free per the splitter guard.)
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
  'L2-B durable episode substrate (real Postgres 17)',
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
          `VALUES ('${id}', '${tenant}', 'L2-B requisition', '${randomUUID()}', 3, 3)`,
      );
      return id;
    }

    // A fresh live episode + its actor, for a test that needs a committed row.
    async function createEpisode(tenant: string, actor: string) {
      const req = await seedRequisition(tenant);
      const talent = randomUUID();
      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: talent, requisition_id: req },
        created_by_id: actor,
      });
      return { req, talent, created };
    }

    async function historyRows(pipelineId: string) {
      return prisma.pipelineStatusHistory.findMany({
        where: { pipeline_id: pipelineId },
        orderBy: { changed_at: 'asc' },
      });
    }

    async function outboxRows(tenant: string) {
      return prisma.outboxEvent.findMany({
        where: { tenant_id: tenant },
        orderBy: { created_at: 'asc' },
      });
    }

    // -----------------------------------------------------------------------
    // AC-6 — creation history row: exactly one, NULL -> no_contact.
    // -----------------------------------------------------------------------
    it('AC-6: create() writes exactly one birth history row (status_from NULL -> no_contact)', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();

      // BEFORE: no history exists for a not-yet-created episode (non-vacuous).
      const req = await seedRequisition(tenant);
      const talent = randomUUID();

      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: talent, requisition_id: req },
        created_by_id: actor,
      });

      // AFTER: exactly one row, the birth row, committed in the create tx.
      const rows = await historyRows(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status_from).toBeNull();
      expect(rows[0]!.status_to).toBe('no_contact');
      expect(rows[0]!.changed_by_id).toBe(actor);

      // Negative control: an episode created WITHOUT an actor still writes the
      // birth row, with a NULL actor — the row is unconditional, the actor is not.
      const anon = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: randomUUID(), requisition_id: req },
      });
      const anonRows = await historyRows(anon.id);
      expect(anonRows).toHaveLength(1);
      expect(anonRows[0]!.status_from).toBeNull();
      expect(anonRows[0]!.changed_by_id).toBeNull();
    });

    // -----------------------------------------------------------------------
    // AC-7 — canonical outbox events, in the same tx as the mutation.
    // -----------------------------------------------------------------------
    it('AC-7: create() emits one pipeline.created; a committed transition emits one pipeline.state_transition', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();

      // BEFORE: no outbox rows for this tenant (non-vacuous).
      expect(await outboxRows(tenant)).toHaveLength(0);

      const { created } = await createEpisode(tenant, actor);

      const afterCreate = await outboxRows(tenant);
      expect(afterCreate).toHaveLength(1);
      expect(afterCreate[0]!.event_type).toBe('pipeline.created');
      expect(afterCreate[0]!.published_at).toBeNull();

      // A committed transition emits exactly one more, of the transition type.
      const cur = await repo.findById({ tenant_id: tenant, id: created.id });
      await repo.transition({
        tenant_id: tenant,
        id: created.id,
        to_status: 'contacted',
        changed_by_id: actor,
        requestId: 'ac7',
        expected_version: cur!.version,
        visible_requisition_ids: null,
      });

      const afterTransition = await outboxRows(tenant);
      expect(afterTransition).toHaveLength(2);
      expect(afterTransition[1]!.event_type).toBe('pipeline.state_transition');
    });

    // -----------------------------------------------------------------------
    // AC-1 — history UPDATE rejected at the DB layer (append-only).
    // -----------------------------------------------------------------------
    it('AC-1: a raw UPDATE of a PipelineStatusHistory row raises check_violation', async () => {
      const tenant = randomUUID();
      const { created } = await createEpisode(tenant, randomUUID());
      const birth = (await historyRows(created.id))[0]!;

      // The trigger rejects the UPDATE wholesale.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE pipeline."PipelineStatusHistory" SET note = 'tampered' WHERE id = '${birth.id}'`,
        ),
      ).rejects.toThrow();

      // The row is unchanged (note still NULL) — the UPDATE never landed.
      const after = (await historyRows(created.id))[0]!;
      expect(after.note).toBeNull();

      // Negative control: the trigger blocks UPDATE ONLY — appending a NEW
      // history row via a legal transition still succeeds (append-only, not
      // write-locked). This proves the rejection is UPDATE-specific.
      const cur = await repo.findById({ tenant_id: tenant, id: created.id });
      await repo.transition({
        tenant_id: tenant,
        id: created.id,
        to_status: 'contacted',
        changed_by_id: randomUUID(),
        requestId: 'ac1-neg',
        expected_version: cur!.version,
        visible_requisition_ids: null,
      });
      expect(await historyRows(created.id)).toHaveLength(2);
    });

    // -----------------------------------------------------------------------
    // AC-2 / AC-3 — history DELETE rejected without the GUC; the exact-value
    // tenant-reset escape (and ONLY that exact value) permits it.
    // -----------------------------------------------------------------------
    it('AC-2/AC-3: DELETE rejected without the GUC; permitted under exact app.tenant_reset=authorized; rejected for any other value', async () => {
      const tenant = randomUUID();
      const { created } = await createEpisode(tenant, randomUUID());
      const birthId = (await historyRows(created.id))[0]!.id;

      // AC-2 — ordinary DELETE (no GUC) is rejected.
      await expect(
        prisma.$executeRawUnsafe(
          `DELETE FROM pipeline."PipelineStatusHistory" WHERE id = '${birthId}'`,
        ),
      ).rejects.toThrow();
      expect(await historyRows(created.id)).toHaveLength(1);

      // AC-3 negative control (exact-value): a WRONG GUC value is still rejected —
      // proving the escape is exact-match, not truthy/non-empty.
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL app.tenant_reset = 'nope'");
          await tx.$executeRawUnsafe(
            `DELETE FROM pipeline."PipelineStatusHistory" WHERE id = '${birthId}'`,
          );
        }),
      ).rejects.toThrow();
      expect(await historyRows(created.id)).toHaveLength(1);

      // AC-3 — the exact authorized value permits the DELETE inside the tx.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL app.tenant_reset = 'authorized'");
        await tx.$executeRawUnsafe(
          `DELETE FROM pipeline."PipelineStatusHistory" WHERE id = '${birthId}'`,
        );
      });
      expect(await historyRows(created.id)).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // AC-5 — ended_at/ended_by_id on the live->terminal flip; NULL while live.
    // -----------------------------------------------------------------------
    it('AC-5: a live->terminal transition sets ended_at + ended_by_id; a live->live transition leaves both NULL', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { created } = await createEpisode(tenant, actor);

      // BEFORE (live): both NULL.
      const beforeRow = await repo.findById({ tenant_id: tenant, id: created.id });
      const beforeRaw = await prisma.pipeline.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(beforeRaw.ended_at).toBeNull();
      expect(beforeRaw.ended_by_id).toBeNull();

      // Negative control — a live->live transition (no_contact -> contacted)
      // leaves BOTH columns NULL (the flip is terminal-only, not every write).
      await repo.transition({
        tenant_id: tenant,
        id: created.id,
        to_status: 'contacted',
        changed_by_id: actor,
        requestId: 'ac5-live',
        expected_version: beforeRow!.version,
        visible_requisition_ids: null,
      });
      const liveRaw = await prisma.pipeline.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(liveRaw.ended_at).toBeNull();
      expect(liveRaw.ended_by_id).toBeNull();

      // The live->terminal flip (contacted -> not_in_consideration) sets BOTH:
      // ended_by_id == the actor, ended_at == the transition instant. Bracket the
      // transition by wall-clock [t0, t1] and assert ended_at falls inside — the
      // repo captures a single `eventInstant` for this write, so the timestamp is
      // the ACTUAL transition instant, not a defaulted or zero value (non-vacuous).
      const terminalActor = randomUUID();
      const midRow = await repo.findById({ tenant_id: tenant, id: created.id });
      const t0 = Date.now();
      await repo.transition({
        tenant_id: tenant,
        id: created.id,
        to_status: 'not_in_consideration',
        changed_by_id: terminalActor,
        requestId: 'ac5-terminal',
        expected_version: midRow!.version,
        visible_requisition_ids: null,
      });
      const t1 = Date.now();
      const endedRaw = await prisma.pipeline.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(endedRaw.ended_at).not.toBeNull();
      expect(endedRaw.ended_by_id).toBe(terminalActor);

      // Non-vacuous: ended_at is the terminal transition instant (within the
      // bracket), and the final history row is the terminal one.
      const endedMs = endedRaw.ended_at!.getTime();
      expect(endedMs).toBeGreaterThanOrEqual(t0);
      expect(endedMs).toBeLessThanOrEqual(t1);
      const rows = await historyRows(created.id);
      expect(rows[rows.length - 1]!.status_to).toBe('not_in_consideration');
    });

    // -----------------------------------------------------------------------
    // AC-9 (structural) — the identity-merge reconcile never touches history:
    // repoint mutates Pipeline.talent_record_id only, leaving every history row
    // byte-for-byte, while the trigger DOES fire on a direct history UPDATE.
    // -----------------------------------------------------------------------
    it('AC-9: repointTalentRecordRefs preserves history (count + content) while the append-only trigger stays live', async () => {
      const tenant = randomUUID();
      const actor = randomUUID();
      const { created, talent } = await createEpisode(tenant, actor);

      // Give the episode a second history row so preservation is non-trivial.
      const cur = await repo.findById({ tenant_id: tenant, id: created.id });
      await repo.transition({
        tenant_id: tenant,
        id: created.id,
        to_status: 'contacted',
        changed_by_id: actor,
        requestId: 'ac9-seed',
        expected_version: cur!.version,
        visible_requisition_ids: null,
      });
      const before = await historyRows(created.id);
      expect(before).toHaveLength(2);
      const beforeSnapshot = JSON.stringify(before);

      // The reconcile repoints the talent ref (PRESERVE-ALL), touching only
      // Pipeline.talent_record_id — never a history row.
      const newRecord = randomUUID();
      const result = await repo.repointTalentRecordRefs({
        tenant_id: tenant,
        from_record_id: talent,
        to_record_id: newRecord,
      });
      expect(result.repointed_ids).toContain(created.id);
      expect(result.removed_rows).toHaveLength(0);

      const repointed = await prisma.pipeline.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(repointed.talent_record_id).toBe(newRecord);

      // History is byte-for-byte unchanged — the reconcile never trips the trigger.
      const after = await historyRows(created.id);
      expect(after).toHaveLength(2);
      expect(JSON.stringify(after)).toBe(beforeSnapshot);

      // Structural counter-proof: the trigger is genuinely live — a DIRECT
      // history UPDATE (what the reconcile scrupulously avoids) IS rejected.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE pipeline."PipelineStatusHistory" SET note = 'x' WHERE id = '${after[0]!.id}'`,
        ),
      ).rejects.toThrow();
    });
  },
);
