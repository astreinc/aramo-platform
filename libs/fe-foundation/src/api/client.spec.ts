import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient, ApiError } from './client';

function mockFetchOnce(response: Response) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApiClient', () => {
  it('parses JSON body on 2xx and includes credentials', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const client = new ApiClient();
    const result = await client.get<{ ok: boolean }>('/v1/anything');

    expect(result).toEqual({ ok: true });
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('include');
    expect(init?.method).toBe('GET');
  });

  it('returns undefined on 204', async () => {
    mockFetchOnce(new Response(null, { status: 204 }));
    const client = new ApiClient();
    const result = await client.delete<undefined>('/v1/x');
    expect(result).toBeUndefined();
  });

  it('surfaces a structured ApiError with code + details on a 400', async () => {
    // The backend's S2 VALIDATION_ERROR envelope (verbatim shape).
    mockFetchOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'bad value',
            details: { reason: 'invalid_value', key: 'compensation.display_default' },
          },
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = new ApiClient();
    const err = await client
      .put('/v1/tenant/settings/compensation.display_default', { value: 'nope' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(400);
    expect(apiErr.code).toBe('VALIDATION_ERROR');
    expect(apiErr.message).toBe('bad value');
    expect(apiErr.details).toEqual({
      reason: 'invalid_value',
      key: 'compensation.display_default',
    });
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    mockFetchOnce(
      new Response('not-json', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const client = new ApiClient();
    const err = (await client
      .get('/v1/oops')
      .catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(500);
    expect(err.code).toBeUndefined();
    expect(err.details).toBeUndefined();
    expect(err.message).toContain('Request failed');
    expect(err.message).toContain('500');
  });

  it('sends Content-Type: application/json on PUT/PATCH/POST with a body', async () => {
    // Each call gets a fresh Response — Body can be read only once.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify({}), { status: 200 }),
      );

    const client = new ApiClient();
    await client.put('/v1/p', { value: 'both' });
    await client.patch('/v1/p', { roles: ['recruiter'] });
    await client.post('/v1/p', { a: 1 });

    for (const call of fetchSpy.mock.calls) {
      const init = call[1];
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(typeof init?.body).toBe('string');
    }
  });
});

// Refresh-on-401 — the self-healing access-token refresh. The 15-min access
// cookie expires while the 30-day refresh cookie is still valid; a 401 must
// transparently re-mint and retry, not dead-end on "could not be loaded".
describe('ApiClient — refresh-on-401', () => {
  function url(input: RequestInfo | URL): string {
    return typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;
  }

  function nthUrl(spy: ReturnType<typeof vi.spyOn>, n: number): string {
    const call = spy.mock.calls[n];
    if (call === undefined) return '';
    return url(call[0] as RequestInfo | URL);
  }

  it('a 401 triggers POST /refresh, then retries the original request and returns its data', async () => {
    let firstCall = true;
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const u = url(input);
        if (u.endsWith('/auth/recruiter/refresh')) {
          expect(init?.method).toBe('POST');
          return new Response(null, { status: 200 });
        }
        if (u.endsWith('/v1/requisitions')) {
          if (firstCall) {
            firstCall = false;
            return new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED' } }), {
              status: 401,
            });
          }
          return new Response(JSON.stringify({ items: [{ id: 'r1' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(null, { status: 404 });
      });

    const client = new ApiClient();
    const result = await client.get<{ items: unknown[] }>('/v1/requisitions');
    expect(result).toEqual({ items: [{ id: 'r1' }] });
    // GET(401) → POST /refresh → GET(200): exactly 3 fetches.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(nthUrl(fetchSpy, 1)).toContain('/auth/recruiter/refresh');
  });

  it('when /refresh ALSO 401s, the original 401 is surfaced (no infinite loop)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const u = url(input);
        if (u.endsWith('/auth/recruiter/refresh')) {
          return new Response(JSON.stringify({ error: { code: 'REFRESH_TOKEN_INVALID' } }), {
            status: 401,
          });
        }
        return new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED' } }), {
          status: 401,
        });
      });

    const client = new ApiClient();
    const err = (await client.get('/v1/requisitions').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    // GET(401) → POST /refresh(401) → give up (no second retry): 2 fetches.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('concurrent 401s share ONE /refresh (the rotating refresh token is not double-spent)', async () => {
    let refreshCount = 0;
    const pending: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = url(input);
      if (u.endsWith('/auth/recruiter/refresh')) {
        refreshCount += 1;
        // Small async gap so the second 401 lands while refresh is in flight.
        await new Promise((r) => setTimeout(r, 5));
        return new Response(null, { status: 200 });
      }
      // First time each endpoint is hit → 401; second time → 200.
      const n = pending.filter((p) => p === (u.endsWith('/v1/a') ? 0 : 1)).length;
      pending.push(u.endsWith('/v1/a') ? 0 : 1);
      if (n === 0) {
        return new Response(JSON.stringify({ error: { code: 'AUTH_REQUIRED' } }), {
          status: 401,
        });
      }
      return new Response(JSON.stringify({ ok: u }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new ApiClient();
    const [a, b] = await Promise.all([
      client.get<{ ok: string }>('/v1/a'),
      client.get<{ ok: string }>('/v1/b'),
    ]);
    expect(a.ok).toContain('/v1/a');
    expect(b.ok).toContain('/v1/b');
    // Both 401s shared a single refresh — not two.
    expect(refreshCount).toBe(1);
  });

  it('does not attempt a refresh on non-401 errors', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 }),
      );
    const client = new ApiClient();
    await client.get('/v1/missing').catch(() => undefined);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(nthUrl(fetchSpy, 0)).not.toContain('/refresh');
  });
});
