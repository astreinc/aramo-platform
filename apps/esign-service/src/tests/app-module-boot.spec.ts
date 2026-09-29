import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCUMENT_SOURCE_PROVIDER_PORT } from '@aramo/esign';

import { AppModule } from '../app/app.module.js';
import { EsignSignerController } from '../app/esign-http.controller.js';

// PX-V1 F3 — real Nest AppModule compile/boot regression. Its ONLY job is to
// resolve the full runtime DI graph, catching provider/export-boundary failures
// that constructor-unit tests (which use `new`) and `tsc` cannot detect.
//
// The bug this guards: F3 added a DOCUMENT_SOURCE_PROVIDER_PORT injection to the
// AppModule-level EsignSignerController. That token is bound inside
// EsignModule.forRoot; unless EsignModule EXPORTS it (extraExports), the AppModule
// fails to compile at boot — which the pact provider caught but every local check
// missed. compile() (not init()) resolves the graph without DB/worker side effects.

describe('esign-service AppModule boot (PX-V1 F3 DI regression)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ['DATABASE_URL', 'MAILER_PROVIDER']) saved[k] = process.env[k];
    // A non-connecting URL: compile() constructs providers but never connects.
    process.env['DATABASE_URL'] = 'postgresql://boot:test@localhost:5432/esign_boot_test';
    process.env['MAILER_PROVIDER'] = 'stub';
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('compiles the full AppModule DI graph — EsignSignerController resolves DOCUMENT_SOURCE_PROVIDER_PORT', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // The controller + the token both resolve — proving the source port crosses
    // the EsignModule -> AppModule boundary that F3 depends on.
    expect(moduleRef.get(EsignSignerController, { strict: false })).toBeDefined();
    expect(moduleRef.get(DOCUMENT_SOURCE_PROVIDER_PORT, { strict: false })).toBeDefined();
    await moduleRef.close();
  });
});
