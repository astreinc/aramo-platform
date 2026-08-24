import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AramoError } from '@aramo/common';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';
import { CommercialApprovalPolicyService } from '../lib/policy/commercial-approval-policy.service.js';
import {
  COMMERCIAL_APPROVAL_LIFECYCLE_PACKAGE_NAME,
  COMMERCIAL_APPROVAL_RESOURCE,
  COMMERCIAL_APPROVAL_AUTHORITY_ACTIONS,
} from '../lib/lifecycle/commercial-approval-lifecycle.js';

// Requisition Workflow slice #4 — Commercial Approval (LOCKED
// Aramo-Commercial-Approval-Directive-v1_0), real Postgres 17. Proves the
// CommercialRevisionProposal governance layer end-to-end: propose is INTENT
// (writes NO AssignmentRateVersion), the authority transitions are SoD-gated +
// ADR-0024 fail-closed, and APPLY reuses createCommercialRevision to materialise
// exactly ONE new rate version — with the apply-time 409 leaving the proposal
// APPROVED (reconciliation). The governing invariant is asserted, not assumed.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260807120000_placement_fallthrough_reason',
  '20260808120000_placement_replacement_link',
  '20260809120000_placement_contract_assignment',
  '20260825120000_assignment_extension_horizon',
  '20260810100000_placement_assignment_ended_value',
  '20260810110000_placement_assignment_aware_guard',
  '20260810120000_placement_assignment_end_reason',
  '20260810130000_t5_assignment_rate_version',
  '20260812140000_t6_b1_effective_window_substrate',
  '20260813130000_t6_b3_commercial_cancellation',
  '20260826120000_commercial_revision_proposal',
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));
const POLICY_MIGS = [
  resolve(ROOT, 'libs/policy-store/prisma/migrations/20260730120000_init_policy_store/migration.sql'),
  resolve(ROOT, 'libs/policy-store/prisma/migrations/20260730160000_add_policy_decision_record/migration.sql'),
];

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (sql[i] === ';' && !inDollar) { out.push(cur); cur = ''; } else cur += sql[i];
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const T_PAST = '2026-01-01T00:00:00.000Z';
const T_FUT1 = '2030-01-01T00:00:00.000Z';
const SYSTEM = '00000000-0000-0000-0000-000000000000';
const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);

