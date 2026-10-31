import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignPurgeService, SignPurgeWorker } from '../app/retention/sign-purge.service.js';

// Retention and Purge directive (ebd41d99) W4 — the purge engine with fakes (no DB, no S3).

const T = '019000a0-0000-7000-8000-000000000001';

function fakes() {
  const repo = {
    retentionDue: vi.fn(async () => [] as Array<{ tenant_id: string; envelope_id: string; level: string }>),
    allPartiesDeletedDue: vi.fn(async () => [] as Array<{ tenant_id: string; envelope_id: string }>),
    dueForExecution: vi.fn(async () => [] as Array<{ tenant_id: string; envelope_id: string; level: string; reason: string }>),
    queue: vi.fn(async () => 'queued' as string),
    execute: vi.fn(async () => ({ status: 'executed' }) as { status: string }),
    markWaiting: vi.fn(async () => undefined),
    targetedEnvelopeIds: vi.fn(async () => [] as string[]),
    tenantTerminalEnvelopeIds: vi.fn(async () => [] as string[]),
    integrationCopyDelivered: vi.fn(async () => null as boolean | null),
  };
  const store = {
    enabled: true,
    purgeEnvelopeObjects: vi.fn(async () => ({ deleted: [{ key: 'k', version_id: 'v' }], locked: [] as Array<{ key: string; version_id: string; retain_until: Date }> })),
  };
  const svc = new SignPurgeService(repo as never, store as never);
  return { repo, store, svc };
}

const due = (envelope_id: string) => ({ tenant_id: T, envelope_id, level: 'DOCUMENTS', reason: 'retention' });

