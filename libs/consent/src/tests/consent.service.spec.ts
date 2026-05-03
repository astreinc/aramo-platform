import type { AuthContextType } from '@aramo/auth';
import { describe, expect, it, vi } from 'vitest';

import { ConsentRepository } from '../lib/consent.repository.js';
import { ConsentService } from '../lib/consent.service.js';
import type { ConsentCheckRequestDto } from '../lib/dto/consent-check-request.dto.js';
import type { ConsentDecisionDto } from '../lib/dto/consent-decision.dto.js';
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

function makeCheckRequest(
  overrides: Partial<ConsentCheckRequestDto> = {},
): ConsentCheckRequestDto {
  return {
    talent_id: TALENT_ID,
    operation: 'matching',
    ...overrides,
  } as ConsentCheckRequestDto;
}

function makeDecision(): ConsentDecisionDto {
  return {
    result: 'allowed',
    scope: 'matching',
    decision_id: 'd2d7a0f0-0000-7000-8000-0000000000ff',
    computed_at: '2026-04-30T12:00:00Z',
  };
}

describe('ConsentService.check', () => {
  it('forwards talent_id, operation, channel, idempotencyKey, requestId, and JWT-derived tenant', async () => {
    const repo = { resolveConsentState: vi.fn().mockResolvedValue(makeDecision()) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.check(
      makeCheckRequest({ operation: 'engagement', channel: 'email' }),
      'aabbccdd-0000-7000-8000-000000000001',
      recruiterContext(),
      'req-c1',
    );
    expect(repo.resolveConsentState).toHaveBeenCalledOnce();
    const args = repo.resolveConsentState.mock.calls[0][0] as {
      tenant_id: string;
      talent_id: string;
      operation: string;
      channel: string;
      idempotencyKey: string;
      requestId: string;
    };
    expect(args.tenant_id).toBe(TENANT_ID);
    expect(args.talent_id).toBe(TALENT_ID);
    expect(args.operation).toBe('engagement');
    expect(args.channel).toBe('email');
    expect(args.idempotencyKey).toBe('aabbccdd-0000-7000-8000-000000000001');
    expect(args.requestId).toBe('req-c1');
  });

  it('uses tenant_id from JWT, never from request body', async () => {
    const repo = { resolveConsentState: vi.fn().mockResolvedValue(makeDecision()) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    const request = {
      ...makeCheckRequest(),
      tenant_id: 'aa000000-0000-0000-0000-000000000099',
    } as unknown as ConsentCheckRequestDto;
    await service.check(request, undefined, recruiterContext(), 'req-c2');
    const args = repo.resolveConsentState.mock.calls[0][0] as { tenant_id: string };
    expect(args.tenant_id).toBe(TENANT_ID);
  });

  it('passes idempotencyKey=undefined when header was absent', async () => {
    const repo = { resolveConsentState: vi.fn().mockResolvedValue(makeDecision()) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.check(makeCheckRequest(), undefined, portalContext(), 'req-c3');
    const args = repo.resolveConsentState.mock.calls[0][0] as {
      idempotencyKey: string | undefined;
    };
    expect(args.idempotencyKey).toBeUndefined();
  });

  it('produces a stable request hash for the same canonical check body', async () => {
    const repo = { resolveConsentState: vi.fn().mockResolvedValue(makeDecision()) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.check(makeCheckRequest(), undefined, recruiterContext(), 'req-c4');
    const firstHash = (repo.resolveConsentState.mock.calls[0][0] as { requestHash: string }).requestHash;
    repo.resolveConsentState.mockClear();
    await service.check(makeCheckRequest(), undefined, recruiterContext(), 'req-c5');
    const secondHash = (repo.resolveConsentState.mock.calls[0][0] as { requestHash: string }).requestHash;
    expect(firstHash).toBe(secondHash);
  });

  it('returns the ConsentDecision unchanged from the resolver', async () => {
    const decision = makeDecision();
    const repo = { resolveConsentState: vi.fn().mockResolvedValue(decision) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    const result = await service.check(makeCheckRequest(), undefined, recruiterContext(), 'req-c6');
    expect(result).toEqual(decision);
  });
});

describe('ConsentService.getState', () => {
  const stateResponse = {
    talent_id: TALENT_ID,
    tenant_id: TENANT_ID,
    is_anonymized: false,
    computed_at: '2026-05-01T12:00:00Z',
    scopes: [
      {
        scope: 'matching',
        status: 'granted',
        granted_at: '2026-04-01T10:00:00Z',
        revoked_at: null,
        expires_at: null,
      },
    ],
  };

  it('forwards talent_id, requestId, and JWT-derived tenant_id to the resolver', async () => {
    const repo = { resolveAllScopes: vi.fn().mockResolvedValue(stateResponse) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.getState(TALENT_ID, recruiterContext(), 'req-state-1');
    expect(repo.resolveAllScopes).toHaveBeenCalledOnce();
    const args = repo.resolveAllScopes.mock.calls[0][0] as {
      tenant_id: string;
      talent_id: string;
      requestId: string;
    };
    expect(args.tenant_id).toBe(TENANT_ID);
    expect(args.talent_id).toBe(TALENT_ID);
    expect(args.requestId).toBe('req-state-1');
  });

  it('uses tenant_id from JWT, not from any other source', async () => {
    const repo = { resolveAllScopes: vi.fn().mockResolvedValue(stateResponse) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    const overriddenContext = recruiterContext({ tenant_id: 'aa000000-0000-0000-0000-000000000099' });
    await service.getState(TALENT_ID, overriddenContext, 'req-state-2');
    const args = repo.resolveAllScopes.mock.calls[0][0] as { tenant_id: string };
    expect(args.tenant_id).toBe('aa000000-0000-0000-0000-000000000099');
  });

  it('returns the resolver response unchanged', async () => {
    const repo = { resolveAllScopes: vi.fn().mockResolvedValue(stateResponse) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    const result = await service.getState(TALENT_ID, portalContext(), 'req-state-3');
    expect(result).toEqual(stateResponse);
  });
});

describe('ConsentService.getHistory (PR-6)', () => {
  const historyResponse = {
    events: [],
    next_cursor: null,
    is_anonymized: false,
  };

  it('forwards talent_id, scope, limit, cursor, requestId, and JWT-derived tenant_id', async () => {
    const repo = { resolveHistory: vi.fn().mockResolvedValue(historyResponse) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    const cursor = {
      created_at: new Date('2026-04-15T12:00:00Z'),
      event_id: 'aabbccdd-0000-7000-8000-000000000099',
    };
    await service.getHistory(
      TALENT_ID,
      'contacting',
      25,
      cursor,
      recruiterContext(),
      'req-h-1',
    );
    expect(repo.resolveHistory).toHaveBeenCalledOnce();
    const args = repo.resolveHistory.mock.calls[0][0] as {
      tenant_id: string;
      talent_id: string;
      scope: string;
      limit: number;
      cursor: { created_at: Date; event_id: string };
      requestId: string;
    };
    expect(args.tenant_id).toBe(TENANT_ID);
    expect(args.talent_id).toBe(TALENT_ID);
    expect(args.scope).toBe('contacting');
    expect(args.limit).toBe(25);
    expect(args.cursor).toEqual(cursor);
    expect(args.requestId).toBe('req-h-1');
  });

  it('uses tenant_id from JWT, never from any other source', async () => {
    const repo = { resolveHistory: vi.fn().mockResolvedValue(historyResponse) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.getHistory(
      TALENT_ID,
      undefined,
      50,
      undefined,
      recruiterContext({ tenant_id: 'aa000000-0000-0000-0000-000000000099' }),
      'req-h-2',
    );
    const args = repo.resolveHistory.mock.calls[0][0] as { tenant_id: string };
    expect(args.tenant_id).toBe('aa000000-0000-0000-0000-000000000099');
  });

  it('passes scope=undefined and cursor=undefined through unchanged', async () => {
    const repo = { resolveHistory: vi.fn().mockResolvedValue(historyResponse) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.getHistory(TALENT_ID, undefined, 50, undefined, portalContext(), 'req-h-3');
    const args = repo.resolveHistory.mock.calls[0][0] as {
      scope: unknown;
      cursor: unknown;
    };
    expect(args.scope).toBeUndefined();
    expect(args.cursor).toBeUndefined();
  });

  it('returns the resolver response unchanged', async () => {
    const repo = { resolveHistory: vi.fn().mockResolvedValue(historyResponse) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    const result = await service.getHistory(
      TALENT_ID,
      undefined,
      50,
      undefined,
      portalContext(),
      'req-h-4',
    );
    expect(result).toEqual(historyResponse);
  });
});

describe('ConsentService.getDecisionLog (PR-7)', () => {
  const decisionLogResponse = {
    entries: [],
    next_cursor: null,
    is_anonymized: false,
  };

  it('forwards talent_id, event_type, limit, cursor, requestId, and JWT-derived tenant_id', async () => {
    const repo = { resolveDecisionLog: vi.fn().mockResolvedValue(decisionLogResponse) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    const cursor = {
      created_at: new Date('2026-04-15T12:00:00Z'),
      event_id: 'aabbccdd-0000-7000-8000-000000000099',
    };
    await service.getDecisionLog(
      TALENT_ID,
      'consent.check.decision',
      25,
      cursor,
      recruiterContext(),
      'req-dl-1',
    );
    expect(repo.resolveDecisionLog).toHaveBeenCalledOnce();
    const args = repo.resolveDecisionLog.mock.calls[0][0] as {
      tenant_id: string;
      talent_id: string;
      event_type: string;
      limit: number;
      cursor: { created_at: Date; event_id: string };
      requestId: string;
    };
    expect(args.tenant_id).toBe(TENANT_ID);
    expect(args.talent_id).toBe(TALENT_ID);
    expect(args.event_type).toBe('consent.check.decision');
    expect(args.limit).toBe(25);
    expect(args.cursor).toEqual(cursor);
    expect(args.requestId).toBe('req-dl-1');
  });

  it('uses tenant_id from JWT, never from any other source', async () => {
    const repo = { resolveDecisionLog: vi.fn().mockResolvedValue(decisionLogResponse) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.getDecisionLog(
      TALENT_ID,
      undefined,
      50,
      undefined,
      recruiterContext({ tenant_id: 'aa000000-0000-0000-0000-000000000099' }),
      'req-dl-2',
    );
    const args = repo.resolveDecisionLog.mock.calls[0][0] as { tenant_id: string };
    expect(args.tenant_id).toBe('aa000000-0000-0000-0000-000000000099');
  });

  it('passes event_type=undefined and cursor=undefined through unchanged', async () => {
    const repo = { resolveDecisionLog: vi.fn().mockResolvedValue(decisionLogResponse) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    await service.getDecisionLog(
      TALENT_ID,
      undefined,
      50,
      undefined,
      portalContext(),
      'req-dl-3',
    );
    const args = repo.resolveDecisionLog.mock.calls[0][0] as {
      event_type: unknown;
      cursor: unknown;
    };
    expect(args.event_type).toBeUndefined();
    expect(args.cursor).toBeUndefined();
  });

  it('returns the resolver response unchanged', async () => {
    const repo = { resolveDecisionLog: vi.fn().mockResolvedValue(decisionLogResponse) };
    const service = new ConsentService(repo as unknown as ConsentRepository);
    const result = await service.getDecisionLog(
      TALENT_ID,
      undefined,
      50,
      undefined,
      portalContext(),
      'req-dl-4',
    );
    expect(result).toEqual(decisionLogResponse);
  });
});
