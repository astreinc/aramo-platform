import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module.js';
import { VerificationConfirmBudget } from '../controllers/public-verification.controller.js';
import { applyTrustProxy } from '../trust-proxy.js';

// Front-Door PR-1 (Ruling 4/5, apps/api integration lane) — proves the full chain
// HTTP → Express trust-proxy resolution → @Ip() → budget KEY, end to end, without
// weakening the oracle-free posture. The real AppModule boots with
// VerificationConfirmBudget overridden by a RECORDING fake (captures the key,
// returns true); assertions are on the CAPTURED KEY, never the response (over-
// budget ≡ the same notFound as a bad token — the spec must not become an oracle).
//
// applyTrustProxy(app) is called on the test app — the SAME helper main.ts boots
// (Ruling 2) — so this exercises the deploy path, not a test-harness reimpl.
//
// The confirm handler runs budget.allow(ip) BEFORE token extraction; a no-token
// body ({}) is refused with 404 AFTER the key is captured and BEFORE any DB query,
// so this spec needs no seed.

const captured: string[] = [];
const recordingBudget = {
  allow(key: string, _nowMs: number): boolean {
    captured.push(key);
    return true;
  },
};

const CONFIRM = '/v1/email-verifications/confirm';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Front-Door PR-1 — api trust-proxy → VerificationConfirmBudget key (real AppModule)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let app: INestApplication;
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      for (const k of ['DATABASE_URL', 'AUTH_AUDIENCE', 'MAILER_PROVIDER']) {
        savedEnv[k] = process.env[k];
      }
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'aramo-trust-proxy-spec';
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(VerificationConfirmBudget)
        .useValue(recordingBudget)
        .compile();

      app = module.createNestApplication<NestExpressApplication>();
      // Ruling 3 order — trust-proxy BEFORE any middleware, exactly as main.ts.
      applyTrustProxy(app as NestExpressApplication);
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      await app.init();
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    beforeEach(() => {
      captured.length = 0;
    });

    it('(a) distinct X-Forwarded-For clients → distinct captured budget keys', async () => {
      await request(app.getHttpServer()).post(CONFIRM).set('X-Forwarded-For', '10.0.0.1').send({});
      await request(app.getHttpServer()).post(CONFIRM).set('X-Forwarded-For', '10.0.0.2').send({});
      expect(captured).toEqual(['10.0.0.1', '10.0.0.2']);
    });

    it('(b) spoof containment: "6.6.6.6, 10.0.0.3" → key 10.0.0.3 (rightmost, proxy-appended entry wins)', async () => {
      // Ruling 6 (trust boundary, stated not papered over): with trust proxy = 1,
      // a client reaching the app port DIRECTLY could forge a single-entry XFF and
      // be keyed by it. Accepted and bounded: app ports are not published beyond
      // the compose network — the proxy is the only public peer, and that network
      // IS the trust boundary. Through the proxy, the rightmost (proxy-appended)
      // entry wins, so a client-forged left-hand entry (6.6.6.6) never becomes the
      // key. Hardening beyond this (mTLS, socket-peer allowlists) is out of scope.
      await request(app.getHttpServer())
        .post(CONFIRM)
        .set('X-Forwarded-For', '6.6.6.6, 10.0.0.3')
        .send({});
      expect(captured).toEqual(['10.0.0.3']);
    });

    it('(c) no X-Forwarded-For → key is the direct socket address (fallback stays sane)', async () => {
      await request(app.getHttpServer()).post(CONFIRM).send({});
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatch(/(^|:)(127\.0\.0\.1|::1)$/);
    });
  },
);
