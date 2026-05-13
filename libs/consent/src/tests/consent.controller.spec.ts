import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { describe, expect, it, vi } from 'vitest';

import { ConsentController } from '../lib/consent.controller.js';
import type { ConsentService } from '../lib/consent.service.js';
import type { ConsentCheckRequestDto } from '../lib/dto/consent-check-request.dto.js';
import type { ConsentGrantRequestDto } from '../lib/dto/consent-grant-request.dto.js';
import type { ConsentRevokeRequestDto } from '../lib/dto/consent-revoke-request.dto.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';
const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';
const VALID_KEY = 'd2d7a0f0-0000-7000-8000-000000000001';

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

function makeAuth(): AuthContextType {
  return {
    sub: RECRUITER_ID,
    consumer_type: 'recruiter',
    actor_kind: 'user',
    tenant_id: TENANT_ID,
    scopes: ['consent:write'],
    iat: 0,
    exp: 9_999_999_999,
  };
}

describe('ConsentController.grantConsent', () => {
  it('delegates to ConsentService.grant on a valid request', async () => {
    const service = { grant: vi.fn().mockResolvedValue({ event_id: 'e1' }), revoke: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    const result = await controller.grantConsent(makeGrantRequest(), VALID_KEY, makeAuth(), 'req-1');
    expect(service.grant).toHaveBeenCalledOnce();
    expect(result).toEqual({ event_id: 'e1' });
  });

  it('throws VALIDATION_ERROR when Idempotency-Key is missing', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.grantConsent(makeGrantRequest(), undefined, makeAuth(), 'req-2'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    expect(service.grant).not.toHaveBeenCalled();
  });

  it('throws VALIDATION_ERROR when Idempotency-Key is empty', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.grantConsent(makeGrantRequest(), '', makeAuth(), 'req-3'),
    ).rejects.toBeInstanceOf(AramoError);
  });

  it('throws VALIDATION_ERROR when Idempotency-Key is not a UUID', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.grantConsent(makeGrantRequest(), 'not-a-uuid', makeAuth(), 'req-4'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { invalid_field: 'Idempotency-Key' } },
    });
  });
});

describe('ConsentController.revokeConsent', () => {
  it('delegates to ConsentService.revoke on a valid request', async () => {
    const service = {
      grant: vi.fn(),
      revoke: vi.fn().mockResolvedValue({ event_id: 'r1', action: 'revoked' }),
    };
    const controller = new ConsentController(service as unknown as ConsentService);
    const result = await controller.revokeConsent(makeRevokeRequest(), VALID_KEY, makeAuth(), 'req-r1');
    expect(service.revoke).toHaveBeenCalledOnce();
    expect(result).toEqual({ event_id: 'r1', action: 'revoked' });
  });

  it('throws VALIDATION_ERROR when Idempotency-Key is missing', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.revokeConsent(makeRevokeRequest(), undefined, makeAuth(), 'req-r2'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    expect(service.revoke).not.toHaveBeenCalled();
  });

  it('throws VALIDATION_ERROR when Idempotency-Key is empty', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.revokeConsent(makeRevokeRequest(), '', makeAuth(), 'req-r3'),
    ).rejects.toBeInstanceOf(AramoError);
  });

  it('throws VALIDATION_ERROR when Idempotency-Key is not a UUID', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.revokeConsent(makeRevokeRequest(), 'not-a-uuid', makeAuth(), 'req-r4'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { invalid_field: 'Idempotency-Key' } },
    });
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

