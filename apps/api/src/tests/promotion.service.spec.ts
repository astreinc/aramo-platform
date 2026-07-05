import { describe, expect, it, vi } from 'vitest';

import { PromotionService } from '../talent-identity/promotion.service.js';
import {
  PROMOTION_LINK_SOURCE,
  PROMOTION_SYSTEM_ACTOR_ID,
} from '../talent-identity/promotion.constants.js';

// Unit coverage for the Promotion Gate create branch. The four collaborators
// (talent_trust / talent_record / consent / ingestion) are stubbed — each is
// integration-tested in its own lib; here we prove the ORCHESTRATION: the five
// outcomes, the evidence→field mapping, system-actor attribution, and the
// create→link→consent ordering.

const TENANT = '11111111-1111-7111-8111-111111111111';
const PAYLOAD_ID = 'pppppppp-pppp-7ppp-8ppp-ppppppppp01'.replace(/p/g, 'a');
const SUBJECT_ID = 'ssssssss-ssss-7sss-8sss-sssssssss01'.replace(/s/g, 'b');
const RECORD_ID = 'rrrrrrrr-rrrr-7rrr-8rrr-rrrrrrrrr01'.replace(/r/g, 'c');

const sourcedRef = {
  tenant_id: TENANT,
  ref_type: 'SOURCED_TALENT' as const,
  ref_id: PAYLOAD_ID,
};

function ev(assertion_type: string, assertion_payload: unknown, current_status = 'VALID') {
  return { id: `ev-${assertion_type}`, assertion_type, assertion_payload, current_status, dimension: 'IDENTITY' };
}

function makeService(over: {
  subject?: unknown;
  refs?: Array<{ ref_type: string; ref_id: string; link_source: string }>;
  evidence?: unknown[];
  arrival?: unknown;
  trustState?: unknown;
} = {}) {
  const resolveSubjectRef = vi
    .fn()
    .mockResolvedValue(over.subject === undefined ? { id: SUBJECT_ID, tenant_id: TENANT } : over.subject);
  const listSubjectRefs = vi.fn().mockResolvedValue(over.refs ?? [
    { ref_type: 'SOURCED_TALENT', ref_id: PAYLOAD_ID, link_source: 'canonicalization' },
  ]);
  const getEvidence = vi.fn().mockResolvedValue(over.evidence ?? []);
  const attachSubjectRef = vi.fn().mockResolvedValue(undefined);
  const getTrustState = vi.fn().mockResolvedValue(over.trustState ?? { identity_band: 'SELF_ASSERTED' });
  const trust = { resolveSubjectRef, listSubjectRefs, getEvidence, attachSubjectRef, getTrustState } as never;

  const create = vi.fn().mockResolvedValue({ id: RECORD_ID });
  const talentRecords = { create } as never;

  // Slice-B2 — the create-path provenance writer.
  const upsertFieldProvenance = vi.fn().mockResolvedValue(undefined);
  const reconcileRepo = { upsertFieldProvenance } as never;

  const registerSourceDerivedConsent = vi.fn().mockResolvedValue(undefined);
  const sourceConsent = { registerSourceDerivedConsent } as never;

  const findById = vi
    .fn()
    .mockResolvedValue(
      over.arrival === undefined
        ? { id: PAYLOAD_ID, source: 'indeed', captured_at: new Date('2026-07-04T00:00:00.000Z') }
        : over.arrival,
    );
  const ingestion = { findById } as never;

  const service = new PromotionService(trust, talentRecords, reconcileRepo, sourceConsent, ingestion);
  return { service, resolveSubjectRef, listSubjectRefs, getEvidence, attachSubjectRef, getTrustState, create, upsertFieldProvenance, registerSourceDerivedConsent, findById };
}

