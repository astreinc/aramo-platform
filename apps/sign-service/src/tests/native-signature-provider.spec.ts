import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EsignRepository, EsignService } from '@aramo/sign';

import type { AramoSignAllowanceGate } from '../app/aramo-sign-allowance.gate.js';
import { NativeAramoSignatureProvider } from '../app/native-aramo-signature.provider.js';

// The allowance gate is exercised in its own spec; here it passes the send through.
const passGate = { guardSend: <T,>(_t: string, _e: string, send: () => Promise<T>) => send() } as unknown as AramoSignAllowanceGate;

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
    delete process.env['SIGN_WEB_BASE_URL'];
    vi.restoreAllMocks();
  });

  it('dispatches SIGNATURE_REQUEST with an in-memory Sign Web URL carrying the raw token', async () => {
    process.env['SIGN_WEB_BASE_URL'] = 'https://sign.aramo.ai/';
    const notifier = { notify: vi.fn(async () => ({ delivered: true })) };
    const provider = new NativeAramoSignatureProvider(mkRepo(), mkService(), passGate, notifier);

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
    const provider = new NativeAramoSignatureProvider(mkRepo(), mkService(), passGate, notifier);
    await expect(provider.sendEnvelope('tenant-1', 'env-1')).resolves.toBeDefined();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('swallows a delivery-provider failure (envelope stays SENT; delivery is retryable)', async () => {
    process.env['SIGN_WEB_BASE_URL'] = 'https://sign.aramo.ai';
    const notifier = { notify: vi.fn(async () => { throw new Error('SES down'); }) };
    const provider = new NativeAramoSignatureProvider(mkRepo(), mkService(), passGate, notifier);
    await expect(provider.sendEnvelope('tenant-1', 'env-1')).resolves.toBeDefined();
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('is a no-op notifier path when no notification port is bound', async () => {
    process.env['SIGN_WEB_BASE_URL'] = 'https://sign.aramo.ai';
    const provider = new NativeAramoSignatureProvider(mkRepo(), mkService(), passGate, undefined);
    await expect(provider.sendEnvelope('tenant-1', 'env-1')).resolves.toBeDefined();
  });
  // Aramo-Sign-Multi-Signer-Amendment-v1_0-LOCKED §7 — usage is one envelope per send,
  // whatever the signer count: the gate is entered once, keyed by the envelope id.
  it('charges a multi-signer envelope once per send while inviting every signer', async () => {
    process.env['SIGN_WEB_BASE_URL'] = 'https://sign.aramo.ai';
    const repo = mkRepo();
    const signers = [1, 2, 3].map((n) => ({ id: `sg-${n}`, email: `s${n}@example.com`, name: `Signer ${n}`, status: 'PENDING' }));
    (repo.getEnvelopeFull as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'env-1', status: 'SENT', subject: 'Agreement', signers });
    const service = {
      send: vi.fn(async () => ({ envelope: {}, sessions: signers.map((s, i) => ({ session_id: `sess-${i}`, signer_id: s.id, raw_token: `RAW-${i}` })) })),
    } as unknown as EsignService;
    const guardSend = vi.fn(<T,>(_t: string, _e: string, send: () => Promise<T>) => send());
    const notifier = { notify: vi.fn(async () => ({ delivered: true })) };
    const provider = new NativeAramoSignatureProvider(repo, service, { guardSend } as unknown as AramoSignAllowanceGate, notifier);

    await provider.sendEnvelope('tenant-1', 'env-1');

    expect(guardSend).toHaveBeenCalledTimes(1);
    expect(guardSend).toHaveBeenCalledWith('tenant-1', 'env-1', expect.any(Function));
    expect(notifier.notify).toHaveBeenCalledTimes(3);
  });
});
