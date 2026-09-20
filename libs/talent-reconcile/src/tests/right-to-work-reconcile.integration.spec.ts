import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';
import {
  TalentRecordPrismaService,
  TalentRecordReconcileRepository,
  type TalentRecordView,
} from '@aramo/talent-record';
import type { EvidenceRecordRow } from '@aramo/talent-trust';

import { computeReconcilePlan } from '../lib/reconcile-plan.js';

// TALENT-INTEL-1 (TI-1C §step-7) — the FIRST lib-local integration spec for
// talent-reconcile (recon D-4 remediation: the lib was unenrolled and bore no
// integration spec, so its DB behavior was silently untested). Proves the
// RIGHT_TO_WORK → work_authorization reconcile END-TO-END against a real Postgres:
// the pure computeReconcilePlan composed with the REAL reconcile writer
// (applyEnrichment + field-provenance + pending-contradiction). The trust-ledger
// READ (TalentTrustService.getEvidence) is unit-covered elsewhere; here the
// evidence is supplied in-memory so the DB proof focuses on the WRITE round-trip
// TI-1C introduces (work_authorization moves from never-touched to fill-null +
// contradiction, sourced ONLY from an explicit declared assertion).

// Apply every talent-record migration in chronological order so the regenerated
// client's SELECT * finds work_authorization + the reconcile-projection tables.
const MIGRATIONS_DIR = resolve(__dirname, '../../../talent-record/prisma/migrations');
const MIGRATIONS = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+_/.test(d.name))
  .map((d) => d.name)
  .sort()
  .map((d) => resolve(MIGRATIONS_DIR, d, 'migration.sql'));

const TENANT = '11111111-1111-7111-8111-111111111111';

