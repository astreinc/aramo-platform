import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { IntelligenceIntegrationWorker } from '@aramo/intelligence-integration';

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

  it('compiles with the drain and the two handlers (canonical skill reconcile, intelligence publisher)', async () => {
    let module: TestingModule | undefined;
    try {
      module = await Test.createTestingModule({ imports: [TalentIntakeWorkerModule] }).compile();
      expect(module.get(ATS_TALENT_EVENTS_DRAIN)).toBeDefined();
      const handlers = module.get<Array<{ name: string }>>(ATS_TALENT_EVENT_HANDLERS, { strict: false });
      expect(handlers.map((h) => h.name)).toEqual([
        'canonical-reconcile',
        // ATI-SEP-1 T10 WP1 — talent-reconcile-signal + legacy-trust-projection removed.
        // ATI-SEP-1 T8 — ATS → Talent Intelligence (no-op when TI is unconfigured).
        'intelligence-publisher',
      ]);
      // The worker hosts the inbound sync + entitlement sync loops (idle while unconfigured).
      expect(module.get(IntelligenceIntegrationWorker, { strict: false })).toBeDefined();
    } finally {
      await module?.close();
    }
  }, 60_000);
});
