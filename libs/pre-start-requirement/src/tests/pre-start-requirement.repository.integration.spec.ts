import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { DefinitionSetRepository } from '../lib/definition-set.repository.js';
import { RequirementInstanceRepository } from '../lib/requirement-instance.repository.js';
import { ReadinessDecisionRepository } from '../lib/readiness-decision.repository.js';
import type { RequirementDefinitionInput } from '../lib/pre-start-requirement-vocab.js';
import type { SetView } from '../lib/pre-start-requirement.types.js';

// Track 3 / E2 — integration spec (real Postgres 17). Applies the init migration
// (5 tables + column-scoped immutability trigger + append-only audit trigger +
// deferred provenance constraint trigger + completeness CHECK) and proves the
// database-level floors end-to-end. New schema, no cross-lib deps.

const INIT_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260804090000_init_pre_start_requirement/migration.sql',
);
// L5-P3 — a SEPARATE const (never a 2nd resolve() arg — ENOTDIR trap). Applied
// after init so the readiness ledger table + its append-only triggers exist.
const READINESS_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260901160000_l5_pre_start_readiness_decision/migration.sql',
);
// L5-P6 — separate const (ENOTDIR trap). The regen'd client SELECTs/INSERTs
// satisfaction_policy, so the column must exist in the test DB.
const SATISFACTION_POLICY_MIGRATION_PATH = resolve(
  __dirname,
  '../../prisma/migrations/20260901200000_l5_pre_start_satisfaction_policy/migration.sql',
);

