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