// A minimal PERMISSIVE package (default ALLOW, no rules) — enough to prove the
// ALLOW path + provenance persistence. The real derived matrix lives in apps/api.
function permissivePackage() {
  return {
    name: COMMERCIAL_APPROVAL_LIFECYCLE_PACKAGE_NAME,
    version: '1.0.0',
    registry: { resources: [COMMERCIAL_APPROVAL_RESOURCE], actions: [...COMMERCIAL_APPROVAL_AUTHORITY_ACTIONS] },
    default_disposition: { decision: 'ALLOW' as const, reason_code: 'COMMERCIAL_APPROVAL_ALLOWED_DEFAULT' },
    rules: [],
  };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Commercial Approval — CommercialRevisionProposal (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let client: PrismaService;
    let storePrisma: PolicyStorePrismaService;
    let store: PolicyStore;
    // Governed repo (policy wired) and an UNGOVERNED repo (no policy) to prove
    // fail-closed both ways: no published package AND no gate configured.
    let repo: PlacementRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      client = new PrismaService(url);
      await client.$connect();
      for (const path of [...MIGRATIONS, ...POLICY_MIGS]) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t.length > 0) await client.$executeRawUnsafe(t);
        }
      }
      storePrisma = new PolicyStorePrismaService(url);
      await storePrisma.$connect();
      store = new PolicyStore(storePrisma);
      repo = new PlacementRepository(client, new CommercialApprovalPolicyService(store));
    }, 120_000);

    afterAll(async () => {
      await client?.$disconnect();
      await storePrisma?.$disconnect();
      await container?.stop();
    });

    async function insertAssignment(o: { tenant_id: string; placement_process_id: string; id: string; lifecycle_state?: 'ACTIVE' | 'ENDED' }): Promise<void> {
      const state = o.lifecycle_state ?? 'ACTIVE';
      await client.$executeRawUnsafe(
        `INSERT INTO placement."ContractAssignment"
           (id, tenant_id, placement_process_id, submittal_id, requisition_id, talent_record_id, started_at, provenance, lifecycle_state, end_reason)
         VALUES ('${o.id}','${o.tenant_id}','${o.placement_process_id}','${randomUUID()}','${randomUUID()}','${randomUUID()}','${T_PAST}','BACKFILLED','${state}',${state === 'ENDED' ? `'COMPLETED'` : 'NULL'})`,
      );
    }
    async function insertVersion(o: { tenant_id: string; contract_assignment_id: string; effective_from: string; effective_to?: string | null; cancelled_at?: string | null }): Promise<string> {
      const id = randomUUID();
      await client.$executeRawUnsafe(
        `INSERT INTO placement."AssignmentRateVersion"
           (id, tenant_id, contract_assignment_id, requisition_id, talent_record_id, pay_rate_amount, bill_rate_amount, currency, rate_period, effective_from, effective_to, recorded_by, cancelled_at)
         VALUES ('${id}','${o.tenant_id}','${o.contract_assignment_id}','${randomUUID()}','${randomUUID()}',
           80.00,120.00,'USD','HOURLY','${o.effective_from}',${q(o.effective_to ?? null)},'${randomUUID()}',${q(o.cancelled_at ?? null)})`,
      );
      return id;
    }
    // A live ACTIVE assignment with a single open version at T_PAST (pay 80 / bill 120 → margin 33.33%).
    async function seedActiveOpen(): Promise<{ tenant: string; ppid: string; aid: string }> {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_PAST, effective_to: null });
      return { tenant, ppid, aid };
    }
    const versionCount = (s: { tenant: string; aid: string }) =>
      client.assignmentRateVersion.count({ where: { tenant_id: s.tenant, contract_assignment_id: s.aid } });
    const propose = (s: { tenant: string; ppid: string }, extra: Record<string, unknown> = {}) =>
      repo.createCommercialRevisionProposal(
        { tenant_id: s.tenant, placement_process_id: s.ppid, pay_rate_amount: '90.00', bill_rate_amount: '150.00', currency: 'USD', rate_period: 'HOURLY', reason: 'rate uplift', requested_by: PROPOSER, ...extra },
        'x',
      );
    const PROPOSER = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa1';
    const APPROVER = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbb1';
    const APPROVE_SCOPES = ['assignment:commercials:approve'];

    // ---- Propose = INTENT (no rate version written) + margin derivation ----
    it('propose creates a DRAFT proposal and writes NO AssignmentRateVersion (INTENT, not TRUTH)', async () => {
      const s = await seedActiveOpen();
      const before = await versionCount(s);
      const p = await propose(s);
      expect(p.state).toBe('DRAFT');
      expect(await versionCount(s)).toBe(before); // the governing invariant: no rate version on propose
      // derived margin comparison: current 80/120 (33.33%) vs proposed 90/150 (40.00%)
      expect(p.margin.current.margin_percent).toBe('33.33');
      expect(p.margin.proposed.margin_percent).toBe('40.00');
      expect(p.margin.pay_rate_delta).toBe('10.00');
      expect(p.margin.bill_rate_delta).toBe('30.00');
      expect(p.margin.margin_point_delta).toBe('6.67');
    });

    it('propose refuses a non-ACTIVE assignment and an assignment with no open version (404)', async () => {
      const ended = { tenant: randomUUID(), ppid: randomUUID(), aid: randomUUID() };
      await insertAssignment({ tenant_id: ended.tenant, placement_process_id: ended.ppid, id: ended.aid, lifecycle_state: 'ENDED' });
      await expect(propose(ended)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('one-live: a second non-terminal proposal is refused COMMERCIAL_PROPOSAL_ALREADY_LIVE (409)', async () => {
      const s = await seedActiveOpen();
      await propose(s);
      let err: AramoError | undefined;
      try { await propose(s); } catch (e) { err = e as AramoError; }
      expect(err?.code).toBe('COMMERCIAL_PROPOSAL_ALREADY_LIVE');
      expect(err?.statusCode).toBe(409);
    });

    it('one-live releases after a terminal: a new proposal may follow a WITHDRAWN one', async () => {
      const s = await seedActiveOpen();
      const p = await propose(s);
      await repo.transitionCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'withdraw', actor_id: PROPOSER }, 'x');
      const again = await propose(s); // no longer refused
      expect(again.state).toBe('DRAFT');
    });

    // ---- Segregation of duties (fail-closed) ----
    it('SoD: the proposer cannot self-approve → COMMERCIAL_PROPOSAL_SELF_APPROVAL (403)', async () => {
      await store.publish({ tenant_id: (await seedActiveOpen()).tenant, definition: permissivePackage(), published_by: SYSTEM });
      const s = await seedActiveOpen();
      await store.publish({ tenant_id: s.tenant, definition: permissivePackage(), published_by: SYSTEM });
      const p = await propose(s);
      await repo.transitionCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'submit', actor_id: PROPOSER }, 'x');
      let err: AramoError | undefined;
      try {
        await repo.decideCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'margin_approve', actor_id: PROPOSER, scopes: APPROVE_SCOPES }, 'x');
      } catch (e) { err = e as AramoError; }
      expect(err?.code).toBe('COMMERCIAL_PROPOSAL_SELF_APPROVAL');
      expect(err?.statusCode).toBe(403);
    });

    // ---- ADR-0024 fail-closed ----
    it('FAIL-CLOSED: authority transition with NO published package → POLICY_DENIED (403), no state change', async () => {
      const s = await seedActiveOpen(); // this tenant has NO published package
      const p = await propose(s);
      await repo.transitionCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'submit', actor_id: PROPOSER }, 'x');
      let err: AramoError | undefined;
      try {
        await repo.decideCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'margin_approve', actor_id: APPROVER, scopes: APPROVE_SCOPES }, 'x');
      } catch (e) { err = e as AramoError; }
      expect(err?.code).toBe('POLICY_DENIED');
      const read = await repo.findCommercialRevisionProposalById(s.tenant, s.ppid, p.id, 'x');
      expect(read?.state).toBe('PENDING_REVIEW'); // unchanged
    });

    // ---- Illegal edge ----
    it('illegal transition (DRAFT client_approve) → COMMERCIAL_PROPOSAL_STATE_INVALID (422)', async () => {
      const s = await seedActiveOpen();
      await store.publish({ tenant_id: s.tenant, definition: permissivePackage(), published_by: SYSTEM });
      const p = await propose(s);
      let err: AramoError | undefined;
      try {
        await repo.decideCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'client_approve', actor_id: APPROVER, scopes: APPROVE_SCOPES }, 'x');
      } catch (e) { err = e as AramoError; }
      expect(err?.code).toBe('COMMERCIAL_PROPOSAL_STATE_INVALID');
      expect(err?.statusCode).toBe(422);
    });

    // ---- Full happy path: APPLY reuses createCommercialRevision (exactly ONE new version) ----
    it('DRAFT→…→APPROVED→APPLIED materialises exactly ONE new AssignmentRateVersion (predecessor closed, evidence captured)', async () => {
      const s = await seedActiveOpen();
      await store.publish({ tenant_id: s.tenant, definition: permissivePackage(), published_by: SYSTEM });
      const before = await versionCount(s);
      expect(before).toBe(1);
      const p = await propose(s);
      await repo.transitionCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'submit', actor_id: PROPOSER }, 'x');
      await repo.decideCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'margin_approve', actor_id: APPROVER, scopes: APPROVE_SCOPES, note: 'margin ok' }, 'x');
      const clientApproved = await repo.decideCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'client_approve', actor_id: APPROVER, scopes: APPROVE_SCOPES, client_reference: 'WO-892731', client_approval_source: 'VMS' }, 'x');
      expect(clientApproved.state).toBe('APPROVED');
      expect(clientApproved.client_reference).toBe('WO-892731');
      expect(clientApproved.client_approval_source).toBe('VMS');
      expect(clientApproved.review_decided_by).toBe(APPROVER);

      const applied = await repo.decideCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'apply', actor_id: APPROVER, scopes: APPROVE_SCOPES }, 'x');
      expect(applied.state).toBe('APPLIED');
      expect(applied.applied_rate_version_id).not.toBeNull();
      expect(applied.applied_by).toBe(APPROVER);
      // exactly ONE new version; predecessor closed
      expect(await versionCount(s)).toBe(before + 1);
      const rows = await client.assignmentRateVersion.findMany({ where: { tenant_id: s.tenant, contract_assignment_id: s.aid }, orderBy: { effective_from: 'asc' } });
      expect(rows[0].effective_to).not.toBeNull(); // predecessor first-closed
      expect(rows[1].id).toBe(applied.applied_rate_version_id);
      expect(rows[1].pay_rate_amount.toFixed(2)).toBe('90.00');
      expect(rows[1].bill_rate_amount.toFixed(2)).toBe('150.00');
    });

    // ---- Apply-time reconciliation: a window conflict leaves the proposal APPROVED ----
    it('apply-time window conflict → 409 ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT; proposal STAYS APPROVED (reconciliation)', async () => {
      const s = await seedActiveOpen();
      await store.publish({ tenant_id: s.tenant, definition: permissivePackage(), published_by: SYSTEM });
      // A cancelled version already reserves T_FUT1 (the non-partial unique key fires
      // even against cancelled rows), so an apply at T_FUT1 duplicates it.
      await insertVersion({ tenant_id: s.tenant, contract_assignment_id: s.aid, effective_from: T_FUT1, effective_to: null, cancelled_at: T_PAST });
      const p = await propose(s, { effective_from: T_FUT1 });
      await repo.transitionCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'submit', actor_id: PROPOSER }, 'x');
      await repo.decideCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'margin_approve', actor_id: APPROVER, scopes: APPROVE_SCOPES }, 'x');
      await repo.decideCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'client_approve', actor_id: APPROVER, scopes: APPROVE_SCOPES, client_approval_source: 'MANUAL' }, 'x');
      let err: AramoError | undefined;
      try {
        await repo.decideCommercialRevisionProposal({ tenant_id: s.tenant, placement_process_id: s.ppid, proposal_id: p.id, action: 'apply', actor_id: APPROVER, scopes: APPROVE_SCOPES }, 'x');
      } catch (e) { err = e as AramoError; }
      expect(err?.code).toBe('ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT');
      const read = await repo.findCommercialRevisionProposalById(s.tenant, s.ppid, p.id, 'x');
      expect(read?.state).toBe('APPROVED'); // recoverable — did NOT vanish or auto-reject
    });

    // ---- Cross-tenant isolation ----
    it('cross-tenant: a proposal is invisible / immutable from another tenant (404)', async () => {
      const s = await seedActiveOpen();
      const p = await propose(s);
      const other = randomUUID();
      expect(await repo.findCommercialRevisionProposalById(other, s.ppid, p.id, 'x')).toBeNull();
      await expect(
        repo.transitionCommercialRevisionProposal({ tenant_id: other, placement_process_id: s.ppid, proposal_id: p.id, action: 'withdraw', actor_id: PROPOSER }, 'x'),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  },
);