describe('ConsentController.checkConsent', () => {
  const decisionResponse = {
    result: 'allowed',
    scope: 'matching',
    decision_id: 'd2d7a0f0-0000-7000-8000-0000000000ff',
    computed_at: '2026-04-30T12:00:00Z',
  };

  it('delegates to ConsentService.check on a valid request with idempotency key', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn(), check: vi.fn().mockResolvedValue(decisionResponse) };
    const controller = new ConsentController(service as unknown as ConsentService);
    const result = await controller.checkConsent(makeCheckRequest(), VALID_KEY, makeAuth(), 'req-c1');
    expect(service.check).toHaveBeenCalledOnce();
    expect(result).toEqual(decisionResponse);
  });

  it('delegates to ConsentService.check WITHOUT an idempotency key (optional per Phase 1 §6)', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn(), check: vi.fn().mockResolvedValue(decisionResponse) };
    const controller = new ConsentController(service as unknown as ConsentService);
    const result = await controller.checkConsent(makeCheckRequest(), undefined, makeAuth(), 'req-c2');
    expect(service.check).toHaveBeenCalledOnce();
    expect(service.check.mock.calls[0][1]).toBeUndefined();
    expect(result).toEqual(decisionResponse);
  });

  it('treats empty Idempotency-Key the same as absent', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn(), check: vi.fn().mockResolvedValue(decisionResponse) };
    const controller = new ConsentController(service as unknown as ConsentService);
    await controller.checkConsent(makeCheckRequest(), '', makeAuth(), 'req-c3');
    expect(service.check).toHaveBeenCalledOnce();
  });

  it('throws VALIDATION_ERROR when Idempotency-Key is present but malformed', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn(), check: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.checkConsent(makeCheckRequest(), 'not-a-uuid', makeAuth(), 'req-c4'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { invalid_field: 'Idempotency-Key' } },
    });
    expect(service.check).not.toHaveBeenCalled();
  });
});

describe('ConsentController.getTalentConsentState', () => {
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

  it('delegates to ConsentService.getState on a valid talent_id', async () => {
    const service = {
      grant: vi.fn(),
      revoke: vi.fn(),
      check: vi.fn(),
      getState: vi.fn().mockResolvedValue(stateResponse),
    };
    const controller = new ConsentController(service as unknown as ConsentService);
    const result = await controller.getTalentConsentState(TALENT_ID, makeAuth(), 'req-s1');
    expect(service.getState).toHaveBeenCalledOnce();
    expect(service.getState.mock.calls[0][0]).toBe(TALENT_ID);
    expect(result).toEqual(stateResponse);
  });

  it('throws VALIDATION_ERROR when talent_id is not a UUID', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn(), check: vi.fn(), getState: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentState('not-a-uuid', makeAuth(), 'req-s2'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { invalid_field: 'talent_id' } },
    });
    expect(service.getState).not.toHaveBeenCalled();
  });

  it('throws VALIDATION_ERROR when talent_id is malformed (random string)', async () => {
    const service = { grant: vi.fn(), revoke: vi.fn(), check: vi.fn(), getState: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentState('12345', makeAuth(), 'req-s3'),
    ).rejects.toBeInstanceOf(AramoError);
    expect(service.getState).not.toHaveBeenCalled();
  });
});

