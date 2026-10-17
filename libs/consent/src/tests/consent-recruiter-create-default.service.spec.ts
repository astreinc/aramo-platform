import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@aramo/auth';

import { CONSENT_DEFAULT_TERM_MONTHS, ConsentService } from '../lib/consent.service.js';
import type { ConsentRepository, RecordConsentEventInput } from '../lib/consent.repository.js';
import {
  CONSENT_TEXT_RECRUITER_CREATE_DEFAULT_VERSION,
  hashRecruiterCreateDefaultConsentText,
  renderRecruiterCreateDefaultConsentText,
} from '../lib/consent-texts.js';
import { CONSENT_CAPTURED_METHODS } from '../lib/dto/consent-grant-request.dto.js';
import { CONSENT_CAPTURE_METHODS } from '../lib/dto/consent-capture-request.dto.js';

// CONSENT-RECRUITER-CREATE-DEFAULT-1 (Amendment v1.0 LOCKED) — service-level
// proofs for the at-create contact-consent default. A stub repository captures
// every recordConsentEvent call (no database).

const TENANT = '019000a0-0000-7000-8000-000000000001';
const RECRUITER = '019000a0-0000-7000-8000-000000000002';
const TALENT = '448aa5b2-02ac-4e38-8bd2-ac0d1414a57a';
const NOW = new Date('2026-10-16T12:00:00.000Z');

function auth(consumer_type = 'recruiter'): AuthContextType {
  return { sub: RECRUITER, tenant_id: TENANT, consumer_type } as unknown as AuthContextType;
}

function makeService(priorEvents: unknown[] = []): {
  service: ConsentService;
  calls: RecordConsentEventInput[];
  resolveHistory: ReturnType<typeof vi.fn>;
} {
  const calls: RecordConsentEventInput[] = [];
  const resolveHistory = vi.fn(async () => ({
    events: priorEvents,
    next_cursor: null,
    is_anonymized: false,
  }));
  const repo = {
    resolveHistory,
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
        recorded_at: '2026-10-16T12:00:00.500Z',
      };
    }),
  };
  return {
    service: new ConsentService(repo as unknown as ConsentRepository),
    calls,
    resolveHistory,
  };
}

const sha256 = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');

