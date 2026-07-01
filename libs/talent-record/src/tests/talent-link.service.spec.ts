import { describe, expect, it, vi } from 'vitest';

import { TalentLinkService } from '../lib/talent-link.service.js';

// TalentLinkService — ASSOCIATE-NOT-RESOLVE mechanism (the link path).
//
// This unit test PINS THE MECHANISM: the link path validates the caller-
// supplied cluster_id via findClusterById ONLY, and NEVER invokes a resolver
// or a mint (findClusterByFingerprint / findOrCreateClusterByFingerprint /
// createClusterWithFingerprint). Enumerating IdentityIndexRepository's shape
// cannot prove this (the repo legitimately CARRIES those resolve/mint methods
// for the canonicalization resolver — the I14-wall test asserts only that none
// is PII-keyed). The behavioral backstops (ats-batch4b: cluster_not_found
// reject; LINK-NOT-CREATE row-count bit-identical) prove the EFFECT; this spy
// proves the MECHANISM.

function makeIdentityIndexMock() {
  return {
    findClusterById: vi.fn().mockResolvedValue({ id: 'cl1' }),
    // The resolve/mint surface — must NEVER be touched by the link path.
    findClusterByFingerprint: vi.fn(),
    findOrCreateClusterByFingerprint: vi.fn(),
    createClusterWithFingerprint: vi.fn(),
  };
}

describe('TalentLinkService — ASSOCIATE-NOT-RESOLVE (link path mechanism)', () => {
  it('link validates via findClusterById ONLY — never a resolver or mint', async () => {
    const talentRecordRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'tr1' }),
      findLinkState: vi.fn().mockResolvedValue({ id: 'tr1', cluster_id: null }),
      setLink: vi.fn().mockResolvedValue({ id: 'tr1', cluster_id: 'cl1' }),
    };
    const identityIndex = makeIdentityIndexMock();

    const svc = new TalentLinkService(
      talentRecordRepo as never,
      identityIndex as never,
    );

    const out = await svc.link({
      tenant_id: 't1',
      talent_record_id: 'tr1',
      cluster_id: 'cl1',
      requestId: 'req1',
    });

    expect(out).toEqual({ talent_record_id: 'tr1', is_linked: true });

    // ASSOCIATE: the explicit id is validated via findClusterById.
    expect(identityIndex.findClusterById).toHaveBeenCalledTimes(1);
    expect(identityIndex.findClusterById).toHaveBeenCalledWith('cl1');

    // NOT-RESOLVE / NOT-MINT: no resolver or creator on the link path.
    expect(identityIndex.findClusterByFingerprint).not.toHaveBeenCalled();
    expect(identityIndex.findOrCreateClusterByFingerprint).not.toHaveBeenCalled();
    expect(identityIndex.createClusterWithFingerprint).not.toHaveBeenCalled();
  });

  it('getLink resolves link-state via findLinkState — no resolver/mint', async () => {
    const talentRecordRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'tr1' }),
      findLinkState: vi.fn().mockResolvedValue({ id: 'tr1', cluster_id: 'cl1' }),
    };
    const identityIndex = makeIdentityIndexMock();

    const svc = new TalentLinkService(
      talentRecordRepo as never,
      identityIndex as never,
    );

    const out = await svc.getLink({
      tenant_id: 't1',
      talent_record_id: 'tr1',
      requestId: 'req1',
    });

    expect(out).toEqual({ talent_record_id: 'tr1', is_linked: true });
    // A read of link-state touches NO identity_index resolver/mint at all.
    expect(identityIndex.findClusterById).not.toHaveBeenCalled();
    expect(identityIndex.findClusterByFingerprint).not.toHaveBeenCalled();
    expect(identityIndex.findOrCreateClusterByFingerprint).not.toHaveBeenCalled();
    expect(identityIndex.createClusterWithFingerprint).not.toHaveBeenCalled();
  });
});
