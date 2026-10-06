import { describe, it, expect, vi } from 'vitest';

import { OfferStartWorklistReadService } from '../offer-start-worklist/offer-start-worklist-read.service.js';

// Offer & Start §9 — the cross-requisition worklist composer, proven deterministically over fake
// owner repos. Covers: cross-req union, deepest-owner precedence (Placement over Offer), inclusion
// of pre-PlacementProcess offer rows (§9.1), terminal exclusion, exception-first ordering (§9.3/§9.6),
// episode-id resolution (+ null when unresolvable), name composition, engagement derivation, and the
// visibility-threading / empty-visibility short-circuit (§9.4 — no fetch-all-then-filter).

const noopLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

type Fakes = {
  offers?: any[];
  placements?: any[];
  episodes?: any[];
  talentNames?: Map<string, string>;
  reqSummaries?: any[];
  companyNames?: Map<string, string>;
};

function makeService(f: Fakes) {
  const spies = {
    offerList: vi.fn(async () => f.offers ?? []),
    placementList: vi.fn(async () => f.placements ?? []),
    episodes: vi.fn(async () => f.episodes ?? []),
    talentNames: vi.fn(async () => f.talentNames ?? new Map()),
    reqSummaries: vi.fn(async () => f.reqSummaries ?? []),
    companyNames: vi.fn(async () => f.companyNames ?? new Map()),
  };
  const svc = new OfferStartWorklistReadService(
    { list: spies.offerList } as never,
    { listForActor: spies.placementList } as never,
    { listByRequisitionsAndStatus: spies.episodes } as never,
    { findNamesByIds: spies.talentNames } as never,
    { findSummariesByIds: spies.reqSummaries } as never,
    { findNamesByIds: spies.companyNames } as never,
    noopLogger,
  );
  return { svc, spies };
}

const offer = (over: Record<string, unknown> = {}) => ({
  id: 'o', tenant_id: 'T', submittal_id: 's', requisition_id: 'r1', talent_record_id: 't1',
  state: 'SENT', proposed_start_date: null, offer_expires_at: null, client_offer_reference: null,
  offer_terms_summary: null, compensation_type: 'CONTRACT', compensation_amount: null,
  compensation_currency: null, compensation_period: null, decline_reason: null, created_at: '2026-10-02T00:00:00.000Z', ...over,
});
const placement = (over: Record<string, unknown> = {}) => ({
  id: 'p', tenant_id: 'T', submittal_id: 's', requisition_id: 'r1', talent_record_id: 't1',
  state: 'PRE_START', placement_kind: null, offered_at: new Date('2026-10-01T00:00:00.000Z'), ...over,
});
const episode = (requisition_id: string, talent_record_id: string, id: string) => ({ id, requisition_id, talent_record_id, status: 'qualified' });
const reqSummary = (id: string, company_id: string) => ({ id, requisition_number: 101, title: 'Senior BA', company_id, status: 'OPEN', is_hot: false, owner_id: null, recruiter_id: null });

const ctx = { tenant_id: 'T', visible_requisition_ids: null as ReadonlySet<string> | null, requestId: 'r' };

