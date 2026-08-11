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
// valid OPTIONAL code for OFFER_DECLINED from the registry (no detail needed), so
// the proofs stay taxonomy-neutral.
const DECLINE_REASON = PLACEMENT_REASONS.find(
  (r) => r.status === 'active' && r.detailPolicy === 'OPTIONAL' && r.allowedTargets.includes('OFFER_DECLINED'),
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
    for (const migration of [INIT_MIGRATION, OFFER_OUTBOX_MIGRATION, REASON_MIGRATION, REPLACEMENT_MIGRATION, CONTRACT_ASSIGNMENT_MIGRATION, ASSIGNMENT_ENDED_MIGRATION, ASSIGNMENT_GUARD_MIGRATION, ASSIGNMENT_END_REASON_MIGRATION, ASSIGNMENT_RATE_VERSION_MIGRATION]) {
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

  async function make(tenant: string): Promise<string> {
    const v = await ctrl.create(auth(['placement:create'], tenant), 'r', body());
    expect(v.state).toBe('OFFER_EXTENDED');
    return v.id;
  }

  it('create returns OFFER_EXTENDED', async () => {
    const id = await make(randomUUID());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('an ordinary-progression transition needs placement:transition', async () => {
    const t = randomUUID();
    const id = await make(t);
    // Without the class scope → 403.
    await expect(ctrl.transition(auth([], t), 'r', id, { to: 'OFFER_ACCEPTED' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { authority_class: 'transition', required_scope: 'placement:transition' } },
    });
    // With it → succeeds.
    const moved = await ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'OFFER_ACCEPTED' });
    expect(moved.state).toBe('OFFER_ACCEPTED');
  });

  it('a terminal transition needs placement:terminate (not :transition)', async () => {
    const t = randomUUID();
    const id = await make(t);
    // Holding :transition is NOT enough for a terminal edge.
    await expect(ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'OFFER_DECLINED' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      context: { details: { authority_class: 'terminate', required_scope: 'placement:terminate' } },
    });
    const done = await ctrl.transition(auth(['placement:terminate'], t), 'r', id, { to: 'OFFER_DECLINED', reason_code: DECLINE_REASON });
    expect(done.state).toBe('OFFER_DECLINED');
  });

  it('the activate edge (READY_TO_START->STARTED) needs placement:activate', async () => {
    const t = randomUUID();
    const id = await make(t);
    const s = auth(['placement:transition', 'placement:activate', 'assignment:commercials:write'], t);
    await ctrl.transition(s, 'r', id, { to: 'OFFER_ACCEPTED' });
    await ctrl.transition(s, 'r', id, { to: 'PRE_START' });
    await ctrl.transition(s, 'r', id, { to: 'READY_TO_START' });
    // Without :activate the live edge is refused even holding :transition.
    await expect(ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'STARTED' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      context: { details: { authority_class: 'activate', required_scope: 'placement:activate' } },
    });
    const live = await ctrl.transition(s, 'r', id, { to: 'STARTED', assignment_company_id: randomUUID(), commercial_terms: T5_TERMS });
    expect(live.state).toBe('STARTED');
  });

  it('T5-P1 — STARTED requires assignment:commercials:write IN CONJUNCTION with placement:activate; placement:* alone does NOT satisfy it', async () => {
    const t = randomUUID();
    const id = await make(t);
    for (const to of ['OFFER_ACCEPTED', 'PRE_START', 'READY_TO_START'] as const) {
      await ctrl.transition(auth(['placement:transition'], t), 'r', id, { to });
    }
    // Holds the edge scope (placement:activate) but NOT commercials:write → refused
    // by the commercial conjunction, before any state change.
    await expect(
      ctrl.transition(auth(['placement:transition', 'placement:activate'], t), 'r', id, { to: 'STARTED', assignment_company_id: randomUUID(), commercial_terms: T5_TERMS }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { required_scope: 'assignment:commercials:write' } },
    });
  });

  it('an illegal edge is refused by the matrix (PLACEMENT_STATE_INVALID 422) even with the scope', async () => {
    const t = randomUUID();
    const id = await make(t);
    // OFFER_EXTENDED -> READY_TO_START is not a legal edge; scope class of the
    // target (transition) is held, so the refusal is the matrix, not authz.
    await expect(ctrl.transition(auth(['placement:transition'], t), 'r', id, { to: 'READY_TO_START' })).rejects.toMatchObject({
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
    const v = await ctrl.create(auth(['placement:create'], t), 'r', {
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
    const v = await ctrl.create(auth(['placement:create'], t), 'r', body());
    expect(v.offered_at).toBeInstanceOf(Date);
    expect(v.proposed_start_date).toBeNull();
    expect(v.client_offer_reference).toBeNull();
  });

  it('an offer_expires_at before offered_at is refused (VALIDATION_ERROR 400)', async () => {
    const t = randomUUID();
    await expect(
      ctrl.create(auth(['placement:create'], t), 'r', {
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
    const id = await ctrl.create(auth(RECRUITER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    // Ordinary-progression edges are all `transition` class — the recruiter set holds them.
    await ctrl.transition(auth(RECRUITER_PLACEMENT, t), 'r', id, { to: 'OFFER_ACCEPTED' });
    await ctrl.transition(auth(RECRUITER_PLACEMENT, t), 'r', id, { to: 'PRE_START' });
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
    const id = await ctrl.create(auth(RECRUITER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    const before = await snapshot(t, id);
    expect(before.state).toBe('OFFER_EXTENDED');
    await expect(ctrl.transition(auth(RECRUITER_PLACEMENT, t), 'r', id, { to: 'OFFER_DECLINED' })).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { authority_class: 'terminate', required_scope: 'placement:terminate' } },
    });
    expect(await snapshot(t, id)).toEqual(before);
  });

  it('matrix: MANAGER set (account_manager/tenant_admin/tenant_owner) CAN activate the live edge', async () => {
    const t = randomUUID();
    const id = await ctrl.create(auth(MANAGER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'OFFER_ACCEPTED' });
    await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'PRE_START' });
    await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'READY_TO_START' });
    const live = await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'STARTED', assignment_company_id: randomUUID(), commercial_terms: T5_TERMS });
    expect(live.state).toBe('STARTED');
  });

  // ---- T4-D assignment:read — the assignment-state read surface ----

  async function driveToStarted(t: string, company_id = randomUUID()): Promise<string> {
    const id = await ctrl.create(auth(MANAGER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'OFFER_ACCEPTED' });
    await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'PRE_START' });
    await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'READY_TO_START' });
    await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'STARTED', assignment_company_id: company_id, commercial_terms: T5_TERMS });
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
    const id = await ctrl.create(auth(RECRUITER_PLACEMENT, t), 'r', body()).then((v) => v.id); // OFFER_EXTENDED, never STARTED
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

  it('matrix: MANAGER set (account_manager/tenant_admin/tenant_owner) CAN terminate with a valid reason (a terminal edge)', async () => {
    const t = randomUUID();
    const id = await ctrl.create(auth(MANAGER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    const done = await ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'OFFER_DECLINED', reason_code: DECLINE_REASON });
    expect(done.state).toBe('OFFER_DECLINED');
  });

  it('matrix: read is tenant-isolated after authorization — a placement:read grant in tenant A does not read tenant B', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const id = await ctrl.create(auth(MANAGER_PLACEMENT, tenantA), 'r', body()).then((v) => v.id);
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
    const id = await ctrl.create(auth(RECRUITER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    const before = await snapshot(t, id);
    await expect(
      ctrl.transition(auth(RECRUITER_PLACEMENT, t), 'r', id, { to: 'OFFER_DECLINED', reason_code: DECLINE_REASON }),
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
    const id = await ctrl.create(auth(MANAGER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    const before = await snapshot(t, id);
    await expect(
      ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'OFFER_DECLINED' }),
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
    const id = await ctrl.create(auth(MANAGER_PLACEMENT, t), 'r', body()).then((v) => v.id);
    const before = await snapshot(t, id);
    await expect(
      ctrl.transition(auth(MANAGER_PLACEMENT, t), 'r', id, { to: 'OFFER_ACCEPTED', reason_code: DECLINE_REASON }),
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
    const id = await ctrl.create(auth(MANAGER_PLACEMENT, owner), 'r', body()).then((v) => v.id);
    const before = await snapshot(owner, id);
    await expect(
      ctrl.transition(auth(MANAGER_PLACEMENT, intruder), 'r', id, { to: 'OFFER_DECLINED', reason_code: DECLINE_REASON }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    // The owner's placement is untouched.
    expect(await snapshot(owner, id)).toEqual(before);
  });

  // ── Track 3 / E4 — replacement authorization + linkage ────────────────────
  // Create a terminal predecessor to replace: create (OFFER_EXTENDED) then
  // terminate into OFFER_DECLINED with a valid governed reason. Returns its id.
  async function makeTerminalPredecessor(tenant: string, requisitionId: string): Promise<string> {
    const created = await ctrl.create(auth(['placement:create'], tenant), 'r', {
      submittal_id: randomUUID(),
      requisition_id: requisitionId,
      talent_record_id: randomUUID(),
    });
    await ctrl.transition(auth(['placement:terminate'], tenant), 'r', created.id, {
      to: 'OFFER_DECLINED',
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
      ctrl.create(auth(['placement:create'], t), 'r', {
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
    const successor = await ctrl.create(auth(MANAGER_PLACEMENT, t), 'r', {
      submittal_id: randomUUID(),
      requisition_id: req,
      talent_record_id: randomUUID(),
      replaces_placement_process_id: predecessor,
    });
    expect(successor.state).toBe('OFFER_EXTENDED');
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
    const live = await ctrl.create(auth(['placement:create'], t), 'r', {
      submittal_id: randomUUID(),
      requisition_id: req,
      talent_record_id: randomUUID(),
    });
    const countBefore = await prisma.placementProcess.count({ where: { tenant_id: t } });
    await expect(
      ctrl.create(auth(MANAGER_PLACEMENT, t), 'r', {
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
      ctrl.create(auth(MANAGER_PLACEMENT, t), 'r', {
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
      ctrl.create(auth(MANAGER_PLACEMENT, intruder), 'r', {
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
      ctrl.create(auth(MANAGER_PLACEMENT, t), 'r', {
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
