import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { jwtVerify as mockedJwtVerify } from 'jose';

import {
  CognitoVerifierService,
  CognitoVerificationError,
} from '../lib/cognito-verifier.service.js';

// jose is mocked so the verifier can be unit-tested without a real
// Cognito IdP. Production behavior is covered by the integration suite.
// vi.mock is hoisted by vitest above the imports, so the alias above
// resolves to the mocked function at runtime.
vi.mock('jose', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('jose');
  return {
    ...actual,
    createRemoteJWKSet: vi.fn().mockReturnValue({} as unknown),
    jwtVerify: vi.fn(),
  };
});

const SUB = 'cognito-sub-01';

let savedDomain: string | undefined;
let savedClient: string | undefined;

beforeAll(() => {
  savedDomain = process.env['AUTH_COGNITO_DOMAIN'];
  savedClient = process.env['AUTH_COGNITO_CLIENT_ID'];
  process.env['AUTH_COGNITO_DOMAIN'] = 'auth.example.com';
  process.env['AUTH_COGNITO_CLIENT_ID'] = 'test-client-id';
});

afterAll(() => {
  if (savedDomain === undefined) delete process.env['AUTH_COGNITO_DOMAIN'];
  else process.env['AUTH_COGNITO_DOMAIN'] = savedDomain;
  if (savedClient === undefined) delete process.env['AUTH_COGNITO_CLIENT_ID'];
  else process.env['AUTH_COGNITO_CLIENT_ID'] = savedClient;
});

describe('CognitoVerifierService.verify', () => {
  it('accepts a well-formed Cognito ID token', async () => {
    (mockedJwtVerify as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: {
        sub: SUB,
        email: 'user@example.com',
        email_verified: true,
        token_use: 'id',
      },
    });
    const svc = new CognitoVerifierService();
    const out = await svc.verify('token');
    expect(out.sub).toBe(SUB);
    expect(out.email).toBe('user@example.com');
  });

  it('rejects on missing email', async () => {
    (mockedJwtVerify as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: { sub: SUB, email_verified: true, token_use: 'id' },
    });
    const svc = new CognitoVerifierService();
    await expect(svc.verify('token')).rejects.toThrow(/missing_email/);
  });

  it('rejects on email_verified=false', async () => {
    (mockedJwtVerify as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: {
        sub: SUB,
        email: 'u@e.com',
        email_verified: false,
        token_use: 'id',
      },
    });
    const svc = new CognitoVerifierService();
    await expect(svc.verify('token')).rejects.toThrow(/email_not_verified/);
  });

  it('rejects on token_use !== "id"', async () => {
    (mockedJwtVerify as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: {
        sub: SUB,
        email: 'u@e.com',
        email_verified: true,
        token_use: 'access',
      },
    });
    const svc = new CognitoVerifierService();
    await expect(svc.verify('token')).rejects.toThrow(/wrong_token_use/);
  });

  // §5 Auth-Hardening D2 P4 — token-content rejections are the typed class
  // (so the orchestrator maps them to a 4xx auth_error, not a 500).
  it('throws a typed CognitoVerificationError on a token-content rejection', async () => {
    (mockedJwtVerify as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: { sub: SUB, email: 'u@e.com', email_verified: false, token_use: 'id' },
    });
    const svc = new CognitoVerifierService();
    await expect(svc.verify('token')).rejects.toBeInstanceOf(
      CognitoVerificationError,
    );
  });
});

