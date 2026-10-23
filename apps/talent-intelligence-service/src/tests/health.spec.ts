import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IntelligencePrismaService } from '@aramo/intelligence-core';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app/app.module.js';

// ATI-SEP-1 T0 — the TI service boots its real AppModule and serves GET /health.
// The database is replaced by a stub ping (no DB needed); a separate case proves
// the boot FAILS CLOSED when INTELLIGENCE_DATABASE_URL is unset.

const KEY = 'INTELLIGENCE_DATABASE_URL';

describe('talent-intelligence-service — GET /health', () => {
  let saved: string | undefined;
  let app: INestApplication | undefined;

  beforeAll(() => {
    saved = process.env[KEY];
    // Never connected: the ping is stubbed below.
    process.env[KEY] = 'postgresql://boot:test@127.0.0.1:1/aramo_intelligence';
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  async function boot(ping: boolean): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IntelligencePrismaService)
      .useValue({ ping: async () => ping, $disconnect: async () => undefined })
      .compile();
    const created = moduleRef.createNestApplication();
    await created.init();
    return created;
  }

  it('200 with the database reachable', async () => {
    app = await boot(true);
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ service: 'talent-intelligence-service', status: 'ok', database: 'ok' });
  });

  it('503 with the database unreachable', async () => {
    app = await boot(false);
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', database: 'unavailable' });
  });

  it('the real AppModule refuses to compile without INTELLIGENCE_DATABASE_URL', async () => {
    delete process.env[KEY];
    try {
      await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(
        /INTELLIGENCE_DATABASE_URL is not configured/,
      );
    } finally {
      process.env[KEY] = 'postgresql://boot:test@127.0.0.1:1/aramo_intelligence';
    }
  });
});
