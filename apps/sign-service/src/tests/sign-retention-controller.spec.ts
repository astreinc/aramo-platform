import { AramoError } from '@aramo/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignRetentionController } from '../app/retention/sign-retention.controller.js';

// Retention and Purge directive (ebd41d99) — the sender retention routes: dark gating,
// validation, refusals, and the visibility check before every envelope action.

const T = '019000a0-0000-7000-8000-000000000001';
const RID = 'req-1';
const ADMIN = { tenant_id: T, sub: 'u-admin', scopes: ['sign:envelope:read', 'sign:settings:manage', 'sign:envelope:manage:all'] };
const READER = { tenant_id: T, sub: 'u-read', scopes: ['sign:envelope:read'] };

function make(enabled = true) {
  const repo = {
    getPolicy: vi.fn(async () => ({ tenant_id: T, retention_days: null, purge_level: 'DOCUMENTS', updated_at: null, updated_by: null })),
    setPolicy: vi.fn(async (_t: string, input: { retention_days: number | null; purge_level: string }) => ({ tenant_id: T, ...input, updated_at: new Date('2026-11-01T00:00:00Z'), updated_by: 'u-admin' })),
    partyDelete: vi.fn(async () => 'deleted' as string),
    partyRestore: vi.fn(async () => 'restored' as string),
    queue: vi.fn(async () => 'queued' as string),
    dequeue: vi.fn(async () => 'dequeued' as string),
    status: vi.fn(async () => ({ state: 'QUEUED', level: 'DOCUMENTS', reason: 'manual', queued_at: new Date(), due_at: new Date('2026-11-15T00:00:00Z'), waiting_until: null, executed_at: null })),
  };
  const engine = { enabled, queueTargeted: vi.fn(async () => 3) };
  const envelopes = { assertVisible: vi.fn(async () => undefined) };
  const c = new SignRetentionController(repo as never, engine as never, envelopes as never);
  return { c, repo, engine, envelopes };
}

async function refusal(p: Promise<unknown>): Promise<AramoError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AramoError);
    return e as AramoError;
  }
  throw new Error('expected a refusal');
}