const DEFS: RequirementDefinitionInput[] = [
  { requirement_type: 'BACKGROUND_CHECK', label: 'Background check', blocking: true, owner_role: null, sequence: 1, waiver_mode: 'NOT_WAIVABLE' },
  { requirement_type: 'CLIENT_PAPERWORK', label: 'Client paperwork', blocking: true, owner_role: 'account_manager', sequence: 2, waiver_mode: 'COMPLIANCE_AUTHORITY_ONLY' },
  { requirement_type: 'NDA', label: 'NDA', blocking: false, owner_role: null, sequence: 3, waiver_mode: 'AUTHORIZED_INTERNAL' },
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'pre-start-requirement — repository + DB floors integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let setupClient: PrismaService;
    let prisma: PrismaService;
    let sets: DefinitionSetRepository;
    let instances: RequirementInstanceRepository;
    let decisions: ReadinessDecisionRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const migrationPath of [INIT_MIGRATION_PATH, READINESS_MIGRATION_PATH, SATISFACTION_POLICY_MIGRATION_PATH]) {
        for (const stmt of splitDdl(readFileSync(migrationPath, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      sets = new DefinitionSetRepository(prisma);
      instances = new RequirementInstanceRepository(prisma);
      decisions = new ReadinessDecisionRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await setupClient?.$disconnect();
      await prisma?.$disconnect();
      await container?.stop();
    });

    // Publish a TENANT set for a fresh tenant, materialize a placement, return the
    // published set + the created instances.
    async function seedPlacement(): Promise<{ tenant: string; placement: string; set: SetView }> {
      const tenant = randomUUID();
      const placement = randomUUID();
      const draft = await sets.createDraft(
        { tenant_id: tenant, scope: 'TENANT', scope_ref_id: tenant, version: 'v1', definitions: DEFS },
        'seed',
      );
      const set = await sets.publish({ tenant_id: tenant, set_id: draft.id, published_by: randomUUID() }, 'seed');
      await instances.materialize(tenant, placement, set);
      return { tenant, placement, set };
    }

    it('resolveApplicable returns the single open published set (TENANT-only)', async () => {
      const { tenant, set } = await seedPlacement();
      const resolved = await sets.resolveApplicable(tenant, { scope: 'TENANT', scope_ref_id: tenant }, 'r');
      expect(resolved?.id).toBe(set.id);
      expect(resolved?.definitions.length).toBe(3);
    });

    it('materialize is idempotent — a second call creates no duplicate instances', async () => {
      const { tenant, placement, set } = await seedPlacement();
      const first = await instances.findByPlacement(tenant, placement);
      expect(first.length).toBe(3);
      await instances.materialize(tenant, placement, set);
      const second = await instances.findByPlacement(tenant, placement);
      expect(second.length).toBe(3);
    });

    it('assessBlocking is fail-closed when no snapshot exists', async () => {
      const a = await instances.assessBlocking(randomUUID(), randomUUID());
      expect(a.materialized).toBe(false);
      expect(a.ready).toBe(false);
    });

    // ---- Integration proof 1: domain waiver floor ----

    it('NOT_WAIVABLE is refused unconditionally (domain rule, snapshot-anchored)', async () => {
      const { tenant, placement } = await seedPlacement();
      const list = await instances.findByPlacement(tenant, placement);
      const notWaivable = list.find((i) => i.waiver_mode === 'NOT_WAIVABLE')!;
      await expect(
        instances.waive(
          { tenant_id: tenant, requirement_instance_id: notWaivable.id, authority: 'COMPLIANCE', actor_id: randomUUID(), actor_type: 'user', justification: 'x' },
          'w',
        ),
      ).rejects.toMatchObject({ code: 'PRE_START_REQUIREMENT_INVALID', statusCode: 422 });
    });

    it('a waivable requirement waives with the correct authority + appends audit', async () => {
      const { tenant, placement } = await seedPlacement();
      const list = await instances.findByPlacement(tenant, placement);
      const compliance = list.find((i) => i.waiver_mode === 'COMPLIANCE_AUTHORITY_ONLY')!;
      const waived = await instances.waive(
        { tenant_id: tenant, requirement_instance_id: compliance.id, authority: 'COMPLIANCE', actor_id: randomUUID(), actor_type: 'user', justification: 'approved' },
        'w',
      );
      expect(waived.status).toBe('WAIVED');
      const audits = await instances.listAudits(tenant, compliance.id);
      expect(audits.map((a) => a.action)).toContain('WAIVED');
    });

    it('the wrong authority class is refused (COMPLIANCE mode, CLIENT authority)', async () => {
      const { tenant, placement } = await seedPlacement();
      const list = await instances.findByPlacement(tenant, placement);
      const compliance = list.find((i) => i.waiver_mode === 'COMPLIANCE_AUTHORITY_ONLY')!;
      await expect(
        instances.waive(
          { tenant_id: tenant, requirement_instance_id: compliance.id, authority: 'CLIENT', actor_id: randomUUID(), actor_type: 'user', justification: 'x' },
          'w',
        ),
      ).rejects.toMatchObject({ code: 'PRE_START_REQUIREMENT_INVALID', statusCode: 422 });
    });

    // ---- Integration proof 2: column-scoped DB immutability ----

    it('the trigger rejects raw mutation of each frozen snapshot column', async () => {
      const { tenant, placement } = await seedPlacement();
      const list = await instances.findByPlacement(tenant, placement);
      // Pick the BACKGROUND_CHECK instance deliberately (blocking=true, version=v1,
      // waiver_mode=NOT_WAIVABLE) so every value below is GUARANTEED distinct from
      // the current one — the trigger uses IS DISTINCT FROM, so a no-op set of a
      // frozen column to its SAME value is (correctly) allowed and must not be the
      // thing under test.
      const inst = list.find((i) => i.requirement_type === 'BACKGROUND_CHECK')!;
      const frozen: Array<[string, string]> = [
        ['waiver_mode', `'AUTHORIZED_INTERNAL'`], // != NOT_WAIVABLE
        ['requirement_definition_id', `'${randomUUID()}'`],
        ['definition_set_version', `'v2'`], // != v1
        ['blocking', 'false'], // != true
        ['placement_process_id', `'${randomUUID()}'`],
        ['tenant_id', `'${randomUUID()}'`],
      ];
      for (const [col, val] of frozen) {
        await expect(
          setupClient.$executeRawUnsafe(
            `UPDATE pre_start_requirement."PreStartRequirementInstance" SET "${col}" = ${val} WHERE id = '${inst.id}'`,
          ),
        ).rejects.toThrow(/immutable/);
      }
    });

    it('the intended mutable path still works (status IN_PROGRESS, evidence_reference)', async () => {
      const { tenant, placement } = await seedPlacement();
      const [inst] = await instances.findByPlacement(tenant, placement);
      // IN_PROGRESS is non-consequential — no audit required, mutable.
      await setupClient.$executeRawUnsafe(
        `UPDATE pre_start_requirement."PreStartRequirementInstance" SET status = 'IN_PROGRESS', evidence_reference = 'ref-1', updated_at = now() WHERE id = '${inst!.id}'`,
      );
      const after = await instances.findById(tenant, inst!.id);
      expect(after?.status).toBe('IN_PROGRESS');
      expect(after?.evidence_reference).toBe('ref-1');
    });

    // ---- Integration proof: provenance invariant (no consequential state without audit) ----

    it('raw status=WAIVED with NO audit row is rejected at commit (provenance invariant)', async () => {
      const { tenant, placement } = await seedPlacement();
      const list = await instances.findByPlacement(tenant, placement);
      const inst = list.find((i) => i.waiver_mode !== 'NOT_WAIVABLE')!;
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE pre_start_requirement."PreStartRequirementInstance" SET status = 'WAIVED', completed_at = now() WHERE id = '${inst.id}'`,
        ),
      ).rejects.toThrow(/provenance/);
    });

    // ---- Integration proof 3: append-only audit ----

    it('the audit ledger rejects UPDATE and DELETE at the database layer', async () => {
      const { tenant, placement } = await seedPlacement();
      const list = await instances.findByPlacement(tenant, placement);
      const compliance = list.find((i) => i.waiver_mode === 'COMPLIANCE_AUTHORITY_ONLY')!;
      await instances.waive(
        { tenant_id: tenant, requirement_instance_id: compliance.id, authority: 'COMPLIANCE', actor_id: randomUUID(), actor_type: 'user', justification: 'a' },
        'w',
      );
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM pre_start_requirement."PreStartRequirementAudit" WHERE requirement_instance_id = $1 LIMIT 1`,
        compliance.id,
      );
      const auditId = rows[0]!.id;
      await expect(
        setupClient.$executeRawUnsafe(`UPDATE pre_start_requirement."PreStartRequirementAudit" SET action = 'FAILED' WHERE id = '${auditId}'`),
      ).rejects.toThrow(/append-only/);
      await expect(
        setupClient.$executeRawUnsafe(`DELETE FROM pre_start_requirement."PreStartRequirementAudit" WHERE id = '${auditId}'`),
      ).rejects.toThrow(/append-only/);
    });

    // ---- status move happy path + audit provenance link ----

    it('a governed SATISFIED move updates status and appends a matching audit row', async () => {
      const { tenant, placement } = await seedPlacement();
      const [inst] = await instances.findByPlacement(tenant, placement);
      const done = await instances.applyStatusMove(
        { tenant_id: tenant, requirement_instance_id: inst!.id, to: 'SATISFIED', actor_id: randomUUID(), actor_type: 'user', completed_by: randomUUID() },
        's',
      );
      expect(done.status).toBe('SATISFIED');
      expect(done.completed_at).not.toBeNull();
      const audits = await instances.listAudits(tenant, inst!.id);
      expect(audits.at(-1)).toMatchObject({ action: 'SATISFIED', previous_status: 'PENDING', resulting_status: 'SATISFIED' });
    });

    // ---- Reset-ready delete escape (T0 v1.1 §2.4) — A4 ships the trigger BRANCH
    //      + these four boundary proofs. It does NOT ship the tenant-reset service,
    //      the SET LOCAL production command, the inventory, or the six-part reset
    //      proof (those are the separate tenant-reset PR). The SET LOCAL below is
    //      test-only, inside an explicit transaction.

    const INST_TBL = 'pre_start_requirement."PreStartRequirementInstance"';
    const AUDIT_TBL = 'pre_start_requirement."PreStartRequirementAudit"';

    it('an ordinary DELETE of an instance is rejected (no marker)', async () => {
      const { tenant, placement } = await seedPlacement();
      const [inst] = await instances.findByPlacement(tenant, placement);
      await expect(
        setupClient.$executeRawUnsafe(`DELETE FROM ${INST_TBL} WHERE id = '${inst!.id}'`),
      ).rejects.toThrow(/not permitted/);
    });

    it("the EXACT authorized SET LOCAL app.tenant_reset='authorized' permits the delete (audit + instance)", async () => {
      const { tenant, placement } = await seedPlacement();
      const [inst] = await instances.findByPlacement(tenant, placement);
      // Make an audit row so we exercise BOTH escape branches (audit + instance),
      // deleted in FK-safe order (audit child first).
      await instances.applyStatusMove(
        { tenant_id: tenant, requirement_instance_id: inst!.id, to: 'SATISFIED', actor_id: randomUUID(), actor_type: 'user', completed_by: randomUUID() },
        's',
      );
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_reset = 'authorized'`);
        await tx.$executeRawUnsafe(`DELETE FROM ${AUDIT_TBL} WHERE requirement_instance_id = '${inst!.id}'`);
        await tx.$executeRawUnsafe(`DELETE FROM ${INST_TBL} WHERE id = '${inst!.id}'`);
      });
      expect(await instances.findById(tenant, inst!.id)).toBeNull();
    });

    it('a WRONG marker value does NOT permit the delete (exact-value, not truthy)', async () => {
      const { tenant, placement } = await seedPlacement();
      const [inst] = await instances.findByPlacement(tenant, placement);
      for (const wrong of ['true', '1', 'Authorized', 'AUTHORIZED', '']) {
        await expect(
          prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.tenant_reset = '${wrong}'`);
            await tx.$executeRawUnsafe(`DELETE FROM ${INST_TBL} WHERE id = '${inst!.id}'`);
          }),
        ).rejects.toThrow(/not permitted/);
      }
    });

    it('the exemption is GONE after the transaction ends (SET LOCAL is tx-scoped)', async () => {
      const { tenant, placement } = await seedPlacement();
      const [inst] = await instances.findByPlacement(tenant, placement);
      // An authorized transaction that does NOT touch this instance.
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_reset = 'authorized'`);
        await tx.$executeRawUnsafe(`SELECT 1`);
      });
      // A fresh ordinary DELETE (new connection/tx, no marker) is rejected again.
      await expect(
        setupClient.$executeRawUnsafe(`DELETE FROM ${INST_TBL} WHERE id = '${inst!.id}'`),
      ).rejects.toThrow(/not permitted/);
    });

    // ---- tenant isolation ----

    it('reads are tenant-isolated', async () => {
      const { tenant, placement } = await seedPlacement();
      expect((await instances.findByPlacement(tenant, placement)).length).toBe(3);
      expect((await instances.findByPlacement(randomUUID(), placement)).length).toBe(0);
    });

    // ---- L5-P2 — state-guarded CAS closes the concurrent-move race ----

    it('concurrent moves on separate connections — exactly one commits, exactly one audit row (no double last-write-wins)', async () => {
      const { tenant, placement } = await seedPlacement();
      const [inst] = await instances.findByPlacement(tenant, placement);

      // Two SEPARATE connections so the two loads genuinely interleave. A single client
      // serializes them and the app-guard reload (canMoveStatus) — not the CAS — catches
      // the loser; separate connections let both read PENDING before either commits, so
      // the row-locked CAS (WHERE status = the captured 'PENDING') is what decides the
      // winner: one UPDATE matches, the other matches 0 rows → PRE_START_REQUIREMENT_CONFLICT.
      const prismaB = new PrismaService(container.getConnectionUri());
      await prismaB.$connect();
      const instancesB = new RequirementInstanceRepository(prismaB);
      try {
        const outcomes = await Promise.allSettled([
          instances.applyStatusMove(
            { tenant_id: tenant, requirement_instance_id: inst?.id ?? '', to: 'SATISFIED', actor_id: randomUUID(), actor_type: 'user', completed_by: randomUUID() },
            'race-a',
          ),
          instancesB.applyStatusMove(
            { tenant_id: tenant, requirement_instance_id: inst?.id ?? '', to: 'FAILED', actor_id: randomUUID(), actor_type: 'user' },
            'race-b',
          ),
        ]);

        // Exactly one move commits; the loser is refused — the CAS conflict (409) under a
        // true race, or a reloaded illegal-move (422) if the two happened to serialize.
        // Never a silent second success.
        expect(outcomes.filter((r) => r.status === 'fulfilled').length).toBe(1);
        const rejected = outcomes.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
        expect(rejected.length).toBe(1);
        expect(['PRE_START_REQUIREMENT_CONFLICT', 'PRE_START_REQUIREMENT_INVALID']).toContain(
          (rejected[0]?.reason as { code?: string }).code,
        );

        // The defect proof: the audit ledger holds EXACTLY ONE row for this instance.
        // Before the CAS, both concurrent writers committed and appended a row — two
        // contradictory provenance rows + last-write-wins.
        const audits = await instances.listAudits(tenant, inst?.id ?? '');
        expect(audits.length).toBe(1);
      } finally {
        await prismaB.$disconnect();
      }
    });

    // ---- L5-P3 — readiness decision ledger (append-only, ruling P7) ----

    const DECISION_TBL = 'pre_start_requirement."PreStartReadinessDecision"';

    it('records a READY and a REFUSED decision; listByPlacement returns them in order', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      const actor = randomUUID();
      const refused = await decisions.record({
        tenant_id: tenant, placement_process_id: placement, result: 'REFUSED',
        refusal_reason: 'materialization_absent', materialized: false, total_requirements: 0,
        unresolved_blocking_count: 0, actor_id: actor, actor_type: 'user',
      });
      expect(refused.result).toBe('REFUSED');
      const ready = await decisions.record({
        tenant_id: tenant, placement_process_id: placement, result: 'READY',
        refusal_reason: null, materialized: true, total_requirements: 3,
        unresolved_blocking_count: 0, actor_id: actor, actor_type: 'user',
      });
      expect(ready.result).toBe('READY');
      const all = await decisions.listByPlacement(tenant, placement);
      expect(all.map((d) => d.result)).toEqual(['REFUSED', 'READY']);
    });

    it('the result/reason CHECK rejects an inconsistent row (REFUSED without a reason)', async () => {
      const tenant = randomUUID();
      await expect(
        setupClient.$executeRawUnsafe(
          `INSERT INTO ${DECISION_TBL} (id, tenant_id, placement_process_id, result, refusal_reason, materialized, total_requirements, unresolved_blocking_count, actor_id, actor_type)
             VALUES ('${randomUUID()}','${tenant}','${randomUUID()}','REFUSED', NULL, false, 0, 0, '${randomUUID()}','user')`,
        ),
      ).rejects.toThrow();
    });

    it('the ledger rejects UPDATE and DELETE at the database layer (append-only)', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      const d = await decisions.record({
        tenant_id: tenant, placement_process_id: placement, result: 'READY',
        refusal_reason: null, materialized: true, total_requirements: 1,
        unresolved_blocking_count: 0, actor_id: randomUUID(), actor_type: 'system',
      });
      await expect(
        setupClient.$executeRawUnsafe(`UPDATE ${DECISION_TBL} SET result = 'REFUSED' WHERE id = '${d.id}'`),
      ).rejects.toThrow(/append-only/);
      await expect(
        setupClient.$executeRawUnsafe(`DELETE FROM ${DECISION_TBL} WHERE id = '${d.id}'`),
      ).rejects.toThrow(/append-only/);
    });

    it("the EXACT authorized tenant-reset GUC permits the delete; a wrong value does not", async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      const d = await decisions.record({
        tenant_id: tenant, placement_process_id: placement, result: 'READY',
        refusal_reason: null, materialized: true, total_requirements: 1,
        unresolved_blocking_count: 0, actor_id: randomUUID(), actor_type: 'user',
      });
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL app.tenant_reset = 'nope'`);
          await tx.$executeRawUnsafe(`DELETE FROM ${DECISION_TBL} WHERE id = '${d.id}'`);
        }),
      ).rejects.toThrow(/not permitted/);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_reset = 'authorized'`);
        await tx.$executeRawUnsafe(`DELETE FROM ${DECISION_TBL} WHERE id = '${d.id}'`);
      });
      expect((await decisions.listByPlacement(tenant, placement)).length).toBe(0);
    });

    it('decisions are tenant-isolated', async () => {
      const tenant = randomUUID();
      const placement = randomUUID();
      await decisions.record({
        tenant_id: tenant, placement_process_id: placement, result: 'READY',
        refusal_reason: null, materialized: true, total_requirements: 1,
        unresolved_blocking_count: 0, actor_id: randomUUID(), actor_type: 'user',
      });
      expect((await decisions.listByPlacement(tenant, placement)).length).toBe(1);
      expect((await decisions.listByPlacement(randomUUID(), placement)).length).toBe(0);
    });

    // ---- L5-P4 — the BLOCKED projection (deriveBlockers, ruling P3) ----

    it('deriveBlockers: all PENDING → not blocked; a FAILED blocking requirement → blocked', async () => {
      const { tenant, placement } = await seedPlacement();
      // Normal onboarding (all PENDING) is NOT a block.
      expect((await instances.deriveBlockers(tenant, placement)).blocked).toBe(false);

      const list = await instances.findByPlacement(tenant, placement);
      const bg = list.find((i) => i.requirement_type === 'BACKGROUND_CHECK'); // blocking=true
      await instances.applyStatusMove(
        { tenant_id: tenant, requirement_instance_id: bg?.id ?? '', to: 'FAILED', actor_id: randomUUID(), actor_type: 'user', reason: 'adverse_finding' },
        'f',
      );

      const proj = await instances.deriveBlockers(tenant, placement);
      expect(proj.blocked).toBe(true);
      expect(proj.failed_blocking.map((i) => i.requirement_type)).toEqual(['BACKGROUND_CHECK']);
    });

    it('deriveBlockers: a FAILED NON-blocking requirement does NOT block', async () => {
      const { tenant, placement } = await seedPlacement();
      const list = await instances.findByPlacement(tenant, placement);
      const nda = list.find((i) => i.requirement_type === 'NDA'); // blocking=false
      await instances.applyStatusMove(
        { tenant_id: tenant, requirement_instance_id: nda?.id ?? '', to: 'FAILED', actor_id: randomUUID(), actor_type: 'user' },
        'f',
      );
      expect((await instances.deriveBlockers(tenant, placement)).blocked).toBe(false);
    });

    // ---- L5-P5 — layered precedence (resolveEffective, ruling P2) ----

    async function publishSet(
      tenant: string,
      scope: 'TENANT' | 'CLIENT' | 'REQUISITION',
      ref: string,
      version: string,
      defs: RequirementDefinitionInput[],
    ): Promise<void> {
      const draft = await sets.createDraft(
        { tenant_id: tenant, scope, scope_ref_id: ref, version, definitions: defs },
        's',
      );
      await sets.publish({ tenant_id: tenant, set_id: draft.id, published_by: randomUUID() }, 's');
    }

    it('resolveEffective: TENANT-only resolves the tenant baseline', async () => {
      const tenant = randomUUID();
      await publishSet(tenant, 'TENANT', tenant, 'v1', DEFS);
      const eff = await sets.resolveEffective(tenant, { client_id: null, requisition_id: null }, 'r');
      expect(eff?.definitions.map((d) => d.requirement_type).sort()).toEqual([
        'BACKGROUND_CHECK',
        'CLIENT_PAPERWORK',
        'NDA',
      ]);
    });

    it('resolveEffective: REQUISITION overrides same-type + augments new types; version is composite', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      await publishSet(tenant, 'TENANT', tenant, 'v1', DEFS);
      await publishSet(tenant, 'REQUISITION', req, 'v3', [
        { requirement_type: 'BACKGROUND_CHECK', label: 'override', blocking: false, owner_role: null, sequence: 1, waiver_mode: 'AUTHORIZED_INTERNAL' },
        { requirement_type: 'DRUG_SCREEN', label: 'aug', blocking: true, owner_role: null, sequence: 2, waiver_mode: 'CLIENT_AUTHORITY_ONLY' },
      ]);
      const eff = await sets.resolveEffective(tenant, { client_id: null, requisition_id: req }, 'r');
      expect(eff?.definitions.map((d) => d.requirement_type).sort()).toEqual([
        'BACKGROUND_CHECK',
        'CLIENT_PAPERWORK',
        'DRUG_SCREEN',
        'NDA',
      ]);
      // the more-specific REQUISITION layer won the override.
      expect(eff?.definitions.find((d) => d.requirement_type === 'BACKGROUND_CHECK')?.blocking).toBe(false);
      expect(eff?.version).toBe('TENANT:v1|REQUISITION:v3');
    });

    it('resolveEffective: deterministic — same inputs yield the same checksum', async () => {
      const tenant = randomUUID();
      const req = randomUUID();
      await publishSet(tenant, 'TENANT', tenant, 'v1', DEFS);
      await publishSet(tenant, 'REQUISITION', req, 'v1', [
        { requirement_type: 'DRUG_SCREEN', label: 'd', blocking: true, owner_role: null, sequence: 1, waiver_mode: 'CLIENT_AUTHORITY_ONLY' },
      ]);
      const a = await sets.resolveEffective(tenant, { client_id: null, requisition_id: req }, 'r');
      const b = await sets.resolveEffective(tenant, { client_id: null, requisition_id: req }, 'r');
      expect(a?.checksum).toBe(b?.checksum);
    });

    it('resolveEffective: no published set at any layer → null (fail-closed)', async () => {
      expect(await sets.resolveEffective(randomUUID(), { client_id: null, requisition_id: randomUUID() }, 'r')).toBeNull();
    });

    // ---- L5-P6 — completion vs verification split (ruling P4) + waiver evidence (P5) ----

    // Publish a TENANT set whose BACKGROUND_CHECK is VERIFICATION_REQUIRED, materialize.
    async function seedVerified(): Promise<{ tenant: string; placement: string }> {
      const tenant = randomUUID();
      const placement = randomUUID();
      await publishSet(tenant, 'TENANT', tenant, 'v1', [
        { requirement_type: 'BACKGROUND_CHECK', label: 'BG', blocking: true, owner_role: null, sequence: 1, waiver_mode: 'AUTHORIZED_INTERNAL', satisfaction_policy: 'VERIFICATION_REQUIRED' },
        { requirement_type: 'NDA', label: 'NDA', blocking: false, owner_role: null, sequence: 2, waiver_mode: 'AUTHORIZED_INTERNAL' }, // default SELF_ATTEST
      ]);
      const set = await sets.resolveEffective(tenant, { client_id: null, requisition_id: null }, 'r');
      await instances.materialize(tenant, placement, set!);
      return { tenant, placement };
    }

    it('materialize snapshots satisfaction_policy (VERIFICATION_REQUIRED preserved; default SELF_ATTEST)', async () => {
      const { tenant, placement } = await seedVerified();
      const list = await instances.findByPlacement(tenant, placement);
      expect(list.find((i) => i.requirement_type === 'BACKGROUND_CHECK')?.satisfaction_policy).toBe('VERIFICATION_REQUIRED');
      expect(list.find((i) => i.requirement_type === 'NDA')?.satisfaction_policy).toBe('SELF_ATTEST');
    });

    it(':act cannot SATISFY a VERIFICATION_REQUIRED requirement; verify() can (separation of duties)', async () => {
      const { tenant, placement } = await seedVerified();
      const bg = (await instances.findByPlacement(tenant, placement)).find((i) => i.requirement_type === 'BACKGROUND_CHECK');
      // :act SATISFIED is refused for a verification-required requirement.
      await expect(
        instances.applyStatusMove(
          { tenant_id: tenant, requirement_instance_id: bg?.id ?? '', to: 'SATISFIED', actor_id: randomUUID(), actor_type: 'user', completed_by: randomUUID() },
          'a',
        ),
      ).rejects.toMatchObject({ code: 'PRE_START_REQUIREMENT_INVALID', context: { details: { reason: 'verification_required' } } });
      // The governed verify op (a distinct verifier) satisfies it, recording source=verification.
      const verifier = randomUUID();
      const verified = await instances.verify(
        { tenant_id: tenant, requirement_instance_id: bg?.id ?? '', actor_id: verifier, actor_type: 'user', justification: 'checked' },
        'v',
      );
      expect(verified.status).toBe('SATISFIED');
      const audits = await instances.listAudits(tenant, bg?.id ?? '');
      expect(audits.at(-1)).toMatchObject({ action: 'SATISFIED', resulting_status: 'SATISFIED', source: 'verification', actor_id: verifier });
    });

    it('verify() is refused for a SELF_ATTEST requirement (not applicable)', async () => {
      const { tenant, placement } = await seedVerified();
      const nda = (await instances.findByPlacement(tenant, placement)).find((i) => i.requirement_type === 'NDA');
      await expect(
        instances.verify({ tenant_id: tenant, requirement_instance_id: nda?.id ?? '', actor_id: randomUUID(), actor_type: 'user' }, 'v'),
      ).rejects.toMatchObject({ code: 'PRE_START_REQUIREMENT_INVALID', context: { details: { reason: 'not_verification_required' } } });
    });

    it('the frozen-column trigger rejects a raw mutation of satisfaction_policy', async () => {
      const { tenant, placement } = await seedVerified();
      const bg = (await instances.findByPlacement(tenant, placement)).find((i) => i.requirement_type === 'BACKGROUND_CHECK');
      await expect(
        setupClient.$executeRawUnsafe(
          `UPDATE pre_start_requirement."PreStartRequirementInstance" SET satisfaction_policy = 'SELF_ATTEST' WHERE id = '${bg?.id}'`,
        ),
      ).rejects.toThrow(/immutable/);
    });

    it('a waiver MAY carry a supporting-evidence pointer (P5 — no hard-null)', async () => {
      const { tenant, placement } = await seedVerified();
      const bg = (await instances.findByPlacement(tenant, placement)).find((i) => i.requirement_type === 'BACKGROUND_CHECK');
      const waived = await instances.waive(
        { tenant_id: tenant, requirement_instance_id: bg?.id ?? '', authority: 'INTERNAL', actor_id: randomUUID(), actor_type: 'user', justification: 'accepted risk', evidence_reference: 'att://waiver-memo-1' },
        'w',
      );
      expect(waived.status).toBe('WAIVED');
      expect(waived.evidence_reference).toBe('att://waiver-memo-1');
    });
  },
);

// Dollar-quote-aware DDL splitter (placement precedent) — splits on `;` outside
// `$$` regions. Does NOT strip line comments, which is why the migration forbids
// `;`/`$` inside comment lines.
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
