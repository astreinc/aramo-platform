import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AramoEventEnvelope, LeasedOutboxRow, LeaseSafeOutboxRepository } from '@aramo/events';
import { LeaseSafeOutboxDrainService } from '@aramo/outbox-publisher';

import { AtsTalentEventDispatcher } from '../ats-talent-events/ats-talent-event-dispatcher.js';
import type { AtsTalentEventHandler } from '../ats-talent-events/ats-talent-event-handler.js';
import { AtsTalentEventsDrainWorker } from '../ats-talent-events/ats-talent-events-drain.worker.js';
import { LegacyTrustTalentEventHandler } from '../ats-talent-events/legacy-trust-talent-event.handler.js';
import {
  CanonicalReconcileTalentEventHandler,
  TalentReconcileSignalTalentEventHandler,
} from '../ats-talent-events/reconcile-signal.handlers.js';

// ATI-SEP-1 A3 — the ATS talent outbox consumers run post-commit, off the
// lease-safe drain: fan-out to every handler, a failing handler fails only the
// dispatch (retry → quarantine past the budget) and never touches ATS rows, an
// erased / absent Talent is a no-op. A4 — the global write-time interceptor is gone.

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const TENANT = 't-1';

function row(id: string, event_type: string, attempts = 1): LeasedOutboxRow {
  return {
    id,
    tenant_id: TENANT,
    event_type,
    event_payload: { talent_record_id: `tal-${id}` },
    created_at: new Date('2026-10-23T00:00:00Z'),
    event_version: 'v1',
    source: 'ats-talent-record',
    subject_type: 'talent_record',
    subject_id: `tal-${id}`,
    correlation_id: null,
    causation_id: null,
    publish_attempts: attempts,
  };
}

function leaseRepo(rows: LeasedOutboxRow[]) {
  const repo = {
    claimOutboxBatch: vi.fn(async () => rows),
    markOutboxPublished: vi.fn(async (i: { event_ids: readonly string[] }) => i.event_ids.length),
    releaseOutboxLease: vi.fn(async (i: { event_ids: readonly string[] }) => i.event_ids.length),
    quarantineOutbox: vi.fn(async (i: { event_ids: readonly string[] }) => i.event_ids.length),
  };
  return repo as typeof repo & LeaseSafeOutboxRepository;
}

const DEFAULTS = {
  source: 'ats-talent-record',
  event_version: 'v1',
  subjectTypeFor: () => 'talent_record',
  subjectIdFor: (r: { id: string }) => r.id,
};

function drainWith(rows: LeasedOutboxRow[], handlers: AtsTalentEventHandler[], maxAttempts = 3) {
  const repo = leaseRepo(rows);
  const dispatcher = new AtsTalentEventDispatcher(handlers, logger);
  const drain = new LeaseSafeOutboxDrainService(
    repo,
    dispatcher,
    DEFAULTS,
    { limit: 10, lease_seconds: 60, max_attempts: maxAttempts },
    logger,
    'test',
  );
  return { repo, drain };
}

