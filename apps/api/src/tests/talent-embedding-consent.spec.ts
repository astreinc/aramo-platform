import { describe, expect, it, vi } from 'vitest';
import type { ConsentService } from '@aramo/consent';

import { TalentEmbeddingConsentGate } from '../embedding/talent-embedding-consent.gate.js';

// GS-2 P4 — the ai_processing consent gate for the Talent embedding path is fail-closed, checks the
// INDEPENDENT `ai_processing` operation (never another operation), and distinguishes a stable
// revocation (`denied` → the worker invalidates) from an uncertain state (`error` → skip) and from a
// transient throw (propagates → the worker retries, never invalidates).

function make(check: (input: { operation: string }) => Promise<unknown>) {
  const checkOperationForService = vi.fn(check);
  const gate = new TalentEmbeddingConsentGate({ checkOperationForService } as unknown as ConsentService);
  return { gate, checkOperationForService };
}

const SUBJECT = { tenant_id: 't-1', talent_record_id: 'tr-1' };

describe('TalentEmbeddingConsentGate (GS-2 P4)', () => {
  it('allows only on an explicit allowed decision and carries the decision ref', async () => {
    const { gate, checkOperationForService } = make(async () => ({ result: 'allowed', decision_id: 'd-9' }));
    expect(await gate.evaluate(SUBJECT)).toEqual({ allowed: true, consent_decision_ref: 'd-9' });
    expect(checkOperationForService).toHaveBeenCalledWith({
      tenant_id: 't-1',
      talent_record_id: 'tr-1',
      operation: 'ai_processing',
    });
  });

  it('checks ai_processing — never recording/transcription or any inferred operation', async () => {
    const { gate, checkOperationForService } = make(async ({ operation }) => {
      if (operation !== 'ai_processing') throw new Error(`unexpected operation: ${operation}`);
      return { result: 'allowed', decision_id: 'd-1' };
    });
    await gate.evaluate(SUBJECT);
    expect(checkOperationForService).toHaveBeenCalledTimes(1);
    expect(checkOperationForService.mock.calls[0][0]).toMatchObject({ operation: 'ai_processing' });
  });

  it('fail-closed: a denied decision is not allowed, reason=denied (worker invalidates)', async () => {
    const { gate } = make(async () => ({ result: 'denied', decision_id: 'd-2', reason_code: 'stale_consent' }));
    expect(await gate.evaluate(SUBJECT)).toEqual({ allowed: false, reason: 'denied' });
  });

  it('fail-closed: an error decision is not allowed, reason=error (worker skips, does not invalidate)', async () => {
    const { gate } = make(async () => ({ result: 'error', decision_id: 'd-3', reason_code: 'consent_state_unknown' }));
    expect(await gate.evaluate(SUBJECT)).toEqual({ allowed: false, reason: 'error' });
  });

  it('propagates a thrown consent-authority error (transient) rather than masking it as revocation', async () => {
    const { gate } = make(async () => {
      throw new Error('consent service unavailable');
    });
    await expect(gate.evaluate(SUBJECT)).rejects.toThrow('consent service unavailable');
  });
});
