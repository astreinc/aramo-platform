import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Reflector } from '@nestjs/core';
import { PlacementProcessEventRepository, PlacementRepository, PrismaService, PLACEMENT_REASONS } from '@aramo/placement';
import { RolesGuard } from '@aramo/authorization';

import { PlacementController } from '../placement/placement.controller.js';

// The placement scope-sets a principal carries under the ratified role matrix
// (Placement-Role-Matrix seam). Mirrors PLACEMENT_SEED_BUNDLES; the seed→scope
// binding (which role resolves to which set) is proven against the real seed in
// libs/identity placement-role-matrix.spec.ts + identity.integration test 17.
// Here we prove the OTHER half: fed to the real placement authorization
// boundary, each set allows/denies the right authority classes.
const RECRUITER_PLACEMENT = ['placement:read', 'placement:create', 'placement:transition'];
const MANAGER_PLACEMENT = ['placement:read', 'placement:create', 'placement:transition', 'placement:activate', 'placement:terminate', 'placement:replace', 'assignment:commercials:write'];
// Track 5 / T5-P1 — valid commercial terms for the FORWARD STARTED body (the
// initial Assignment Rate Version is materialised in the same tx).
const T5_TERMS = { pay_rate_amount: '80.00', bill_rate_amount: '120.00', currency: 'USD', rate_period: 'HOURLY' } as const;

// E3 — a governed terminal transition now requires a canonical reason. Derive a
// valid OPTIONAL code for the FELL_THROUGH terminal from the registry (no detail needed), so
// the proofs stay taxonomy-neutral.
const DECLINE_REASON = PLACEMENT_REASONS.find(
  (r) => r.status === 'active' && r.detailPolicy === 'OPTIONAL' && r.allowedTargets.includes('FELL_THROUGH'),
)!.code;

// Track 3 / E1-b — the guarded PlacementProcess surface at the controller + repo
// level against real Postgres 17. The JWT/guard layer is covered by app-module-di
// + the shared guard specs; here we drive the controller with a constructed
// AuthContext to prove the DATA-DEPENDENT transition authorization and the create/
// read paths end-to-end. All placement scopes ship with ZERO default grants, so a
// caller must be given the exact class scope or the transition is refused.

const INIT_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260803180000_init_placement_model/migration.sql');
// E1-c — the additive offer-snapshot + OutboxEvent migration, applied AFTER init.
const OFFER_OUTBOX_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260805120000_placement_offer_and_outbox/migration.sql');
// E3 — the additive reason-evidence columns (curated migration list).
const REASON_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260807120000_placement_fallthrough_reason/migration.sql');
// E4 — additive replacement-lineage column; the Prisma client now selects it.
const REPLACEMENT_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260808120000_placement_replacement_link/migration.sql');
// Track 4 / T4-A1 — the additive ContractAssignment table; the STARTED transition
// INSERTs into it, so this HTTP spec (which activates placements) must apply it.
const CONTRACT_ASSIGNMENT_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260809120000_placement_contract_assignment/migration.sql');
// Track 4 / T4-C — ENDED lifecycle value + assignment-aware one-live guard (the
// create() pre-check queries lifecycle_state='ENDED'; guard trigger is assignment-aware).
const ASSIGNMENT_ENDED_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260810100000_placement_assignment_ended_value/migration.sql');
const ASSIGNMENT_GUARD_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260810110000_placement_assignment_aware_guard/migration.sql');
const ASSIGNMENT_END_REASON_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260810120000_placement_assignment_end_reason/migration.sql');
// Track 5 / T5-P1 — the additive AssignmentRateVersion table; the STARTED transition
// now INSERTs the initial rate version, so this HTTP spec (which activates placements) must apply it.
const ASSIGNMENT_RATE_VERSION_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260810130000_t5_assignment_rate_version/migration.sql');
// Track 6 / T6-B1 — the effective-window substrate: adds cancelled_* columns (the
// regenerated client selects them), the interval CHECK, the btree_gist overlap
// EXCLUDE, and the governed effective_to first-close trigger. This HTTP spec drives
// STARTED (which INSERTs an AssignmentRateVersion) so it must apply this migration.
const EFFECTIVE_WINDOW_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260812140000_t6_b1_effective_window_substrate/migration.sql');
// Track 6 / T6-B3 — the commercial-cancellation substrate: adds ContractAssignment.
// ended_at (the regenerated client selects it) and the cancellation + future-only
// re-open trigger branches. This HTTP spec drives END + cancellation, so it must apply
// this migration (SEPARATE const — never a 2nd resolve() arg, the ENOTDIR trap).
const COMMERCIAL_CANCELLATION_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260813130000_t6_b3_commercial_cancellation/migration.sql');
// T7-P1: adds PlacementProcess.placement_kind (the regenerated client selects it) +
// the PermanentPlacement table/enums. This HTTP spec drives placement reads/starts,
// so it must apply this migration (SEPARATE const — never a 2nd resolve() arg, ENOTDIR).
const PERMANENT_PLACEMENT_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260814120000_t7_permanent_placement/migration.sql');
// T7-P2: PermanentPlacement.falloff_* columns + PermanentPlacementRemedy table (SEPARATE const).
const FALLOFF_REMEDY_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260815120000_t7_p2_falloff_remedy/migration.sql');
// T7-P3: SEPARATE const (never a 2nd resolve() arg — that path-joins to ENOTDIR).
const GUARANTEE_TERMS_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260816120000_t7_p3_guarantee_term_versioning/migration.sql');
const OFFER_INIT_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260824120000_init_offer_model/migration.sql');
const OFFER_ID_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260824130000_placement_offer_id/migration.sql');
// Slice #3 — Assignment Extension: expected_end_at + AssignmentExtension. A SEPARATE
// const + apply-list entry (single-path resolve — never a 2nd resolve() arg → ENOTDIR).
const ASSIGNMENT_EXTENSION_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260825120000_assignment_extension_horizon/migration.sql');
// Slice #4 — Commercial Approval: CommercialRevisionProposal aggregate + event log.
// A SEPARATE const + apply-list entry (single-path resolve — never a 2nd resolve() arg → ENOTDIR).
const COMMERCIAL_PROPOSAL_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260826120000_commercial_revision_proposal/migration.sql');
// L4-0 (Hiring Commitment) — collapse PlacementState 10 -> 6 (the four OFFER_* states
// removed; offer lifecycle is owned solely by the Offer aggregate). Applied LAST; the
// fail-loud ::text:: cast is a no-op on a fresh DB (zero surviving rows), and it swaps
// the lifecycle guard body in for the collapsed 8-edge matrix (PRE_START-born).
// SEPARATE const + apply-list entry (single-path resolve — never a 2nd resolve() arg → ENOTDIR).
const OFFER_STATE_COLLAPSE_MIGRATION = resolve(__dirname, '../../../../libs/placement/prisma/migrations/20260901120000_l4_placement_offer_state_collapse/migration.sql');
// T6-B1 overlap exclusion constraint — dropped+restored around the legacy-corruption
// defensive proof (the only way to seed a state the constraint now forbids).
const OVERLAP_CONSTRAINT = 'AssignmentRateVersion_no_window_overlap_excl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const auth = (scopes: string[], tenant: string): any => ({ sub: '01900000-0000-7000-8000-0000000000aa', tenant_id: tenant, actor_kind: 'user', consumer_type: 'tenant', scopes });

