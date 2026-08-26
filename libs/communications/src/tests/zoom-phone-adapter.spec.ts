import { describe, expect, it } from 'vitest';

import {
  ZoomPhoneAdapter,
  ZOOM_PHONE_PROVIDER_KEY,
  ZoomAdapterDeferredError,
} from '../lib/provider/zoom/zoom-phone.adapter.js';
import {
  encodeZoomCredential,
  decodeZoomCredential,
  ZoomCredentialDecodeError,
} from '../lib/provider/zoom/zoom-credential.js';

// COMM-B3 — ZoomPhoneAdapter (connection-binding scaffold) + credential codec.
// The adapter is exercised with NO live Zoom (real API deferred to B8): only the
// static capability descriptor, the health proxy, and the deferred-op guards.

describe('ZoomPhoneAdapter', () => {
  const adapter = new ZoomPhoneAdapter();

  it('binds the locked provider key "zoom_phone"', () => {
    expect(adapter.providerKey()).toBe('zoom_phone');
    expect(ZOOM_PHONE_PROVIDER_KEY).toBe('zoom_phone');
  });

  it('reports a static provider-neutral capability descriptor (outbound voice + embedded)', () => {
    const caps = adapter.getCapabilities();
    expect(caps.voice.outbound).toBe(true);
    expect(caps.voice.embedded).toBe(true);
    expect(caps.recording).toBe(true);
  });

  it('validateConnection: healthy iff a provider account id is bound', async () => {
    const ok = await adapter.validateConnection({
      id: 'c1',
      tenant_id: 't1',
      provider_key: 'zoom_phone',
      provider_account_id: 'zoom-acct-1',
    });
    expect(ok.healthy).toBe(true);
    const missing = await adapter.validateConnection({
      id: 'c1',
      tenant_id: 't1',
      provider_key: 'zoom_phone',
      provider_account_id: null,
    });
    expect(missing.healthy).toBe(false);
  });

  it('defers live operations (initiateCall=B5, normalizeWebhook=B6) rather than inventing semantics', async () => {
    await expect(
      adapter.initiateCall({
        tenant_id: 't',
        integration_connection_id: 'c',
        channel: 'voice',
        direction: 'outbound',
        from_address: '+1',
        to_address: '+1',
      }),
    ).rejects.toBeInstanceOf(ZoomAdapterDeferredError);
    await expect(adapter.normalizeWebhook({})).rejects.toBeInstanceOf(ZoomAdapterDeferredError);
  });
});

describe('Zoom credential codec (opaque-token storage)', () => {
  it('round-trips a token bundle through the opaque credential string', () => {
    const bundle = {
      access_token: 'at-123',
      refresh_token: 'rt-456',
      token_type: 'bearer',
      account_id: 'acct-9',
      expires_at: '2026-09-01T00:00:00Z',
    };
    const raw = encodeZoomCredential(bundle);
    expect(typeof raw).toBe('string');
    const decoded = decodeZoomCredential(raw);
    expect(decoded).toEqual(bundle);
  });

  it('rejects an empty access_token on encode and malformed input on decode', () => {
    expect(() => encodeZoomCredential({ access_token: '' })).toThrow(ZoomCredentialDecodeError);
    expect(() => decodeZoomCredential('not json')).toThrow(ZoomCredentialDecodeError);
    expect(() => decodeZoomCredential('{"token_type":"bearer"}')).toThrow(ZoomCredentialDecodeError);
  });
});
