import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IndeedTokenService } from '../lib/indeed/indeed-token.service.js';
import {
  INDEED_CLIENT_ID_ENV,
  INDEED_CLIENT_SECRET_ENV,
} from '../lib/indeed/indeed.constants.js';

// SRC-2 PR-3 (R7) — the OAuth token service: fail-closed, cache, early refresh,
// shared in-flight fetch. `fetch` is stubbed; a controllable clock drives expiry.

function okToken(access_token: string, expires_in = 3600): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token, expires_in }),
    text: async () => '',
  } as unknown as Response;
}

describe('IndeedTokenService', () => {
  const origId = process.env[INDEED_CLIENT_ID_ENV];
  const origSecret = process.env[INDEED_CLIENT_SECRET_ENV];

  beforeEach(() => {
    process.env[INDEED_CLIENT_ID_ENV] = 'client-abc';
    process.env[INDEED_CLIENT_SECRET_ENV] = 'secret-xyz';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origId === undefined) delete process.env[INDEED_CLIENT_ID_ENV];
    else process.env[INDEED_CLIENT_ID_ENV] = origId;
    if (origSecret === undefined) delete process.env[INDEED_CLIENT_SECRET_ENV];
    else process.env[INDEED_CLIENT_SECRET_ENV] = origSecret;
  });

  it('fail-closed: unset credentials → isConfigured false + getAccessToken throws, no fetch', async () => {
    delete process.env[INDEED_CLIENT_ID_ENV];
    delete process.env[INDEED_CLIENT_SECRET_ENV];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const svc = new IndeedTokenService();
    expect(svc.isConfigured).toBe(false);
    await expect(svc.getAccessToken()).rejects.toThrow(/not configured/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches once and caches within the TTL window', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okToken('tok-1'));
    let clock = 1_000_000;
    const svc = new IndeedTokenService(() => clock);

    expect(await svc.getAccessToken()).toBe('tok-1');
    clock += 60_000; // still well inside 3600s - 60s skew
    expect(await svc.getAccessToken()).toBe('tok-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refreshes after the cached token expires', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(okToken('tok-1', 3600))
      .mockResolvedValueOnce(okToken('tok-2', 3600));
    let clock = 0;
    const svc = new IndeedTokenService(() => clock);

    expect(await svc.getAccessToken()).toBe('tok-1');
    clock += 3600 * 1000; // past (expires_in - skew)
    expect(await svc.getAccessToken()).toBe('tok-2');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight fetch across concurrent callers', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(okToken('tok-1'));
    const svc = new IndeedTokenService();
    const [a, b] = await Promise.all([svc.getAccessToken(), svc.getAccessToken()]);
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-ok token response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'unauthorized',
    } as unknown as Response);
    const svc = new IndeedTokenService();
    await expect(svc.getAccessToken()).rejects.toThrow(/token request failed/);
  });

  it('throws when the response omits access_token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ expires_in: 3600 }),
      text: async () => '',
    } as unknown as Response);
    const svc = new IndeedTokenService();
    await expect(svc.getAccessToken()).rejects.toThrow(/missing access_token/);
  });
});
