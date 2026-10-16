import { createHash } from 'node:crypto';

import { AramoError } from '@aramo/common';
import { describe, expect, it, vi } from 'vitest';

import { LOGO_MAX_BYTES, RtrTemplateTenantLogoService, sniffImageMime } from '../rtr/rtr-template-tenant-logo.service.js';

// Amendment A1 §2.4 — tenant-profile logo capture: fetched ONCE at the admin action from
// Tenant.logo_url (https only, no IP-literal/local hosts, no redirects, 5 s, 1 MB,
// PNG/JPEG by declared type AND magic bytes), stored in documents object storage. The
// fetch is mocked — no network.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

function service(opts: { logo_url?: string | null; response?: () => Response | Promise<Response> }) {
  const tenants = {
    findBrandingById: async () => ({ name: 'ws', display_name: 'Astre', legal_name: 'Astre Inc.', logo_url: opts.logo_url === undefined ? 'https://cdn.example.com/logo.png' : opts.logo_url }),
  };
  const storage = { putArtifact: vi.fn(async () => ({ storage_key: 'k', sha256: 's' })), getArtifact: vi.fn(async () => PNG) };
  const fetcher = vi.fn(async () => (opts.response ?? (() => new Response(PNG, { headers: { 'content-type': 'image/png' } })))());
  return { svc: new RtrTemplateTenantLogoService(tenants as never, storage as never, fetcher as never), storage, fetcher };
}

async function reason(p: Promise<unknown>): Promise<{ status: number; reason: unknown }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AramoError);
    return { status: (e as AramoError).statusCode, reason: ((e as AramoError).context.details as { reason?: unknown })?.reason };
  }
  throw new Error('expected a refusal');
}

describe('RtrTemplateTenantLogoService (A1 §2.4)', () => {
  it('captures a PNG: stores the exact bytes and returns sha256 + mime + locator; fetch is https, no redirects', async () => {
    const { svc, storage, fetcher } = service({});
    const out = await svc.capture({ tenant_id: 't-1', requestId: 'r' });
    const sha = createHash('sha256').update(PNG).digest('hex');
    expect(out).toEqual({ sha256: sha, mime: 'image/png', storage_provider: 'aramo-s3', storage_locator: `documents/t-1/template-assets/logo/${sha}.png`, byte_size: PNG.byteLength });
    expect(storage.putArtifact).toHaveBeenCalledWith({ storage_key: out.storage_locator, body: PNG, content_type: 'image/png', requestId: 'r' });
    expect((fetcher.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('no logo on the Tenant profile → 409 no_tenant_logo (no fetch)', async () => {
    const { svc, fetcher } = service({ logo_url: null });
    expect(await reason(svc.capture({ tenant_id: 't', requestId: 'r' }))).toEqual({ status: 409, reason: 'no_tenant_logo' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('https only; IP-literal / localhost hosts refused (no fetch)', async () => {
    for (const [url, why] of [
      ['http://cdn.example.com/logo.png', 'logo_url_not_https'],
      ['https://169.254.169.254/latest', 'logo_url_host_refused'],
      ['https://localhost/logo.png', 'logo_url_host_refused'],
      ['https://[::1]/logo.png', 'logo_url_host_refused'],
      ['not a url', 'logo_url_invalid'],
    ] as const) {
      const { svc, fetcher } = service({ logo_url: url });
      expect(await reason(svc.capture({ tenant_id: 't', requestId: 'r' }))).toEqual({ status: 422, reason: why });
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it('size cap: declared content-length over 1 MB, or a streamed body over 1 MB → logo_too_large; nothing stored', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(LOGO_MAX_BYTES)]);
    const declared = service({ response: () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(LOGO_MAX_BYTES + 1) } }) });
    expect(await reason(declared.svc.capture({ tenant_id: 't', requestId: 'r' }))).toEqual({ status: 422, reason: 'logo_too_large' });
    const streamed = service({ response: () => new Response(big, { headers: { 'content-type': 'image/png' } }) });
    expect(await reason(streamed.svc.capture({ tenant_id: 't', requestId: 'r' }))).toEqual({ status: 422, reason: 'logo_too_large' });
    expect(streamed.storage.putArtifact).not.toHaveBeenCalled();
  });

  it('type: declared type must be png/jpeg AND match the magic bytes', async () => {
    const svgDeclared = service({ response: () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }) });
    expect(await reason(svgDeclared.svc.capture({ tenant_id: 't', requestId: 'r' }))).toEqual({ status: 422, reason: 'logo_type_invalid' });
    const lying = service({ response: () => new Response('<html>', { headers: { 'content-type': 'image/png' } }) });
    expect(await reason(lying.svc.capture({ tenant_id: 't', requestId: 'r' }))).toEqual({ status: 422, reason: 'logo_type_invalid' });
    const mismatch = service({ response: () => new Response(JPEG, { headers: { 'content-type': 'image/png' } }) });
    expect(await reason(mismatch.svc.capture({ tenant_id: 't', requestId: 'r' }))).toEqual({ status: 422, reason: 'logo_type_invalid' });
    const jpeg = service({ response: () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg; charset=binary' } }) });
    expect((await jpeg.svc.capture({ tenant_id: 't', requestId: 'r' })).mime).toBe('image/jpeg');
  });

  it('fetch failures (network error / non-2xx) → logo_fetch_failed', async () => {
    const net = service({ response: () => Promise.reject(new Error('ECONNRESET')) });
    expect(await reason(net.svc.capture({ tenant_id: 't', requestId: 'r' }))).toEqual({ status: 422, reason: 'logo_fetch_failed' });
    const http = service({ response: () => new Response('nope', { status: 404 }) });
    expect(await reason(http.svc.capture({ tenant_id: 't', requestId: 'r' }))).toEqual({ status: 422, reason: 'logo_fetch_failed' });
  });

  it('info: available iff Tenant.logo_url is set; tenant_name = display → legal → workspace', async () => {
    expect(await service({}).svc.info('t')).toEqual({ available: true, tenant_name: 'Astre' });
    expect(await service({ logo_url: '  ' }).svc.info('t')).toEqual({ available: false, tenant_name: 'Astre' });
  });

  it('sniffImageMime recognises PNG / JPEG only', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBeNull();
  });
});