// §5 Auth-Hardening D2 P1 — email_verified trusted-federation normalization.
// The gate is PARSED, not removed: federated IdPs surface email_verified as
// the STRING "true"; we accept it ONLY for an IdP named in
// AUTH_TRUSTED_IDP_NAMES. Native/untrusted/empty-config keep the strict gate.
// This is the unverified-email account-takeover vector — it stays closed.
describe('CognitoVerifierService.verify — email_verified fail-closed normalization', () => {
  afterEach(() => {
    delete process.env['AUTH_TRUSTED_IDP_NAMES'];
  });

  function mockPayload(payload: Record<string, unknown>): void {
    (mockedJwtVerify as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload,
    });
  }

  it('FAIL-CLOSED: string "true" with an EMPTY trusted-IdP config does NOT pass', async () => {
    delete process.env['AUTH_TRUSTED_IDP_NAMES']; // nothing trusted
    mockPayload({
      sub: SUB,
      email: 'u@e.com',
      email_verified: 'true', // federated string form
      token_use: 'id',
      identities: [{ providerName: 'Google' }],
    });
    const svc = new CognitoVerifierService();
    await expect(svc.verify('token')).rejects.toThrow(/email_not_verified/);
  });

  it('FAIL-CLOSED: string "true" from an UNTRUSTED provider does NOT pass', async () => {
    process.env['AUTH_TRUSTED_IDP_NAMES'] = 'Google';
    mockPayload({
      sub: SUB,
      email: 'u@e.com',
      email_verified: 'true',
      token_use: 'id',
      identities: [{ providerName: 'EvilCorp' }], // not in the trusted list
    });
    const svc = new CognitoVerifierService();
    await expect(svc.verify('token')).rejects.toThrow(/email_not_verified/);
  });

  it('passes string "true" ONLY for a TRUSTED federated provider (identities[].providerName)', async () => {
    process.env['AUTH_TRUSTED_IDP_NAMES'] = 'google,microsoft';
    mockPayload({
      sub: SUB,
      email: 'u@e.com',
      email_verified: 'true',
      token_use: 'id',
      identities: [{ providerName: 'Microsoft' }], // case-insensitive match
    });
    const svc = new CognitoVerifierService();
    const out = await svc.verify('token');
    expect(out.sub).toBe(SUB);
    expect(out.email_verified).toBe(true);
  });

  it('passes string "true" via the cognito:username "<Provider>_" prefix for a trusted IdP', async () => {
    process.env['AUTH_TRUSTED_IDP_NAMES'] = 'google';
    mockPayload({
      sub: SUB,
      email: 'u@e.com',
      email_verified: 'true',
      token_use: 'id',
      'cognito:username': 'Google_115551234567890', // prefix before '_'
    });
    const svc = new CognitoVerifierService();
    const out = await svc.verify('token');
    expect(out.sub).toBe(SUB);
  });

  it('native boolean true always passes regardless of trusted-IdP config', async () => {
    delete process.env['AUTH_TRUSTED_IDP_NAMES'];
    mockPayload({ sub: SUB, email: 'u@e.com', email_verified: true, token_use: 'id' });
    const svc = new CognitoVerifierService();
    const out = await svc.verify('token');
    expect(out.email_verified).toBe(true);
  });
});

// AUTH-SIGNIN-1 Amendment M-A1 §3.3 — native-exchange verification options:
// audience = the native app client, nonce byte-equal, and typed (4xx) issuer /
// audience / expiry rejections. Without options the browser path is unchanged.
describe('CognitoVerifierService.verify — native options (M-A1)', () => {
  const mocked = mockedJwtVerify as unknown as ReturnType<typeof vi.fn>;
  const good = { sub: SUB, email: 'u@e.com', email_verified: true, token_use: 'id', nonce: 'n-1' };

  it('verifies against the NATIVE audience, not AUTH_COGNITO_CLIENT_ID', async () => {
    mocked.mockResolvedValue({ payload: good });
    await new CognitoVerifierService().verify('token', { audience: 'native-client', nonce: 'n-1' });
    expect(mocked.mock.calls.at(-1)![2]).toMatchObject({ audience: 'native-client' });
  });

  it('refuses a nonce mismatch and a missing nonce', async () => {
    mocked.mockResolvedValue({ payload: { ...good, nonce: 'other' } });
    await expect(new CognitoVerifierService().verify('token', { audience: 'native-client', nonce: 'n-1' })).rejects.toMatchObject({ reason: 'nonce_mismatch' });
    mocked.mockResolvedValue({ payload: { sub: SUB, email: 'u@e.com', email_verified: true, token_use: 'id' } });
    await expect(new CognitoVerifierService().verify('token', { audience: 'native-client', nonce: 'n-1' })).rejects.toMatchObject({ reason: 'nonce_missing' });
  });

  it('classes aud / iss claim failures as typed rejections on the native path only', async () => {
    const { errors } = await vi.importActual<typeof import('jose')>('jose');
    mocked.mockRejectedValue(new errors.JWTClaimValidationFailed('unexpected "aud" claim value', {}, 'aud', 'check_failed'));
    const native = new CognitoVerifierService().verify('token', { audience: 'native-client', nonce: 'n-1' });
    await expect(native).rejects.toBeInstanceOf(CognitoVerificationError);
    await expect(new CognitoVerifierService().verify('token', { audience: 'native-client', nonce: 'n-1' })).rejects.toMatchObject({ reason: 'id_token_audience_mismatch' });
    // Browser path: the jose error passes through untyped (500 class, unchanged).
    await expect(new CognitoVerifierService().verify('token')).rejects.not.toBeInstanceOf(CognitoVerificationError);
    mocked.mockRejectedValue(new errors.JWTClaimValidationFailed('unexpected "iss" claim value', {}, 'iss', 'check_failed'));
    await expect(new CognitoVerifierService().verify('token', { audience: 'native-client', nonce: 'n-1' })).rejects.toMatchObject({ reason: 'id_token_issuer_mismatch' });
  });
});

