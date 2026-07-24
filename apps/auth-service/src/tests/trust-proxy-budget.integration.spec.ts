import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PortalLoginBudget } from '@aramo/auth-core';

import { AppModule } from '../app/app.module.js';
import { applyTrustProxy } from '../trust-proxy.js';

// Front-Door PR-1 (Ruling 4/5, apps/auth-service integration lane) — proves the
// chain HTTP → Express trust-proxy → @Ip() → PortalLoginBudget KEY for BOTH portal
// sites (request-link + consume), without weakening the oracle-free posture. The
// real AppModule boots with PortalLoginBudget overridden by a RECORDING fake
// (captures the key, returns true); assertions are on captured keys, never the
// response (over-budget ≡ the same neutral outcome as ineligible/invalid).
// applyTrustProxy(app) is the SAME helper main.ts boots (Ruling 2). Both handlers
// call budget.allow(ip) FIRST — before any eligibility/token DB work — so benign
// inputs (unknown email / invalid token) capture the key with no seed.

const captured: string[] = [];
const recordingBudget = {
  allow(key: string, _nowMs: number): boolean {
    captured.push(key);
    return true;
  },
};

interface Site {
  name: string;
  fire: (server: unknown, ip?: string) => request.Test;
}

const SITES: Site[] = [
  {
    name: 'POST /auth/portal/request-link',
    fire: (server, ip) => {
      const r = request(server as never).post('/auth/portal/request-link');
      if (ip !== undefined) r.set('X-Forwarded-For', ip);
      return r.send({ email: 'nobody@example.com' });
    },
  },
  {
    name: 'GET /auth/portal/consume',
    fire: (server, ip) => {
      const r = request(server as never).get('/auth/portal/consume?token=deadbeef');
      if (ip !== undefined) r.set('X-Forwarded-For', ip);
      return r;
    },
  },
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Front-Door PR-1 — auth-service trust-proxy → PortalLoginBudget key (real AppModule)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let app: INestApplication;
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      for (const k of [
        'DATABASE_URL',
        'ARAMO_IDENTITY_PEPPER',
        'AUTH_ALLOW_INSECURE_COOKIES',
        'MAILER_PROVIDER',
      ]) {
        savedEnv[k] = process.env[k];
      }
      process.env['DATABASE_URL'] = url;
      process.env['ARAMO_IDENTITY_PEPPER'] = 'trust-proxy-spec-pepper';
      process.env['AUTH_ALLOW_INSECURE_COOKIES'] = 'true';
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PortalLoginBudget)
        .useValue(recordingBudget)
        .compile();

      app = module.createNestApplication<NestExpressApplication>();
      // Ruling 3 order — trust-proxy BEFORE any middleware, exactly as main.ts.
      applyTrustProxy(app as NestExpressApplication);
      app.use(cookieParser());
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

    for (const site of SITES) {
      describe(site.name, () => {
        it('(a) distinct X-Forwarded-For clients → distinct captured keys', async () => {
          const server = app.getHttpServer();
          await site.fire(server, '10.0.0.1');
          await site.fire(server, '10.0.0.2');
          expect(captured).toEqual(['10.0.0.1', '10.0.0.2']);
        });

        it('(b) spoof containment: "6.6.6.6, 10.0.0.3" → key 10.0.0.3 (rightmost, proxy-appended entry wins)', async () => {
          // Ruling 6 (trust boundary, stated not papered over): with trust proxy = 1,
          // a client reaching the app port DIRECTLY could forge a single-entry XFF
          // and be keyed by it. Accepted and bounded: app ports are not published
          // beyond the compose network — the proxy is the only public peer, and that
          // network IS the trust boundary. Through the proxy, the rightmost (proxy-
          // appended) entry wins, so a client-forged left-hand entry (6.6.6.6) never
          // becomes the key. Hardening beyond this is out of scope.
          await site.fire(app.getHttpServer(), '6.6.6.6, 10.0.0.3');
          expect(captured).toEqual(['10.0.0.3']);
        });

        it('(c) no X-Forwarded-For → key is the direct socket address (fallback stays sane)', async () => {
          await site.fire(app.getHttpServer());
          expect(captured).toHaveLength(1);
          expect(captured[0]).toMatch(/(^|:)(127\.0\.0\.1|::1)$/);
        });
      });
    }
  },
);
