import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EsignRepository, EsignService } from '@aramo/esign';

import { NativeAramoSignatureProvider } from '../app/native-aramo-signature.provider.js';

function mkRepo(): EsignRepository {
  return {
    getEnvelope: vi.fn(async () => ({ created_by: 'actor-1', status: 'SENT' })),
    getEnvelopeFull: vi.fn(async () => ({
      id: 'env-1',
      status: 'SENT',
      subject: 'Right to Represent',
      signers: [{ id: 'sg-1', email: 'talent@example.com', name: 'Talent X', status: 'PENDING' }],
    })),
  } as unknown as EsignRepository;
}

function mkService(): EsignService {
  return {
    send: vi.fn(async () => ({
      envelope: {},
      sessions: [{ session_id: 'sess-1', signer_id: 'sg-1', raw_token: 'RAW-TOKEN-123' }],
    })),
  } as unknown as EsignService;
}

describe('NativeAramoSignatureProvider.sendEnvelope — OC-1 signer delivery', () => {
  afterEach(() => {
    delete process.env['ESIGN_SIGN_WEB_BASE_URL'];
    vi.restoreAllMocks();
  });

  it('dispatches SIGNATURE_REQUEST with an in-memory Sign Web URL carrying the raw token', async () => {
    process.env['ESIGN_SIGN_WEB_BASE_URL'] = 'https://sign.aramo.ai/';
    const notifier = { notify: vi.fn(async () => ({ delivered: true })) };
    const provider = new NativeAramoSignatureProvider(mkRepo(), mkService(), notifier);

    await provider.sendEnvelope('tenant-1', 'env-1');

    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith({
      kind: 'SIGNATURE_REQUEST',
      to_email: 'talent@example.com',
      to_name: 'Talent X',
      envelope_subject: 'Right to Represent',
      // trailing slash on the base is normalized; token is the raw capability.
      signing_url: 'https://sign.aramo.ai/s/RAW-TOKEN-123',
    });
  });

  it('does not dispatch (and does not throw) when the Sign Web origin is unset', async () => {
    const notifier = { notify: vi.fn(async () => ({ delivered: true })) };
    const provider = new NativeAramoSignatureProvider(mkRepo(), mkService(), notifier);
    await expect(provider.sendEnvelope('tenant-1', 'env-1')).resolves.toBeDefined();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('swallows a delivery-provider failure (envelope stays SENT; delivery is retryable)', async () => {
    process.env['ESIGN_SIGN_WEB_BASE_URL'] = 'https://sign.aramo.ai';
    const notifier = { notify: vi.fn(async () => { throw new Error('SES down'); }) };
    const provider = new NativeAramoSignatureProvider(mkRepo(), mkService(), notifier);
    await expect(provider.sendEnvelope('tenant-1', 'env-1')).resolves.toBeDefined();
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('is a no-op notifier path when no notification port is bound', async () => {
    process.env['ESIGN_SIGN_WEB_BASE_URL'] = 'https://sign.aramo.ai';
    const provider = new NativeAramoSignatureProvider(mkRepo(), mkService(), undefined);
    await expect(provider.sendEnvelope('tenant-1', 'env-1')).resolves.toBeDefined();
  });
});