describe('PromotionService.promoteSubject — create branch', () => {
  it('promotes: maps FULL_NAME + contact → named record (system actor), links, reconciles consent, attaches advisory', async () => {
    const { service, create, attachSubjectRef, registerSourceDerivedConsent, upsertFieldProvenance } = makeService({
      evidence: [
        ev('FULL_NAME', { first_name: 'Alan', last_name: 'Turing' }),
        ev('EMAIL', { normalized_value: 'alan@example.com' }),
        ev('PHONE', { value: '+15551234567' }),
        ev('ADDRESS', { address: '1 Bletchley', city: 'MK', state: 'BK', zip: 'MK3' }),
      ],
    });

    const result = await service.promoteSubject(sourcedRef);

    expect(result).toEqual({ status: 'promoted', talent_record_id: RECORD_ID, trust_state: { identity_band: 'SELF_ASSERTED' } });
    // create: system actor + mapped PII + source.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT,
        entered_by_id: PROMOTION_SYSTEM_ACTOR_ID,
        input: expect.objectContaining({
          first_name: 'Alan',
          last_name: 'Turing',
          email1: 'alan@example.com',
          phone_cell: '+15551234567',
          address: '1 Bletchley',
          city: 'MK',
          state: 'BK',
          zip: 'MK3',
          source: 'indeed',
        }),
      }),
    );
    // link: ATS_TALENT_RECORD ref → new record, promotion link_source.
    expect(attachSubjectRef).toHaveBeenCalledWith({
      tenant_id: TENANT,
      subject_id: SUBJECT_ID,
      ref_type: 'ATS_TALENT_RECORD',
      ref_id: RECORD_ID,
      link_source: PROMOTION_LINK_SOURCE,
    });
    // consent: keyed to the new record, arrival source + captured_at.
    expect(registerSourceDerivedConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT,
        talent_record_id: RECORD_ID,
        source: 'indeed',
        occurred_at: '2026-07-04T00:00:00.000Z',
      }),
    );
    // Slice-B2 create-path provenance: each set field → its source EvidenceRecord.id
    // (the back-fill invariant so B2's incumbent join always resolves).
    const provWrites = upsertFieldProvenance.mock.calls.map((c) => ({
      field_name: c[0].field_name,
      evidence_id: c[0].evidence_id,
      talent_record_id: c[0].talent_record_id,
    }));
    expect(provWrites).toEqual(
      expect.arrayContaining([
        { field_name: 'first_name', evidence_id: 'ev-FULL_NAME', talent_record_id: RECORD_ID },
        { field_name: 'last_name', evidence_id: 'ev-FULL_NAME', talent_record_id: RECORD_ID },
        { field_name: 'email1', evidence_id: 'ev-EMAIL', talent_record_id: RECORD_ID },
        { field_name: 'phone_cell', evidence_id: 'ev-PHONE', talent_record_id: RECORD_ID },
        { field_name: 'address', evidence_id: 'ev-ADDRESS', talent_record_id: RECORD_ID },
        { field_name: 'city', evidence_id: 'ev-ADDRESS', talent_record_id: RECORD_ID },
      ]),
    );
  });

  it('already_promoted: subject already carrying an ATS_TALENT_RECORD ref → no-op returns the existing record, no create', async () => {
    const { service, create, attachSubjectRef } = makeService({
      refs: [
        { ref_type: 'SOURCED_TALENT', ref_id: PAYLOAD_ID, link_source: 'canonicalization' },
        { ref_type: 'ATS_TALENT_RECORD', ref_id: RECORD_ID, link_source: 'manual' },
      ],
    });
    const result = await service.promoteSubject(sourcedRef);
    expect(result).toEqual({ status: 'already_promoted', talent_record_id: RECORD_ID });
    expect(create).not.toHaveBeenCalled();
    expect(attachSubjectRef).not.toHaveBeenCalled();
  });

  it('deferred_no_name: no FULL_NAME evidence → defer, no record created', async () => {
    const { service, create } = makeService({ evidence: [ev('EMAIL', { normalized_value: 'x@y.com' })] });
    const result = await service.promoteSubject(sourcedRef);
    expect(result).toEqual({ status: 'deferred_no_name' });
    expect(create).not.toHaveBeenCalled();
  });

  it('deferred_no_name: PARTIAL name (first only) is not promotable → defer, no half-named record', async () => {
    const { service, create } = makeService({ evidence: [ev('FULL_NAME', { first_name: 'Alan' })] });
    const result = await service.promoteSubject(sourcedRef);
    expect(result).toEqual({ status: 'deferred_no_name' });
    expect(create).not.toHaveBeenCalled();
  });

  it('deferred_no_name: SUPERSEDED name evidence is not live → defer', async () => {
    const { service } = makeService({
      evidence: [ev('FULL_NAME', { first_name: 'Alan', last_name: 'Turing' }, 'SUPERSEDED')],
    });
    expect(await service.promoteSubject(sourcedRef)).toEqual({ status: 'deferred_no_name' });
  });

  it('deferred_no_basis: no SOURCED_TALENT ref → cannot reconcile basis, defer (no orphan record)', async () => {
    const { service, create } = makeService({
      refs: [],
      evidence: [ev('FULL_NAME', { first_name: 'Alan', last_name: 'Turing' })],
    });
    const result = await service.promoteSubject(sourcedRef);
    expect(result).toEqual({ status: 'deferred_no_basis' });
    expect(create).not.toHaveBeenCalled();
  });

  it('deferred_no_basis: arrival source not a consent source type → defer', async () => {
    const { service, create } = makeService({
      evidence: [ev('FULL_NAME', { first_name: 'Alan', last_name: 'Turing' })],
      arrival: { id: PAYLOAD_ID, source: 'mystery_source', captured_at: new Date('2026-07-04T00:00:00.000Z') },
    });
    const result = await service.promoteSubject(sourcedRef);
    expect(result).toEqual({ status: 'deferred_no_basis' });
    expect(create).not.toHaveBeenCalled();
  });

  it('deferred_unknown_subject: subjectRef resolves to nothing → defer, no create', async () => {
    const { service, create } = makeService({ subject: null });
    const result = await service.promoteSubject(sourcedRef);
    expect(result).toEqual({ status: 'deferred_unknown_subject' });
    expect(create).not.toHaveBeenCalled();
  });
});
