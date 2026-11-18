import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { accessCookieName } from '@aramo/auth';

import { AccountLinkController } from '../lib/account-link.controller.js';

// Amendment M-A18 (LOCKED) — GET / DELETE /auth/me/devices: the `sign` browser cookie only,
// DELETE needs X-Aramo-Consumer: sign, and the owner comes from the cookie alone.

const SUB = '01900000-0000-7000-8000-00000000a001';
const TENANT = '01900000-0000-7000-8000-00000000b001';
const PHONE = '01900000-0000-7000-8000-00000000c001';

function build(context: Record<string, unknown> = { sub: SUB, tenant_id: TENANT, consumer_type: 'sign' }) {
  const jwt = { verifyAccessToken: vi.fn(async () => ({ context, authz_version: 1 })) };
  const native = {
    listSessionsForBrowser: vi.fn(async () => ({ items: [] })),
    revokeSessionFromBrowser: vi.fn(async () => undefined),
  };
  const ctl = new AccountLinkController({} as never, jwt as never, native as never);
  return { ctl, jwt, native };
}

function req(opts: { headers?: Record<string, string>; cookies?: Record<string, string> } = {}) {
  const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    requestId: 'r',
    cookies: opts.cookies ?? { [accessCookieName('sign')]: 'cookie-token' },
    header: (name: string) => headers[name.toLowerCase()],
  } as never;
}
const res = () => ({ setHeader: vi.fn() }) as never;

async function refusal(p: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof AramoError)) throw e;
    return { status: e.statusCode, reason: (e.context.details as Record<string, unknown> | undefined)?.['reason'] };
  }
  throw new Error('expected a refusal');
}

describe('web Devices (M-A18)', () => {
  it('lists with the cookie owner and tenant only', async () => {
    const { ctl, native } = build();
    await ctl.listDevices('sign', req(), res());
    expect(native.listSessionsForBrowser).toHaveBeenCalledWith({ sub: SUB, tenant_id: TENANT });
  });

  it('signs a phone out with the cookie owner when X-Aramo-Consumer: sign is present', async () => {
    const { ctl, native } = build();
    await ctl.revokeDevice(PHONE, 'sign', req({ headers: { 'X-Aramo-Consumer': 'sign' } }), res());
    expect(native.revokeSessionFromBrowser).toHaveBeenCalledWith({ sub: SUB, tenant_id: TENANT }, PHONE, 'r');
  });

  it('DELETE without the X-Aramo-Consumer header is refused (CSRF)', async () => {
    const { ctl, native } = build();
    expect(await refusal(ctl.revokeDevice(PHONE, 'sign', req(), res()))).toEqual({ status: 401, reason: 'consumer_header_mismatch' });
    expect(native.revokeSessionFromBrowser).not.toHaveBeenCalled();
  });

  it('a Bearer token is refused: the app keeps its own routes', async () => {
    const { ctl } = build();
    expect(await refusal(ctl.listDevices('sign', req({ headers: { Authorization: 'Bearer x' } }), res()))).toEqual({
      status: 401,
      reason: 'browser_session_required',
    });
  });

  it('consumer other than sign → 400; no cookie → 401', async () => {
    const { ctl } = build();
    expect(await refusal(ctl.listDevices('recruiter', req(), res()))).toEqual({ status: 400, reason: 'invalid_consumer' });
    expect(await refusal(ctl.listDevices(undefined, req(), res()))).toEqual({ status: 400, reason: 'invalid_consumer' });
    expect(await refusal(ctl.listDevices('sign', req({ cookies: {} }), res()))).toEqual({ status: 401, reason: 'session_required' });
  });

  it('a cookie minted for another consumer, or a native token in a cookie, is refused', async () => {
    expect(await refusal(build({ sub: SUB, tenant_id: TENANT, consumer_type: 'recruiter' }).ctl.listDevices('sign', req(), res()))).toEqual({
      status: 401,
      reason: 'consumer_header_mismatch',
    });
    expect(
      await refusal(build({ sub: SUB, tenant_id: TENANT, consumer_type: 'sign', client: 'native' }).ctl.listDevices('sign', req(), res())),
    ).toEqual({ status: 401, reason: 'consumer_header_mismatch' });
  });

  it('a declared consumer other than sign is refused', async () => {
    const { ctl } = build();
    expect(await refusal(ctl.listDevices('sign', req({ headers: { 'X-Aramo-Consumer': 'recruiter' } }), res()))).toEqual({
      status: 401,
      reason: 'consumer_header_mismatch',
    });
  });
});