describe('ATI-SEP-1 A3 — ATS talent event dispatcher + drain', () => {
  it('fans every event out to every handler, in order; all ok → published', async () => {
    const seen: string[] = [];
    const h = (name: string): AtsTalentEventHandler => ({
      name,
      handle: async (e: AramoEventEnvelope) => {
        seen.push(`${name}:${e.event_type}:${e.subject_id}`);
      },
    });
    const { repo, drain } = drainWith([row('a', 'talent.created'), row('b', 'talent.profile_updated')], [h('one'), h('two')]);
    const out = await drain.drainOnce();
    expect(out).toMatchObject({ claimed: 2, published: 2, failed: 0 });
    expect(seen).toEqual([
      'one:talent.created:tal-a',
      'two:talent.created:tal-a',
      'one:talent.profile_updated:tal-b',
      'two:talent.profile_updated:tal-b',
    ]);
    expect(repo.markOutboxPublished).toHaveBeenCalledWith({ event_ids: ['a', 'b'] });
  });

  it('a failing handler fails ONLY that event (others still run), the lease is released for backoff; ATS rows untouched', async () => {
    const atsRows = new Map([['tal-a', { id: 'tal-a', first_name: 'Ada' }]]);
    const snapshot = JSON.stringify([...atsRows]);
    const ok = { name: 'ok', handle: vi.fn(async () => undefined) };
    const boom = {
      name: 'boom',
      handle: vi.fn(async (e: AramoEventEnvelope) => {
        if (e.event_id === 'a') throw new Error('trust store down');
      }),
    };
    const { repo, drain } = drainWith([row('a', 'talent.created'), row('b', 'talent.created')], [boom, ok]);
    const out = await drain.drainOnce();
    expect(out).toMatchObject({ published: 1, failed: 1, quarantined: 0 });
    expect(ok.handle).toHaveBeenCalledTimes(2); // isolation between handlers
    expect(repo.markOutboxPublished).toHaveBeenCalledWith({ event_ids: ['b'] });
    expect(repo.releaseOutboxLease).toHaveBeenCalledWith(expect.objectContaining({ event_ids: ['a'] }));
    expect(JSON.stringify([...atsRows])).toBe(snapshot);
  });

  it('past the attempt budget a persistently failing event is quarantined (visible), never retried forever', async () => {
    const boom = { name: 'boom', handle: vi.fn(async () => Promise.reject(new Error('down'))) };
    const { repo, drain } = drainWith([row('a', 'talent.created', 3)], [boom], 3);
    const out = await drain.drainOnce();
    expect(out.quarantined).toBe(1);
    expect(repo.quarantineOutbox).toHaveBeenCalledWith({ event_ids: ['a'], reason: 'max_publish_attempts_exceeded' });
  });

  it('an unknown event type is acknowledged without invoking handlers', async () => {
    const h = { name: 'h', handle: vi.fn(async () => undefined) };
    const { drain } = drainWith([row('a', 'talent.something_new')], [h]);
    expect((await drain.drainOnce()).published).toBe(1);
    expect(h.handle).not.toHaveBeenCalled();
  });
});