// E1-d — the read routes take a Request and resolve the actor's visible
// requisition set (attached by the global VisibilityInterceptor in the real
// app). These direct-call proofs exercise transition authorization, not
// visibility, so they pass a see-all request (null ⇒ unrestricted); the
// visibility 404 behaviour is proven in placement-read.integration.spec.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reqSeeAll: any = { resolveVisibleRequisitionIds: async () => null };

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

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('E1-b PlacementController (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let setup: PrismaService;
  let prisma: PrismaService;
  let ctrl: PlacementController;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
    const url = container.getConnectionUri();
    setup = new PrismaService(url);
    await setup.$connect();
    for (const migration of [INIT_MIGRATION, OFFER_OUTBOX_MIGRATION, REASON_MIGRATION, REPLACEMENT_MIGRATION, CONTRACT_ASSIGNMENT_MIGRATION, ASSIGNMENT_ENDED_MIGRATION, ASSIGNMENT_GUARD_MIGRATION, ASSIGNMENT_END_REASON_MIGRATION, ASSIGNMENT_RATE_VERSION_MIGRATION, EFFECTIVE_WINDOW_MIGRATION, COMMERCIAL_CANCELLATION_MIGRATION, PERMANENT_PLACEMENT_MIGRATION, FALLOFF_REMEDY_MIGRATION, GUARANTEE_TERMS_MIGRATION, OFFER_INIT_MIGRATION, OFFER_ID_MIGRATION, ASSIGNMENT_EXTENSION_MIGRATION, COMMERCIAL_PROPOSAL_MIGRATION, OFFER_STATE_COLLAPSE_MIGRATION]) {
      for (const s of splitDdl(readFileSync(migration, 'utf8'))) {
        if (s.trim()) await setup.$executeRawUnsafe(s.trim());
      }
    }
    prisma = new PrismaService(url);
    await prisma.$connect();
    ctrl = new PlacementController(new PlacementRepository(prisma), new PlacementProcessEventRepository(prisma));
  }, 120_000);

  afterAll(async () => {
    await setup?.$disconnect();
    await prisma?.$disconnect();
    await container?.stop();
  });

  const body = () => ({ submittal_id: randomUUID(), requisition_id: randomUUID(), talent_record_id: randomUUID() });

  // Offer Lifecycle (D6) — a placement is created from an ACCEPTED offer. Seed one
  // (raw, via the placement client's offer model) for the request's tenant and
  // inject offer_id; the wrapper preserves ctrl.create's (auth, req, body) shape so
  // guard/E4 refusal tests still hit their earlier checks first (offer unused).
  async function seedOffer(tenant: string): Promise<string> {
    const id = randomUUID();
    await prisma.offer.create({ data: { id, tenant_id: tenant, submittal_id: randomUUID(), requisition_id: randomUUID(), talent_record_id: randomUUID(), state: 'ACCEPTED' } });
    return id;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function ctrlCreate(a: any, req: string, b: Record<string, unknown>) {
    const offer_id = b['offer_id'] ?? (await seedOffer(a.tenant_id));
    return ctrl.create(a, req, { ...b, offer_id } as never);
  }

  async function make(tenant: string): Promise<string> {
    const v = await ctrlCreate(auth(['placement:create'], tenant), 'r', body());
    expect(v.state).toBe('PRE_START');
    return v.id;
  }

  it('create returns PRE_START', async () => {
    const id = await make(randomUUID());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('an ordinary-progression transition needs placement:transition', async () => {
    const t = randomUUID();
    const id = await make(t);
    // Without the class scope → 403.
    await expect(ctrl.transition(auth([], t), 'r', id, { to: 'READY_TO_START' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { authority_class: 'transition', required_scope: 'placement:transition' } },
    });
    // With it → succeeds.
    const moved = await ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'READY_TO_START' });
    expect(moved.state).toBe('READY_TO_START');
  });

  it('a terminal transition needs placement:terminate (not :transition)', async () => {
    const t = randomUUID();
    const id = await make(t);
    // Holding :transition is NOT enough for a terminal edge.
    await expect(ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'FELL_THROUGH' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      context: { details: { authority_class: 'terminate', required_scope: 'placement:terminate' } },
    });
    const done = await ctrl.transition(auth(['placement:terminate'], t), 'r', id, { to: 'FELL_THROUGH', reason_code: DECLINE_REASON });
    expect(done.state).toBe('FELL_THROUGH');
  });

  it('the activate edge (READY_TO_START->STARTED) needs placement:activate', async () => {
    const t = randomUUID();
    const id = await make(t);
    const s = auth(['placement:transition', 'placement:activate', 'assignment:commercials:write'], t);
    await ctrl.transition(s, 'r', id, { to: 'READY_TO_START' });
    // Without :activate the live edge is refused even holding :transition.
    await expect(ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'STARTED' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      context: { details: { authority_class: 'activate', required_scope: 'placement:activate' } },
    });
    const live = await ctrl.transition(s, 'r', id, { to: 'STARTED', assignment_company_id: randomUUID(), assignment_expected_end_at: '2027-06-30T00:00:00.000Z', commercial_terms: T5_TERMS });
    expect(live.state).toBe('STARTED');
  });

  it('T5-P1 — STARTED requires assignment:commercials:write IN CONJUNCTION with placement:activate; placement:* alone does NOT satisfy it', async () => {
    const t = randomUUID();
    const id = await make(t);
    for (const to of ['READY_TO_START'] as const) {
      await ctrl.transition(auth(['placement:transition'], t), 'r', id, { to });
    }
    // Holds the edge scope (placement:activate) but NOT commercials:write → refused
    // by the commercial conjunction, before any state change.
    await expect(
      ctrl.transition(auth(['placement:transition', 'placement:activate'], t), 'r', id, { to: 'STARTED', assignment_company_id: randomUUID(), assignment_expected_end_at: '2027-06-30T00:00:00.000Z', commercial_terms: T5_TERMS }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { required_scope: 'assignment:commercials:write' } },
    });
  });

  it('an illegal edge is refused by the matrix (PLACEMENT_STATE_INVALID 422) even with the scope', async () => {
    const t = randomUUID();
    const id = await make(t);
    // L4 6-state machine — born PRE_START; drive it to READY_TO_START, then attempt
    // READY_TO_START -> BLOCKED. That edge is NOT in the 8-edge matrix, and BLOCKED is
    // a transition-class target (PRE_START -> BLOCKED is a legal ordinary edge, so the
    // scope is held), so the refusal is the matrix (422), not authz.
    await ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'READY_TO_START' });
    await expect(ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'BLOCKED' })).rejects.toMatchObject({
      code: 'PLACEMENT_STATE_INVALID',
      statusCode: 422,
    });
  });

  it('get is tenant-isolated and 404s a foreign/absent id', async () => {
    const t = randomUUID();
    const id = await make(t);
    expect((await ctrl.get(auth(['placement:read'], t), 'r', id, reqSeeAll)).id).toBe(id);
    await expect(ctrl.get(auth(['placement:read'], randomUUID()), 'r', id, reqSeeAll)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  // E1-c — the offer snapshot flows through the HTTP boundary (DTO ISO strings →
  // Date at the controller) and is returned on the response view.
  it('create accepts the offer snapshot and the response carries it back', async () => {
    const t = randomUUID();
    const v = await ctrlCreate(auth(['placement:create'], t), 'r', {
      submittal_id: randomUUID(),
      requisition_id: randomUUID(),
      talent_record_id: randomUUID(),
      offered_at: '2026-08-05T12:00:00.000Z',
      proposed_start_date: '2026-09-01',
      offer_expires_at: '2026-08-12T12:00:00.000Z',
      client_offer_reference: 'CLIENT-REF-99',
      offer_terms_summary: 'Full-time, hybrid.',
    });
    expect(v.offered_at.toISOString()).toBe('2026-08-05T12:00:00.000Z');
    expect(v.offer_expires_at?.toISOString()).toBe('2026-08-12T12:00:00.000Z');
    expect(v.client_offer_reference).toBe('CLIENT-REF-99');
    expect(v.offer_terms_summary).toBe('Full-time, hybrid.');
    // The read surface returns the same snapshot.
    const read = await ctrl.get(auth(['placement:read'], t), 'r', v.id, reqSeeAll);
    expect(read.client_offer_reference).toBe('CLIENT-REF-99');
  });

  it('create without an offer snapshot defaults offered_at and nulls the optional fields', async () => {
    const t = randomUUID();
    const v = await ctrlCreate(auth(['placement:create'], t), 'r', body());
    expect(v.offered_at).toBeInstanceOf(Date);
    expect(v.proposed_start_date).toBeNull();
    expect(v.client_offer_reference).toBeNull();
  });

  it('an offer_expires_at before offered_at is refused (VALIDATION_ERROR 400)', async () => {
    const t = randomUUID();
    await expect(
      ctrlCreate(auth(['placement:create'], t), 'r', {
        submittal_id: randomUUID(),
        requisition_id: randomUUID(),
        talent_record_id: randomUUID(),
        offered_at: '2026-08-05T12:00:00.000Z',
        offer_expires_at: '2026-08-04T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  // ─── Placement role matrix — authorization-boundary proofs ────────────────
  // The scope-sets are the ratified per-role placement bundles (above). These
  // reach the REAL in-handler authorization boundary (edgeAuthorityClass +
  // scope check) for transition / activate / terminate, and prove denial is
  // NON-VACUOUS: the protected state, event log, and outbox are unchanged.

  // {state, per-placement event count, per-tenant outbox count}. A fresh random
  // tenant per test isolates the outbox count to this placement's writes.
  async function snapshot(tenant: string, id: string): Promise<{ state: string | null; events: number; outbox: number }> {
    const p = await prisma.placementProcess.findFirst({ where: { id, tenant_id: tenant } });
    const events = await prisma.placementProcessEvent.count({ where: { placement_process_id: id } });
    const outbox = await prisma.outboxEvent.count({ where: { tenant_id: tenant } });
    return { state: p?.state ?? null, events, outbox };
  }

  it('matrix: RECRUITER set drives the ordinary edges to READY_TO_START but is DENIED activate (state/event/outbox unchanged)', async () => {
    const t = randomUUID();
    const id = await ctrlCreate(auth(RECRUITER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    // Ordinary-progression edges are all `transition` class — the recruiter set holds them.
    await ctrl.transition(auth(RECRUITER_PLACEMENT, t), 'r', id, { to: 'READY_TO_START' });
    const before = await snapshot(t, id);
    expect(before.state).toBe('READY_TO_START');
    // The live activation edge (READY_TO_START -> STARTED) is `activate` class — recruiter lacks it.
    await expect(ctrl.transition(auth(RECRUITER_PLACEMENT, t), 'r', id, { to: 'STARTED' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { authority_class: 'activate', required_scope: 'placement:activate' } },
    });
    // Non-vacuity: nothing moved.
    expect(await snapshot(t, id)).toEqual(before);
  });

  it('matrix: RECRUITER set is DENIED a terminal edge (terminate), state/event/outbox unchanged', async () => {
    const t = randomUUID();
    const id = await ctrlCreate(auth(RECRUITER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    const before = await snapshot(t, id);
    expect(before.state).toBe('PRE_START');
    await expect(ctrl.transition(auth(RECRUITER_PLACEMENT, t), 'r', id, { to: 'FELL_THROUGH' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { authority_class: 'terminate', required_scope: 'placement:terminate' } },
    });
    expect(await snapshot(t, id)).toEqual(before);
  });

  it('matrix: MANAGER set (account_manager/tenant_admin/tenant_owner) CAN activate the live edge', async () => {
    const t = randomUUID();
    const id = await ctrlCreate(auth(MANAGER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'READY_TO_START' });
    const live = await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'STARTED', assignment_company_id: randomUUID(), assignment_expected_end_at: '2027-06-30T00:00:00.000Z', commercial_terms: T5_TERMS });
    expect(live.state).toBe('STARTED');
  });

  // ---- T4-D assignment:read — the assignment-state read surface ----

  async function driveToStarted(t: string, company_id = randomUUID()): Promise<string> {
    const id = await ctrlCreate(auth(MANAGER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'READY_TO_START' });
    await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'STARTED', assignment_company_id: company_id, assignment_expected_end_at: '2027-06-30T00:00:00.000Z', commercial_terms: T5_TERMS });
    return id;
  }
  const readAuth = (t: string) => auth(['assignment:read'], t);

  it('assignment:read read correctness — returns the FORWARD/ACTIVE assignment with exact provenance/state/started_at (non-vacuous: row exists)', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    const seeded = await prisma.contractAssignment.count({ where: { tenant_id: t, placement_process_id: id } });
    expect(seeded).toBe(1); // non-vacuity
    const res = await ctrl.getAssignment(readAuth(t), 'r', id, reqSeeAll);
    expect(res.assignment).not.toBeNull();
    expect(res.assignment!.placement_process_id).toBe(id);
    expect(res.assignment!.provenance).toBe('FORWARD');
    expect(res.assignment!.lifecycle_state).toBe('ACTIVE');
    expect(res.assignment!.end_reason).toBeNull();
    expect(res.assignment!.started_at).toBeInstanceOf(Date);
  });

  it('assignment:read ended — returns end_reason as the authoritative discriminator (COMPLETED/WORKER_ENDED/CLIENT_ENDED, never collapsed)', async () => {
    for (const reason of ['COMPLETED', 'WORKER_ENDED', 'CLIENT_ENDED'] as const) {
      const t = randomUUID();
      const id = await driveToStarted(t);
      await ctrl.endAssignment(auth([], t), 'r', id, { end_reason: reason });
      const res = await ctrl.getAssignment(readAuth(t), 'r', id, reqSeeAll);
      expect(res.assignment!.lifecycle_state).toBe('ENDED');
      expect(res.assignment!.end_reason).toBe(reason);
    }
  });

  it('assignment:read no-assignment — a placement with no ContractAssignment returns { assignment: null } (coherent absence, not error, not fabricated)', async () => {
    const t = randomUUID();
    const id = await ctrlCreate(auth(RECRUITER_PLACEMENT, t), 'r', body()).then((v) => v.id); // PRE_START, never STARTED
    const res = await ctrl.getAssignment(readAuth(t), 'r', id, reqSeeAll);
    expect(res.assignment).toBeNull();
  });

  it('assignment:read tenant isolation — cross-tenant read is 404 (never 403)', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    await expect(ctrl.getAssignment(readAuth(randomUUID()), 'r', id, reqSeeAll)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });

  it('assignment:read no-capacity — the response carries NO capacity field (capacity stays A2/B2-gated; assert ABSENCE, C1-style)', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    const res = await ctrl.getAssignment(readAuth(t), 'r', id, reqSeeAll);
    expect(res.assignment).not.toBeNull();
    expect('capacity' in (res.assignment as unknown as Record<string, unknown>)).toBe(false);
    expect((res as unknown as Record<string, unknown>).capacity).toBeUndefined();
  });

  // ---- T5-P2 assignment:commercials:read — the commercial projection ----
  const commAuth = (t: string) => auth(['assignment:commercials:read'], t);

  // A/F/G/H/J/K — exact stored actuals + DEC-5 derived views. T5_TERMS = pay 80.00,
  // bill 120.00 → spread 40.00, margin 33.33, markup 50.00. Non-vacuous (row exists).
  it('T5-P2 read correctness — current effective projection: exact actuals + spread 40.00, margin 33.33, markup 50.00', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    expect(await prisma.assignmentRateVersion.count({ where: { tenant_id: t } })).toBe(1);
    const res = await ctrl.getAssignmentCommercials(commAuth(t), 'r', id, reqSeeAll);
    expect(res.commercials).not.toBeNull();
    const c = res.commercials!;
    expect(c.pay_rate_amount).toBe('80.00');
    expect(c.bill_rate_amount).toBe('120.00');
    expect(c.currency).toBe('USD');
    expect(c.rate_period).toBe('HOURLY');
    expect(c.spread_amount).toBe('40.00');
    expect(c.margin_percent).toBe('33.33');
    expect(c.markup_percent).toBe('50.00');
    expect(c.effective_to).toBeNull(); // L — initial active version, open window
  });

  // D (tenant) — same assignment id in another tenant is a tenant-safe 404.
  it('T5-P2 tenant isolation — same id in another tenant is 404 (never 403, never the row)', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    await expect(ctrl.getAssignmentCommercials(commAuth(randomUUID()), 'r', id, reqSeeAll)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  // E — coherent absence: a visible placement with no assignment returns null.
  it('T5-P2 coherent absence — visible placement, no assignment → { commercials: null }', async () => {
    const t = randomUUID();
    const id = await ctrlCreate(auth(MANAGER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    const res = await ctrl.getAssignmentCommercials(commAuth(t), 'r', id, reqSeeAll);
    expect(res.commercials).toBeNull();
  });

  // M — a read emits NO outbox event.
  it('T5-P2 read-only — the commercial read emits no outbox event', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    const before = await prisma.outboxEvent.count({ where: { tenant_id: t } });
    await ctrl.getAssignmentCommercials(commAuth(t), 'r', id, reqSeeAll);
    expect(await prisma.outboxEvent.count({ where: { tenant_id: t } })).toBe(before);
  });

  // O — the commercial scope cannot reveal a hidden (non-visible) assignment.
  it('T5-P2 boundary O — a placement not in the actor visible set is 404 (commercial scope cannot reveal it)', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reqSeeNone: any = { resolveVisibleRequisitionIds: async () => new Set<string>() };
    await expect(ctrl.getAssignmentCommercials(commAuth(t), 'r', id, reqSeeNone)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  // Seed an additional AssignmentRateVersion directly (INSERT is allowed by the
  // append-only trigger; the unique key is (tenant, assignment, effective_from)).
  async function seedVersion(t: string, ca: { id: string; requisition_id: string; talent_record_id: string }, effective_from: Date, effective_to: Date | null): Promise<void> {
    await prisma.assignmentRateVersion.create({
      data: {
        id: randomUUID(),
        tenant_id: t,
        contract_assignment_id: ca.id,
        requisition_id: ca.requisition_id,
        talent_record_id: ca.talent_record_id,
        pay_rate_amount: '90.00',
        bill_rate_amount: '140.00',
        currency: 'USD',
        rate_period: 'HOURLY',
        effective_from,
        effective_to,
        recorded_by: randomUUID(),
      },
    });
  }

  // §9.B — a FUTURE version is ignored; the current (initial) version is returned.
  // T6-B1: an open initial + an open future version would overlap and is now
  // DB-forbidden, so govern-close the initial at a future boundary and seed the
  // future version there (adjacent, non-overlapping). The now-read still returns the
  // still-current initial — and this also exercises the governed effective_to close.
  it('T5-P2/T6-B1 resolver — a future-effective version is ignored (current returned)', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    const ca = await prisma.contractAssignment.findFirstOrThrow({ where: { tenant_id: t, placement_process_id: id } });
    const initial = await prisma.assignmentRateVersion.findFirstOrThrow({ where: { tenant_id: t, contract_assignment_id: ca.id } });
    const boundary = new Date(Date.now() + 86_400_000);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.assignment_commercial_revision = 'authorized'`);
      await tx.$executeRawUnsafe(`UPDATE placement."AssignmentRateVersion" SET effective_to = '${boundary.toISOString()}' WHERE id = '${initial.id}'`);
    });
    await seedVersion(t, ca, boundary, null); // future version starts at the boundary
    const res = await ctrl.getAssignmentCommercials(commAuth(t), 'r', id, reqSeeAll);
    expect(res.commercials!.pay_rate_amount).toBe('80.00'); // the INITIAL, not the 90.00 future one
    expect(res.commercials!.markup_percent).toBe('50.00');
  });

  // §9.C — an EXPIRED version (effective_to in the past) is ignored.
  it('T5-P2 resolver — an expired version is ignored (current returned)', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    const ca = await prisma.contractAssignment.findFirstOrThrow({ where: { tenant_id: t, placement_process_id: id } });
    await seedVersion(t, ca, new Date(Date.now() - 172_800_000), new Date(Date.now() - 86_400_000)); // ended yesterday
    const res = await ctrl.getAssignmentCommercials(commAuth(t), 'r', id, reqSeeAll);
    expect(res.commercials!.pay_rate_amount).toBe('80.00');
  });

  // §6/§8/§9.F — TWO simultaneously-effective versions FAIL CLOSED (server-integrity
  // 500), never silently picking a winner; no financial values leaked, no row mutated,
  // no outbox event. T6-B1 now PREVENTS this overlap at the DB, so the legacy/corrupt
  // state is injected via a test-container-local, self-restoring DDL window: drop the
  // exclusion, inject the overlap, assert fail-closed, then delete the injected rows
  // via the tenant-reset escape and restore the exclusion in finally. No production
  // bypass exists — the drop/restore lives only in this spec.
  it('T5-P2/T6-B1 ambiguity — legacy overlapping versions fail closed (500), no leak, no mutation, no outbox', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    const ca = await prisma.contractAssignment.findFirstOrThrow({ where: { tenant_id: t, placement_process_id: id } });
    await prisma.$executeRawUnsafe(`ALTER TABLE placement."AssignmentRateVersion" DROP CONSTRAINT "${OVERLAP_CONSTRAINT}"`);
    try {
      await seedVersion(t, ca, new Date(Date.now() - 60_000), null); // second ACTIVE version (effective_to null)
      const before = await prisma.outboxEvent.count({ where: { tenant_id: t } });
      const err = await ctrl.getAssignmentCommercials(commAuth(t), 'r', id, reqSeeAll).then(() => null).catch((e) => e);
      expect(err).toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
      // No competing financial values leaked anywhere in the error.
      const errStr = JSON.stringify({ message: err?.message, context: err?.context });
      for (const v of ['80.00', '120.00', '90.00', '140.00']) expect(errStr).not.toContain(v);
      // No mutation: both versions present, both effective_to still null.
      const rows = await prisma.assignmentRateVersion.findMany({ where: { tenant_id: t, contract_assignment_id: ca.id } });
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.effective_to === null)).toBe(true);
      // No outbox event from the read.
      expect(await prisma.outboxEvent.count({ where: { tenant_id: t } })).toBe(before);
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.tenant_reset = 'authorized'`);
        await tx.$executeRawUnsafe(`DELETE FROM placement."AssignmentRateVersion" WHERE tenant_id = '${t}'`);
      });
      await prisma.$executeRawUnsafe(
        `ALTER TABLE placement."AssignmentRateVersion" ADD CONSTRAINT "${OVERLAP_CONSTRAINT}" EXCLUDE USING gist ("tenant_id" public.gist_uuid_ops WITH =, "contract_assignment_id" public.gist_uuid_ops WITH =, tstzrange("effective_from", COALESCE("effective_to", 'infinity'), '[)') WITH &&) WHERE ("cancelled_at" IS NULL)`,
      );
    }
  });

  // ===== Track 6 / T6-B2 — governed commercial revision (functional HTTP) =====
  const revisionAuth = (t: string) => auth(['assignment:commercials:write'], t);
  it('T6-B2 — a governed future revision closes the current window and returns the new open version; the series lists both DESC', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    const res = await ctrl.createAssignmentCommercialRevision(revisionAuth(t), 'r', id, {
      pay_rate_amount: '90.00', bill_rate_amount: '150.00', currency: 'USD', rate_period: 'HOURLY', effective_from: '2030-01-01T00:00:00Z', change_reason: 'rate correction',
    });
    expect(res.commercials.pay_rate_amount).toBe('90.00');
    expect(res.commercials.markup_percent).toBe('66.67'); // (150-90)/90*100
    expect(res.commercials.effective_to).toBeNull();
    const series = await ctrl.listAssignmentCommercialRevisions(commAuth(t), 'r', id, reqSeeAll);
    expect(series.items).toHaveLength(2);
    expect(series.items[0].effective_to).toBeNull(); // current first (DESC)
    expect(series.items[1].effective_to).not.toBeNull(); // the closed predecessor
  });

  it('T6-B2 — a revision at an instant reserved by a cancelled version fails closed 409 duplicate_effective_from', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    const ca = await prisma.contractAssignment.findFirstOrThrow({ where: { tenant_id: t, placement_process_id: id } });
    await prisma.assignmentRateVersion.create({
      data: {
        id: randomUUID(), tenant_id: t, contract_assignment_id: ca.id, requisition_id: ca.requisition_id, talent_record_id: ca.talent_record_id,
        pay_rate_amount: '80.00', bill_rate_amount: '120.00', currency: 'USD', rate_period: 'HOURLY',
        effective_from: new Date('2030-01-01T00:00:00Z'), recorded_by: randomUUID(), cancelled_at: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const err = await ctrl
      .createAssignmentCommercialRevision(revisionAuth(t), 'r', id, {
        pay_rate_amount: '90.00', bill_rate_amount: '150.00', currency: 'USD', rate_period: 'HOURLY', effective_from: '2030-01-01T00:00:00Z', change_reason: 'x',
      })
      .then(() => null)
      .catch((e) => e);
    expect(err).toMatchObject({ code: 'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', statusCode: 409 });
    expect(err.context.details.reason).toBe('duplicate_effective_from');
  });

  it('T6-B2 — the series read is 404 for a not-visible placement (visibility-first)', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reqSeeNone: any = { resolveVisibleRequisitionIds: async () => new Set<string>() };
    await expect(ctrl.listAssignmentCommercialRevisions(commAuth(t), 'r', id, reqSeeNone)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  // ===== Track 6 / T6-B3 — cancellation + END reconciliation (functional HTTP) =====
  // Schedule a future revision, then cancel it; the predecessor re-opens, so the
  // refreshed series is a single open current version (back to the initial actuals).
  async function scheduleFutureRevision(t: string, id: string): Promise<string> {
    const created = await ctrl.createAssignmentCommercialRevision(revisionAuth(t), 'r', id, {
      pay_rate_amount: '90.00', bill_rate_amount: '150.00', currency: 'USD', rate_period: 'HOURLY', effective_from: '2030-01-01T00:00:00Z', change_reason: 'scheduled bump',
    });
    return created.commercials.assignment_rate_version_id;
  }

  it('T6-B3 — cancelling a future revision re-opens the predecessor and returns the single open series', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    const futureId = await scheduleFutureRevision(t, id);
    const res = await ctrl.cancelAssignmentCommercialRevision(revisionAuth(t), 'r', id, futureId, { cancellation_reason_code: 'SCHEDULE_WITHDRAWN' }, reqSeeAll);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].effective_to).toBeNull(); // predecessor re-opened
    expect(res.items[0].pay_rate_amount).toBe('80.00'); // back to the initial actuals
  });

  it('T6-B3 — the reserved ASSIGNMENT_ENDED reason is refused on an explicit cancellation (400)', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    const futureId = await scheduleFutureRevision(t, id);
    await expect(
      ctrl.cancelAssignmentCommercialRevision(revisionAuth(t), 'r', id, futureId, { cancellation_reason_code: 'ASSIGNMENT_ENDED' }, reqSeeAll),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });

  it('T6-B3 — cancelling an unknown revision is 404', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    await expect(
      ctrl.cancelAssignmentCommercialRevision(revisionAuth(t), 'r', id, randomUUID(), { cancellation_reason_code: 'CLIENT_REQUEST' }, reqSeeAll),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('T6-B3 — cancellation on a not-visible placement is 404 (visibility-first)', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    const futureId = await scheduleFutureRevision(t, id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reqSeeNone: any = { resolveVisibleRequisitionIds: async () => new Set<string>() };
    await expect(
      ctrl.cancelAssignmentCommercialRevision(revisionAuth(t), 'r', id, futureId, { cancellation_reason_code: 'CLIENT_REQUEST' }, reqSeeNone),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });

  it('T6-B3 — ending an assignment reconciles the scheduled future window (assignment:end only, no commercials:write)', async () => {
    const t = randomUUID();
    const id = await driveToStarted(t);
    await scheduleFutureRevision(t, id); // predecessor [start,2030) + successor [2030, ∞)
    await ctrl.endAssignment(auth(['assignment:end'], t), 'r', id, { end_reason: 'COMPLETED' });
    const ca = await prisma.contractAssignment.findFirstOrThrow({ where: { tenant_id: t, placement_process_id: id } });
    expect(ca.lifecycle_state).toBe('ENDED');
    expect(ca.ended_at).not.toBeNull();
    const rows = await prisma.assignmentRateVersion.findMany({ where: { tenant_id: t, contract_assignment_id: ca.id } });
    const future = rows.find((r) => r.effective_from.toISOString() === new Date('2030-01-01T00:00:00Z').toISOString())!;
    expect(future.cancellation_reason_code).toBe('ASSIGNMENT_ENDED'); // reserved reason, END-set
    // No non-cancelled version is effective at/after ended_at.
    for (const r of rows) {
      if (r.cancelled_at !== null) continue;
      expect(r.effective_to).not.toBeNull();
      expect(r.effective_to!.getTime()).toBeLessThanOrEqual((ca.ended_at as Date).getTime());
    }
  });

  it('matrix: MANAGER set (account_manager/tenant_admin/tenant_owner) CAN terminate with a valid reason (a terminal edge)', async () => {
    const t = randomUUID();
    const id = await ctrlCreate(auth(MANAGER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    const done = await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'FELL_THROUGH', reason_code: DECLINE_REASON });
    expect(done.state).toBe('FELL_THROUGH');
  });

  it('matrix: read is tenant-isolated after authorization — a placement:read grant in tenant A does not read tenant B', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const id = await ctrlCreate(auth(MANAGER_PLACEMENT, tenantA), 'r', body()).then((v) => v.id);
    // Same authorized scope, different tenant → least-visibility 404 (NOT the row).
    await expect(ctrl.get(auth(['placement:read'], tenantB), 'r', id, reqSeeAll)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    // Sanity: within tenant A the read succeeds.
    expect((await ctrl.get(auth(['placement:read'], tenantA), 'r', id, reqSeeAll)).id).toBe(id);
  });

  // ─── E3 — reason evidence at the HTTP boundary ────────────────────────────

  // Authorization is enforced in the controller BEFORE the repository validates
  // the reason, so a recruiter attempting a terminal edge is refused 403 EVEN
  // WITH a valid reason — the reason never gets a chance to matter. Non-vacuous:
  // state/event/outbox unchanged.
  it('E3: RECRUITER attempting a terminal edge WITH a valid reason is still 403 (authz precedes reason); state/event/outbox unchanged', async () => {
    const t = randomUUID();
    const id = await ctrlCreate(auth(RECRUITER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    const before = await snapshot(t, id);
    await expect(
      ctrl.transition(auth(RECRUITER_PLACEMENT, t), 'r', id, { to: 'FELL_THROUGH', reason_code: DECLINE_REASON }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { authority_class: 'terminate', required_scope: 'placement:terminate' } },
    });
    expect(await snapshot(t, id)).toEqual(before);
  });

  // An authorized terminal transition MISSING the required reason is refused by
  // the reason gate (422), not authorization. Non-vacuous: nothing moved.
  it('E3: an authorized terminal transition with NO reason_code → 422 PLACEMENT_REASON_INVALID (reason_required); nothing moved', async () => {
    const t = randomUUID();
    const id = await ctrlCreate(auth(MANAGER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    const before = await snapshot(t, id);
    await expect(
      ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'FELL_THROUGH' }),
    ).rejects.toMatchObject({
      code: 'PLACEMENT_REASON_INVALID',
      statusCode: 422,
      context: { details: { reason: 'reason_required' } },
    });
    expect(await snapshot(t, id)).toEqual(before);
  });

  // Reason input on a NON-governed edge is refused (422), even when authorized.
  it('E3: a non-governed transition carrying a reason_code → 422 PLACEMENT_REASON_INVALID (reason_on_non_governed_target)', async () => {
    const t = randomUUID();
    const id = await ctrlCreate(auth(MANAGER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    const before = await snapshot(t, id);
    await expect(
      ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'READY_TO_START', reason_code: DECLINE_REASON }),
    ).rejects.toMatchObject({
      code: 'PLACEMENT_REASON_INVALID',
      statusCode: 422,
      context: { details: { reason: 'reason_on_non_governed_target' } },
    });
    expect(await snapshot(t, id)).toEqual(before);
  });

  // A cross-tenant terminal transition attempt (valid reason, valid scope in the
  // WRONG tenant) resolves to least-visibility 404 — the placement is invisible,
  // so neither reason nor authorization is reached.
  it('E3: a cross-tenant terminal transition attempt (valid reason) is 404 (least-visibility), and the real placement is untouched', async () => {
    const owner = randomUUID();
    const intruder = randomUUID();
    const id = await ctrlCreate(auth(MANAGER_PLACEMENT, owner), 'r', body()).then((v) => v.id);
    const before = await snapshot(owner, id);
    await expect(
      ctrl.transition(auth(MANAGER_PLACEMENT, intruder), 'r', id, { to: 'FELL_THROUGH', reason_code: DECLINE_REASON }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    // The owner's placement is untouched.
    expect(await snapshot(owner, id)).toEqual(before);
  });

  // ── Track 3 / E4 — replacement authorization + linkage ────────────────────
  // Create a terminal predecessor to replace: create (born PRE_START) then
  // terminate into FELL_THROUGH with a valid governed reason. Returns its id.
  async function makeTerminalPredecessor(tenant: string, requisitionId: string): Promise<string> {
    const created = await ctrlCreate(auth(['placement:create'], tenant), 'r', {
      submittal_id: randomUUID(),
      requisition_id: requisitionId,
      talent_record_id: randomUUID(),
    });
    await ctrl.transition(auth(['placement:terminate'], tenant), 'r', created.id, {
      to: 'FELL_THROUGH',
      reason_code: DECLINE_REASON,
    });
    return created.id;
  }

  // P-authz-1 (mandatory, load-bearing — the direction that actually guards the
  // conjunction): a create-only principal that supplies replaces_* is refused at
  // the handler BEFORE any mutation. Nothing is inserted.
  it('E4 / P-authz-1: create-only principal + replaces present → 403 placement:replace, nothing inserted', async () => {
    const t = randomUUID();
    const req = randomUUID();
    const predecessor = await makeTerminalPredecessor(t, req);
    const countBefore = await prisma.placementProcess.count({ where: { tenant_id: t } });
    await expect(
      ctrlCreate(auth(['placement:create'], t), 'r', {
        submittal_id: randomUUID(),
        requisition_id: req,
        talent_record_id: randomUUID(),
        replaces_placement_process_id: predecessor,
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { required_scope: 'placement:replace' } },
    });
    expect(await prisma.placementProcess.count({ where: { tenant_id: t } })).toBe(countBefore);
  });

  // P-authz-3 + P-link: with BOTH create and replace (MANAGER set) and a valid
  // terminal predecessor, the replacement create SUCCEEDS, persists replaces =
  // predecessor.id, and leaves the predecessor row byte-untouched. The successor
  // is on a DIFFERENT submittal (R2) — the one-live guard never engages.
  it('E4 / P-authz-3 + P-link: create+replace with a valid terminal predecessor succeeds, persists the pointer, predecessor untouched', async () => {
    const t = randomUUID();
    const req = randomUUID();
    const predecessor = await makeTerminalPredecessor(t, req);
    const predBefore = await prisma.placementProcess.findFirst({ where: { tenant_id: t, id: predecessor } });
    const successor = await ctrlCreate(auth(MANAGER_PLACEMENT, t), 'r', {
      submittal_id: randomUUID(),
      requisition_id: req,
      talent_record_id: randomUUID(),
      replaces_placement_process_id: predecessor,
    });
    expect(successor.state).toBe('PRE_START');
    // The response projection carries NO replaces field (§2 — request-only).
    expect(successor).not.toHaveProperty('replaces_placement_process_id');
    // The pointer is persisted on the successor row (read at the DB boundary).
    const row = (await prisma.placementProcess.findFirst({
      where: { tenant_id: t, id: successor.id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    expect(row.replaces_placement_process_id).toBe(predecessor);
    // The predecessor row is byte-untouched.
    expect(await prisma.placementProcess.findFirst({ where: { tenant_id: t, id: predecessor } })).toEqual(predBefore);
  });

  // P-valid-1 (T-cyc-1): a NON-terminal predecessor is refused. This is the
  // invariant (INV-1) that, with the frozen-terminal invariant (INV-2), makes a
  // replacement cycle structurally impossible — asserted, not walked.
  it('E4 / P-valid-1 (T-cyc-1): predecessor NON-terminal → 422 predecessor_not_terminal, nothing inserted', async () => {
    const t = randomUUID();
    const req = randomUUID();
    const live = await ctrlCreate(auth(['placement:create'], t), 'r', {
      submittal_id: randomUUID(),
      requisition_id: req,
      talent_record_id: randomUUID(),
    });
    const countBefore = await prisma.placementProcess.count({ where: { tenant_id: t } });
    await expect(
      ctrlCreate(auth(MANAGER_PLACEMENT, t), 'r', {
        submittal_id: randomUUID(),
        requisition_id: req,
        talent_record_id: randomUUID(),
        replaces_placement_process_id: live.id,
      }),
    ).rejects.toMatchObject({
      code: 'PLACEMENT_REPLACEMENT_INVALID',
      statusCode: 422,
      context: { details: { reason: 'predecessor_not_terminal' } },
    });
    expect(await prisma.placementProcess.count({ where: { tenant_id: t } })).toBe(countBefore);
  });

  // P-valid-2: an absent predecessor → predecessor_not_found; and both a
  // cross-tenant and a cross-requisition predecessor FOLD to not_found
  // (least-visibility; the two-discriminator set is honoured).
  it('E4 / P-valid-2: absent predecessor → 422 predecessor_not_found', async () => {
    const t = randomUUID();
    await expect(
      ctrlCreate(auth(MANAGER_PLACEMENT, t), 'r', {
        submittal_id: randomUUID(),
        requisition_id: randomUUID(),
        talent_record_id: randomUUID(),
        replaces_placement_process_id: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'PLACEMENT_REPLACEMENT_INVALID',
      statusCode: 422,
      context: { details: { reason: 'predecessor_not_found' } },
    });
  });

  it('E4 / P-valid-2: cross-tenant predecessor folds to predecessor_not_found (least-visibility)', async () => {
    const owner = randomUUID();
    const intruder = randomUUID();
    const req = randomUUID();
    const pred = await makeTerminalPredecessor(owner, req);
    await expect(
      ctrlCreate(auth(MANAGER_PLACEMENT, intruder), 'r', {
        submittal_id: randomUUID(),
        requisition_id: req,
        talent_record_id: randomUUID(),
        replaces_placement_process_id: pred,
      }),
    ).rejects.toMatchObject({
      code: 'PLACEMENT_REPLACEMENT_INVALID',
      statusCode: 422,
      context: { details: { reason: 'predecessor_not_found' } },
    });
  });

  it('E4 / P-valid-2: cross-requisition predecessor folds to predecessor_not_found', async () => {
    const t = randomUUID();
    const reqA = randomUUID();
    const reqB = randomUUID();
    const pred = await makeTerminalPredecessor(t, reqA);
    await expect(
      ctrlCreate(auth(MANAGER_PLACEMENT, t), 'r', {
        submittal_id: randomUUID(),
        requisition_id: reqB,
        talent_record_id: randomUUID(),
        replaces_placement_process_id: pred,
      }),
    ).rejects.toMatchObject({
      code: 'PLACEMENT_REPLACEMENT_INVALID',
      statusCode: 422,
      context: { details: { reason: 'predecessor_not_found' } },
    });
  });
});

// The read / create authority classes are guard-enforced (@RequireScopes +
// RolesGuard), not checked in-handler. This block drives the REAL RolesGuard
// against the REAL PlacementController route metadata (via a live Reflector),
// so it proves the actual read/create boundary — no DB, runs in every lane.
describe('E1-b placement matrix — read/create guard boundary (real RolesGuard + real route metadata)', () => {
  const guard = new RolesGuard(new Reflector());

  function ctx(handler: (...a: unknown[]) => unknown, scopes: string[]): unknown {
    const request = {
      authContext: { sub: 'u', tenant_id: randomUUID(), actor_kind: 'user', consumer_type: 'tenant', scopes },
      requestId: 'r',
      params: {},
      query: {},
    };
    return {
      getHandler: () => handler,
      getClass: () => PlacementController,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => ({}) }),
    };
  }

  const read = PlacementController.prototype.get as unknown as (...a: unknown[]) => unknown;
  const create = PlacementController.prototype.create as unknown as (...a: unknown[]) => unknown;
  const endAssignment = PlacementController.prototype.endAssignment as unknown as (...a: unknown[]) => unknown;

  function denial(handler: (...a: unknown[]) => unknown, scopes: string[]): unknown {
    let err: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { guard.canActivate(ctx(handler, scopes) as any); } catch (e) { err = e; }
    return err;
  }

  it('GET /v1/placements/:id requires placement:read — WITH it passes; WITHOUT it is 403 INSUFFICIENT_PERMISSIONS', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(guard.canActivate(ctx(read, ['placement:read']) as any)).toBe(true);
    expect(denial(read, [])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });

  it('POST /v1/placements requires placement:create — WITH it passes; WITHOUT it is 403 INSUFFICIENT_PERMISSIONS', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(guard.canActivate(ctx(create, ['placement:create']) as any)).toBe(true);
    expect(denial(create, [])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });

  it('T4-D: POST /v1/placements/:id/assignment/end requires assignment:end — WITH it passes; WITHOUT it 403; placement:* does NOT satisfy it (§7 no-reuse)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(guard.canActivate(ctx(endAssignment, ['assignment:end']) as any)).toBe(true);
    expect(denial(endAssignment, [])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    // The dedicated family is NOT satisfied by placement authority — reuse is rejected.
    expect(denial(endAssignment, ['placement:terminate', 'placement:activate', 'placement:transition'])).toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
    });
  });

  it('T4-D: GET /v1/placements/:id/assignment requires assignment:read — WITH it passes; WITHOUT it 403; placement:read does NOT satisfy it (§7 no-reuse)', () => {
    const getAssignment = PlacementController.prototype.getAssignment as unknown as (...a: unknown[]) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(guard.canActivate(ctx(getAssignment, ['assignment:read']) as any)).toBe(true);
    expect(denial(getAssignment, [])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    // placement:read (which guards the placement item/events reads) does NOT satisfy assignment:read.
    expect(denial(getAssignment, ['placement:read'])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });

  it('T5-P2: GET .../assignment/commercials requires assignment:commercials:read — WITH it passes; WITHOUT 403; assignment:read / placement:read / commercials:write do NOT satisfy it', () => {
    const h = PlacementController.prototype.getAssignmentCommercials as unknown as (...a: unknown[]) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(guard.canActivate(ctx(h, ['assignment:commercials:read']) as any)).toBe(true);
    expect(denial(h, [])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    // B/C — a lesser financial-blind scope does NOT satisfy the dedicated read scope.
    expect(denial(h, ['assignment:read'])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(denial(h, ['placement:read'])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    // N — write does NOT imply read.
    expect(denial(h, ['assignment:commercials:write'])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });

  it('T6-B2: POST .../commercials/revisions requires assignment:commercials:write — WITH it passes; WITHOUT 403; read / placement:* / assignment:update do NOT satisfy it', () => {
    const h = PlacementController.prototype.createAssignmentCommercialRevision as unknown as (...a: unknown[]) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(guard.canActivate(ctx(h, ['assignment:commercials:write']) as any)).toBe(true);
    expect(denial(h, [])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    // read does NOT imply write — the dedicated financial WRITE scope is required.
    expect(denial(h, ['assignment:commercials:read'])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    // placement authority and the dormant assignment:update do NOT substitute (§9 no-reuse).
    expect(denial(h, ['placement:activate', 'placement:transition', 'placement:terminate'])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(denial(h, ['assignment:update'])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });

  it('T6-B2: GET .../commercials/revisions requires assignment:commercials:read — WITH it passes; WITHOUT 403; write does NOT imply read', () => {
    const h = PlacementController.prototype.listAssignmentCommercialRevisions as unknown as (...a: unknown[]) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(guard.canActivate(ctx(h, ['assignment:commercials:read']) as any)).toBe(true);
    expect(denial(h, [])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(denial(h, ['assignment:commercials:write'])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    expect(denial(h, ['placement:read'])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });

  it('a no-placement-grant principal (e.g. super_admin / any role outside the matrix) is denied read AND create', () => {
    const noPlacement = ['requisition:read', 'talent:read']; // scopes a non-matrix role might carry — none are placement:*
    expect(denial(read, noPlacement)).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(denial(create, noPlacement)).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
  });

  // E4 / P-authz-2 — the OTHER conjunction direction, via the static create
  // guard. The harness synthesizes arbitrary scope sets, so the replace-only
  // principal IS constructible (§9.1): a principal holding placement:replace
  // WITHOUT placement:create is refused by the create guard, so placement:replace
  // can never become an alternative general creation permission. (No seeded role
  // is replace-only — every role granted replace also holds create — so this is
  // the synthetic-scope proof, not a seeded-identity one.)
  it('E4 / P-authz-2: a replace-ONLY principal is denied POST /v1/placements by the create guard (403)', () => {
    expect(guard.canActivate(ctx(create, ['placement:create', 'placement:replace']) as any)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(denial(create, ['placement:replace'])).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
  });
});
