import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { DefinitionSetRepository } from '../lib/definition-set.repository.js';
import { RequirementInstanceRepository } from '../lib/requirement-instance.repository.js';
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

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      setupClient = new PrismaService(url);
      await setupClient.$connect();
      const sql = readFileSync(INIT_MIGRATION_PATH, 'utf8');
      for (const stmt of splitDdl(sql)) {
        const trimmed = stmt.trim();
        if (trimmed.length === 0) continue;
        await setupClient.$executeRawUnsafe(trimmed);
      }
      prisma = new PrismaService(url);
      await prisma.$connect();
      sets = new DefinitionSetRepository(prisma);
      instances = new RequirementInstanceRepository(prisma);
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
      const [inst] = await instances.findByPlacement(tenant, placement);
      const frozen: Array<[string, string]> = [
        ['waiver_mode', `'AUTHORIZED_INTERNAL'`],
        ['requirement_definition_id', `'${randomUUID()}'`],
        ['definition_set_version', `'v2'`],
        ['blocking', 'false'],
        ['placement_process_id', `'${randomUUID()}'`],
        ['tenant_id', `'${randomUUID()}'`],
      ];
      for (const [col, val] of frozen) {
        await expect(
          setupClient.$executeRawUnsafe(
            `UPDATE pre_start_requirement."PreStartRequirementInstance" SET "${col}" = ${val} WHERE id = '${inst!.id}'`,
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
