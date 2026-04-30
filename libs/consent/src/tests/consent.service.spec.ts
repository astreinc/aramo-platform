import type { AuthContextType } from '@aramo/auth';
import { describe, expect, it, vi } from 'vitest';

import { ConsentRepository } from '../lib/consent.repository.js';
import { ConsentService } from '../lib/consent.service.js';
import type { ConsentGrantRequestDto } from '../lib/dto/consent-grant-request.dto.js';
import type { ConsentRevokeRequestDto } from '../lib/dto/consent-revoke-request.dto.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';
const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';

function recruiterContext(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    sub: RECRUITER_ID,
    consumer_type: 'recruiter',
    tenant_id: TENANT_ID,
    scopes: ['consent:write'],
    iat: 0,
    exp: 9_999_999_999,
    ...overrides,
  };
}

function portalContext(overrides: Partial<AuthContextType> = {}): AuthContextType {
  return {
    sub: TALENT_ID,
    consumer_type: 'portal',
    tenant_id: TENANT_ID,
    scopes: ['consent:write'],
    iat: 0,
    exp: 9_999_999_999,
    ...overrides,
  };
}

function makeGrantRequest(): ConsentGrantRequestDto {
  return {
    talent_id: TALENT_ID,
    scope: 'matching',
    captured_method: 'recruiter_capture',
    consent_version: 'v1',
    occurred_at: '2026-04-29T00:00:00Z',
  } as ConsentGrantRequestDto;
}

function makeRevokeRequest(): ConsentRevokeRequestDto {
  return {
    talent_id: TALENT_ID,
    scope: 'matching',
    captured_method: 'recruiter_capture',
    consent_version: 'v1',
    occurred_at: '2026-04-29T00:00:00Z',
  } as ConsentRevokeRequestDto;
}

