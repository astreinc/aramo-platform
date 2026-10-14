import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';

import { TalentTrustService } from '../lib/talent-trust.service.js';
import {
  StaleEvidenceTransitionError,
  type EvidenceRecordRow,
  type TalentTrustRepository,
} from '../lib/talent-trust.repository.js';

// Security S1a (directive §3 R1–R4, §3 R3 C4–C7) — unit proofs of the
// tenant-bound lifecycle guard on a mocked repository. The real-Postgres T1–T12
// matrix lives in apps/api/src/tests/security-s1a-trust-tenant-isolation.integration.spec.ts.

const ACTING = '01900000-0000-7000-8000-00000000a001';
const OTHER = '01900000-0000-7000-8000-00000000b002';
const EV = '01900000-0000-7000-8000-00000000e001';
const SUBJ = '01900000-0000-7000-8000-00000000c001';

function row(status: string, tenant = ACTING): EvidenceRecordRow {
  return { id: EV, tenant_id: tenant, subject_id: SUBJ, current_status: status } as unknown as EvidenceRecordRow;
}

function build(over: Partial<Record<keyof TalentTrustRepository, unknown>> = {}) {
  const repo = {
    findEvidenceById: vi.fn(async () => row('VALID', OTHER)),
    findEvidenceByIdForTenant: vi.fn(async () => null),
    applyTenantBoundTransition: vi.fn(async () => true),
    appendResolvedThenRevoked: vi.fn(async () => undefined),
    clusterMembers: vi.fn(async () => [SUBJ]),
    listEvidenceBySubjects: vi.fn(async () => []),
    upsertTrustState: vi.fn(async () => ({})),
    advancePortalWorkItemStatus: vi.fn(async () => undefined),
    findTenantWorkItemsForDispute: vi.fn(async () => []),
    findAllWorkItemsForDispute: vi.fn(async () => []),
    findAnchorById: vi.fn(async () => null),
    findVerificationRequestById: vi.fn(async () => null),
    findSubjectAnchor: vi.fn(async () => null),
    findPortalDisputeInCluster: vi.fn(async () => null),
    ...over,
  } as unknown as TalentTrustRepository;
  const svc = new TalentTrustService(repo, {} as never);
  return { repo, svc };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return e instanceof AramoError ? e.code : `non-aramo:${(e as Error).name}`;
  }
  return 'no-throw';
};

