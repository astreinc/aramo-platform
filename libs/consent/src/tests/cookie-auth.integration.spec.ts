import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { JwtAuthGuard } from '@aramo/auth';

import { ConsentController } from '../lib/consent.controller.js';
import { ConsentService } from '../lib/consent.service.js';

type SignKey = CryptoKey | KeyObject;

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-integration-cookie';
const ALG = 'RS256';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TALENT_ID = '00000000-0000-0000-0000-0000000000aa';
const RECRUITER_ID = '00000000-0000-0000-0000-0000000000bb';
const IDEMPOTENCY_KEY = 'd2d7a0f0-0000-7000-8000-000000000099';

// PR-8.0b §8.7 / §9 (1 integration test): cookie-authenticated consent
// endpoint succeeds. Bootstraps the real ConsentController + JwtAuthGuard
// behind cookie-parser; ConsentService is mocked so the test stays
// HTTP-layer focused (Postgres is not the surface under test here — the
// cookie-auth path through JwtAuthGuard is). Gated by
// ARAMO_RUN_INTEGRATION=1 to match the existing consent integration suite
// (libs/consent/src/tests/consent.integration.spec.ts).
describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'consent + cookie auth — integration',
  () => {
    let app: INestApplication;
    let module: TestingModule;
    let publicPem: string;
    let privateKey: SignKey;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    const consentServiceMock = {
      grant: vi.fn(),
      revoke: vi.fn(),
      check: vi.fn(),
      getState: vi.fn(),
      getHistory: vi.fn(),
      getDecisionLog: vi.fn(),
    };

    beforeAll(async () => {
      const kp = await generateKeyPair(ALG);
      publicPem = await exportSPKI(kp.publicKey as never);
      privateKey = kp.privateKey as SignKey;

      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;

      module = await Test.createTestingModule({
        controllers: [ConsentController],
        providers: [
          { provide: ConsentService, useValue: consentServiceMock },
          JwtAuthGuard,
        ],
      }).compile();

      app = module.createNestApplication();
      // Matches apps/api/src/main.ts §8.4 wiring: cookieParser() runs
      // before the guard so JwtAuthGuard can read request.cookies.
      app.use(cookieParser());
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
      process.env['AUTH_AUDIENCE'] = savedEnv['AUTH_AUDIENCE'];
      process.env['AUTH_PUBLIC_KEY'] = savedEnv['AUTH_PUBLIC_KEY'];
    });

    async function signAccessToken(
      claimOverrides: Record<string, unknown> = {},
    ): Promise<string> {
      const claims = {
        sub: RECRUITER_ID,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_ID,
        scopes: ['consent:write'],
        ...claimOverrides,
      };
      return new SignJWT(claims)
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }

    it('accepts a POST /v1/consent/grant request authenticated via the aramo_access_token cookie', async () => {
      const stubResponse = {
        event_id: '11111111-1111-7111-8111-111111111111',
        tenant_id: TENANT_ID,
        talent_id: TALENT_ID,
        scope: 'matching',
        action: 'granted',
        captured_method: 'recruiter_capture',
        consent_version: 'v1',
        occurred_at: '2026-04-29T00:00:00Z',
        recorded_at: '2026-04-29T00:00:01Z',
      };
      consentServiceMock.grant.mockResolvedValueOnce(stubResponse);

      const token = await signAccessToken();

      const response = await request(app.getHttpServer())
        .post('/v1/consent/grant')
        .set('Cookie', [`aramo_access_token=${token}`])
        .set('Idempotency-Key', IDEMPOTENCY_KEY)
        .send({
          talent_id: TALENT_ID,
          scope: 'matching',
          captured_method: 'recruiter_capture',
          consent_version: 'v1',
          occurred_at: '2026-04-29T00:00:00Z',
        });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(stubResponse);
      expect(consentServiceMock.grant).toHaveBeenCalledOnce();
      const authContextArg = consentServiceMock.grant.mock.calls[0]?.[2] as {
        sub: string;
        actor_kind: string;
        tenant_id: string;
      };
      expect(authContextArg).toMatchObject({
        sub: RECRUITER_ID,
        actor_kind: 'user',
        tenant_id: TENANT_ID,
      });
    });
  },
);
