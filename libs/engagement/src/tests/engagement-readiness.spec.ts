import { describe, expect, it } from 'vitest';

import {
  evaluateEngagementReadiness,
  meetsStrength,
  type EngagementEvidenceFact,
  type EngagementRequirement,
} from '../index.js';

// COMM-C3 — pure readiness evaluator proofs (R6/R9; directive §9 2-6).

const voiceReq = (min: 'RECRUITER_ATTESTED' | 'PROVIDER_VERIFIED'): EngagementRequirement => ({
  channel: 'voice',
  required: true,
  condition: 'two_way_conversation',
  minimum_strength: min,
});

const voiceFact = (
  two_way: boolean,
  strength: 'RECRUITER_ATTESTED' | 'PROVIDER_VERIFIED' | null,
): EngagementEvidenceFact => ({
  channel: 'voice',
  availability: 'available',
  two_way_conversation: two_way,
  evidence_strength: strength,
});

describe('meetsStrength', () => {
  it('orders RECRUITER_ATTESTED < PROVIDER_VERIFIED deterministically', () => {
    expect(meetsStrength('RECRUITER_ATTESTED', 'RECRUITER_ATTESTED')).toBe(true);
    expect(meetsStrength('PROVIDER_VERIFIED', 'RECRUITER_ATTESTED')).toBe(true);
    expect(meetsStrength('RECRUITER_ATTESTED', 'PROVIDER_VERIFIED')).toBe(false);
    expect(meetsStrength(null, 'RECRUITER_ATTESTED')).toBe(false);
  });
});

describe('evaluateEngagementReadiness', () => {
  it('voice-required / no two-way → blocked (missing)', () => {
    const r = evaluateEngagementReadiness({ requirements: [voiceReq('RECRUITER_ATTESTED')] }, [
      voiceFact(false, null),
    ]);
    expect(r.satisfied).toBe(false);
    expect(r.missing).toEqual(['voice']);
    expect(r.results[0]?.status).toBe('missing');
    expect(r.unavailable).toBe(false);
  });

  it('voice-required recruiter-attested + policy allows it → satisfied', () => {
    const r = evaluateEngagementReadiness({ requirements: [voiceReq('RECRUITER_ATTESTED')] }, [
      voiceFact(true, 'RECRUITER_ATTESTED'),
    ]);
    expect(r.satisfied).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('policy requires PROVIDER_VERIFIED but only RECRUITER_ATTESTED → blocked (insufficient)', () => {
    const r = evaluateEngagementReadiness({ requirements: [voiceReq('PROVIDER_VERIFIED')] }, [
      voiceFact(true, 'RECRUITER_ATTESTED'),
    ]);
    expect(r.satisfied).toBe(false);
    expect(r.results[0]?.status).toBe('insufficient_strength');
  });

  it('provider-verified evidence → satisfied', () => {
    const r = evaluateEngagementReadiness({ requirements: [voiceReq('PROVIDER_VERIFIED')] }, [
      voiceFact(true, 'PROVIDER_VERIFIED'),
    ]);
    expect(r.satisfied).toBe(true);
  });

  it('evidence read error → fail-closed with DISTINCT unavailable status (R9)', () => {
    const r = evaluateEngagementReadiness({ requirements: [voiceReq('RECRUITER_ATTESTED')] }, [
      { channel: 'voice', availability: 'read_error' },
    ]);
    expect(r.satisfied).toBe(false);
    expect(r.unavailable).toBe(true);
    expect(r.results[0]?.status).toBe('unavailable');
  });

  it('a not-required requirement never blocks', () => {
    const r = evaluateEngagementReadiness(
      { requirements: [{ channel: 'email', required: false, condition: 'recorded_evidence' }] },
      [{ channel: 'email', availability: 'no_producer' }],
    );
    expect(r.satisfied).toBe(true);
    expect(r.results[0]?.status).toBe('not_required');
  });

  it('email required with no producer → blocked (no_producer); publish guard prevents this reaching an active policy', () => {
    const r = evaluateEngagementReadiness(
      { requirements: [{ channel: 'email', required: true, condition: 'recorded_evidence' }] },
      [{ channel: 'email', availability: 'no_producer' }],
    );
    expect(r.satisfied).toBe(false);
    expect(r.results[0]?.status).toBe('no_producer');
  });
});
