import { describe, expect, it } from 'vitest';

import { computeProjection, generateProposals, identifierDigest, type ProjectionAssertion, type ProjectionIdentifier } from '../index.js';

// ATI-SEP-1 T10 M-2 / M-3 — the PURE parts: the proposal rules (ported from the
// legacy generator) and the projection honouring RECONCILES pairs.

const NOW = new Date('2026-10-23T00:00:00.000Z');
const OPTS = { now: NOW, availabilityFreshnessDays: 90 };

function a(id: string, over: Partial<ProjectionAssertion> = {}): ProjectionAssertion {
  return {
    id,
    assertion_type: 'TITLE',
    payload: { value: 'Engineer' },
    source_reference_id: 'ref-1',
    source_system_id: 'ARAMO_ATS',
    source_tenant_id: 't1',
    source_kind: 'RECRUITER',
    verification_status: 'DECLARED',
    observed_at: new Date('2026-10-01T00:00:00.000Z'),
    valid_from: null,
    valid_to: null,
    current_status: 'VALID',
    ai_derived: false,
    ...over,
  };
}

const email: ProjectionIdentifier = {
  id: 'i-1',
  identifier_type: 'EMAIL',
  normalized_value: 'p@x.io',
  verification_status: 'UNVERIFIED',
  is_primary: true,
  status: 'ACTIVE',
  source_reference_id: 'ref-1',
};

function run(assertions: ProjectionAssertion[], identifiers: ProjectionIdentifier[], reconciled?: Set<string>) {
  const projection = computeProjection(assertions, identifiers, { ...OPTS, ...(reconciled ? { reconciled } : {}) });
  return { projection, proposals: generateProposals({ assertions, identifiers, projection }, NOW) };
}

describe('generateProposals', () => {
  it('silent when nothing triggers (two independent sources, no contradiction)', () => {
    const { proposals } = run([a('x1'), a('x2', { source_tenant_id: 't2', source_reference_id: 'ref-2' })], [email]);
    expect(proposals).toEqual([]);
  });

  it('VERIFY_CONTACT for a never-verified contact of a single-source subject (digest only, never the value)', () => {
    const { proposals } = run([a('x1')], [email]);
    expect(proposals).toEqual([
      {
        kind: 'VERIFY_CONTACT',
        trigger_kind: 'SINGLE_SOURCE_ONLY',
        basis_ref: `identifier:${identifierDigest('EMAIL', 'p@x.io')}`,
        assertion_id: null,
        identifier_type: 'EMAIL',
        identifier_digest: identifierDigest('EMAIL', 'p@x.io'),
        basis_snapshot: { identifier_type: 'EMAIL' },
      },
    ]);
  });

  it('RESOLVE_CONTRADICTION per contradicted assertion; RENEW_VERIFICATION for a TI verification older than 365 days', () => {
    const old = a('v1', {
      assertion_type: 'VERIFICATION_OUTCOME',
      payload: { target: 'EMAIL', identifier_digest: identifierDigest('EMAIL', 'p@x.io') },
      source_kind: 'VERIFICATION',
      source_system_id: 'TALENT_INTELLIGENCE',
      source_tenant_id: null,
      source_reference_id: null,
      verification_status: 'VERIFIED',
      observed_at: new Date('2025-01-01T00:00:00.000Z'),
    });
    const { proposals } = run([a('x1'), a('x2', { payload: { value: 'Manager' }, source_reference_id: 'ref-2', source_tenant_id: 't2' }), old], [email]);
    expect(proposals.map((p) => [p.kind, p.trigger_kind, p.basis_ref])).toEqual([
      ['RESOLVE_CONTRADICTION', 'OPEN_CONTRADICTION', 'assertion:x1'],
      ['RESOLVE_CONTRADICTION', 'OPEN_CONTRADICTION', 'assertion:x2'],
      ['RENEW_VERIFICATION', 'VERIFICATION_STALE', `identifier:${identifierDigest('EMAIL', 'p@x.io')}`],
    ]);
  });
});

describe('computeProjection — RECONCILES pairs (contradiction resolution)', () => {
  const pair = [a('x1'), a('x2', { payload: { value: 'Manager' }, source_reference_id: 'ref-2', observed_at: new Date('2026-10-05T00:00:00.000Z') })];

  it('an un-reconciled pair is contradicted, with each other as partners', () => {
    const { projection } = run(pair, []);
    expect([projection.effective_status.get('x1'), projection.effective_status.get('x2')]).toEqual(['CONTRADICTED', 'CONTRADICTED']);
    expect(projection.contradiction_partners.get('x1')).toEqual(['x2']);
    expect(projection.trust.open_contradiction_count).toBe(2);
  });

  it('a reconciled pair is never paired again', () => {
    const { projection } = run(pair, [], new Set(['x1|x2', 'x2|x1']));
    expect([projection.effective_status.get('x1'), projection.effective_status.get('x2')]).toEqual(['VALID', 'VALID']);
    expect(projection.contradictions).toEqual([]);
    expect(projection.trust.open_contradiction_count).toBe(0);
  });

  it('a DISPUTED assertion keeps its stored status in the view (has_open_dispute)', () => {
    const { projection } = run([a('x1', { current_status: 'DISPUTED' })], []);
    expect(projection.effective_status.get('x1')).toBe('DISPUTED');
    expect(projection.trust.has_open_dispute).toBe(true);
  });
});
