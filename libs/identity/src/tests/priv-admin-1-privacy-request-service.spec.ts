import { describe, expect, it, vi } from 'vitest';

import { PrivacyRequestService } from '../lib/privacy/privacy-request.service.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// PRIV-ADMIN-1 (LOCKED) — the record-side pieces of the operator console: execution
// attempts counted since the request last entered EXECUTING (OD-4), a failure that
// moves the request to the back of the worker queue (updated_at stamped with the
// event), the operator queue filters (§1.1) and a deterministic worker queue order.

const T0 = new Date('2026-11-27T10:00:00.000Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function svcWith(prisma: Record<string, unknown>): PrivacyRequestService {
  return new PrivacyRequestService(prisma as unknown as PrismaService);
}

describe('PrivacyRequestService — PRIV-ADMIN-1', () => {
  it('executionAttempts counts EXECUTION_FAILED events since the last entry into EXECUTING (same instant counts as after)', async () => {
    const findMany = vi.fn(async () => [
      { request_id: 'a', event_type: 'STATUS_CHANGED', payload: {}, created_at: at(0) },
      { request_id: 'a', event_type: 'EXECUTION_FAILED', payload: { error: 'OldError' }, created_at: at(1) },
      { request_id: 'a', event_type: 'STATUS_CHANGED', payload: {}, created_at: at(10) },
      { request_id: 'a', event_type: 'EXECUTION_FAILED', payload: { error: 'E1' }, created_at: at(10) },
      { request_id: 'a', event_type: 'EXECUTION_FAILED', payload: { error: 'E2' }, created_at: at(12) },
      { request_id: 'b', event_type: 'STATUS_CHANGED', payload: {}, created_at: at(0) },
    ]);
    const out = await svcWith({ privacyRequestEvent: { findMany } }).executionAttempts(['a', 'b', 'c']);
    expect(out.get('a')).toEqual({ attempts: 2, last_failure_at: at(12), last_error: 'E2' });
    expect(out.get('b')).toEqual({ attempts: 0, last_failure_at: null, last_error: null });
    expect(out.get('c')).toEqual({ attempts: 0, last_failure_at: null, last_error: null });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { request_id: { in: ['a', 'b', 'c'] }, OR: [{ event_type: 'EXECUTION_FAILED' }, { event_type: 'STATUS_CHANGED', to_status: 'EXECUTING' }] },
      }),
    );
  });

  it('executionAttempts reads nothing for no ids', async () => {
    const findMany = vi.fn();
    expect((await svcWith({ privacyRequestEvent: { findMany } }).executionAttempts([])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('recordEvent with touch stamps updated_at in the same transaction; without it updated_at is untouched', async () => {
    const create = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      privacyRequest: { findUnique: vi.fn(async () => ({ status: 'EXECUTING' })) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ privacyRequestEvent: { create }, privacyRequest: { updateMany } }),
    };
    const svc = svcWith(prisma);
    await svc.recordEvent('r1', 'NOTE', { actor_type: 'OPERATOR', actor_id: 'op' }, { note: 'x' }, T0);
    expect(updateMany).not.toHaveBeenCalled();
    await svc.recordEvent('r1', 'EXECUTION_FAILED', { actor_type: 'SYSTEM', actor_id: null }, { error: 'E' }, T0, { touch: true });
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'r1', status: 'EXECUTING' }, data: { updated_at: T0 } });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('listQueue applies channel, subject kind, assigned operator, overdue (at the injected now) and reference filters', async () => {
    const findMany = vi.fn(async () => []);
    await svcWith({ privacyRequest: { findMany } }).listQueue({
      channel: 'WEB',
      subject_kind: 'BUSINESS_MEMBER',
      assigned_operator_id: 'op-1',
      overdue: true,
      reference: 'PR-0000-0000-0000',
      include_closed: true,
      limit: 200,
      now: T0,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { channel: 'WEB', subject_kind: 'BUSINESS_MEMBER', assigned_operator_id: 'op-1', completed_at: null, due_at: { lt: T0 }, reference: 'PR-0000-0000-0000' },
      orderBy: [{ due_at: 'asc' }, { id: 'asc' }],
      take: 200,
    });
  });

  it('listExecuting orders by updated_at then id (a failed request goes to the back)', async () => {
    const findMany = vi.fn(async () => []);
    await svcWith({ privacyRequest: { findMany } }).listExecuting('SIGN', 100);
    expect(findMany).toHaveBeenCalledWith({ where: { product: 'SIGN', status: 'EXECUTING' }, orderBy: [{ updated_at: 'asc' }, { id: 'asc' }], take: 100 });
  });
});
