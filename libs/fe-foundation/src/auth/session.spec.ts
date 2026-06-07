import { describe, expect, it, vi } from 'vitest';

import { fetchSession, type Session } from './session';

const sample: Session = {
  sub: '00000000-0000-0000-0000-000000000001',
  consumer_type: 'recruiter',
  tenant_id: '00000000-0000-0000-0000-000000000002',
  scopes: ['session:read'],
  iat: 1_700_000_000,
  exp: 1_700_000_900,
};

describe('fetchSession', () => {
  it('returns the parsed session on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(sample), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(fetchSession()).resolves.toEqual(sample);
  });

  it('returns null on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 401 }),
    );

    await expect(fetchSession()).resolves.toBeNull();
  });

  it('rethrows on non-401 failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500 }),
    );

    await expect(fetchSession()).rejects.toThrow(/500/);
  });
});
