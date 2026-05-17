import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';

import { AppModule } from '../app.module.js';

// PR-16 §2.2 — AppModule DI resolution regression test.
//
// F11 (Determination: Outcome A, PRODUCTION-BREAKING) was latent because no
// test exercised apps/api's real DI graph. With consent's PrismaService
// constructor parameter undecorated, NestFactory.create(AppModule) threw
// synchronously on String-token resolution before any constructor body ran.
// This spec compiles AppModule through Nest DI with no overrideProvider of
// any kind, so the next undecorated-primitive provider defect anywhere in
// the apps/api graph cannot stay latent past CI.
//
// Surface under test is DI resolution only — no .createNestApplication(),
// no app.init(), no $connect(). Env stubs satisfy any constructor that reads
// process.env at module-init time without requiring a live database or a
// real keypair (the test never reaches onModuleInit).
describe('apps/api AppModule — DI resolution', () => {
  const savedEnv: Partial<Record<string, string | undefined>> = {};

  beforeAll(() => {
    savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
    savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
    savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];

    process.env['DATABASE_URL'] = 'postgres://stub:stub@127.0.0.1:1/stub';
    process.env['AUTH_AUDIENCE'] = 'aramo-app-module-di-spec';
    process.env['AUTH_PUBLIC_KEY'] =
      '-----BEGIN PUBLIC KEY-----\nMII\n-----END PUBLIC KEY-----';
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('compiles AppModule with no overrideProvider — every provider in the graph must resolve natively', async () => {
    let module: TestingModule | undefined;
    try {
      module = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      expect(module).toBeDefined();
    } finally {
      await module?.close();
    }
  });
});
