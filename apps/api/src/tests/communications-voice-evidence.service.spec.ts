import { describe, expect, it, vi } from 'vitest';

import { CommunicationsApiService } from '../communications/communications-api.service.js';

// COMM-C2A — fast unit proofs for the derived voice-evidence projection (R3/R4).
// The intersection repo read is mocked; we assert the provider-neutral derivation:
// attempt vs two-way, and the evidence-strength grading (provider outranks
// recruiter; qualifying vs non-qualifying dispositions).

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const TALENT = '00000000-0000-7000-8000-0000000000t1';
const REQ = '00000000-0000-7000-8000-0000000000r1';

function serviceWith(rows: unknown[]) {
  const repo = {
    findVoiceEvidenceInteractions: vi.fn(async () => rows),
  } as unknown as ConstructorParameters<typeof CommunicationsApiService>[0];
  const providers = {} as unknown as ConstructorParameters<typeof CommunicationsApiService>[1];
  const connections = {} as unknown as ConstructorParameters<typeof CommunicationsApiService>[2];
  return new CommunicationsApiService(repo, providers, connections);
}

function row(status: string, dispositions: Array<{ disposition: string; at: string }>, createdAt: string) {
  return {
    id: `int-${createdAt}`,
    status,
    created_at: new Date(createdAt),
    dispositions: dispositions.map((d) => ({ disposition: d.disposition, dispositioned_at: new Date(d.at) })),
  };
}

describe('CommunicationsApiService.getVoiceEvidence — COMM-C2A derivation', () => {
  it('no interactions → not attempted, no two-way, null strength (new talent)', async () => {
    const svc = serviceWith([]);
    const e = await svc.getVoiceEvidence(TENANT, TALENT, REQ);
    expect(e).toMatchObject({
      talent_id: TALENT,
      requisition_id: REQ,
      attempted: false,
      two_way_conversation: false,
      evidence_strength: null,
      latest_interaction_id: null,
      latest_outcome: null,
      latest_at: null,
    });
  });

  it('no_answer counts as an ATTEMPT, not a two-way conversation', async () => {
    const svc = serviceWith([
      row('initiated', [{ disposition: 'no_answer', at: '2026-09-04T00:00:01Z' }], '2026-09-04T00:00:00Z'),
    ]);
    const e = await svc.getVoiceEvidence(TENANT, TALENT, REQ);
    expect(e.attempted).toBe(true);
    expect(e.two_way_conversation).toBe(false);
    expect(e.evidence_strength).toBeNull();
    expect(e.latest_outcome).toBe('no_answer');
  });

  it('a recruiter-attested "connected" disposition is a two-way conversation (RECRUITER_ATTESTED)', async () => {
    const svc = serviceWith([
      row('initiated', [{ disposition: 'connected', at: '2026-09-04T00:00:01Z' }], '2026-09-04T00:00:00Z'),
    ]);
    const e = await svc.getVoiceEvidence(TENANT, TALENT, REQ);
    expect(e.two_way_conversation).toBe(true);
    expect(e.evidence_strength).toBe('RECRUITER_ATTESTED');
  });

  it('a provider-connected interaction status grades PROVIDER_VERIFIED (outranks recruiter)', async () => {
    const svc = serviceWith([
      row('completed', [{ disposition: 'connected', at: '2026-09-04T00:00:01Z' }], '2026-09-04T00:00:00Z'),
    ]);
    const e = await svc.getVoiceEvidence(TENANT, TALENT, REQ);
    expect(e.two_way_conversation).toBe(true);
    expect(e.evidence_strength).toBe('PROVIDER_VERIFIED');
  });

  it('interested / callback_requested / follow_up_required each count as two-way', async () => {
    for (const d of ['interested', 'callback_requested', 'follow_up_required']) {
      const svc = serviceWith([row('initiated', [{ disposition: d, at: '2026-09-04T00:00:01Z' }], '2026-09-04T00:00:00Z')]);
      const e = await svc.getVoiceEvidence(TENANT, TALENT, REQ);
      expect(e.two_way_conversation, d).toBe(true);
      expect(e.evidence_strength, d).toBe('RECRUITER_ATTESTED');
    }
  });

  it('not_interested and do_not_contact are NOT positive qualifying two-way evidence', async () => {
    for (const d of ['not_interested', 'do_not_contact']) {
      const svc = serviceWith([row('initiated', [{ disposition: d, at: '2026-09-04T00:00:01Z' }], '2026-09-04T00:00:00Z')]);
      const e = await svc.getVoiceEvidence(TENANT, TALENT, REQ);
      expect(e.attempted, d).toBe(true);
      expect(e.two_way_conversation, d).toBe(false);
      expect(e.evidence_strength, d).toBeNull();
    }
  });

  it('left_voicemail / busy / wrong_number are attempts only', async () => {
    for (const d of ['left_voicemail', 'busy', 'wrong_number']) {
      const svc = serviceWith([row('failed', [{ disposition: d, at: '2026-09-04T00:00:01Z' }], '2026-09-04T00:00:00Z')]);
      const e = await svc.getVoiceEvidence(TENANT, TALENT, REQ);
      expect(e.two_way_conversation, d).toBe(false);
      expect(e.evidence_strength, d).toBeNull();
    }
  });

  it('latest_* reflects the most recent interaction/disposition', async () => {
    const svc = serviceWith([
      // rows arrive created_at DESC (newest first), matching the repo ordering.
      row('initiated', [{ disposition: 'callback_requested', at: '2026-09-04T02:00:01Z' }], '2026-09-04T02:00:00Z'),
      row('initiated', [{ disposition: 'no_answer', at: '2026-09-04T00:00:01Z' }], '2026-09-04T00:00:00Z'),
    ]);
    const e = await svc.getVoiceEvidence(TENANT, TALENT, REQ);
    expect(e.latest_interaction_id).toBe('int-2026-09-04T02:00:00Z');
    expect(e.latest_outcome).toBe('callback_requested');
    expect(e.latest_at).toBe('2026-09-04T02:00:01.000Z');
    expect(e.two_way_conversation).toBe(true); // the earlier row has callback_requested
  });
});