describe('SignRetentionController — dark (SIGN_PURGE_ENABLED unset)', () => {
  it('every write answers 403 ESIGN_FEATURE_NOT_AVAILABLE purge_not_enabled and touches nothing', async () => {
    const { c, repo, engine, envelopes } = make(false);
    const writes: Array<() => Promise<unknown>> = [
      () => c.setPolicy(ADMIN as never, RID, { retention_days: 30, purge_level: 'DOCUMENTS' }),
      () => c.deleteForTenant(ADMIN as never, RID, 'e1'),
      () => c.restoreForTenant(ADMIN as never, RID, 'e1'),
      () => c.queuePurge(ADMIN as never, RID, 'e1', { level: 'DOCUMENTS' }),
      () => c.dequeuePurge(ADMIN as never, RID, 'e1'),
      () => c.targeted(ADMIN as never, RID, { email: 'jane@example.test', level: 'DOCUMENTS' }),
    ];
    for (const w of writes) {
      const e = await refusal(w());
      expect(e.code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
      expect(e.statusCode).toBe(403);
      expect(e.context.details).toEqual({ reason: 'purge_not_enabled' });
    }
    for (const fn of [repo.setPolicy, repo.partyDelete, repo.partyRestore, repo.queue, repo.dequeue, engine.queueTargeted, envelopes.assertVisible]) expect(fn).not.toHaveBeenCalled();
  });

  it('GET reports can_edit false when disabled, even for an admin', async () => {
    const { c } = make(false);
    expect(await c.getPolicy(ADMIN as never)).toEqual({ retention_days: null, purge_level: 'DOCUMENTS', updated_at: null, can_edit: false });
  });
});

describe('SignRetentionController — enabled', () => {
  it('GET: can_edit only with sign:settings:manage', async () => {
    const { c } = make(true);
    expect((await c.getPolicy(ADMIN as never)).can_edit).toBe(true);
    expect((await c.getPolicy(READER as never)).can_edit).toBe(false);
  });

  it('PUT accepts null (keep forever) and 1..9999', async () => {
    const { c, repo } = make(true);
    expect(await c.setPolicy(ADMIN as never, RID, { retention_days: null, purge_level: 'DOCUMENTS' })).toMatchObject({ retention_days: null, can_edit: true });
    await c.setPolicy(ADMIN as never, RID, { retention_days: 1, purge_level: 'DOCUMENTS_AND_METADATA' });
    await c.setPolicy(ADMIN as never, RID, { retention_days: 9999, purge_level: 'DOCUMENTS_AND_METADATA_AND_REDACT' });
    expect(repo.setPolicy).toHaveBeenCalledWith(T, { retention_days: 9999, purge_level: 'DOCUMENTS_AND_METADATA_AND_REDACT' }, 'u-admin');
  });

  it('PUT defaults the level to DOCUMENTS', async () => {
    const { c, repo } = make(true);
    await c.setPolicy(ADMIN as never, RID, { retention_days: 30 });
    expect(repo.setPolicy).toHaveBeenCalledWith(T, { retention_days: 30, purge_level: 'DOCUMENTS' }, 'u-admin');
  });

  it.each([0, 10000, 1.5, 'x', -1, undefined])('PUT refuses retention_days %s with invalid_retention_days', async (days) => {
    const { c, repo } = make(true);
    const e = await refusal(c.setPolicy(ADMIN as never, RID, { retention_days: days, purge_level: 'DOCUMENTS' }));
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.statusCode).toBe(400);
    expect(e.context.details).toEqual({ reason: 'invalid_retention_days' });
    expect(repo.setPolicy).not.toHaveBeenCalled();
  });

  it('PUT refuses an unknown purge level', async () => {
    const { c } = make(true);
    const e = await refusal(c.setPolicy(ADMIN as never, RID, { retention_days: 30, purge_level: 'EVERYTHING' }));
    expect(e.context.details).toEqual({ reason: 'invalid_purge_level' });
  });

  it('delete: visibility first, the SENDER party is the tenant, non-terminal is 409 envelope_not_terminal', async () => {
    const { c, repo, envelopes } = make(true);
    expect(await c.deleteForTenant(READER as never, RID, 'e1')).toEqual({ deleted: true });
    expect(envelopes.assertVisible).toHaveBeenCalledWith(READER, 'e1', RID);
    expect(repo.partyDelete).toHaveBeenCalledWith(T, 'e1', { kind: 'SENDER', key: T }, 'u-read');
    expect(envelopes.assertVisible.mock.invocationCallOrder[0]!).toBeLessThan(repo.partyDelete.mock.invocationCallOrder[0]!);
    repo.partyDelete.mockResolvedValueOnce('not_eligible');
    const e = await refusal(c.deleteForTenant(READER as never, RID, 'e1'));
    expect(e.statusCode).toBe(409);
    expect(e.context.details).toEqual({ reason: 'envelope_not_terminal' });
  });

  it('restore: of a purged envelope is 410 ENVELOPE_PURGED', async () => {
    const { c, repo, envelopes } = make(true);
    expect(await c.restoreForTenant(READER as never, RID, 'e1')).toEqual({ restored: true });
    repo.partyRestore.mockResolvedValueOnce('not_deleted');
    expect(await c.restoreForTenant(READER as never, RID, 'e1')).toEqual({ restored: false });
    repo.partyRestore.mockResolvedValueOnce('purged');
    const e = await refusal(c.restoreForTenant(READER as never, RID, 'e1'));
    expect(e.code).toBe('ENVELOPE_PURGED');
    expect(e.statusCode).toBe(410);
    expect(envelopes.assertVisible).toHaveBeenCalledTimes(3);
  });

  it('purge: queues manual at the requested level and returns the purge view', async () => {
    const { c, repo, envelopes } = make(true);
    const out = await c.queuePurge(ADMIN as never, RID, 'e1', { level: 'DOCUMENTS_AND_METADATA' });
    expect(envelopes.assertVisible).toHaveBeenCalledWith(ADMIN, 'e1', RID);
    expect(repo.queue).toHaveBeenCalledWith(T, 'e1', { level: 'DOCUMENTS_AND_METADATA', reason: 'manual', actor_user_id: 'u-admin' });
    expect(out).toEqual({ purge: { state: 'QUEUED', level: 'DOCUMENTS', due_at: '2026-11-15T00:00:00.000Z', executed_at: null } });
  });

  it('purge: executed is 410 ENVELOPE_PURGED, not eligible is 409, bad level 400', async () => {
    const { c, repo } = make(true);
    repo.queue.mockResolvedValueOnce('executed');
    const gone = await refusal(c.queuePurge(ADMIN as never, RID, 'e1', {}));
    expect([gone.code, gone.statusCode]).toEqual(['ENVELOPE_PURGED', 410]);
    repo.queue.mockResolvedValueOnce('not_eligible');
    const ne = await refusal(c.queuePurge(ADMIN as never, RID, 'e1', {}));
    expect([ne.statusCode, ne.context.details]).toEqual([409, { reason: 'envelope_not_purgeable' }]);
    const bl = await refusal(c.queuePurge(ADMIN as never, RID, 'e1', { level: 'ALL' }));
    expect(bl.context.details).toEqual({ reason: 'invalid_purge_level' });
  });

  it('dequeue: visibility first; not queued is 409 purge_not_queued', async () => {
    const { c, repo, envelopes } = make(true);
    await c.dequeuePurge(ADMIN as never, RID, 'e1');
    expect(envelopes.assertVisible).toHaveBeenCalledWith(ADMIN, 'e1', RID);
    expect(repo.dequeue).toHaveBeenCalledWith(T, 'e1', 'u-admin');
    repo.dequeue.mockResolvedValueOnce('not_queued');
    const e = await refusal(c.dequeuePurge(ADMIN as never, RID, 'e1'));
    expect([e.statusCode, e.context.details]).toEqual([409, { reason: 'purge_not_queued' }]);
  });

  it('an invisible envelope is refused before any purge-state change', async () => {
    const { c, repo, envelopes } = make(true);
    envelopes.assertVisible.mockRejectedValue(new AramoError('ENVELOPE_NOT_FOUND', 'not found', 404, { requestId: RID }));
    for (const call of [
      () => c.deleteForTenant(READER as never, RID, 'e9'),
      () => c.restoreForTenant(READER as never, RID, 'e9'),
      () => c.queuePurge(ADMIN as never, RID, 'e9', {}),
      () => c.dequeuePurge(ADMIN as never, RID, 'e9'),
    ]) {
      expect((await refusal(call())).code).toBe('ENVELOPE_NOT_FOUND');
    }
    for (const fn of [repo.partyDelete, repo.partyRestore, repo.queue, repo.dequeue]) expect(fn).not.toHaveBeenCalled();
  });

  it('targeted: trims the email, validates it and the level, returns the queued count', async () => {
    const { c, engine } = make(true);
    expect(await c.targeted(ADMIN as never, RID, { email: '  jane@example.test ', level: 'DOCUMENTS_AND_METADATA_AND_REDACT' })).toEqual({ queued: 3 });
    expect(engine.queueTargeted).toHaveBeenCalledWith(T, 'jane@example.test', 'DOCUMENTS_AND_METADATA_AND_REDACT', 'u-admin');
    for (const email of [undefined, '', 'not-an-email', 'a@b', 42, `${'x'.repeat(320)}@example.test`]) {
      const e = await refusal(c.targeted(ADMIN as never, RID, { email, level: 'DOCUMENTS' }));
      expect(e.context.details).toEqual({ reason: 'invalid_email' });
    }
    const bl = await refusal(c.targeted(ADMIN as never, RID, { email: 'jane@example.test', level: 'NOPE' }));
    expect(bl.context.details).toEqual({ reason: 'invalid_purge_level' });
  });
});

describe('env isolation', () => {
  let saved: string | undefined;
  beforeEach(() => (saved = process.env['SIGN_PURGE_ENABLED']));
  afterEach(() => {
    if (saved === undefined) delete process.env['SIGN_PURGE_ENABLED'];
    else process.env['SIGN_PURGE_ENABLED'] = saved;
  });
  it('the controller reads enabled from the engine, not the process env', async () => {
    process.env['SIGN_PURGE_ENABLED'] = '1';
    const { c } = make(false);
    expect((await refusal(c.dequeuePurge(ADMIN as never, RID, 'e1'))).code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
  });
});
