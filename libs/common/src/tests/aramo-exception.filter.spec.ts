import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AramoError } from '../lib/errors/aramo-error.js';
import { AramoExceptionFilter } from '../lib/errors/aramo-exception.filter.js';

interface MockResponse {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
}

function makeHost(requestId: string | undefined): {
  host: { switchToHttp: () => { getRequest: () => unknown; getResponse: () => MockResponse } };
  res: MockResponse;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res: MockResponse = { status, json };
  return {
    res,
    host: {
      switchToHttp: () => ({
        getRequest: () => ({ requestId }),
        getResponse: () => res,
      }),
    },
  };
}

describe('AramoExceptionFilter', () => {
  it('renders the locked nested envelope for an AramoError', () => {
    const filter = new AramoExceptionFilter();
    const err = new AramoError('VALIDATION_ERROR', 'bad body', 400, {
      requestId: 'req-1',
      details: { field: 'talent_id' },
      displayMessage: 'Please correct the request',
      logMessage: 'validation_failed',
    });
    const { host, res } = makeHost('req-1');
    filter.catch(err, host as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad body',
        display_message: 'Please correct the request',
        log_message: 'validation_failed',
        request_id: 'req-1',
        details: { field: 'talent_id' },
      },
    });
  });

  it('omits display_message and log_message when not provided', () => {
    const filter = new AramoExceptionFilter();
    const err = new AramoError('AUTH_REQUIRED', 'no auth', 401, {
      requestId: 'req-2',
    });
    const { host, res } = makeHost('req-2');
    filter.catch(err, host as never);
    const payload = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect((payload as { error: Record<string, unknown> }).error.display_message).toBeUndefined();
    expect((payload as { error: Record<string, unknown> }).error.log_message).toBeUndefined();
  });

  // Status-code-keyed switch — one case per branch.
  it('maps HttpException 400 → VALIDATION_ERROR', () => {
    const filter = new AramoExceptionFilter();
    const { host, res } = makeHost('req-400');
    filter.catch(new BadRequestException(['talent_id must be a UUID']), host as never);
    expect(res.status).toHaveBeenCalledWith(400);
    const payload = res.json.mock.calls[0][0] as { error: { code: string; request_id: string } };
    expect(payload.error.code).toBe('VALIDATION_ERROR');
    expect(payload.error.request_id).toBe('req-400');
  });

  it('maps HttpException 401 → AUTH_REQUIRED', () => {
    const filter = new AramoExceptionFilter();
    const { host, res } = makeHost('req-401');
    filter.catch(new UnauthorizedException('no auth'), host as never);
    expect(res.status).toHaveBeenCalledWith(401);
    const payload = res.json.mock.calls[0][0] as { error: { code: string } };
    expect(payload.error.code).toBe('AUTH_REQUIRED');
  });

  it('maps HttpException 403 → TENANT_ACCESS_DENIED', () => {
    const filter = new AramoExceptionFilter();
    const { host, res } = makeHost('req-403');
    filter.catch(new ForbiddenException('forbidden'), host as never);
    expect(res.status).toHaveBeenCalledWith(403);
    const payload = res.json.mock.calls[0][0] as { error: { code: string } };
    expect(payload.error.code).toBe('TENANT_ACCESS_DENIED');
  });

  it('maps HttpException 409 → IDEMPOTENCY_KEY_CONFLICT', () => {
    const filter = new AramoExceptionFilter();
    const { host, res } = makeHost('req-409');
    filter.catch(new HttpException('conflict', 409), host as never);
    expect(res.status).toHaveBeenCalledWith(409);
    const payload = res.json.mock.calls[0][0] as { error: { code: string } };
    expect(payload.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('maps HttpException 500 → INTERNAL_ERROR (status-code default branch)', () => {
    const filter = new AramoExceptionFilter();
    const { host, res } = makeHost('req-500');
    filter.catch(new InternalServerErrorException('boom'), host as never);
    expect(res.status).toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0] as { error: { code: string } };
    expect(payload.error.code).toBe('INTERNAL_ERROR');
  });

  it('maps HttpException with non-enumerated status (e.g. 418) → INTERNAL_ERROR', () => {
    const filter = new AramoExceptionFilter();
    const { host, res } = makeHost('req-418');
    filter.catch(new HttpException("I'm a teapot", 418), host as never);
    expect(res.status).toHaveBeenCalledWith(418);
    const payload = res.json.mock.calls[0][0] as { error: { code: string } };
    expect(payload.error.code).toBe('INTERNAL_ERROR');
  });

  it('maps an unknown thrown value (generic Error) → 500 + INTERNAL_ERROR with empty details', () => {
    const filter = new AramoExceptionFilter();
    const { host, res } = makeHost('req-unknown');
    filter.catch(new Error('boom'), host as never);
    expect(res.status).toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0] as {
      error: { code: string; request_id: string; details: object };
    };
    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(payload.error.request_id).toBe('req-unknown');
    expect(payload.error.details).toEqual({});
  });
});