describe('ConsentService.recordRecruiterCreateDefault', () => {
  it('records profile_storage → matching → contacting (dependency order), all granted', async () => {
    const { service, calls } = makeService();
    const out = await service.recordRecruiterCreateDefault({
      talent_record_id: TALENT,
      authContext: auth(),
      requestId: 'req-1',
      now: NOW,
    });
    expect(out.status).toBe('recorded');
    expect(calls.map((c) => c.scope)).toEqual(['profile_storage', 'matching', 'contacting']);
    expect(calls.every((c) => c.action === 'granted')).toBe(true);
    expect(calls.every((c) => c.tenant_id === TENANT && c.talent_record_id === TALENT)).toBe(true);
  });

  it('method recruiter_create_default, recruiter actor, frozen text version + hash', async () => {
    const { service, calls } = makeService();
    await service.recordRecruiterCreateDefault({
      talent_record_id: TALENT,
      authContext: auth(),
      requestId: 'req-2',
      now: NOW,
    });
    const expectedText =
      `Recorded at profile creation by ${RECRUITER}. Aramo's policy for ` +
      `recruiter-created profiles: the recruiter verified the Talent before creating ` +
      `the profile, and email and phone contact is permitted until the Talent or a ` +
      `recruiter withdraws it.`;
    expect(
      renderRecruiterCreateDefaultConsentText(CONSENT_TEXT_RECRUITER_CREATE_DEFAULT_VERSION, {
        recruiter_actor_id: RECRUITER,
      }),
    ).toBe(expectedText);
    for (const c of calls) {
      expect(c.captured_method).toBe('recruiter_create_default');
      expect(c.captured_by_actor_id).toBe(RECRUITER);
      expect(c.consent_version).toBe('recruiter-create-default-v1');
      expect(c.consent_text_snapshot).toBe(expectedText);
      expect(c.consent_evidence?.consent_text_version).toBe('recruiter-create-default-v1');
      expect(c.consent_evidence?.consent_text_hash).toBe(sha256(expectedText));
      expect(c.consent_evidence?.consent_text_hash).toBe(
        hashRecruiterCreateDefaultConsentText('recruiter-create-default-v1', {
          recruiter_actor_id: RECRUITER,
        }).hash,
      );
      // channel names the default basis — never the attestation/self values.
      expect(c.consent_evidence?.channel).toBe('recruiter_create_default');
      expect(c.consent_evidence?.channel).not.toBe('ats_self');
      expect(c.consent_evidence?.channel).not.toBe('recruiter_capture');
    }
  });

  it("contacting carries permitted_channels ['email','phone'] only (no sms); prerequisites carry none", async () => {
    const { service, calls } = makeService();
    await service.recordRecruiterCreateDefault({
      talent_record_id: TALENT,
      authContext: auth(),
      requestId: 'req-3',
      now: NOW,
    });
    const contacting = calls.find((c) => c.scope === 'contacting');
    expect(contacting?.metadata).toEqual({ permitted_channels: ['email', 'phone'] });
    expect(
      (contacting?.metadata?.['permitted_channels'] as string[]).includes('sms'),
    ).toBe(false);
    expect(calls.find((c) => c.scope === 'profile_storage')?.metadata).toBeUndefined();
    expect(calls.find((c) => c.scope === 'matching')?.metadata).toBeUndefined();
  });

  it('standard 12-month term on every grant', async () => {
    const { service, calls } = makeService();
    await service.recordRecruiterCreateDefault({
      talent_record_id: TALENT,
      authContext: auth(),
      requestId: 'req-4',
      now: NOW,
    });
    expect(CONSENT_DEFAULT_TERM_MONTHS).toBe(12);
    for (const c of calls) {
      expect(c.occurred_at).toBe('2026-10-16T12:00:00.000Z');
      expect(c.expires_at).toBe('2027-10-16T12:00:00.000Z');
    }
  });

  it('deterministic per-Talent idempotency key fanned out per scope; replay-stable hash', async () => {
    const a = makeService();
    const b = makeService();
    await a.service.recordRecruiterCreateDefault({
      talent_record_id: TALENT,
      authContext: auth(),
      requestId: 'req-a',
      now: NOW,
    });
    await b.service.recordRecruiterCreateDefault({
      talent_record_id: TALENT,
      authContext: auth(),
      requestId: 'req-b',
      now: new Date('2026-10-17T00:00:00.000Z'),
    });
    expect(a.calls.map((c) => c.idempotencyKey)).toEqual([
      `recruiter-create-default:${TALENT}:profile_storage`,
      `recruiter-create-default:${TALENT}:matching`,
      `recruiter-create-default:${TALENT}:contacting`,
    ]);
    expect(a.calls.map((c) => c.requestHash)).toEqual(b.calls.map((c) => c.requestHash));
  });

  it('§4 — never overrides an existing ledger (e.g. a revocation): skips, writes nothing', async () => {
    const { service, calls, resolveHistory } = makeService([
      { event_id: 'e1', scope: 'contacting', action: 'revoked', created_at: 'x', expires_at: null },
    ]);
    const out = await service.recordRecruiterCreateDefault({
      talent_record_id: TALENT,
      authContext: auth(),
      requestId: 'req-5',
      now: NOW,
    });
    expect(out).toEqual({ status: 'skipped', reason: 'consent_ledger_not_empty' });
    expect(resolveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT, talent_record_id: TALENT, limit: 1 }),
    );
    expect(calls).toHaveLength(0);
  });

  it('non-recruiter consumer → no-op (no read, no write)', async () => {
    const { service, calls, resolveHistory } = makeService();
    const out = await service.recordRecruiterCreateDefault({
      talent_record_id: TALENT,
      authContext: auth('portal'),
      requestId: 'req-6',
      now: NOW,
    });
    expect(out).toEqual({ status: 'skipped', reason: 'not_recruiter' });
    expect(resolveHistory).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('a writer failure propagates (the talent-record caller owns the fail-soft)', async () => {
    const { service } = makeService();
    (
      service as unknown as { consentRepo: { recordConsentEvent: ReturnType<typeof vi.fn> } }
    ).consentRepo.recordConsentEvent.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.recordRecruiterCreateDefault({
        talent_record_id: TALENT,
        authContext: auth(),
        requestId: 'req-7',
        now: NOW,
      }),
    ).rejects.toThrow('db down');
  });

  it('§3.3 — recruiter_create_default is NOT in any HTTP request method enum', () => {
    expect((CONSENT_CAPTURED_METHODS as readonly string[]).includes('recruiter_create_default')).toBe(
      false,
    );
    expect((CONSENT_CAPTURE_METHODS as readonly string[]).includes('recruiter_create_default')).toBe(
      false,
    );
  });
});
