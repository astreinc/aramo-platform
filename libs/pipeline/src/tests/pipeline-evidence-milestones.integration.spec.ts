import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PipelineRepository } from '../lib/pipeline.repository.js';

// Recruiting-Journey Evidence-Governed Milestones — the EVIDENCE GATE, the
// evidence-bearing commands, and FORWARD RECONCILIATION proven against real
// Postgres 17. Each proof asserts the BEFORE value then the EXACT after value.
//
//   I1/I2/§17 — contacted / talent_responded are reachable ONLY from grounded
//   evidence. A naked transition into either (no evidence provenance) is refused
//   in the domain authority with PIPELINE_STAGE_REQUIRES_EVIDENCE (422), writing
//   nothing. NEGATIVE CONTROL: before this slice the generic transition() admitted
//   a naked no_contact → contacted / → talent_responded (the pre-slice CAS/mono
//   specs did exactly that); those are now routed through the evidence commands.
//
//   §9/§10/I4 — qualifying / qualified remain naked recruiter DECISIONS (no
//   evidence predicate).
//
//   §8/§11/§12/I5/I6 — reconcileForward repairs a lagging Pipeline FORWARD through
//   the ordered milestones, idempotently, never backward, never past a terminal.

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
  'Pipeline evidence-governed milestones — gate + evidence commands + reconcile (real Postgres 17)',
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

    async function historyCount(pipelineId: string): Promise<number> {
      const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pipeline."PipelineStatusHistory" WHERE pipeline_id = '${pipelineId}'`,
      );
      return Number(rows[0]!.n);
    }
    async function outboxPayloads(pipelineId: string): Promise<Record<string, unknown>[]> {
      const rows = await prisma.$queryRawUnsafe<{ event_payload: Record<string, unknown> }[]>(
        `SELECT event_payload FROM pipeline."OutboxEvent" WHERE event_payload->>'pipeline_id' = '${pipelineId}' ORDER BY created_at ASC`,
      );
      return rows.map((r) => r.event_payload);
    }
    async function seed(tenant: string): Promise<string> {
      const created = await repo.create({
        tenant_id: tenant,
        input: { talent_record_id: randomUUID(), requisition_id: randomUUID() },
        entry_provenance: { origin_type: 'MANUAL_RECRUITER', initiated_by_kind: 'user' },
      });
      expect(created.status).toBe('no_contact');
      expect(created.version).toBe(0);
      return created.id;
    }

    // ---- GATE-1 — a naked transition into contacted is refused (I1/§22.6) ----
    it('GATE: a naked transition into contacted is refused PIPELINE_STAGE_REQUIRES_EVIDENCE and writes nothing', async () => {
      const tenant = randomUUID();
      const id = await seed(tenant);
      expect(await historyCount(id)).toBe(1); // only the birth row

      await expect(
        repo.transition({
          tenant_id: tenant,
          id,
          to_status: 'contacted',
          changed_by_id: randomUUID(),
          requestId: 'gate-1',
          expected_version: 0,
          visible_requisition_ids: null,
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_STAGE_REQUIRES_EVIDENCE', statusCode: 422 });

      const after = await repo.findById({ tenant_id: tenant, id });
      expect(after?.status).toBe('no_contact'); // unmutated
      expect(after?.version).toBe(0);
      expect(await historyCount(id)).toBe(1); // no new row
    });

    // ---- GATE-2 — a naked transition into talent_responded is refused (I2) ----
    it('GATE: a naked transition into talent_responded is refused PIPELINE_STAGE_REQUIRES_EVIDENCE', async () => {
      const tenant = randomUUID();
      const id = await seed(tenant);
      await expect(
        repo.transition({
          tenant_id: tenant,
          id,
          to_status: 'talent_responded',
          changed_by_id: randomUUID(),
          requestId: 'gate-2',
          expected_version: 0,
          visible_requisition_ids: null,
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_STAGE_REQUIRES_EVIDENCE', statusCode: 422 });
      const after = await repo.findById({ tenant_id: tenant, id });
      expect(after?.status).toBe('no_contact');
    });

    // ---- EV-1 — recordContactEvidence advances no_contact -> contacted + provenance (§5) ----
    it('EVIDENCE: recordContactEvidence advances no_contact -> contacted and stamps evidence provenance on the outbox', async () => {
      const tenant = randomUUID();
      const id = await seed(tenant);
      const evId = randomUUID();
      const res = await repo.recordContactEvidence({
        tenant_id: tenant,
        id,
        changed_by_id: randomUUID(),
        requestId: 'ev-1',
        expected_version: 0,
        visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: evId },
      });
      expect(res.status).toBe('contacted'); // EXACT after
      expect(res.version).toBe(1);
      const events = await outboxPayloads(id);
      const transitionEvent = events.find((e) => e['to_status'] === 'contacted')!;
      expect(transitionEvent['evidence_kind']).toBe('communication_interaction');
      expect(transitionEvent['evidence_id']).toBe(evId); // §28 reconstruction ref
    });

    // ---- EV-2 — recordResponseEvidence advances contacted -> talent_responded (§7) ----
    it('EVIDENCE: recordResponseEvidence advances contacted -> talent_responded', async () => {
      const tenant = randomUUID();
      const id = await seed(tenant);
      const c = await repo.recordContactEvidence({
        tenant_id: tenant, id, changed_by_id: randomUUID(), requestId: 'ev-2a',
        expected_version: 0, visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: randomUUID() },
      });
      const r = await repo.recordResponseEvidence({
        tenant_id: tenant, id, changed_by_id: randomUUID(), requestId: 'ev-2b',
        expected_version: c.version, visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: randomUUID() },
      });
      expect(r.status).toBe('talent_responded');
      expect(r.version).toBe(2);
    });

    // ---- DEC-1 — qualifying / qualified remain naked recruiter DECISIONS (§24/I4) ----
    it('DECISION: qualifying and qualified advance with NO evidence (recruiter decisions)', async () => {
      const tenant = randomUUID();
      const id = await seed(tenant);
      await repo.recordContactEvidence({
        tenant_id: tenant, id, changed_by_id: randomUUID(), requestId: 'dec-c',
        expected_version: 0, visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: randomUUID() },
      });
      await repo.recordResponseEvidence({
        tenant_id: tenant, id, changed_by_id: randomUUID(), requestId: 'dec-r',
        expected_version: 1, visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: randomUUID() },
      });
      // No evidence_provenance — a naked decision transition is ALLOWED for these edges.
      const q = await repo.transition({
        tenant_id: tenant, id, to_status: 'qualifying', changed_by_id: randomUUID(),
        requestId: 'dec-q', expected_version: 2, visible_requisition_ids: null,
      });
      expect(q.status).toBe('qualifying');
      const qd = await repo.transition({
        tenant_id: tenant, id, to_status: 'qualified', changed_by_id: randomUUID(),
        requestId: 'dec-qd', expected_version: 3, visible_requisition_ids: null,
      });
      expect(qd.status).toBe('qualified');
    });

    // ---- REC-1 — reconcileForward walks no_contact -> contacted -> talent_responded (§8/§25) ----
    it('RECONCILE: a lagging no_contact pipeline with response evidence reconciles forward through ordered milestones', async () => {
      const tenant = randomUUID();
      const id = await seed(tenant);
      expect(await historyCount(id)).toBe(1); // birth only — BEFORE

      const res = await repo.reconcileForward({
        tenant_id: tenant,
        id,
        target: 'talent_responded',
        changed_by_id: randomUUID(),
        requestId: 'rec-1',
        visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: randomUUID() },
      });
      expect(res.status).toBe('talent_responded'); // EXACT after
      expect(res.version).toBe(2); // two hops, +1 each
      // TWO new history rows (contacted, talent_responded) — the ordered milestones
      // were truthfully recorded, not a single direct jump.
      expect(await historyCount(id)).toBe(3); // birth + contacted + talent_responded
      // The create() episode-birth event also carries pipeline_id (no to_status);
      // the reconcile's two transition events are the ordered milestones.
      const tos = (await outboxPayloads(id))
        .map((e) => e['to_status'])
        .filter((t): t is string => t !== undefined && t !== null);
      expect(tos).toEqual(['contacted', 'talent_responded']);
    });

    // ---- REC-2 — reconcileForward is idempotent (already past target → no-op, §25) ----
    it('RECONCILE: a pipeline already at/past the target is a no-op (idempotent, no duplicate events)', async () => {
      const tenant = randomUUID();
      const id = await seed(tenant);
      await repo.reconcileForward({
        tenant_id: tenant, id, target: 'talent_responded', changed_by_id: randomUUID(),
        requestId: 'rec-2a', visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: randomUUID() },
      });
      const hc = await historyCount(id);
      const ec = (await outboxPayloads(id)).length;

      // Replay the SAME reconcile — must be a pure no-op.
      const res = await repo.reconcileForward({
        tenant_id: tenant, id, target: 'talent_responded', changed_by_id: randomUUID(),
        requestId: 'rec-2b', visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: randomUUID() },
      });
      expect(res.status).toBe('talent_responded');
      expect(await historyCount(id)).toBe(hc); // NO new history
      expect((await outboxPayloads(id)).length).toBe(ec); // NO new events
    });

    // ---- REC-3 — reconcileForward NEVER regresses a more-advanced stage (§25/I5) ----
    it('RECONCILE: a pipeline already past target (qualifying) is never moved backward', async () => {
      const tenant = randomUUID();
      const id = await seed(tenant);
      await repo.recordContactEvidence({
        tenant_id: tenant, id, changed_by_id: randomUUID(), requestId: 'rec-3c',
        expected_version: 0, visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: randomUUID() },
      });
      await repo.recordResponseEvidence({
        tenant_id: tenant, id, changed_by_id: randomUUID(), requestId: 'rec-3r',
        expected_version: 1, visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: randomUUID() },
      });
      const q = await repo.transition({
        tenant_id: tenant, id, to_status: 'qualifying', changed_by_id: randomUUID(),
        requestId: 'rec-3q', expected_version: 2, visible_requisition_ids: null,
      });
      expect(q.status).toBe('qualifying');
      const hcBefore = await historyCount(id);

      // Reconcile to talent_responded — which is BELOW qualifying — must be a no-op.
      const res = await repo.reconcileForward({
        tenant_id: tenant, id, target: 'talent_responded', changed_by_id: randomUUID(),
        requestId: 'rec-3rec', visible_requisition_ids: null,
        evidence: { kind: 'communication_interaction', id: randomUUID() },
      });
      expect(res.status).toBe('qualifying'); // unchanged — no backward move
      expect(await historyCount(id)).toBe(hcBefore);
    });
  },
);
