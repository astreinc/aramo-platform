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
