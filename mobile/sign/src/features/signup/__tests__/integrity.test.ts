// M-A11 §2.1 (Lead correction 1): the Play Integrity requestHash. The fixed vectors below are
// shared with the backend (platform-admin recomputes the same hash from the received body).
import { platformCrypto } from '../../../auth/pkce';
import { createHash } from 'node:crypto';

import { base64Decode, utf8Decode } from '../../../util/bytes';
import {
  canonicalStartArray,
  canonicalStartJson,
  createIntegritySession,
  integritySessionFor,
  startRequestHash,
  type IntegrityModule,
} from '../integrity';
import { appAttestToken, createAppAttestModule } from '../integrityModule.ios';
import type { NativeStartBody } from '../signupApi';

const VECTOR_1: NativeStartBody = {
  client: 'android',
  name: 'Pat Lee',
  email: 'pat.lee@gmail.com',
  phone: '+14155550100',
  residence: 'US',
  invite_code: null,
  hp: '',
  elapsed_ms: 8423,
};
const VECTOR_1_JSON = '["android","Pat Lee","pat.lee@gmail.com","+14155550100","US",null,"",8423]';
const VECTOR_1_HASH = 'fd66ae8ac42b6818c47718c68fc404bfb907a4ef5d0088161cc00a7223d5eba7';

const VECTOR_2: NativeStartBody = {
  client: 'android',
  name: 'Zoë Ñúñez 李',
  email: 'zoe@gmail.com',
  phone: '+919876543210',
  residence: 'IN',
  invite_code: 'PILOT-7',
  hp: '',
  elapsed_ms: 12000,
};
const VECTOR_2_HASH = '24f1edd3484417dd14b2ff29a707a9921e35813beeb6c065815a14f31fd5a9a0';

describe('requestHash (M-A11 §2.1)', () => {
  it('is the canonical array in the contract order, invite_code null when absent', () => {
    expect(JSON.stringify(canonicalStartArray(VECTOR_1))).toBe(VECTOR_1_JSON);
  });

  it('matches the fixed vectors (lowercase hex SHA-256 over UTF-8), through the platform adapter', async () => {
    expect(await startRequestHash(VECTOR_1, platformCrypto)).toBe(VECTOR_1_HASH);
    expect(await startRequestHash(VECTOR_2, platformCrypto)).toBe(VECTOR_2_HASH);
  });

  it('changes with any bound field, and never includes the token', async () => {
    const withToken = { ...VECTOR_1, integrity_token: 'tok' } as NativeStartBody;
    expect(await startRequestHash(withToken)).toBe(VECTOR_1_HASH);
    expect(await startRequestHash({ ...VECTOR_1, elapsed_ms: 8424 })).not.toBe(VECTOR_1_HASH);
    expect(await startRequestHash({ ...VECTOR_1, name: 'Pat  Lee' })).not.toBe(VECTOR_1_HASH);
  });
});

describe('integrity session', () => {
  function fakeModule(over: { prepare?: jest.Mock; request?: jest.Mock } = {}) {
    return {
      client: 'android' as const,
      needsCloudProject: true,
      prepare: jest.fn(async () => undefined),
      request: jest.fn(async (_hash: string) => 'play-token'),
      ...over,
    } satisfies IntegrityModule;
  }

  it('warms up once per session and asks for a token bound to the body hash', async () => {
    const m = fakeModule();
    const s = createIntegritySession(m, '123456789012');
    s.warmUp();
    await expect(s.tokenFor(VECTOR_1)).resolves.toBe('play-token');
    await s.tokenFor(VECTOR_1);
    expect(m.prepare).toHaveBeenCalledTimes(1);
    expect(m.prepare).toHaveBeenCalledWith('123456789012');
    expect(m.request).toHaveBeenCalledWith(VECTOR_1_HASH, canonicalStartJson(VECTOR_1));
  });

  it('retries a failed warm-up at submit; an empty token is an error', async () => {
    let calls = 0;
    const m = fakeModule({
      prepare: jest.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('play unavailable');
      }),
      request: jest.fn(async () => ''),
    });
    const s = createIntegritySession(m, '1');
    s.warmUp();
    await Promise.resolve();
    await expect(s.tokenFor(VECTOR_1)).rejects.toThrow('integrity_token_empty');
    expect(m.prepare).toHaveBeenCalledTimes(2);
  });
});

describe('iOS App Attest (Apple Go-Live R-9)', () => {
  const IOS_BODY: NativeStartBody = { ...VECTOR_1, client: 'ios' };

  function fakeNative(supported = true) {
    return {
      isSupported: supported,
      generateKeyAsync: jest.fn(async () => 'a2V5LWlk'),
      attestKeyAsync: jest.fn(async (_k: string, _c: string) => 'bzJjYm9yLWF0dGVzdGF0aW9u'),
    };
  }

  it('no App Attest on this device (simulator) → no module → signup unavailable', () => {
    expect(createAppAttestModule(fakeNative(false))).toBeNull();
    expect(integritySessionFor(null, null)).toBeNull();
  });

  it('needs no Play cloud project; Android still does', () => {
    const ios = createAppAttestModule(fakeNative())!;
    expect(integritySessionFor(ios, null)?.client).toBe('ios');
    const android: IntegrityModule = {
      client: 'android',
      needsCloudProject: true,
      prepare: async () => undefined,
      request: async () => 't',
    };
    expect(integritySessionFor(android, null)).toBeNull();
    expect(integritySessionFor(android, '1')?.client).toBe('android');
  });

  it('attests a fresh key with the canonical JSON as challenge: the native SHA-256 of it IS the requestHash', async () => {
    const native = fakeNative();
    const s = createIntegritySession(createAppAttestModule(native)!, null);
    const token = await s.tokenFor(IOS_BODY);
    expect(native.generateKeyAsync).toHaveBeenCalledTimes(1);
    const challenge = native.attestKeyAsync.mock.calls[0]![1];
    expect(native.attestKeyAsync.mock.calls[0]![0]).toBe('a2V5LWlk');
    // IntegrityModule.swift: clientDataHash = SHA256(Data(challenge.utf8)).
    const clientDataHash = createHash('sha256')
      .update(Buffer.from(challenge, 'utf8'))
      .digest('hex');
    expect(clientDataHash).toBe(await startRequestHash(IOS_BODY));
    expect(challenge.startsWith('["ios",')).toBe(true);
    // integrity_token = base64url(JSON {key_id, attestation}).
    expect(token).not.toMatch(/[+/=]/);
    expect(JSON.parse(utf8Decode(base64Decode(token)))).toEqual({
      key_id: 'a2V5LWlk',
      attestation: 'bzJjYm9yLWF0dGVzdGF0aW9u',
    });
    expect(token).toBe(appAttestToken('a2V5LWlk', 'bzJjYm9yLWF0dGVzdGF0aW9u'));
  });

  it('a body whose client is not the module client is refused before any native call', async () => {
    const native = fakeNative();
    const s = createIntegritySession(createAppAttestModule(native)!, null);
    await expect(s.tokenFor(VECTOR_1)).rejects.toThrow('integrity_client_mismatch');
    expect(native.generateKeyAsync).not.toHaveBeenCalled();
  });
});
