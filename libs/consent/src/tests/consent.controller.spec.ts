import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { describe, expect, it, vi } from 'vitest';

import { ConsentController } from '../lib/consent.controller.js';
import type { ConsentService } from '../lib/consent.service.js';
import type { ConsentGrantRequestDto } from '../lib/dto/consent-grant-request.dto.js';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';
const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';
const VALID_KEY = 'd2d7a0f0-0000-7000-8000-000000000001';

function makeRequest(): ConsentGrantRequestDto {
  return {
    talent_id: TALENT_ID,
    scope: 'matching',
    captured_method: 'recruiter_capture',
    consent_version: 'v1',
    occurred_at: '2026-04-29T00:00:00Z',
  } as ConsentGrantRequestDto;
}

function makeAuth(): AuthContextType {
  return {
    sub: RECRUITER_ID,
    consumer_type: 'recruiter',
    tenant_id: TENANT_ID,
    scopes: ['consent:write'],
    iat: 0,
    exp: 9_999_999_999,
  };
}

describe('ConsentController', () => {
  it('delegates to ConsentService.grant on a valid request', async () => {
    const service = { grant: vi.fn().mockResolvedValue({ event_id: 'e1' }) };
    const controller = new ConsentController(service as unknown as ConsentService);
    const result = await controller.grantConsent(makeRequest(), VALID_KEY, makeAuth(), 'req-1');
    expect(service.grant).toHaveBeenCalledOnce();
    expect(result).toEqual({ event_id: 'e1' });
  });

  it('throws VALIDATION_ERROR when Idempotency-Key is missing', async () => {
    const service = { grant: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.grantConsent(makeRequest(), undefined, makeAuth(), 'req-2'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    expect(service.grant).not.toHaveBeenCalled();
  });

  it('throws VALIDATION_ERROR when Idempotency-Key is empty', async () => {
    const service = { grant: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.grantConsent(makeRequest(), '', makeAuth(), 'req-3'),
    ).rejects.toBeInstanceOf(AramoError);
  });

  it('throws VALIDATION_ERROR when Idempotency-Key is not a UUID', async () => {
    const service = { grant: vi.fn() };
    const controller = new ConsentController(service as unknown as ConsentService);
    await expect(
      controller.grantConsent(makeRequest(), 'not-a-uuid', makeAuth(), 'req-4'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { invalid_field: 'Idempotency-Key' } },
    });
  });
});