describe('SignPurgeService', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['SIGN_PURGE_ENABLED'];
    process.env['SIGN_PURGE_ENABLED'] = '1';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['SIGN_PURGE_ENABLED'];
    else process.env['SIGN_PURGE_ENABLED'] = saved;
    vi.restoreAllMocks();
  });

  it('is dark when SIGN_PURGE_ENABLED is unset: no repository or store call', async () => {
    delete process.env['SIGN_PURGE_ENABLED'];
    const { repo, store, svc } = fakes();
    expect(svc.enabled).toBe(false);
    expect(await svc.run()).toEqual({ queued_retention: 0, queued_all_parties: 0, executed: 0, waiting_lock: 0, held: 0, failed: 0 });
    for (const fn of Object.values(repo)) expect(fn).not.toHaveBeenCalled();
    expect(store.purgeEnvelopeObjects).not.toHaveBeenCalled();
  });

  it('queues retention and all-parties envelopes with the right level and reason', async () => {
    const { repo, svc } = fakes();
    repo.retentionDue.mockResolvedValue([{ tenant_id: T, envelope_id: 'e1', level: 'DOCUMENTS_AND_METADATA' }]);
    repo.allPartiesDeletedDue.mockResolvedValue([{ tenant_id: T, envelope_id: 'e2' }]);
    const now = new Date('2026-11-01T00:00:00Z');
    const r = await svc.run(now);
    expect(r.queued_retention).toBe(1);
    expect(r.queued_all_parties).toBe(1);
    expect(repo.queue).toHaveBeenCalledWith(T, 'e1', { level: 'DOCUMENTS_AND_METADATA', reason: 'retention', actor_user_id: null, now });
    expect(repo.queue).toHaveBeenCalledWith(T, 'e2', { level: 'DOCUMENTS', reason: 'all_parties_deleted', actor_user_id: null, now });
  });

  it('does not count a queue outcome other than queued', async () => {
    const { repo, svc } = fakes();
    repo.retentionDue.mockResolvedValue([{ tenant_id: T, envelope_id: 'e1', level: 'DOCUMENTS' }]);
    repo.queue.mockResolvedValue('dequeued_by_admin');
    expect((await svc.run()).queued_retention).toBe(0);
  });

  it('executes a due envelope: S3 objects first (never evidence), then the database purge', async () => {
    const { repo, store, svc } = fakes();
    repo.dueForExecution.mockResolvedValue([due('e1')]);
    const now = new Date('2026-11-01T00:00:00Z');
    const r = await svc.run(now);
    expect(r.executed).toBe(1);
    expect(store.purgeEnvelopeObjects).toHaveBeenCalledWith(T, 'e1', { kinds: ['source', 'executed', 'certificate'], now });
    const kinds = (store.purgeEnvelopeObjects.mock.calls[0] as unknown as [string, string, { kinds: string[] }])[2].kinds;
    expect(kinds).not.toContain('evidence');
    expect(repo.execute).toHaveBeenCalledWith(T, 'e1', { deleted: 1, locked: [] }, now);
    expect(store.purgeEnvelopeObjects.mock.invocationCallOrder[0]!).toBeLessThan(repo.execute.mock.invocationCallOrder[0]!);
  });

  it('waits on an Object Lock: markWaiting(max retain_until + 1s) and never executes', async () => {
    const { repo, store, svc } = fakes();
    repo.dueForExecution.mockResolvedValue([due('e1')]);
    const a = new Date('2033-10-30T00:00:00Z');
    const b = new Date('2033-10-31T00:00:00Z');
    store.purgeEnvelopeObjects.mockResolvedValue({ deleted: [], locked: [{ key: 'k1', version_id: 'v1', retain_until: a }, { key: 'k2', version_id: 'v2', retain_until: b }] });
    const r = await svc.run();
    expect(r.waiting_lock).toBe(1);
    expect(r.executed).toBe(0);
    expect(repo.markWaiting).toHaveBeenCalledWith(T, 'e1', new Date(b.getTime() + 1000));
    expect(repo.execute).not.toHaveBeenCalled();
  });

  it('a store failure counts failed and the run continues with the next envelope', async () => {
    const { repo, store, svc } = fakes();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo.dueForExecution.mockResolvedValue([due('e1'), due('e2')]);
    store.purgeEnvelopeObjects.mockRejectedValueOnce(new Error('S3 down'));
    const r = await svc.run();
    expect(r.failed).toBe(1);
    expect(r.executed).toBe(1);
    expect(repo.execute).toHaveBeenCalledTimes(1);
    expect(repo.execute).toHaveBeenCalledWith(T, 'e2', expect.anything(), expect.any(Date));
  });

  it('counts a held envelope (Aramo legal hold) without executing', async () => {
    const { repo, svc } = fakes();
    repo.dueForExecution.mockResolvedValue([due('e1')]);
    repo.execute.mockResolvedValue({ status: 'held' });
    const r = await svc.run();
    expect(r.held).toBe(1);
    expect(r.executed).toBe(0);
  });

  it('skips S3 when the store is dark and still runs the database purge', async () => {
    const { repo, store, svc } = fakes();
    store.enabled = false;
    repo.dueForExecution.mockResolvedValue([due('e1')]);
    await svc.run();
    expect(store.purgeEnvelopeObjects).not.toHaveBeenCalled();
    expect(repo.execute).toHaveBeenCalledWith(T, 'e1', { deleted: 0, locked: [] }, expect.any(Date));
  });

  // The delivery query itself (SignPurgeRepository.integrationCopyDelivered) is covered by the
  // real-Postgres purge integration spec; here: false alerts, true / null never alerts.
  describe('R-13 integration-copy alert', () => {
    const run = async (delivered: boolean | null) => {
      const f = fakes();
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      f.repo.dueForExecution.mockResolvedValue([due('e1')]);
      f.repo.integrationCopyDelivered.mockResolvedValue(delivered);
      await f.svc.run();
      expect(f.repo.integrationCopyDelivered).toHaveBeenCalledWith(T, 'e1');
      return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('alert_integration_copy_unconfirmed'));
    };

    it('alerts when the integration never received the executed event', async () => {
      const alerts = await run(false);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toContain('envelope_id=e1');
    });
    it('does not alert when it was delivered', async () => {
      expect(await run(true)).toHaveLength(0);
    });
    it('does not alert for a non-integration or non-completed envelope', async () => {
      expect(await run(null)).toHaveLength(0);
    });
  });

  it('queueTargeted counts queued and upgraded only', async () => {
    const { repo, svc } = fakes();
    repo.targetedEnvelopeIds.mockResolvedValue(['a', 'b', 'c', 'd']);
    repo.queue.mockResolvedValueOnce('queued').mockResolvedValueOnce('upgraded').mockResolvedValueOnce('already_queued').mockResolvedValueOnce('executed');
    expect(await svc.queueTargeted(T, 'jane@example.test', 'DOCUMENTS', 'actor')).toBe(2);
    expect(repo.queue).toHaveBeenCalledWith(T, 'a', { level: 'DOCUMENTS', reason: 'targeted', actor_user_id: 'actor' });
  });

  it('queueForAccountClosure is a no-op when disabled', async () => {
    delete process.env['SIGN_PURGE_ENABLED'];
    const { repo, svc } = fakes();
    expect(await svc.queueForAccountClosure(T, 'owner')).toBe(0);
    expect(repo.tenantTerminalEnvelopeIds).not.toHaveBeenCalled();
    expect(repo.queue).not.toHaveBeenCalled();
  });

  it('queueForAccountClosure queues every terminal envelope at REDACT / account_closed', async () => {
    const { repo, svc } = fakes();
    repo.tenantTerminalEnvelopeIds.mockResolvedValue(['a', 'b']);
    repo.queue.mockResolvedValueOnce('queued').mockResolvedValueOnce('already_queued');
    expect(await svc.queueForAccountClosure(T, 'owner')).toBe(1);
    expect(repo.queue).toHaveBeenCalledWith(T, 'a', { level: 'DOCUMENTS_AND_METADATA_AND_REDACT', reason: 'account_closed', actor_user_id: 'owner' });
    expect(repo.queue).toHaveBeenCalledWith(T, 'b', { level: 'DOCUMENTS_AND_METADATA_AND_REDACT', reason: 'account_closed', actor_user_id: 'owner' });
  });
});

describe('SignPurgeWorker', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['SIGN_PURGE_ENABLED'];
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env['SIGN_PURGE_ENABLED'];
    else process.env['SIGN_PURGE_ENABLED'] = saved;
  });

  it('is not scheduled when SIGN_PURGE_ENABLED is unset', () => {
    delete process.env['SIGN_PURGE_ENABLED'];
    const w = new SignPurgeWorker({ run: vi.fn() } as never);
    w.onApplicationBootstrap();
    expect(w.scheduled).toBe(false);
  });

  it('is scheduled when enabled and unscheduled on shutdown', async () => {
    process.env['SIGN_PURGE_ENABLED'] = '1';
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const w = new SignPurgeWorker({ run: vi.fn() } as never);
    w.onApplicationBootstrap();
    expect(w.scheduled).toBe(true);
    await w.onApplicationShutdown();
    expect(w.scheduled).toBe(false);
  });

  it('tick latch prevents an overlapping run', async () => {
    let release!: () => void;
    const run = vi.fn(async () => undefined).mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const w = new SignPurgeWorker({ run } as never);
    const first = w.tick();
    await w.tick();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await first;
    await w.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a failing run is logged and the latch is released', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const w = new SignPurgeWorker({ run } as never);
    await w.tick();
    await w.tick();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not run after shutdown', async () => {
    const run = vi.fn();
    const w = new SignPurgeWorker({ run } as never);
    await w.onApplicationShutdown();
    await w.tick();
    expect(run).not.toHaveBeenCalled();
  });
});
