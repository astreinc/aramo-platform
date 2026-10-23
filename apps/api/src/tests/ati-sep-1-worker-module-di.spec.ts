import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';

import { ATS_TALENT_EVENTS_DRAIN } from '../ats-talent-events/ats-talent-events-drain.worker.js';
import { ATS_TALENT_EVENT_HANDLERS } from '../ats-talent-events/ats-talent-event-handler.js';
import { TalentIntakeWorkerModule } from '../talent-intake-consumer/talent-intake-worker.module.js';

// ATI-SEP-1 A3 — the talent-intake-worker context (built WITHOUT AppModule) must
// resolve the ATS talent outbox drain + every handler natively (the
// app-module-di.spec precedent: DI resolution only, no connect, no init).
describe('talent-intake-worker context — ATS talent events DI resolution', () => {
  const saved: Partial<Record<string, string | undefined>> = {};

  beforeAll(() => {
    for (const k of ['DATABASE_URL', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) saved[k] = process.env[k];
    process.env['DATABASE_URL'] = 'postgres://stub:stub@127.0.0.1:1/stub';
    process.env['AUTH_AUDIENCE'] = 'aramo-worker-di-spec';
    process.env['AUTH_PUBLIC_KEY'] = '-----BEGIN PUBLIC KEY-----\nMII\n-----END PUBLIC KEY-----';
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('compiles with the drain and the three handlers (canonical, talent-reconcile, legacy)', async () => {
    let module: TestingModule | undefined;
    try {
      module = await Test.createTestingModule({ imports: [TalentIntakeWorkerModule] }).compile();
      expect(module.get(ATS_TALENT_EVENTS_DRAIN)).toBeDefined();
      const handlers = module.get<Array<{ name: string }>>(ATS_TALENT_EVENT_HANDLERS, { strict: false });
      expect(handlers.map((h) => h.name)).toEqual([
        'canonical-reconcile',
        'talent-reconcile-signal',
        'legacy-trust-projection',
      ]);
    } finally {
      await module?.close();
    }
  }, 60_000);
});