describe('ConsentController.getTalentConsentHistory (PR-6)', () => {
  const historyResponse = {
    events: [],
    next_cursor: null,
    is_anonymized: false,
  };

  function makeFullService() {
    return {
      grant: vi.fn(),
      revoke: vi.fn(),
      check: vi.fn(),
      getState: vi.fn(),
      getHistory: vi.fn().mockResolvedValue(historyResponse),
    };
  }

  it('delegates to ConsentService.getHistory with parsed query params (defaults)', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    const result = await controller.getTalentConsentHistory(
      TALENT_ID,
      undefined,
      undefined,
      undefined,
      makeAuth(),
      'req-h-c1',
    );
    expect(service.getHistory).toHaveBeenCalledOnce();
    const args = service.getHistory.mock.calls[0];
    expect(args[0]).toBe(TALENT_ID);
    expect(args[1]).toBeUndefined(); // scope
    expect(args[2]).toBe(50); // limit default
    expect(args[3]).toBeUndefined(); // cursor
    expect(result).toEqual(historyResponse);
  });

  it('clamps limit > 200 to 200', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await controller.getTalentConsentHistory(
      TALENT_ID,
      undefined,
      '500',
      undefined,
      makeAuth(),
      'req-h-c2',
    );
    expect(service.getHistory.mock.calls[0][2]).toBe(200);
  });

  it('accepts limit in [1, 200] as-is', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await controller.getTalentConsentHistory(
      TALENT_ID,
      undefined,
      '25',
      undefined,
      makeAuth(),
      'req-h-c3',
    );
    expect(service.getHistory.mock.calls[0][2]).toBe(25);
  });

  it('rejects limit < 1 with VALIDATION_ERROR', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentHistory(
        TALENT_ID,
        undefined,
        '0',
        undefined,
        makeAuth(),
        'req-h-c4',
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { invalid_field: 'limit' } },
    });
    expect(service.getHistory).not.toHaveBeenCalled();
  });

  it('rejects negative limit with VALIDATION_ERROR', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentHistory(
        TALENT_ID,
        undefined,
        '-1',
        undefined,
        makeAuth(),
        'req-h-c5',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.getHistory).not.toHaveBeenCalled();
  });

  it('rejects non-integer limit with VALIDATION_ERROR', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentHistory(
        TALENT_ID,
        undefined,
        'abc',
        undefined,
        makeAuth(),
        'req-h-c6',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.getHistory).not.toHaveBeenCalled();
  });

  it('accepts a valid scope filter', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await controller.getTalentConsentHistory(
      TALENT_ID,
      'contacting',
      undefined,
      undefined,
      makeAuth(),
      'req-h-c7',
    );
    expect(service.getHistory.mock.calls[0][1]).toBe('contacting');
  });

  it('rejects an unknown scope value with VALIDATION_ERROR', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentHistory(
        TALENT_ID,
        'not-a-real-scope',
        undefined,
        undefined,
        makeAuth(),
        'req-h-c8',
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { invalid_field: 'scope' } },
    });
    expect(service.getHistory).not.toHaveBeenCalled();
  });

  it('decodes a valid cursor and forwards the payload', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    // Encode a valid cursor inline (using the same primitive the resolver
    // emits) — controller decodes it back to the payload.
    const payload = { c: '2026-04-15T12:00:00.000Z', e: 'd2d7a0f0-0000-7000-8000-000000000001' };
    const cursorString = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    await controller.getTalentConsentHistory(
      TALENT_ID,
      undefined,
      undefined,
      cursorString,
      makeAuth(),
      'req-h-c9',
    );
    const cursorArg = service.getHistory.mock.calls[0][3] as {
      created_at: Date;
      event_id: string;
    };
    expect(cursorArg.event_id).toBe('d2d7a0f0-0000-7000-8000-000000000001');
    expect(cursorArg.created_at.toISOString()).toBe('2026-04-15T12:00:00.000Z');
  });

  it('maps malformed cursor to HTTP 400 VALIDATION_ERROR (never propagates as 500)', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentHistory(
        TALENT_ID,
        undefined,
        undefined,
        '!!!malformed!!!',
        makeAuth(),
        'req-h-c10',
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { invalid_field: 'cursor' } },
    });
    expect(service.getHistory).not.toHaveBeenCalled();
  });

  it('rejects malformed talent_id with VALIDATION_ERROR (before decoding cursor)', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentHistory(
        'not-a-uuid',
        undefined,
        undefined,
        undefined,
        makeAuth(),
        'req-h-c11',
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { invalid_field: 'talent_id' } },
    });
    expect(service.getHistory).not.toHaveBeenCalled();
  });
});

