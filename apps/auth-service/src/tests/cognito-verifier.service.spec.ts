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
});