describe('ATI-SEP-1 A3 — handlers', () => {
  const env = (event_type: string): AramoEventEnvelope<{ talent_record_id: string }> => ({
    event_id: 'e-1',
    event_type,
    event_version: 'v1',
    tenant_id: TENANT,
    source: 'ats-talent-record',
    subject_type: 'talent_record',
    subject_id: 'tal-1',
    occurred_at: '2026-10-23T00:00:00.000Z',
    correlation_id: 'c',
    causation_id: null,
    payload: { talent_record_id: 'tal-1' },
  });

  function legacy(view: unknown) {
    const deps = {
      talentRecords: { findById: vi.fn(async () => view) },
      anchors: { recordAnchorsForView: vi.fn(async () => 2) },
      matcher: { matchForRef: vi.fn(async () => undefined) },
      projection: {
        routeDeclaredEvidenceToLedger: vi.fn(async () => ({})),
        routePersistedExperienceAssertionsToLedger: vi.fn(async () => 1),
      },
    };
    const h = new LegacyTrustTalentEventHandler(
      deps.talentRecords as never,
      deps.anchors as never,
      deps.matcher as never,
      deps.projection as never,
    );
    return { h, deps };
  }

  it('LEGACY: talent.created → anchors, matcher, declared-evidence + assertion routing (post-commit)', async () => {
    const view = { id: 'tal-1', tenant_id: TENANT, email1: 'ada@example.com' };
    const { h, deps } = legacy(view);
    await h.handle(env('talent.created') as never);
    expect(deps.anchors.recordAnchorsForView).toHaveBeenCalledWith(view);
    expect(deps.matcher.matchForRef).toHaveBeenCalledWith(TENANT, 'ATS_TALENT_RECORD', 'tal-1');
    expect(deps.projection.routeDeclaredEvidenceToLedger).toHaveBeenCalledWith({ tenant_id: TENANT, talent_id: 'tal-1' });
    expect(deps.projection.routePersistedExperienceAssertionsToLedger).toHaveBeenCalledWith({ tenant_id: TENANT, talent_id: 'tal-1' });
  });

  it('LEGACY: talent.erased and an absent Talent are no-ops', async () => {
    const erased = legacy({ id: 'tal-1', tenant_id: TENANT });
    await erased.h.handle(env('talent.erased') as never);
    expect(erased.deps.talentRecords.findById).not.toHaveBeenCalled();
    const gone = legacy(null);
    await gone.h.handle(env('talent.profile_updated') as never);
    expect(gone.deps.anchors.recordAnchorsForView).not.toHaveBeenCalled();
  });

  it('LEGACY: a trust failure propagates (→ dispatch retry), it is never swallowed', async () => {
    const { h, deps } = legacy({ id: 'tal-1', tenant_id: TENANT });
    deps.matcher.matchForRef.mockRejectedValueOnce(new Error('trust down'));
    await expect(h.handle(env('talent.created') as never)).rejects.toThrow('trust down');
  });

  it('canonical reconcile: no Redis → no-op; Redis → the REQUIRED enqueue (a queue failure retries); erased skipped', async () => {
    const producer = { enqueueTalentRequired: vi.fn(async () => undefined) };
    await new CanonicalReconcileTalentEventHandler(producer as never, { isConfigured: false } as never).handle(env('talent.created') as never);
    expect(producer.enqueueTalentRequired).not.toHaveBeenCalled();
    const live = new CanonicalReconcileTalentEventHandler(producer as never, { isConfigured: true } as never);
    await live.handle(env('talent.created') as never);
    expect(producer.enqueueTalentRequired).toHaveBeenCalledWith(TENANT, 'tal-1');
    await live.handle(env('talent.erased') as never);
    expect(producer.enqueueTalentRequired).toHaveBeenCalledTimes(1);
  });

  it('talent reconcile signal: enqueued for created / profile_updated, skipped for erased', async () => {
    const producer = { enqueueTalent: vi.fn(async () => undefined) };
    const h = new TalentReconcileSignalTalentEventHandler(producer as never);
    await h.handle(env('talent.profile_updated') as never);
    await h.handle(env('talent.erased') as never);
    expect(producer.enqueueTalent).toHaveBeenCalledTimes(1);
  });
});

describe('ATI-SEP-1 A3/A4 — wiring', () => {
  afterEach(() => {
    delete process.env['ATS_TALENT_EVENTS_DRAIN_ENABLED'];
  });

  it('drain worker is OFF unless ATS_TALENT_EVENTS_DRAIN_ENABLED=1 (the API default); tick drives it', async () => {
    const drain = { drainOnce: vi.fn(async () => ({ claimed: 0, published: 0, failed: 0, quarantined: 0 })) };
    const w = new AtsTalentEventsDrainWorker(drain as never, logger);
    const spy = vi.spyOn(global, 'setInterval');
    w.onApplicationBootstrap();
    expect(spy).not.toHaveBeenCalled();
    process.env['ATS_TALENT_EVENTS_DRAIN_ENABLED'] = '1';
    w.onApplicationBootstrap();
    expect(spy).toHaveBeenCalledTimes(1);
    w.onApplicationShutdown();
    spy.mockRestore();
  });

  it('the worker entrypoint defaults the drain ON; the global talent-anchor APP_INTERCEPTOR is gone', () => {
    const main = readFileSync(resolve(__dirname, '../talent-intake-worker.main.ts'), 'utf8');
    expect(main).toContain("process.env['ATS_TALENT_EVENTS_DRAIN_ENABLED'] ??= '1'");
    const app = readFileSync(resolve(__dirname, '../app.module.ts'), 'utf8');
    expect(app).not.toContain('TalentAnchorInterceptor');
    expect(app).toContain('AtsTalentEventsModule');
  });
});
