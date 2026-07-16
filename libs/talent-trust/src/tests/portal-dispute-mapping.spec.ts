import { describe, expect, it, vi } from 'vitest';

import {
  PORTAL_DISPUTE_OUTCOME_MAP,
  PORTAL_DISPUTE_WITHDRAWAL_JUSTIFICATION,
  TalentTrustService,
} from '../lib/talent-trust.service.js';
import type { TalentTrustRepository } from '../lib/talent-trust.repository.js';

// Portal P3b — the MANDATORY §2 mapping tripwire (Amendment v1.1 §2 table +
// v1.2 wiring semantics). The talent-visible outcome → TR-15 disposition →
// item end-state, VERBATIM. The "upheld" INVERSION (talent-visible = the ITEM
// upheld; TR-15 = the DISPUTE upheld) is the hazard: if a future edit flips a
// sense, this spec goes red.

describe('§2 outcome-mapping table (verbatim tripwire)', () => {
  it('has exactly the three rows, each mapping to the pinned TR-15 disposition + end-state', () => {
    expect(PORTAL_DISPUTE_OUTCOME_MAP).toEqual({
      // The talent was right; the item was wrong → the DISPUTE is upheld → REVOKED.
      RESOLVED_CORRECTED: { tr15Outcome: 'upheld', itemEndState: 'REVOKED' },
      // The item stands; the dispute is rejected → DISPUTE_RESOLVED → VALID.
      RESOLVED_UPHELD: { tr15Outcome: 'rejected', itemEndState: 'VALID' },
      // The talent withdraws → treated as rejected → DISPUTE_RESOLVED → VALID.
      WITHDRAWN: { tr15Outcome: 'rejected', itemEndState: 'VALID' },
    });
  });

  it('the "upheld" inversion holds — RESOLVED_CORRECTED is NOT resolveDispute(rejected)', () => {
    // Talent CORRECTED ⇒ TR-15 'upheld' (the dispute is upheld → item removed).
    expect(PORTAL_DISPUTE_OUTCOME_MAP.RESOLVED_CORRECTED.tr15Outcome).toBe('upheld');
    // Talent UPHELD (item stands) ⇒ TR-15 'rejected' (the dispute is rejected).
    expect(PORTAL_DISPUTE_OUTCOME_MAP.RESOLVED_UPHELD.tr15Outcome).toBe('rejected');
    expect(PORTAL_DISPUTE_OUTCOME_MAP.RESOLVED_CORRECTED.tr15Outcome).not.toBe(
      PORTAL_DISPUTE_OUTCOME_MAP.RESOLVED_UPHELD.tr15Outcome,
    );
  });
});

// Behavioral: the disposition + withdraw fire resolveDispute with the mapped
// outcome (the const is wired, not just declared).
const TENANT = '11111111-1111-7111-8111-111111111111';
const DISPUTE = 'dddddddd-dddd-7ddd-8ddd-ddddddddddd1';
const EVIDENCE = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeee1';

function makeService(): {
  service: TalentTrustService;
  resolveSpy: ReturnType<typeof vi.fn>;
} {
  const workItem = {
    id: 'wwwwwwww-wwww-7www-8www-wwwwwwwwwww1',
    dispute_id: DISPUTE,
    tenant_id: TENANT,
    subject_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
    item_type: 'ANCHOR',
    underlying_ref_id: 'a0a0a0a0-a0a0-7a0a-8a0a-a0a0a0a0a0a0',
    status: 'UNDER_REVIEW',
    no_transition_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const repo = {
    findTenantWorkItemsForDispute: vi.fn(async () => [workItem]),
    // UNDER_REVIEW (DISPUTED) so withdraw fires resolveDispute; dispose asserts
    // the resolveDispute call (fired before rollup), so the non-terminal rollup here is fine.
    findAllWorkItemsForDispute: vi.fn(async () => [workItem]),
    findAnchorById: vi.fn(async () => ({ source_evidence_id: EVIDENCE })),
    advancePortalWorkItemStatus: vi.fn(async () => undefined),
    setPortalDisputeParentStatus: vi.fn(async () => ({ id: DISPUTE, status: 'RESOLVED_CORRECTED' })),
    findPortalDisputeInCluster: vi.fn(async () => ({ id: DISPUTE, status: 'UNDER_REVIEW' })),
    withdrawPortalDispute: vi.fn(async () => ({ id: DISPUTE, status: 'WITHDRAWN' })),
  } as unknown as TalentTrustRepository;
  const service = new TalentTrustService(repo, {} as never);
  // Stub the TR-15 primitive so no DB is needed; capture the args.
  const resolveSpy = vi.fn(async () => ({ status: 'REVOKED' as const }));
  vi.spyOn(service, 'resolveDispute').mockImplementation(resolveSpy as never);
  return { service, resolveSpy };
}

describe('disposition + withdraw wire to the mapped TR-15 outcome', () => {
  it('correct (RESOLVED_CORRECTED) → resolveDispute(evidence, actor, "upheld", note)', async () => {
    const { service, resolveSpy } = makeService();
    await service.disposePortalDispute({
      tenantId: TENANT, disputeId: DISPUTE, outcome: 'RESOLVED_CORRECTED',
      note: 'corrected', actor: 'reviewer', requestId: 'req-1',
    });
    expect(resolveSpy).toHaveBeenCalledWith(EVIDENCE, 'reviewer', 'upheld', 'corrected', 'req-1');
  });

  it('uphold (RESOLVED_UPHELD) → resolveDispute(evidence, actor, "rejected", note)', async () => {
    const { service, resolveSpy } = makeService();
    await service.disposePortalDispute({
      tenantId: TENANT, disputeId: DISPUTE, outcome: 'RESOLVED_UPHELD',
      note: 'stands', actor: 'reviewer', requestId: 'req-1',
    });
    expect(resolveSpy).toHaveBeenCalledWith(EVIDENCE, 'reviewer', 'rejected', 'stands', 'req-1');
  });

  it('withdraw of a DISPUTED item → resolveDispute("rejected") with the portal principal + withdrawal justification (Pin A)', async () => {
    const { service, resolveSpy } = makeService();
    await service.withdrawPortalDispute({
      clusterId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
      disputeId: DISPUTE, actor: 'portal-user-123', now: new Date(), requestId: 'req-1',
    });
    expect(resolveSpy).toHaveBeenCalledWith(
      EVIDENCE, 'portal-user-123', 'rejected', PORTAL_DISPUTE_WITHDRAWAL_JUSTIFICATION, 'req-1',
    );
  });
});