// Apple Go-Live (LOCKED) R-1 / R-5 / R-7 — Sign in with Apple through Cognito.
describe('CognitoVerifierService.verify — Sign in with Apple (R-1)', () => {
  const mocked = mockedJwtVerify as unknown as ReturnType<typeof vi.fn>;
  let savedTrusted: string | undefined;
  beforeAll(() => {
    savedTrusted = process.env['AUTH_TRUSTED_IDP_NAMES'];
  });
  afterEach(() => {
    if (savedTrusted === undefined) delete process.env['AUTH_TRUSTED_IDP_NAMES'];
    else process.env['AUTH_TRUSTED_IDP_NAMES'] = savedTrusted;
  });

  it('maps the Cognito provider SignInWithApple to the Aramo value apple (identities claim)', async () => {
    mocked.mockResolvedValue({
      payload: { sub: SUB, email: 'x7k2@privaterelay.appleid.com', email_verified: true, token_use: 'id', identities: [{ providerName: 'SignInWithApple' }] },
    });
    const out = await new CognitoVerifierService().verify('token');
    expect(out.idp).toBe('apple');
    expect(out.email).toBe('x7k2@privaterelay.appleid.com');
  });

  it('maps the cognito:username prefix signinwithapple_ to apple; Google and Microsoft are unchanged', async () => {
    mocked.mockResolvedValue({ payload: { sub: SUB, email: 'a@b.test', email_verified: true, token_use: 'id', 'cognito:username': 'signinwithapple_001234.abc' } });
    expect((await new CognitoVerifierService().verify('token')).idp).toBe('apple');
    mocked.mockResolvedValue({ payload: { sub: SUB, email: 'a@b.test', email_verified: true, token_use: 'id', identities: [{ providerName: 'Google' }] } });
    expect((await new CognitoVerifierService().verify('token')).idp).toBe('google');
    mocked.mockResolvedValue({ payload: { sub: SUB, email: 'a@b.test', email_verified: true, token_use: 'id', identities: [{ providerName: 'microsoft' }] } });
    expect((await new CognitoVerifierService().verify('token')).idp).toBe('microsoft');
  });

  it('two linked providers incl. Apple stay ambiguous', async () => {
    mocked.mockResolvedValue({
      payload: { sub: SUB, email: 'a@b.test', email_verified: true, token_use: 'id', identities: [{ providerName: 'SignInWithApple' }, { providerName: 'Google' }] },
    });
    expect((await new CognitoVerifierService().verify('token')).idp).toBe('ambiguous');
  });

  it('string email_verified from Apple passes only when SignInWithApple is a trusted IdP name', async () => {
    const payload = { sub: SUB, email: 'a@b.test', email_verified: 'true', token_use: 'id', identities: [{ providerName: 'SignInWithApple' }] };
    mocked.mockResolvedValue({ payload });
    process.env['AUTH_TRUSTED_IDP_NAMES'] = 'Google,microsoft';
    await expect(new CognitoVerifierService().verify('token')).rejects.toMatchObject({ reason: 'email_not_verified' });
    process.env['AUTH_TRUSTED_IDP_NAMES'] = 'Google,microsoft,SignInWithApple';
    expect((await new CognitoVerifierService().verify('token')).idp).toBe('apple');
  });

  it('surfaces the shared first and last name (R-5 prefill) and null when not shared', async () => {
    mocked.mockResolvedValue({
      payload: { sub: SUB, email: 'a@b.test', email_verified: true, token_use: 'id', given_name: ' Ada ', family_name: 'Lovelace' },
    });
    const named = await new CognitoVerifierService().verify('token');
    expect(named.given_name).toBe('Ada');
    expect(named.family_name).toBe('Lovelace');
    mocked.mockResolvedValue({ payload: { sub: SUB, email: 'a@b.test', email_verified: true, token_use: 'id', given_name: '' } });
    const unnamed = await new CognitoVerifierService().verify('token');
    expect(unnamed.given_name).toBeNull();
    expect(unnamed.family_name).toBeNull();
  });
});