describe('Security S1a — tenant-bound evidence lifecycle (unit)', () => {
  it('a foreign or missing evidence id is NOT_FOUND for all three operations, with no write and no recompute', async () => {
    const { repo, svc } = build();
    expect(await codeOf(svc.dispute(ACTING, EV, 'u', 'g', 'r'))).toBe('NOT_FOUND');
    expect(await codeOf(svc.resolveDispute(ACTING, EV, 'u', 'upheld', 'j', 'r'))).toBe('NOT_FOUND');
    expect(await codeOf(svc.resolveContradiction(ACTING, EV, 'u', 'x', 'r'))).toBe('NOT_FOUND');
    // The bound read is keyed by the ACTING tenant; the id-only read is never used.
    expect(repo.findEvidenceByIdForTenant).toHaveBeenCalledWith(ACTING, EV);
    expect(repo.findEvidenceById).not.toHaveBeenCalled();
    expect(repo.applyTenantBoundTransition).not.toHaveBeenCalled();
    expect(repo.appendResolvedThenRevoked).not.toHaveBeenCalled();
    expect(repo.upsertTrustState).not.toHaveBeenCalled();
  });

  it('the NOT_FOUND refusal carries no status and no evidence id', async () => {
    const { svc } = build();
    try {
      await svc.dispute(ACTING, EV, 'u', 'g', 'r');
      throw new Error('expected refusal');
    } catch (e) {
      const err = e as AramoError;
      expect(err.code).toBe('NOT_FOUND');
      expect(err.statusCode).toBe(404);
      expect(JSON.stringify({ m: err.message, d: err.context?.details ?? null })).not.toMatch(
        /VALID|DISPUTED|CONTRADICTED|REVOKED|SUPERSEDED|STALE|current_status|01900000-0000-7000-8000-00000000e001/,
      );
    }
  });

  it('dispute writes with the ACTING tenant and the VALID expected status', async () => {
    const { repo, svc } = build({ findEvidenceByIdForTenant: vi.fn(async () => row('VALID')) });
    await expect(svc.dispute(ACTING, EV, 'u', 'g', 'r')).resolves.toEqual({ status: 'DISPUTED' });
    expect(repo.applyTenantBoundTransition).toHaveBeenCalledWith(
      expect.objectContaining({ evidence_id: EV, tenant_id: ACTING, expected_status: 'VALID', next_status: 'DISPUTED', event_type: 'DISPUTED' }),
    );
    expect(repo.upsertTrustState).toHaveBeenCalledTimes(1);
  });

  it('a lost race (no row matched) re-reads and classifies without re-writing', async () => {
    const reads = [row('VALID'), row('DISPUTED')];
    const { repo, svc } = build({
      findEvidenceByIdForTenant: vi.fn(async () => reads.shift() ?? null),
      applyTenantBoundTransition: vi.fn(async () => false),
    });
    await expect(svc.dispute(ACTING, EV, 'u', 'g', 'r')).resolves.toEqual({ status: 'DISPUTED' });
    expect(repo.applyTenantBoundTransition).toHaveBeenCalledTimes(1);
    expect(repo.upsertTrustState).not.toHaveBeenCalled();
  });

  it('upheld: a stale transition is classified as EVIDENCE_NOT_DISPUTED; any other error propagates', async () => {
    const reads = [row('DISPUTED'), row('REVOKED')];
    const stale = build({
      findEvidenceByIdForTenant: vi.fn(async () => reads.shift() ?? null),
      appendResolvedThenRevoked: vi.fn(async () => {
        throw new StaleEvidenceTransitionError(EV);
      }),
    });
    expect(await codeOf(stale.svc.resolveDispute(ACTING, EV, 'u', 'upheld', 'j', 'r'))).toBe('EVIDENCE_NOT_DISPUTED');
    expect(stale.repo.appendResolvedThenRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ evidence_id: EV, tenant_id: ACTING }),
    );
    expect(stale.repo.upsertTrustState).not.toHaveBeenCalled();

    const boom = build({
      findEvidenceByIdForTenant: vi.fn(async () => row('DISPUTED')),
      appendResolvedThenRevoked: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    expect(await codeOf(boom.svc.resolveDispute(ACTING, EV, 'u', 'upheld', 'j', 'r'))).toBe('non-aramo:Error');
  });

  it('C7 — a VERIFICATION work item whose request belongs to another tenant is not resolvable (no dispute fired)', async () => {
    const wi = { id: 'wi-1', tenant_id: ACTING, subject_id: SUBJ, item_type: 'VERIFICATION', underlying_ref_id: 'vr-1', status: 'OPEN' };
    const { repo, svc } = build({
      findTenantWorkItemsForDispute: vi.fn(async () => [wi]),
      findVerificationRequestById: vi.fn(async () => ({ id: 'vr-1', tenant_id: OTHER, subject_id: SUBJ, anchor_kind: 'EMAIL', normalized_value: 'x' })),
    });
    // rollupParentDispute is not under test — stub it.
    (svc as unknown as { rollupParentDispute: () => Promise<unknown> }).rollupParentDispute = vi.fn(async () => ({}));
    await svc.triagePortalDispute({ tenantId: ACTING, disputeId: 'd-1', actor: 'u', requestId: 'r' });
    expect(repo.findSubjectAnchor).not.toHaveBeenCalled();
    expect(repo.findEvidenceByIdForTenant).not.toHaveBeenCalled();
    expect(repo.advancePortalWorkItemStatus).toHaveBeenCalledWith('wi-1', 'RESOLVED_NO_TRANSITION', 'backing evidence not resolvable');
  });

  it('C4/C5 — triage and disposition act only on items of the authorized tenant, passing that tenant', async () => {
    const mine = { id: 'wi-a', tenant_id: ACTING, subject_id: SUBJ, item_type: 'ANCHOR', underlying_ref_id: 'an-a', status: 'OPEN' };
    const foreign = { ...mine, id: 'wi-b', tenant_id: OTHER, underlying_ref_id: 'an-b' };
    const { repo, svc } = build({
      findTenantWorkItemsForDispute: vi.fn(async () => [mine, foreign]),
      findAnchorById: vi.fn(async (_t: string, id: string) => ({ source_evidence_id: id === 'an-a' ? EV : 'ev-b' })),
      findEvidenceByIdForTenant: vi.fn(async () => row('VALID')),
    });
    (svc as unknown as { rollupParentDispute: () => Promise<unknown> }).rollupParentDispute = vi.fn(async () => ({}));
    await svc.triagePortalDispute({ tenantId: ACTING, disputeId: 'd-1', actor: 'u', requestId: 'r' });
    expect(repo.findAnchorById).toHaveBeenCalledTimes(1);
    expect(repo.findEvidenceByIdForTenant).toHaveBeenCalledWith(ACTING, EV);
    expect(repo.advancePortalWorkItemStatus).toHaveBeenCalledWith('wi-a', 'UNDER_REVIEW');
    expect(repo.advancePortalWorkItemStatus).not.toHaveBeenCalledWith('wi-b', expect.anything());
  });

  it('C6 — withdrawal acts on each work item under that item’s own tenant', async () => {
    const a = { id: 'wi-a', tenant_id: ACTING, subject_id: SUBJ, item_type: 'ANCHOR', underlying_ref_id: 'an-a', status: 'UNDER_REVIEW' };
    const b = { ...a, id: 'wi-b', tenant_id: OTHER, underlying_ref_id: 'an-b' };
    const { repo, svc } = build({
      findPortalDisputeInCluster: vi.fn(async () => ({ id: 'd-1', status: 'UNDER_REVIEW' })),
      findAllWorkItemsForDispute: vi.fn(async () => [a, b]),
      findAnchorById: vi.fn(async (_t: string, id: string) => ({ source_evidence_id: id })),
      findEvidenceByIdForTenant: vi.fn(async () => null),
      withdrawPortalDispute: vi.fn(async () => ({ id: 'd-1' })),
    } as never);
    await svc.withdrawPortalDispute({ clusterId: 'c', disputeId: 'd-1', actor: 'portal', now: new Date(), requestId: 'r' });
    expect(repo.findEvidenceByIdForTenant).toHaveBeenCalledWith(ACTING, 'an-a');
    expect(repo.findEvidenceByIdForTenant).toHaveBeenCalledWith(OTHER, 'an-b');
  });
});
