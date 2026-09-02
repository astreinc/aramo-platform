import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PrismaService as PreStartPrismaService,
  DefinitionSetRepository,
  RequirementInstanceRepository,
  MaterializationIntentRepository,
  type RequirementDefinitionInput,
} from '@aramo/pre-start-requirement';

import { PreStartMaterializationService } from '../../pre-start-requirement/pre-start-materialization.service.js';
import { PreStartCancellationService } from '../../pre-start-requirement/pre-start-cancellation.service.js';
import { PreStartOrchestratorService } from '../../pre-start-requirement/pre-start-orchestrator.service.js';

// Lane 5 / L5-P1 (E2 ignition) — the pre-start orchestrator, end-to-end against real
// Postgres 17. Proves the wire that was cut is now live: E2's materialize saga +
// terminal cancellation had ZERO production callers before this slice. The orchestrator
// ignites them off the durable placement outbox facts, with idempotency riding E2's own
// state (MaterializationIntent uniqueness + instance resolution) — NO new inbox table.
//
// Schema participation: the WRITE TARGETS under test — the pre_start_requirement schema
// (Set/Definition/Instance/Intent/Audit) — use their REAL init migration (5 tables + the
// three DB triggers + the completeness CHECK). The single READ SOURCE the orchestrator
// consumes (placement.OutboxEvent) is stood up minimally at exactly the columns the raw
// drain reads — its full schema + producer are proven by libs/placement.

const INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../../../../libs/pre-start-requirement/prisma/migrations/20260804090000_init_pre_start_requirement/migration.sql',
);
// L5-P5 — a SEPARATE const (never a 2nd resolve() arg — ENOTDIR trap). ensureIntent
// now writes the layered context columns, so the intent table needs this migration.
const INTENT_CONTEXT_MIGRATION_PATH = resolve(
  __dirname,
  '../../../../../libs/pre-start-requirement/prisma/migrations/20260901190000_l5_pre_start_intent_layered_context/migration.sql',
);
// L5-P6 — materialize now INSERTs satisfaction_policy, so the column must exist.
const SATISFACTION_POLICY_MIGRATION_PATH = resolve(
  __dirname,
  '../../../../../libs/pre-start-requirement/prisma/migrations/20260901200000_l5_pre_start_satisfaction_policy/migration.sql',
);

// The minimal SOURCE tables the orchestrator READS (exact columns only), mirroring the
// L2-G orchestrator spec's approach to a cross-schema read-source. L5-P5 adds a minimal
// requisition.Requisition so drainIntake can derive client_id (company_id).
const SOURCE_TABLES = [
  `CREATE SCHEMA IF NOT EXISTS "placement"`,
  `CREATE TABLE "placement"."OutboxEvent" (
     "id" UUID NOT NULL PRIMARY KEY,
     "tenant_id" UUID NOT NULL,
     "event_type" TEXT NOT NULL,
     "event_payload" JSONB NOT NULL,
     "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "published_at" TIMESTAMPTZ(6)
   )`,
  `CREATE SCHEMA IF NOT EXISTS "requisition"`,
  `CREATE TABLE "requisition"."Requisition" (
     "id" UUID NOT NULL PRIMARY KEY,
     "tenant_id" UUID NOT NULL,
     "company_id" UUID
   )`,
];

const DEFS: RequirementDefinitionInput[] = [
  { requirement_type: 'BACKGROUND_CHECK', label: 'Background check', blocking: true, owner_role: null, sequence: 1, waiver_mode: 'NOT_WAIVABLE' },
  { requirement_type: 'CLIENT_PAPERWORK', label: 'Client paperwork', blocking: true, owner_role: 'account_manager', sequence: 2, waiver_mode: 'COMPLIANCE_AUTHORITY_ONLY' },
  { requirement_type: 'NDA', label: 'NDA', blocking: false, owner_role: null, sequence: 3, waiver_mode: 'AUTHORIZED_INTERNAL' },
];

