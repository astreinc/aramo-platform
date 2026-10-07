import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { ConsentService } from '../lib/consent.service.js';
import type { ConsentRepository } from '../lib/consent.repository.js';
import type { RecordConsentEventInput } from '../lib/consent.repository.js';
import {
  CONSENT_TEXT_CURRENT_VERSION,
  CONSENT_TEXT_RECRUITER_CAPTURE_VERSION,
  renderPortalConsentText,
  renderRecruiterCaptureConsentText,
} from '../lib/consent-texts.js';

// PO RULING "Consent Capture" — governance proofs for the captureProfileConsent
// seam. Pure service-level: a stub repository captures every recordConsentEvent
// call so we assert the orchestration WITHOUT a database. (Persistence +
// idempotent-replay are additionally proven at the integration layer.)

const TENANT = '019000a0-0000-7000-8000-000000000001';
const RECRUITER = '019000a0-0000-7000-8000-000000000002';
const TALENT = '448aa5b2-02ac-4e38-8bd2-ac0d1414a57a';
const OTHER_TENANT = '0190ffff-0000-7000-8000-00000000ffff';
const NOW = new Date('2026-10-06T12:00:00.000Z');

function recruiterAuth(tenant_id = TENANT): AuthContextType {
  return {
    sub: RECRUITER,
    tenant_id,
    consumer_type: 'recruiter',
  } as unknown as AuthContextType;
}

function makeService(): {
  service: ConsentService;
  calls: RecordConsentEventInput[];
} {
  const calls: RecordConsentEventInput[] = [];
  const repo = {
    recordConsentEvent: vi.fn(async (input: RecordConsentEventInput) => {
      calls.push(input);
      return {
        event_id: `evt-${input.scope}`,
        tenant_id: input.tenant_id,
        talent_record_id: input.talent_record_id,
        scope: input.scope,
        action: 'granted' as const,
        captured_method: input.captured_method,
        consent_version: input.consent_version,
        occurred_at: input.occurred_at,
        expires_at: input.expires_at,
        recorded_at: '2026-10-06T12:00:00.500Z',
      };
    }),
  };
  const service = new ConsentService(repo as unknown as ConsentRepository);
  return { service, calls };
}

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

