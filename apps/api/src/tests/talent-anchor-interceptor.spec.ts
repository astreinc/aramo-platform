import { firstValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TalentAnchorInterceptor } from '../talent-anchor/talent-anchor.interceptor.js';

// TR-2a-3 (R7) — write-time trigger wiring on the anchor interceptor. Proves:
//   - on a talent-record WRITE, after the producer records anchors the interceptor
//     invokes the matcher for that subject (matchForRef) so fresh advisories surface;
//   - it is BEST-EFFORT — a matcher (or producer) failure is swallowed and the
//     original write response passes through unchanged (never fails the talent write);
//   - non-write routes are untouched.

const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

function ctx(method: string, path: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, route: { path } }) }),
  } as unknown as ExecutionContext;
}

function handlerOf(value: unknown): CallHandler {
  return { handle: () => of(value) } as CallHandler;
}

const WRITE_VIEW = { id: TALENT, tenant_id: TENANT, email1: 'a@example.com' };

describe('TalentAnchorInterceptor — write-time matcher trigger (R7)', () => {
  it('records anchors THEN runs the matcher for the subject, returns the write response', async () => {
    const recordAnchorsForView = vi.fn(async () => 1);
    const matchForRef = vi.fn(async () => []);
    const interceptor = new TalentAnchorInterceptor(
      { recordAnchorsForView } as never,
      { matchForRef } as never,
    );

    const out = await firstValueFrom(
      interceptor.intercept(ctx('POST', '/v1/talent-records'), handlerOf(WRITE_VIEW)),
    );

    expect(recordAnchorsForView).toHaveBeenCalledTimes(1);
    expect(matchForRef).toHaveBeenCalledTimes(1);
    // Matcher keyed by the ATS_TALENT_RECORD ref the producer just wrote.
    expect(matchForRef).toHaveBeenCalledWith(TENANT, 'ATS_TALENT_RECORD', TALENT);
    expect(out).toBe(WRITE_VIEW);
  });

  it('is best-effort — a matcher failure does NOT fail the talent write', async () => {
    const recordAnchorsForView = vi.fn(async () => 1);
    const matchForRef = vi.fn(async () => {
      throw new Error('matcher boom');
    });
    const interceptor = new TalentAnchorInterceptor(
      { recordAnchorsForView } as never,
      { matchForRef } as never,
    );

    const out = await firstValueFrom(
      interceptor.intercept(ctx('POST', '/v1/talent-records'), handlerOf(WRITE_VIEW)),
    );
    // The write response still passes through unchanged.
    expect(out).toBe(WRITE_VIEW);
  });

  it('is best-effort — a producer failure does NOT fail the talent write (matcher not reached)', async () => {
    const recordAnchorsForView = vi.fn(async () => {
      throw new Error('producer boom');
    });
    const matchForRef = vi.fn(async () => []);
    const interceptor = new TalentAnchorInterceptor(
      { recordAnchorsForView } as never,
      { matchForRef } as never,
    );

    const out = await firstValueFrom(
      interceptor.intercept(ctx('PATCH', '/v1/talent-records/:id'), handlerOf(WRITE_VIEW)),
    );
    expect(out).toBe(WRITE_VIEW);
    expect(matchForRef).not.toHaveBeenCalled();
  });

  it('leaves non-write routes untouched (no anchors, no matcher)', async () => {
    const recordAnchorsForView = vi.fn(async () => 0);
    const matchForRef = vi.fn(async () => []);
    const interceptor = new TalentAnchorInterceptor(
      { recordAnchorsForView } as never,
      { matchForRef } as never,
    );

    const out = await firstValueFrom(
      interceptor.intercept(ctx('GET', '/v1/talent-records/:id'), handlerOf(WRITE_VIEW)),
    );
    expect(out).toBe(WRITE_VIEW);
    expect(recordAnchorsForView).not.toHaveBeenCalled();
    expect(matchForRef).not.toHaveBeenCalled();
  });
});