describe('ConsentController.getTalentConsentDecisionLog (PR-7)', () => {
  const decisionLogResponse = {
    entries: [],
    next_cursor: null,
    is_anonymized: false,
  };

  function makeFullService() {
    return {
      grant: vi.fn(),
      revoke: vi.fn(),
      check: vi.fn(),
      getState: vi.fn(),
      getHistory: vi.fn(),
      getDecisionLog: vi.fn().mockResolvedValue(decisionLogResponse),
    };
  }

  it('delegates to ConsentService.getDecisionLog with parsed query params (defaults)', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    const result = await controller.getTalentConsentDecisionLog(
      TALENT_ID,
      undefined,
      undefined,
      undefined,
      makeAuth(),
      'req-dl-c1',
    );
    expect(service.getDecisionLog).toHaveBeenCalledOnce();
    const args = service.getDecisionLog.mock.calls[0];
    expect(args[0]).toBe(TALENT_ID);
    expect(args[1]).toBeUndefined(); // event_type
    expect(args[2]).toBe(50); // limit default
    expect(args[3]).toBeUndefined(); // cursor
    expect(result).toEqual(decisionLogResponse);
  });

  it('clamps limit > 200 to 200', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await controller.getTalentConsentDecisionLog(
      TALENT_ID,
      undefined,
      '500',
      undefined,
      makeAuth(),
      'req-dl-c2',
    );
    expect(service.getDecisionLog.mock.calls[0][2]).toBe(200);
  });

  it('accepts limit in [1, 200] as-is', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await controller.getTalentConsentDecisionLog(
      TALENT_ID,
      undefined,
      '25',
      undefined,
      makeAuth(),
      'req-dl-c3',
    );
    expect(service.getDecisionLog.mock.calls[0][2]).toBe(25);
  });

  it('rejects limit < 1 with VALIDATION_ERROR', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentDecisionLog(
        TALENT_ID,
        undefined,
        '0',
        undefined,
        makeAuth(),
        'req-dl-c4',
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { invalid_field: 'limit' } },
    });
    expect(service.getDecisionLog).not.toHaveBeenCalled();
  });

  it('rejects non-integer limit with VALIDATION_ERROR', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentDecisionLog(
        TALENT_ID,
        undefined,
        'abc',
        undefined,
        makeAuth(),
        'req-dl-c5',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(service.getDecisionLog).not.toHaveBeenCalled();
  });

  // §9 unit test 4: event_type enum validation → 400 VALIDATION_ERROR
  it('accepts each value of the closed event_type set', async () => {
    const closedSet = [
      'consent.grant.recorded',
      'consent.revoke.recorded',
      'consent.check.decision',
    ] as const;
    for (const value of closedSet) {
      const service = makeFullService();
      const controller = new ConsentController(service as unknown as ConsentService);
      await controller.getTalentConsentDecisionLog(
        TALENT_ID,
        value,
        undefined,
        undefined,
        makeAuth(),
        `req-dl-c6-${value}`,
      );
      expect(service.getDecisionLog.mock.calls[0][1]).toBe(value);
    }
  });

  it('rejects unknown event_type with VALIDATION_ERROR (PR-7 §9 test 4)', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentDecisionLog(
        TALENT_ID,
        'consent.expire.recorded',
        undefined,
        undefined,
        makeAuth(),
        'req-dl-c7',
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { invalid_field: 'event_type' } },
    });
    expect(service.getDecisionLog).not.toHaveBeenCalled();
  });

  it('rejects empty-string event_type as undefined (treated as no filter)', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await controller.getTalentConsentDecisionLog(
      TALENT_ID,
      '',
      undefined,
      undefined,
      makeAuth(),
      'req-dl-c8',
    );
    expect(service.getDecisionLog.mock.calls[0][1]).toBeUndefined();
  });

  it('decodes a valid cursor and forwards the payload', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    const payload = { c: '2026-04-15T12:00:00.000Z', e: 'd2d7a0f0-0000-7000-8000-000000000001' };
    const cursorString = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    await controller.getTalentConsentDecisionLog(
      TALENT_ID,
      undefined,
      undefined,
      cursorString,
      makeAuth(),
      'req-dl-c9',
    );
    const cursorArg = service.getDecisionLog.mock.calls[0][3] as {
      created_at: Date;
      event_id: string;
    };
    expect(cursorArg.event_id).toBe('d2d7a0f0-0000-7000-8000-000000000001');
    expect(cursorArg.created_at.toISOString()).toBe('2026-04-15T12:00:00.000Z');
  });

  it('maps malformed cursor to HTTP 400 VALIDATION_ERROR (never propagates as 500)', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentDecisionLog(
        TALENT_ID,
        undefined,
        undefined,
        '!!!malformed!!!',
        makeAuth(),
        'req-dl-c10',
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      context: { details: { invalid_field: 'cursor' } },
    });
    expect(service.getDecisionLog).not.toHaveBeenCalled();
  });

  it('rejects malformed talent_id with VALIDATION_ERROR (before decoding cursor)', async () => {
    const service = makeFullService();
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.getTalentConsentDecisionLog(
        'not-a-uuid',
        undefined,
        undefined,
        undefined,
        makeAuth(),
        'req-dl-c11',
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { invalid_field: 'talent_id' } },
    });
    expect(service.getDecisionLog).not.toHaveBeenCalled();
  });
});
