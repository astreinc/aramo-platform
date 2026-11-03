// M-A11 §4 — the signup transport is unauthenticated like auth/nativeAuthApi.ts: no
// Authorization, no consumer header, credentials omitted; it sends the app user agent.
import { createSignupApi } from '../signupApi';

function fakeFetch(status: number, body: unknown) {
  return jest.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

const api = (fetch: ReturnType<typeof fakeFetch>) =>
  createSignupApi({
    baseUrl: 'https://sign.aramo.ai',
    fetch,
    userAgent: 'AramoSign/1.0.0 (android 34)',
  });

describe('signup transport', () => {
  it('start: POST, no credentials of any kind, the app user agent', async () => {
    const fetch = fakeFetch(202, { signup_id: 'su-1' });
    const body = {
      client: 'android' as const,
      name: 'Pat Lee',
      email: 'pat.lee@gmail.com',
      phone: '+14155550100',
      residence: 'US' as const,
      invite_code: null,
      hp: '' as const,
      elapsed_ms: 1200,
      integrity_token: 'tok',
    };
    await expect(api(fetch).start(body)).resolves.toEqual({ signup_id: 'su-1' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://sign.aramo.ai/v1/signup/sign/personal/start');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toEqual(
      expect.arrayContaining(['authorization']),
    );
    expect(headers['X-Aramo-Consumer']).toBeUndefined();
    expect(headers['User-Agent']).toBe('AramoSign/1.0.0 (android 34)');
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('terms list (404 = off), terms text by key and version', async () => {
    expect(await api(fakeFetch(404, { error: { code: 'NOT_FOUND' } })).listTerms()).toEqual({
      off: true,
    });
    expect(await api(fakeFetch(200, { documents: null })).listTerms()).toEqual({
      off: false,
      documents: null,
    });
    const fetch = fakeFetch(200, {
      key: 'sign.terms_of_service',
      version: '2.0',
      sha256: 'ab',
      effective_at: 'x',
      text: 't',
    });
    await api(fetch).termsText('sign.terms_of_service', '2.0');
    expect(fetch.mock.calls[0]![0]).toBe(
      'https://sign.aramo.ai/v1/signup/sign/personal/terms/sign.terms_of_service/2.0',
    );
    expect(fetch.mock.calls[0]![1].method).toBe('GET');
  });

  it('complete sends client android and {key, version, sha256} only', async () => {
    const fetch = fakeFetch(200, {
      status: 'PROVISIONED',
      email: 'e',
      sign_in: { google: 'g' },
      held: null,
    });
    await api(fetch).complete('su-1', [
      { key: 'k', version: '1.0', sha256: 'h', extra: 1 } as never,
    ]);
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({
      signup_id: 'su-1',
      client: 'android',
      accept: [{ key: 'k', version: '1.0', sha256: 'h' }],
    });
  });

  it('codes and phone: next steps, sent flag, refusals carry the reason', async () => {
    expect(await api(fakeFetch(200, { next: 'phone' })).verifyEmail('su-1', '123456')).toBe(
      'phone',
    );
    expect(await api(fakeFetch(200, { sent: false })).sendPhoneCode('su-1')).toBe(false);
    expect(await api(fakeFetch(200, { next: 'terms' })).verifyPhone('su-1', '123456')).toBe(
      'terms',
    );
    await expect(
      api(
        fakeFetch(400, {
          error: {
            code: 'VALIDATION_ERROR',
            details: { reason: 'code_invalid', attempts_remaining: 2 },
          },
        }),
      ).verifyEmail('su-1', '1'),
    ).rejects.toMatchObject({ status: 400, reason: 'code_invalid' });
  });
});