describe('OfferStartWorklistReadService (§9)', () => {
  it('composes cross-req rows; a Placement SUPERSEDES the Offer for the same (req, talent)', async () => {
    const { svc } = makeService({
      offers: [offer({ requisition_id: 'r1', talent_record_id: 't1', state: 'ACCEPTED' })],
      placements: [placement({ requisition_id: 'r1', talent_record_id: 't1', state: 'PRE_START' })],
      episodes: [episode('r1', 't1', 'pl-1')],
      talentNames: new Map([['t1', 'Aisha Khan']]),
      reqSummaries: [reqSummary('r1', 'c1')],
      companyNames: new Map([['c1', 'Freddie Mac']]),
    });
    const res = await svc.getWorklist(ctx);
    expect(res.items).toHaveLength(1); // union by (req,talent) — one row, not two
    expect(res.items[0]).toMatchObject({ phase: 'PRE_START', pipeline_id: 'pl-1', talent_name: 'Aisha Khan', client_name: 'Freddie Mac' });
  });

  it('includes a pre-PlacementProcess OFFER row (§9.1) and resolves its journey episode', async () => {
    const { svc } = makeService({
      offers: [offer({ requisition_id: 'r2', talent_record_id: 't2', state: 'SENT' })],
      placements: [],
      episodes: [episode('r2', 't2', 'pl-2')],
      talentNames: new Map([['t2', 'Nora Diaz']]),
      reqSummaries: [reqSummary('r2', 'c1')],
      companyNames: new Map([['c1', 'Acme']]),
    });
    const res = await svc.getWorklist(ctx);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ phase: 'OFFER', phase_label: 'Offer sent', pipeline_id: 'pl-2' });
  });

  it('excludes terminal placements (NO_SHOW/FELL_THROUGH) and RESCINDED offers (not active worklist)', async () => {
    const { svc } = makeService({
      offers: [offer({ requisition_id: 'r3', talent_record_id: 't3', state: 'RESCINDED' })],
      placements: [placement({ requisition_id: 'r4', talent_record_id: 't4', state: 'FELL_THROUGH' })],
      episodes: [episode('r3', 't3', 'pl-3'), episode('r4', 't4', 'pl-4')],
    });
    const res = await svc.getWorklist(ctx);
    expect(res.items).toHaveLength(0);
  });

  it('exception-first ordering (§9.3): BLOCKED / DECLINED outrank ordinary progress', async () => {
    const { svc } = makeService({
      offers: [offer({ requisition_id: 'r5', talent_record_id: 't5', state: 'DECLINED' })],
      placements: [
        placement({ requisition_id: 'r6', talent_record_id: 't6', state: 'STARTED' }),
        placement({ requisition_id: 'r7', talent_record_id: 't7', state: 'BLOCKED' }),
      ],
      episodes: [episode('r5', 't5', 'a'), episode('r6', 't6', 'b'), episode('r7', 't7', 'c')],
    });
    const res = await svc.getWorklist(ctx);
    // exceptions (BLOCKED, DECLINED) first; the STARTED non-exception row sorts last.
    expect(res.items.map((r) => r.has_exception)).toEqual([true, true, false]);
    expect(res.items.find((r) => r.phase === 'STARTED')!.has_exception).toBe(false);
  });

  it('engagement is PERMANENT for a permanent placement; the completion label diverges', async () => {
    const { svc } = makeService({
      placements: [placement({ requisition_id: 'r8', talent_record_id: 't8', state: 'STARTED', placement_kind: 'PERMANENT' })],
      episodes: [episode('r8', 't8', 'pl-8')],
    });
    const res = await svc.getWorklist(ctx);
    expect(res.items[0]).toMatchObject({ engagement: 'PERMANENT', phase_label: 'Placement recorded' });
  });

  it('an unresolvable episode → pipeline_id null (never a guessed key)', async () => {
    const { svc } = makeService({
      offers: [offer({ requisition_id: 'r9', talent_record_id: 't9', state: 'SENT' })],
      episodes: [], // no episode row
    });
    const res = await svc.getWorklist(ctx);
    expect(res.items[0]!.pipeline_id).toBeNull();
  });

  it('threads visible_requisition_ids into EVERY owner read (server-side scoping, §9.4)', async () => {
    const vis = new Set(['r1']);
    const { svc, spies } = makeService({ offers: [], placements: [] });
    await svc.getWorklist({ ...ctx, visible_requisition_ids: vis });
    expect(spies.offerList).toHaveBeenCalledWith(expect.objectContaining({ visible_requisition_ids: vis }));
    expect(spies.placementList).toHaveBeenCalledWith(expect.objectContaining({ visible_requisition_ids: vis }));
  });

  it('an EMPTY visible set short-circuits to no rows WITHOUT reading any owner (actor sees nothing)', async () => {
    const { svc, spies } = makeService({ offers: [offer()], placements: [placement()] });
    const res = await svc.getWorklist({ ...ctx, visible_requisition_ids: new Set() });
    expect(res).toEqual({ items: [], total: 0 });
    expect(spies.offerList).not.toHaveBeenCalled();
    expect(spies.placementList).not.toHaveBeenCalled();
  });
});