describe('ConsentService.grant', () => {
  it('passes the recruiter sub through as captured_by_actor_id when consumer_type=recruiter', async () => {
    const repo = { recordConsentEvent: vi.fn().mockResolvedValue({ action: 'granted' }) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.grant(makeGrantRequest(), 'd2d7a0f0-0000-7000-8000-000000000001', recruiterContext(), 'req-1');
    expect(repo.recordConsentEvent).toHaveBeenCalledOnce();
    const args = repo.recordConsentEvent.mock.calls[0][0] as {
      action: string;
      captured_by_actor_id: string | null;
    };
    expect(args.action).toBe('granted');
    expect(args.captured_by_actor_id).toBe(RECRUITER_ID);
  });

  it('passes captured_by_actor_id=null when consumer_type=portal (self-signup-style flow)', async () => {
    const repo = { recordConsentEvent: vi.fn().mockResolvedValue({ action: 'granted' }) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.grant(makeGrantRequest(), 'd2d7a0f0-0000-7000-8000-000000000002', portalContext(), 'req-2');
    const args = repo.recordConsentEvent.mock.calls[0][0] as { captured_by_actor_id: string | null };
    expect(args.captured_by_actor_id).toBeNull();
  });

  it('uses tenant_id from JWT, never from request body', async () => {
    const repo = { recordConsentEvent: vi.fn().mockResolvedValue({ action: 'granted' }) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    const request = {
      ...makeGrantRequest(),
      tenant_id: 'aa000000-0000-0000-0000-000000000099',
    } as unknown as ConsentGrantRequestDto;
    await service.grant(request, 'd2d7a0f0-0000-7000-8000-000000000003', recruiterContext(), 'req-3');
    const args = repo.recordConsentEvent.mock.calls[0][0] as { tenant_id: string };
    expect(args.tenant_id).toBe(TENANT_ID);
  });

  it('produces a stable request hash for the same canonical body', async () => {
    const repo = { recordConsentEvent: vi.fn().mockResolvedValue({ action: 'granted' }) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.grant(makeGrantRequest(), 'd2d7a0f0-0000-7000-8000-000000000004', recruiterContext(), 'req-4');
    const firstHash = (repo.recordConsentEvent.mock.calls[0][0] as { requestHash: string }).requestHash;
    repo.recordConsentEvent.mockClear();
    await service.grant(makeGrantRequest(), 'd2d7a0f0-0000-7000-8000-000000000005', recruiterContext(), 'req-5');
    const secondHash = (repo.recordConsentEvent.mock.calls[0][0] as { requestHash: string }).requestHash;
    expect(firstHash).toBe(secondHash);
  });
});

describe('ConsentService.revoke', () => {
  it('calls recordConsentEvent with action=revoked', async () => {
    const repo = { recordConsentEvent: vi.fn().mockResolvedValue({ action: 'revoked' }) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.revoke(makeRevokeRequest(), 'd2d7a0f0-0000-7000-8000-000000000010', recruiterContext(), 'req-r1');
    expect(repo.recordConsentEvent).toHaveBeenCalledOnce();
    const args = repo.recordConsentEvent.mock.calls[0][0] as { action: string };
    expect(args.action).toBe('revoked');
  });

  it('passes the recruiter sub through as captured_by_actor_id when consumer_type=recruiter', async () => {
    const repo = { recordConsentEvent: vi.fn().mockResolvedValue({ action: 'revoked' }) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.revoke(makeRevokeRequest(), 'd2d7a0f0-0000-7000-8000-000000000011', recruiterContext(), 'req-r2');
    const args = repo.recordConsentEvent.mock.calls[0][0] as { captured_by_actor_id: string | null };
    expect(args.captured_by_actor_id).toBe(RECRUITER_ID);
  });

  it('passes captured_by_actor_id=null when consumer_type=portal', async () => {
    const repo = { recordConsentEvent: vi.fn().mockResolvedValue({ action: 'revoked' }) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.revoke(makeRevokeRequest(), 'd2d7a0f0-0000-7000-8000-000000000012', portalContext(), 'req-r3');
    const args = repo.recordConsentEvent.mock.calls[0][0] as { captured_by_actor_id: string | null };
    expect(args.captured_by_actor_id).toBeNull();
  });

  it('uses tenant_id from JWT, never from request body', async () => {
    const repo = { recordConsentEvent: vi.fn().mockResolvedValue({ action: 'revoked' }) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    const request = {
      ...makeRevokeRequest(),
      tenant_id: 'aa000000-0000-0000-0000-000000000099',
    } as unknown as ConsentRevokeRequestDto;
    await service.revoke(request, 'd2d7a0f0-0000-7000-8000-000000000013', recruiterContext(), 'req-r4');
    const args = repo.recordConsentEvent.mock.calls[0][0] as { tenant_id: string };
    expect(args.tenant_id).toBe(TENANT_ID);
  });

  it('does not pass expires_at or consent_text_snapshot through (revoke ignores them)', async () => {
    const repo = { recordConsentEvent: vi.fn().mockResolvedValue({ action: 'revoked' }) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.revoke(makeRevokeRequest(), 'd2d7a0f0-0000-7000-8000-000000000014', recruiterContext(), 'req-r5');
    const args = repo.recordConsentEvent.mock.calls[0][0] as Record<string, unknown>;
    expect(args['expires_at']).toBeUndefined();
    expect(args['consent_text_snapshot']).toBeUndefined();
  });

  it('produces a stable request hash for the same canonical revoke body', async () => {
    const repo = { recordConsentEvent: vi.fn().mockResolvedValue({ action: 'revoked' }) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.revoke(makeRevokeRequest(), 'd2d7a0f0-0000-7000-8000-000000000015', recruiterContext(), 'req-r6');
    const firstHash = (repo.recordConsentEvent.mock.calls[0][0] as { requestHash: string }).requestHash;
    repo.recordConsentEvent.mockClear();
    await service.revoke(makeRevokeRequest(), 'd2d7a0f0-0000-7000-8000-000000000016', recruiterContext(), 'req-r7');
    const secondHash = (repo.recordConsentEvent.mock.calls[0][0] as { requestHash: string }).requestHash;
    expect(firstHash).toBe(secondHash);
  });
});
