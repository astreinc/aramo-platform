import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jwtVerify as mockedJwtVerify } from 'jose';

import { CognitoVerifierService } from '../app/auth/cognito-verifier.service.js';

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
let savedTrustedIdp: string | undefined;

beforeAll(() => {
  savedDomain = process.env['AUTH_COGNITO_DOMAIN'];
  savedClient = process.env['AUTH_COGNITO_CLIENT_ID'];
  savedTrustedIdp = process.env['AUTH_TRUSTED_IDP_NAMES'];
  process.env['AUTH_COGNITO_DOMAIN'] = 'auth.example.com';
  process.env['AUTH_COGNITO_CLIENT_ID'] = 'test-client-id';
  // The configured trusted federated IdP name (Super-Admin-Login P1).
  process.env['AUTH_TRUSTED_IDP_NAMES'] = 'Microsoft';
});

afterAll(() => {
  if (savedDomain === undefined) delete process.env['AUTH_COGNITO_DOMAIN'];
  else process.env['AUTH_COGNITO_DOMAIN'] = savedDomain;
  if (savedClient === undefined) delete process.env['AUTH_COGNITO_CLIENT_ID'];
  else process.env['AUTH_COGNITO_CLIENT_ID'] = savedClient;
  if (savedTrustedIdp === undefined) delete process.env['AUTH_TRUSTED_IDP_NAMES'];
  else process.env['AUTH_TRUSTED_IDP_NAMES'] = savedTrustedIdp;
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

  // Super-Admin-Login P1 — email_verified normalization for trusted
  // federation. Microsoft sends the STRING "true"; with a trusted
  // identities[].providerName the verifier accepts it.
  it('accepts string email_verified "true" from a trusted federated provider (identities)', async () => {
    (mockedJwtVerify as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: {
        sub: SUB,
        email: 'owner@aramo.ai',
        email_verified: 'true',
        token_use: 'id',
        identities: [{ providerName: 'Microsoft', providerType: 'OIDC' }],
      },
    });
    const svc = new CognitoVerifierService();
    const out = await svc.verify('token');
    expect(out.email).toBe('owner@aramo.ai');
    expect(out.email_verified).toBe(true);
  });

  // The cognito:username "<ProviderName>_..." prefix is the fallback signal.
  it('accepts string "true" via the cognito:username trusted-provider prefix', async () => {
    (mockedJwtVerify as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: {
        sub: SUB,
        email: 'owner@aramo.ai',
        email_verified: 'true',
        token_use: 'id',
        'cognito:username': 'Microsoft_0a1b2c3d',
      },
    });
    const svc = new CognitoVerifierService();
    const out = await svc.verify('token');
    expect(out.email_verified).toBe(true);
  });

  // The gate is PARSED, not removed: a string "true" WITHOUT a trusted
  // federation signal (i.e. a native/untrusted token) still fails.
  it('rejects string "true" when no trusted-federation provider is present (gate intact)', async () => {
    (mockedJwtVerify as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: {
        sub: SUB,
        email: 'spoof@evil.test',
        email_verified: 'true',
        token_use: 'id',
      },
    });
    const svc = new CognitoVerifierService();
    await expect(svc.verify('token')).rejects.toThrow(/email_not_verified/);
  });

  // An untrusted federated provider name does not unlock the string form.
  it('rejects string "true" from an UNTRUSTED federated provider', async () => {
    (mockedJwtVerify as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: {
        sub: SUB,
        email: 'x@untrusted.test',
        email_verified: 'true',
        token_use: 'id',
        identities: [{ providerName: 'SomeRandomIdP' }],
      },
    });
    const svc = new CognitoVerifierService();
    await expect(svc.verify('token')).rejects.toThrow(/email_not_verified/);
  });

  // Native boolean true still passes unchanged (no regression).
  it('still accepts native boolean email_verified true (no trusted provider needed)', async () => {
    (mockedJwtVerify as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      payload: {
        sub: SUB,
        email: 'native@aramo.dev',
        email_verified: true,
        token_use: 'id',
      },
    });
    const svc = new CognitoVerifierService();
    const out = await svc.verify('token');
    expect(out.email_verified).toBe(true);
  });
});