const NOOP_LOGGER = { log: () => undefined, warn: () => undefined, error: () => undefined } as never;
const BATCH = 100;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L5-P1 pre-start orchestrator — E2 ignition (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PreStartPrismaService;
    let prisma: PreStartPrismaService;
    let sets: DefinitionSetRepository;
    let instances: RequirementInstanceRepository;
    let intents: MaterializationIntentRepository;
    let orchestrator: PreStartOrchestratorService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setupClient = new PreStartPrismaService(url);
      await setupClient.$connect();
      for (const migrationPath of [INIT_MIGRATION_PATH, INTENT_CONTEXT_MIGRATION_PATH, SATISFACTION_POLICY_MIGRATION_PATH]) {
        for (const stmt of splitDdl(readFileSync(migrationPath, 'utf8'))) {
          if (stmt.trim()) await setupClient.$executeRawUnsafe(stmt.trim());
        }
      }
      for (const stmt of SOURCE_TABLES) await setupClient.$executeRawUnsafe(stmt);

      prisma = new PreStartPrismaService(url);
      await prisma.$connect();
      sets = new DefinitionSetRepository(prisma);
      instances = new RequirementInstanceRepository(prisma);
      intents = new MaterializationIntentRepository(prisma);
      const materialization = new PreStartMaterializationService(sets, instances, intents);
      const cancellation = new PreStartCancellationService(instances);
      // The raw reader is the same pooled client (reads placement.OutboxEvent + pre_start).
      orchestrator = new PreStartOrchestratorService(
        prisma as never,
        materialization,
        cancellation,
        NOOP_LOGGER,
      );
    }, 180_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    // ---- helpers -----------------------------------------------------------
    async function publishTenantSet(tenant: string): Promise<void> {
      const draft = await sets.createDraft(
        { tenant_id: tenant, scope: 'TENANT', scope_ref_id: tenant, version: 'v1', definitions: DEFS },
        'seed',
      );
      await sets.publish({ tenant_id: tenant, set_id: draft.id, published_by: randomUUID() }, 'seed');
    }

    async function seedOutbox(tenant: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
      await setupClient.$executeRawUnsafe(
        `INSERT INTO placement."OutboxEvent" (id, tenant_id, event_type, event_payload)
           VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)`,
        randomUUID(),
        tenant,
        eventType,
        JSON.stringify(payload),
      );
    }

    const seedCreated = (tenant: string, placement: string) =>
      seedOutbox(tenant, 'placement.process.created', { placement_process_id: placement, tenant_id: tenant, state: 'PRE_START' });

    const seedTerminal = (tenant: string, placement: string, to_state: 'NO_SHOW' | 'FELL_THROUGH') =>
      seedOutbox(tenant, 'placement.process.state_changed', { placement_process_id: placement, tenant_id: tenant, from_state: 'READY_TO_START', to_state });

    async function statuses(tenant: string, placement: string): Promise<string[]> {
      return (await instances.findByPlacement(tenant, placement)).map((i) => i.status).sort();
    }

    // ---- Proof A — drainIntake materializes (the ignition; non-vacuous) ----

    it('drainIntake materializes the applicable snapshot for a created placement (0 before → 3 after)', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      await publishTenantSet(tenant);
      await seedCreated(tenant, placement);

      // BEFORE: nothing materialized, no intent — the pre-ignition state.
      expect((await instances.findByPlacement(tenant, placement)).length).toBe(0);
      expect(await intents.findByPlacement(tenant, placement)).toBeNull();

      const materialized = await orchestrator.drainIntake(BATCH);

      // AFTER: exactly the 3 configured requirements exist and the intent is resolved.
      expect(materialized).toBe(1);
      expect((await instances.findByPlacement(tenant, placement)).length).toBe(3);
      expect((await intents.findByPlacement(tenant, placement))?.status).toBe('resolved');
    });

    it('drainIntake is idempotent — a placement with an intent is not re-picked (no duplicate instances)', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      await publishTenantSet(tenant);
      await seedCreated(tenant, placement);

      expect(await orchestrator.drainIntake(BATCH)).toBe(1);
      // Second drain: the intent now exists, so the created event is excluded (0 picked)
      // and the instance set is unchanged (still exactly 3).
      expect(await orchestrator.drainIntake(BATCH)).toBe(0);
      expect((await instances.findByPlacement(tenant, placement)).length).toBe(3);
    });

    it('drainIntake with NO published set QUARANTINES the intent (fail-closed; 0 instances)', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      // no publishTenantSet — a config gap.
      await seedCreated(tenant, placement);

      await orchestrator.drainIntake(BATCH);

      const intent = await intents.findByPlacement(tenant, placement);
      expect(intent?.status).toBe('quarantined');
      expect(intent?.quarantine_reason).toBe('no_published_definition_set');
      expect((await instances.findByPlacement(tenant, placement)).length).toBe(0);
    });

    it('drainIntake is tenant-isolated — a created event never materializes under another tenant', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      await publishTenantSet(tenant);
      await seedCreated(tenant, placement);
      await orchestrator.drainIntake(BATCH);

      expect((await instances.findByPlacement(tenant, placement)).length).toBe(3);
      expect((await instances.findByPlacement(randomUUID(), placement)).length).toBe(0);
    });

    // ---- Proof B — drainTerminalCancellations cancels unresolved (non-vacuous) ----

    it('drainTerminalCancellations cancels every unresolved requirement on FELL_THROUGH (3 PENDING → 3 CANCELED)', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      await publishTenantSet(tenant);
      await seedCreated(tenant, placement);
      await orchestrator.drainIntake(BATCH);

      // BEFORE: the 3 requirements are unresolved (PENDING).
      expect(await statuses(tenant, placement)).toEqual(['PENDING', 'PENDING', 'PENDING']);

      await seedTerminal(tenant, placement, 'FELL_THROUGH');
      const cancelled = await orchestrator.drainTerminalCancellations(BATCH);

      // AFTER: every instance is CANCELED.
      expect(cancelled).toBe(1);
      expect(await statuses(tenant, placement)).toEqual(['CANCELED', 'CANCELED', 'CANCELED']);
    });

    it('drainTerminalCancellations is self-limiting — a placement with no unresolved instances is not re-picked', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      await publishTenantSet(tenant);
      await seedCreated(tenant, placement);
      await orchestrator.drainIntake(BATCH);
      await seedTerminal(tenant, placement, 'FELL_THROUGH');

      expect(await orchestrator.drainTerminalCancellations(BATCH)).toBe(1);
      // Second drain: no unresolved instances remain → the EXISTS predicate excludes it.
      expect(await orchestrator.drainTerminalCancellations(BATCH)).toBe(0);
      expect(await statuses(tenant, placement)).toEqual(['CANCELED', 'CANCELED', 'CANCELED']);
    });

    it('the cancellation reason maps by terminal state (NO_SHOW → placement_no_show)', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      await publishTenantSet(tenant);
      await seedCreated(tenant, placement);
      await orchestrator.drainIntake(BATCH);
      await seedTerminal(tenant, placement, 'NO_SHOW');
      await orchestrator.drainTerminalCancellations(BATCH);

      const rows = await prisma.$queryRawUnsafe<Array<{ reason: string }>>(
        `SELECT DISTINCT reason FROM pre_start_requirement."PreStartRequirementAudit"
           WHERE tenant_id = $1::uuid AND action = 'CANCELED'`,
        tenant,
      );
      expect(rows.map((r) => r.reason)).toEqual(['placement_no_show']);
    });

    it('an already-SATISFIED requirement is NOT cancelled by a terminal event', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      await publishTenantSet(tenant);
      await seedCreated(tenant, placement);
      await orchestrator.drainIntake(BATCH);

      const list = await instances.findByPlacement(tenant, placement);
      const nda = list.find((i) => i.requirement_type === 'NDA');
      await instances.applyStatusMove(
        { tenant_id: tenant, requirement_instance_id: nda?.id ?? '', to: 'SATISFIED', actor_id: randomUUID(), actor_type: 'user', completed_by: randomUUID() },
        's',
      );

      await seedTerminal(tenant, placement, 'FELL_THROUGH');
      await orchestrator.drainTerminalCancellations(BATCH);

      const after = await instances.findByPlacement(tenant, placement);
      expect(after.find((i) => i.requirement_type === 'NDA')?.status).toBe('SATISFIED');
      // the two still-unresolved blocking requirements were cancelled.
      expect(after.filter((i) => i.status === 'CANCELED').length).toBe(2);
    });

    // ---- Proof C — tick() composes reconcile + intake + terminal ----

    it('tick() drives the full sweep end-to-end (created → materialized; terminal → cancelled)', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      await publishTenantSet(tenant);
      await seedCreated(tenant, placement);

      const first = await orchestrator.tick(BATCH);
      expect(first.intake).toBe(1);
      expect((await instances.findByPlacement(tenant, placement)).length).toBe(3);

      await seedTerminal(tenant, placement, 'FELL_THROUGH');
      const second = await orchestrator.tick(BATCH);
      expect(second.cancelled).toBe(1);
      expect(await statuses(tenant, placement)).toEqual(['CANCELED', 'CANCELED', 'CANCELED']);
    });

    // ---- L5-P5 — drainIntake materializes the MERGED layered effective config ----

    it('layered: TENANT + REQUISITION override/augment merge; intent captures the context', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      const requisitionId = randomUUID();
      const companyId = randomUUID();
      await publishTenantSet(tenant); // BACKGROUND_CHECK, CLIENT_PAPERWORK, NDA

      // A REQUISITION-scoped set: OVERRIDE BACKGROUND_CHECK (blocking->false, new waiver_mode)
      // + AUGMENT with DRUG_SCREEN.
      const reqDraft = await sets.createDraft(
        {
          tenant_id: tenant,
          scope: 'REQUISITION',
          scope_ref_id: requisitionId,
          version: 'v1',
          definitions: [
            { requirement_type: 'BACKGROUND_CHECK', label: 'BG (req override)', blocking: false, owner_role: null, sequence: 1, waiver_mode: 'AUTHORIZED_INTERNAL' },
            { requirement_type: 'DRUG_SCREEN', label: 'Drug screen', blocking: true, owner_role: null, sequence: 2, waiver_mode: 'CLIENT_AUTHORITY_ONLY' },
          ],
        },
        'seed',
      );
      await sets.publish({ tenant_id: tenant, set_id: reqDraft.id, published_by: randomUUID() }, 'seed');

      // A requisition row so drainIntake also derives client_id (company_id).
      await setupClient.$executeRawUnsafe(
        `INSERT INTO requisition."Requisition" (id, tenant_id, company_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        requisitionId,
        tenant,
        companyId,
      );
      await seedOutbox(tenant, 'placement.process.created', {
        placement_process_id: placement,
        tenant_id: tenant,
        requisition_id: requisitionId,
        state: 'PRE_START',
      });

      expect(await orchestrator.drainIntake(BATCH)).toBe(1);

      const list = await instances.findByPlacement(tenant, placement);
      // TENANT {BACKGROUND_CHECK, CLIENT_PAPERWORK, NDA} + REQUISITION override of
      // BACKGROUND_CHECK + augment DRUG_SCREEN = 4 distinct types.
      expect(list.map((i) => i.requirement_type).sort()).toEqual([
        'BACKGROUND_CHECK',
        'CLIENT_PAPERWORK',
        'DRUG_SCREEN',
        'NDA',
      ]);
      // The more-specific REQUISITION layer WON for BACKGROUND_CHECK.
      const bg = list.find((i) => i.requirement_type === 'BACKGROUND_CHECK');
      expect(bg?.blocking).toBe(false);
      expect(bg?.waiver_mode).toBe('AUTHORIZED_INTERNAL');
      // The intent durably captured the layered context for the reconciler.
      const intent = await intents.findByPlacement(tenant, placement);
      expect(intent?.requisition_id).toBe(requisitionId);
      expect(intent?.client_id).toBe(companyId);
    });
  },
);

// Dollar-quote- AND line-comment-aware DDL splitter (skips `;` inside `$$` bodies and
// inside `--` comment lines).
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