function splitDdl(sql: string): string[] {
  return sql
    .replace(/--[^\n]*$/gm, '')
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function rightToWork(status: string, id: string): EvidenceRecordRow {
  return {
    id,
    assertion_type: 'RIGHT_TO_WORK',
    assertion_payload: { work_authorization_status_raw: status, requires_sponsorship: false },
    current_status: 'VALID',
    collected_at: new Date('2026-07-04T00:00:00.000Z'),
    created_at: new Date('2026-07-04T00:00:00.000Z'),
  } as EvidenceRecordRow;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'talent-reconcile — RIGHT_TO_WORK → work_authorization (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: TalentRecordPrismaService;
    let repo: TalentRecordReconcileRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new TalentRecordPrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          await setup.$executeRawUnsafe(stmt);
        }
      }
      await setup.$disconnect();

      prisma = new TalentRecordPrismaService(url);
      await prisma.$connect();
      repo = new TalentRecordReconcileRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function seedRecord(workAuth: string | null): Promise<string> {
      const id = uuidv7();
      const wa = workAuth === null ? 'NULL' : `'${workAuth}'`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "talent_record"."TalentRecord" (id, tenant_id, first_name, last_name, work_authorization)
         VALUES ('${id}'::uuid, '${TENANT}'::uuid, 'Alan', 'Turing', ${wa})`,
      );
      return id;
    }

    async function view(id: string): Promise<TalentRecordView> {
      const row = await prisma.talentRecord.findUnique({ where: { id } });
      return row as unknown as TalentRecordView;
    }

    it('fills null work_authorization from a declared RIGHT_TO_WORK assertion + persists provenance', async () => {
      const id = await seedRecord(null);
      const evId = uuidv7(); // evidence_id is a UUID column
      const plan = computeReconcilePlan(await view(id), [rightToWork('US_CITIZEN', evId)]);
      expect(plan.patch).toEqual({ work_authorization: 'US_CITIZEN' });

      await repo.applyEnrichment({ tenant_id: TENANT, talent_record_id: id, patch: plan.patch });
      for (const p of plan.provenance) {
        await repo.upsertFieldProvenance({
          tenant_id: TENANT,
          talent_record_id: id,
          field_name: p.field_name,
          evidence_id: p.evidence_id,
        });
      }

      const row = await prisma.talentRecord.findUnique({ where: { id } });
      expect(row?.work_authorization).toBe('US_CITIZEN');
      const prov = await repo.listFieldProvenance(id);
      expect(
        prov.some((r) => r.field_name === 'work_authorization' && r.evidence_id === evId),
      ).toBe(true);
    });

    it('occupied-differing → pending contradiction; TalentRecord NEVER overwritten', async () => {
      const id = await seedRecord('US_CITIZEN');
      const evId = uuidv7(); // new_evidence_id is a UUID column
      const plan = computeReconcilePlan(await view(id), [rightToWork('VISA_HOLDER', evId)]);
      // No overwrite of the talent-stated value.
      expect(plan.patch).toEqual({});
      expect(plan.contradictions).toEqual([
        { field_name: 'work_authorization', new_evidence_id: evId, proposed_value: 'VISA_HOLDER' },
      ]);

      for (const c of plan.contradictions) {
        await repo.recordPendingContradiction({
          tenant_id: TENANT,
          talent_record_id: id,
          field_name: c.field_name,
          new_evidence_id: c.new_evidence_id,
        });
      }

      const row = await prisma.talentRecord.findUnique({ where: { id } });
      expect(row?.work_authorization).toBe('US_CITIZEN'); // unchanged
      const contras = await repo.listPendingContradictions(id);
      expect(contras.some((r) => r.field_name === 'work_authorization')).toBe(true);
    });

    // TI-1D-A end-to-end (real DB): an EXPLICITLY_CLEARED + HOLD field-state must
    // block automatic refill of a NULL slot, but still record a contradiction —
    // exercising the TalentProfileFieldState table + repo upsert/list + the
    // reconcile-plan gate together.
    it('EXPLICITLY_CLEARED + HOLD field-state → reconcile does NOT refill; records a contradiction', async () => {
      const id = await seedRecord(null); // work_authorization null (empty slot)
      await repo.upsertProfileFieldState({
        tenant_id: TENANT,
        talent_record_id: id,
        field_key: 'work_authorization',
        value_state: 'EXPLICITLY_CLEARED',
        source_type: 'MANUAL',
        projection_policy: 'HOLD',
      });

      const stateRows = await repo.listProfileFieldStates(id);
      const fieldStates = new Map(
        stateRows.map((s) => [
          s.field_key,
          { value_state: s.value_state, projection_policy: s.projection_policy },
        ]),
      );
      const evId = uuidv7();
      const plan = computeReconcilePlan(await view(id), [rightToWork('US_CITIZEN', evId)], fieldStates);

      // Blocked: no refill of the recruiter-cleared slot, but not silent.
      expect(plan.patch).toEqual({});
      expect(plan.contradictions).toEqual([
        { field_name: 'work_authorization', new_evidence_id: evId, proposed_value: 'US_CITIZEN' },
      ]);

      await repo.applyEnrichment({ tenant_id: TENANT, talent_record_id: id, patch: plan.patch });
      const row = await prisma.talentRecord.findUnique({ where: { id } });
      expect(row?.work_authorization).toBeNull(); // stayed cleared
    });

    it('setProjectionPolicy AUTO releases a hold and does NOT mutate value_state', async () => {
      const id = await seedRecord(null);
      await repo.upsertProfileFieldState({
        tenant_id: TENANT,
        talent_record_id: id,
        field_key: 'work_authorization',
        value_state: 'EXPLICITLY_CLEARED',
        source_type: 'MANUAL',
        projection_policy: 'HOLD',
      });

      await repo.setProjectionPolicy({
        tenant_id: TENANT,
        talent_record_id: id,
        field_key: 'work_authorization',
        projection_policy: 'AUTO',
      });

      const [state] = await repo.listProfileFieldStates(id);
      expect(state?.projection_policy).toBe('AUTO'); // hold released
      expect(state?.value_state).toBe('EXPLICITLY_CLEARED'); // value_state untouched

      // Still not auto-refilled: EXPLICITLY_CLEARED blocks even under AUTO.
      const fieldStates = new Map([
        ['work_authorization', { value_state: state!.value_state, projection_policy: state!.projection_policy }],
      ]);
      const plan = computeReconcilePlan(await view(id), [rightToWork('US_CITIZEN', uuidv7())], fieldStates);
      expect(plan.patch).toEqual({});
    });

    // TALENT-INTEL-1 TI-1D-B — the field-state READ MODEL joins the per-field
    // control state with the field→evidence provenance (TalentRecordFieldProvenance
    // stays the SOLE evidence-linkage authority — no source_evidence_id duplication).
    it('getFieldStateReadModel joins control state with provenance (evidence linkage read-through)', async () => {
      const id = await seedRecord('US_CITIZEN');
      await repo.upsertProfileFieldState({
        tenant_id: TENANT,
        talent_record_id: id,
        field_key: 'work_authorization',
        value_state: 'SET',
        source_type: 'MANUAL',
        projection_policy: 'AUTO',
      });
      const evId = uuidv7();
      await repo.upsertFieldProvenance({
        tenant_id: TENANT,
        talent_record_id: id,
        field_name: 'work_authorization',
        evidence_id: evId,
      });

      const model = await repo.getFieldStateReadModel(id);
      const wa = model.find((r) => r.field_key === 'work_authorization');
      expect(wa).toEqual({
        field_key: 'work_authorization',
        value_state: 'SET',
        source_type: 'MANUAL',
        projection_policy: 'AUTO',
        resolution_status: 'NONE',
        resolution_reason: null,
        proposed_value: null,
        provenance: { evidence_id: evId },
      });
    });

    // A field with provenance but NO explicit control row still appears — reconcile
    // projected it, so it reads as UNKNOWN / RECONCILED / AUTO with the evidence linkage.
    it('getFieldStateReadModel surfaces a provenance-only field with default control state', async () => {
      const id = await seedRecord(null);
      const evId = uuidv7();
      await repo.upsertFieldProvenance({
        tenant_id: TENANT,
        talent_record_id: id,
        field_name: 'email1',
        evidence_id: evId,
      });
      const model = await repo.getFieldStateReadModel(id);
      const email = model.find((r) => r.field_key === 'email1');
      expect(email).toEqual({
        field_key: 'email1',
        value_state: 'UNKNOWN',
        source_type: 'RECONCILED',
        projection_policy: 'AUTO',
        resolution_status: 'NONE',
        resolution_reason: null,
        proposed_value: null,
        provenance: { evidence_id: evId },
      });
    });

    // markFieldPendingReview sets the resolution SUMMARY (PENDING_REVIEW +
    // EVIDENCE_CONFLICT + proposed_value) WITHOUT disturbing the recruiter's
    // EXPLICITLY_CLEARED / HOLD control (value_state + projection_policy preserved).
    it('markFieldPendingReview records PENDING_REVIEW + proposed_value, preserving an EXPLICITLY_CLEARED + HOLD control', async () => {
      const id = await seedRecord(null);
      await repo.upsertProfileFieldState({
        tenant_id: TENANT,
        talent_record_id: id,
        field_key: 'work_authorization',
        value_state: 'EXPLICITLY_CLEARED',
        source_type: 'MANUAL',
        projection_policy: 'HOLD',
      });

      await repo.markFieldPendingReview({
        tenant_id: TENANT,
        talent_record_id: id,
        field_key: 'work_authorization',
        proposed_value: 'US_CITIZEN',
      });

      const model = await repo.getFieldStateReadModel(id);
      const wa = model.find((r) => r.field_key === 'work_authorization');
      expect(wa).toEqual({
        field_key: 'work_authorization',
        value_state: 'EXPLICITLY_CLEARED', // control preserved
        source_type: 'MANUAL',
        projection_policy: 'HOLD', // control preserved
        resolution_status: 'PENDING_REVIEW',
        resolution_reason: 'EVIDENCE_CONFLICT',
        proposed_value: 'US_CITIZEN',
        provenance: null,
      });
    });

    // markFieldPendingReview on a field with NO prior control row creates one
    // (UNKNOWN / RECONCILED) carrying the pending-review summary. TI-1F-C §4-I —
    // an unresolved contradiction FREEZES automatic projection: projection_policy
    // is HOLD (not AUTO) until the review is resolved.
    it('markFieldPendingReview creates a default control row when none exists (HOLD per §4-I)', async () => {
      const id = await seedRecord(null);
      await repo.markFieldPendingReview({
        tenant_id: TENANT,
        talent_record_id: id,
        field_key: 'city',
        proposed_value: 'London',
      });
      const model = await repo.getFieldStateReadModel(id);
      const city = model.find((r) => r.field_key === 'city');
      expect(city).toEqual({
        field_key: 'city',
        value_state: 'UNKNOWN',
        source_type: 'RECONCILED',
        projection_policy: 'HOLD',
        resolution_status: 'PENDING_REVIEW',
        resolution_reason: 'EVIDENCE_CONFLICT',
        proposed_value: 'London',
        provenance: null,
      });
    });

    // resolveFieldReview flips PENDING_REVIEW → RESOLVED, clears proposed_value, and
    // NEVER mutates value_state / projection_policy (the control stays as the
    // recruiter left it). proposed_value is populated ONLY while PENDING_REVIEW.
    it('resolveFieldReview → RESOLVED, clears proposed_value, control untouched', async () => {
      const id = await seedRecord(null);
      await repo.upsertProfileFieldState({
        tenant_id: TENANT,
        talent_record_id: id,
        field_key: 'work_authorization',
        value_state: 'EXPLICITLY_CLEARED',
        source_type: 'MANUAL',
        projection_policy: 'HOLD',
      });
      await repo.markFieldPendingReview({
        tenant_id: TENANT,
        talent_record_id: id,
        field_key: 'work_authorization',
        proposed_value: 'US_CITIZEN',
      });

      await repo.resolveFieldReview({
        tenant_id: TENANT,
        talent_record_id: id,
        field_key: 'work_authorization',
        resolution_reason: 'KEPT_CURRENT',
      });

      const model = await repo.getFieldStateReadModel(id);
      const wa = model.find((r) => r.field_key === 'work_authorization');
      expect(wa).toEqual({
        field_key: 'work_authorization',
        value_state: 'EXPLICITLY_CLEARED', // untouched
        source_type: 'MANUAL',
        projection_policy: 'HOLD', // untouched
        resolution_status: 'RESOLVED',
        resolution_reason: 'KEPT_CURRENT',
        proposed_value: null, // cleared on resolve
        provenance: null,
      });
    });
  },
);
