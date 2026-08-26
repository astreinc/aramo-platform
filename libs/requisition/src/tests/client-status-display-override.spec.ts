import { describe, expect, it } from 'vitest';

import type { RequisitionView } from '../lib/dto/requisition.view.js';
import { RequisitionRepository } from '../lib/requisition.repository.js';

// Requisition Lane 1-C (D-C1 DISPLAY / proof 8) — the DISPLAY override in
// enrichClientStatus. ONLY RecruitingStatus === 'submittals_closed' forces the
// DISPLAYED client_submittal_status to 'closed', overriding the eligibility-
// derived value; every other non-open status leaves the field eligibility-
// derived. The submit boundary and the displayed status are intentionally
// different rules — this spec proves the display half in isolation.
//
// enrichClientStatus is a private method; TS `private` is compile-time only, so
// the runtime bracket access is legitimate. The clientStatus reader (5th ctor
// arg) is stubbed to return an OPEN posture for EVERY requisition, so the only
// thing that can turn a view 'closed' here is the L1-C status override — the
// non-vacuous contrast the proof requires.

// The reader stub answers OPEN for every requisition it is asked about, so the
// eligibility-derived baseline is uniformly 'open'. Any 'closed' in the output
// therefore comes from the L1-C override, not the eligibility derivation.
const OPEN_FOR_ALL = {
  deriveByRequisitionIds: async (_t: string, ids: readonly string[]) =>
    new Map(ids.map((id) => [id, { status: 'open' as const, reason: null }])),
};

function view(id: string, status: RequisitionView['status']): RequisitionView {
  // Only id + status + the two client_submittal_* fields are load-bearing here;
  // the rest are filled with inert defaults so the object satisfies the view.
  return {
    id,
    status,
    client_submittal_status: null,
    client_submittal_reason: null,
  } as unknown as RequisitionView;
}

type WithEnrich = {
  enrichClientStatus(
    tenant_id: string,
    views: RequisitionView[],
  ): Promise<RequisitionView[]>;
};

function repo(): WithEnrich {
  return new RequisitionRepository(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    OPEN_FOR_ALL as never,
  ) as unknown as WithEnrich;
}

const TENANT = '00000000-0000-0000-0000-000000000000';

describe('L1-C proof 8 — DISPLAY override is submittals_closed-ONLY', () => {
  it('a submittals_closed req shows client_submittal_status:closed while an otherwise-identical open req shows open (same eligibility posture)', async () => {
    const closedReq = view('11111111-1111-1111-1111-111111111111', 'submittals_closed');
    const openReq = view('22222222-2222-2222-2222-222222222222', 'open');

    const [closed, open] = await repo().enrichClientStatus(TENANT, [closedReq, openReq]);

    // Same eligibility posture (the stub derives 'open' for BOTH), yet the
    // submittals_closed req is forced 'closed' and the open req stays 'open'.
    expect(closed?.client_submittal_status).toBe('closed');
    expect(open?.client_submittal_status).toBe('open');
  });

  it('draft and on_hold reqs leave client_submittal_status eligibility-derived (NOT forced closed)', async () => {
    const draftReq = view('33333333-3333-3333-3333-333333333333', 'draft');
    const onHoldReq = view('44444444-4444-4444-4444-444444444444', 'on_hold');

    const [draft, onHold] = await repo().enrichClientStatus(TENANT, [draftReq, onHoldReq]);

    // Neither is submittals_closed, so both keep the eligibility-derived 'open'
    // — the override never fires for any non-submittals_closed status.
    expect(draft?.client_submittal_status).toBe('open');
    expect(onHold?.client_submittal_status).toBe('open');
  });
});