describe('ConsentService.captureProfileConsent — governance proofs', () => {
  it('records only the affirmatively-attested scopes, in dependency order', async () => {
    const { service, calls } = makeService();
    await service.captureProfileConsent({
      talent_record_id: TALENT,
      captured_method: 'recruiter_capture',
      scopes: ['contacting', 'profile_storage', 'matching'], // intentionally unordered
      authContext: recruiterAuth(),
      idempotencyKey: '11111111-1111-7111-8111-111111111111',
      requestId: 'req-1',
      now: NOW,
    });
    // Exactly the three attested scopes, written prerequisites-first.
    expect(calls.map((c) => c.scope)).toEqual([
      'profile_storage',
      'matching',
      'contacting',
    ]);
    expect(calls.every((c) => c.action === 'granted')).toBe(true);
  });

  it('does NOT manufacture an unselected scope (only two selected → two events)', async () => {
    const { service, calls } = makeService();
    await service.captureProfileConsent({
      talent_record_id: TALENT,
      captured_method: 'recruiter_capture',
      scopes: ['profile_storage', 'matching'],
      authContext: recruiterAuth(),
      idempotencyKey: '22222222-2222-7222-8222-222222222222',
      requestId: 'req-2',
      now: NOW,
    });
    expect(calls.map((c) => c.scope)).toEqual(['profile_storage', 'matching']);
    expect(calls.some((c) => c.scope === 'contacting')).toBe(false);
  });

  it('rejects a dependency-incomplete set (contacting without its prerequisites)', async () => {
    const { service, calls } = makeService();
    await expect(
      service.captureProfileConsent({
        talent_record_id: TALENT,
        captured_method: 'recruiter_capture',
        scopes: ['contacting'],
        authContext: recruiterAuth(),
        idempotencyKey: '33333333-3333-7333-8333-333333333333',
        requestId: 'req-3',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SCOPE_COMBINATION' });
    // Fail-closed: NOTHING written when the set is invalid.
    expect(calls).toHaveLength(0);
  });

  it('server-rendered consent_text_snapshot IS the hashed D7 preimage (recruiter)', async () => {
    const { service, calls } = makeService();
    await service.captureProfileConsent({
      talent_record_id: TALENT,
      captured_method: 'recruiter_capture',
      scopes: ['profile_storage', 'matching', 'contacting'],
      authContext: recruiterAuth(),
      idempotencyKey: '44444444-4444-7444-8444-444444444444',
      requestId: 'req-4',
      now: NOW,
    });
    for (const call of calls) {
      // the stored snapshot equals the frozen render for (version, scope)
      expect(call.consent_text_snapshot).toBe(
        renderRecruiterCaptureConsentText(CONSENT_TEXT_RECRUITER_CAPTURE_VERSION, {
          scope: call.scope as 'profile_storage' | 'matching' | 'contacting',
        }),
      );
      // and the evidence hash is sha256 of exactly that snapshot (displayed==hashed)
      expect(call.consent_evidence?.consent_text_hash).toBe(
        sha256(call.consent_text_snapshot as string),
      );
      expect(call.consent_evidence?.consent_text_version).toBe(
        CONSENT_TEXT_RECRUITER_CAPTURE_VERSION,
      );
      expect(call.consent_version).toBe(CONSENT_TEXT_RECRUITER_CAPTURE_VERSION);
      expect(call.consent_evidence?.channel).toBe('recruiter_capture');
    }
  });

  it('selects the approved first-person portal text for the Talent-direct method', async () => {
    const { service, calls } = makeService();
    await service.captureProfileConsent({
      talent_record_id: TALENT,
      captured_method: 'self_signup',
      scopes: ['profile_storage'],
      authContext: recruiterAuth(),
      idempotencyKey: '55555555-5555-7555-8555-555555555555',
      requestId: 'req-5',
      now: NOW,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.consent_version).toBe(CONSENT_TEXT_CURRENT_VERSION);
    expect(calls[0]?.consent_text_snapshot).toBe(
      renderPortalConsentText(CONSENT_TEXT_CURRENT_VERSION, {
        recipient_tenant_id: TENANT,
        scope: 'profile_storage',
      }),
    );
    expect(calls[0]?.consent_evidence?.channel).toBe('ats_self');
  });

  it('fans the single Idempotency-Key out to a stable per-scope key', async () => {
    const { service, calls } = makeService();
    await service.captureProfileConsent({
      talent_record_id: TALENT,
      captured_method: 'recruiter_capture',
      scopes: ['profile_storage', 'matching', 'contacting'],
      authContext: recruiterAuth(),
      idempotencyKey: '66666666-6666-7666-8666-666666666666',
      requestId: 'req-6',
      now: NOW,
    });
    expect(calls.map((c) => c.idempotencyKey)).toEqual([
      '66666666-6666-7666-8666-666666666666:profile_storage',
      '66666666-6666-7666-8666-666666666666:matching',
      '66666666-6666-7666-8666-666666666666:contacting',
    ]);
  });

  it('derives tenant + actor from the JWT (never a request body), and sets 12-month expiry', async () => {
    const { service, calls } = makeService();
    await service.captureProfileConsent({
      talent_record_id: TALENT,
      captured_method: 'recruiter_capture',
      scopes: ['profile_storage'],
      authContext: recruiterAuth(OTHER_TENANT),
      idempotencyKey: '77777777-7777-7777-8777-777777777777',
      requestId: 'req-7',
      now: NOW,
    });
    expect(calls[0]?.tenant_id).toBe(OTHER_TENANT); // from JWT
    expect(calls[0]?.captured_by_actor_id).toBe(RECRUITER); // from JWT
    const expectedExpiry = new Date(NOW);
    expectedExpiry.setMonth(expectedExpiry.getMonth() + 12);
    expect(calls[0]?.expires_at).toBe(expectedExpiry.toISOString());
    expect(calls[0]?.occurred_at).toBe(NOW.toISOString());
  });

  it('getCaptureTexts returns exactly the bytes the write-path hashes', async () => {
    const { service } = makeService();
    const recruiter = service.getCaptureTexts('recruiter_capture', TENANT);
    expect(recruiter.version).toBe(CONSENT_TEXT_RECRUITER_CAPTURE_VERSION);
    expect(recruiter.texts.map((t) => t.scope)).toEqual([
      'profile_storage',
      'matching',
      'contacting',
    ]);
    for (const entry of recruiter.texts) {
      expect(entry.text).toBe(
        renderRecruiterCaptureConsentText(CONSENT_TEXT_RECRUITER_CAPTURE_VERSION, {
          scope: entry.scope,
        }),
      );
    }
    const selfDirect = service.getCaptureTexts('self_signup', TENANT);
    expect(selfDirect.version).toBe(CONSENT_TEXT_CURRENT_VERSION);
  });
});
