import { describe, expect, it, vi } from 'vitest';

import { CanonicalReconcileProducer } from '../lib/canonical-reconcile.producer.js';
import {
  CANONICAL_RECONCILE_BACKSTOP_JOB,
  CANONICAL_RECONCILE_BACKSTOP_JOB_ID,
  CANONICAL_RECONCILE_JOB,
  CANONICAL_RECONCILE_QUEUE_NAME,
} from '../lib/canonical-reconcile.queue.constants.js';

// SKILL-TAX Canonical Reconciliation Activation — the best-effort producer contract.
// These prove the two write-isolation Gate guarantees WITHOUT Redis/Postgres:
//   • a user-facing write is NEVER coupled to canonicalization (Redis-gated no-op
//     when unconfigured; enqueue errors are swallowed, never re-thrown);
//   • duplicate signals are harmless (a stable idempotent jobId dedups).

const TENANT = '10000000-0000-7000-8000-000000000001';
const TALENT = '20000000-0000-7000-8000-00000000000a';
const REQ = '30000000-0000-7000-8000-000000000001';
const GP = '50000000-0000-7000-8000-000000000001';

function make(parts: { isConfigured?: boolean; add?: ReturnType<typeof vi.fn> } = {}) {
  const add = parts.add ?? vi.fn().mockResolvedValue({ id: 'job' });
  const queue = { add } as never;
  const redisConfig = { isConfigured: parts.isConfigured ?? true } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const producer = new CanonicalReconcileProducer(queue, redisConfig, logger as never);
  return { producer, add, logger };
}

describe('CanonicalReconcileProducer — Redis-gate (write never coupled to Redis)', () => {
  it('enqueueTalent is a silent no-op when Redis is unconfigured', async () => {
    const { producer, add } = make({ isConfigured: false });
    await expect(producer.enqueueTalent(TENANT, TALENT)).resolves.toBeUndefined();
    expect(add).not.toHaveBeenCalled();
  });

  it('enqueueRequisition + scheduleBackstop are silent no-ops when Redis is unconfigured', async () => {
    const { producer, add } = make({ isConfigured: false });
    await expect(producer.enqueueRequisition(TENANT, REQ, GP)).resolves.toBeUndefined();
    await expect(producer.scheduleBackstop()).resolves.toBeUndefined();
    expect(add).not.toHaveBeenCalled();
  });
});

describe('CanonicalReconcileProducer — best-effort (enqueue error never re-thrown)', () => {
  it('enqueueTalent swallows a queue.add rejection and logs it (the create still succeeds)', async () => {
    const add = vi.fn().mockRejectedValue(new Error('redis exploded'));
    const { producer, logger } = make({ isConfigured: true, add });
    await expect(producer.enqueueTalent(TENANT, TALENT)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'canonical_reconcile_enqueue_failed', kind: 'TALENT' }),
    );
  });

  it('enqueueRequisition swallows a queue.add rejection (confirmProfile still succeeds)', async () => {
    const add = vi.fn().mockRejectedValue(new Error('redis exploded'));
    const { producer, logger } = make({ isConfigured: true, add });
    await expect(producer.enqueueRequisition(TENANT, REQ, GP)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'canonical_reconcile_enqueue_failed', kind: 'REQUISITION' }),
    );
  });
});

describe('CanonicalReconcileProducer — idempotent enqueue (duplicate delivery harmless)', () => {
  it('enqueueTalent uses a stable per-talent jobId + identifiers-only payload', async () => {
    const { producer, add } = make({ isConfigured: true });
    await producer.enqueueTalent(TENANT, TALENT);
    await producer.enqueueTalent(TENANT, TALENT); // duplicate signal
    expect(add).toHaveBeenCalledTimes(2);
    for (const call of add.mock.calls) {
      expect(call[0]).toBe(CANONICAL_RECONCILE_JOB);
      expect(call[1]).toEqual({ kind: 'TALENT', tenant_id: TENANT, talent_id: TALENT });
      expect(call[2]).toMatchObject({ jobId: `${CANONICAL_RECONCILE_JOB}-talent-${TALENT}` });
    }
    // Both signals carry the SAME jobId → BullMQ dedups while pending.
    expect(add.mock.calls[0][2].jobId).toBe(add.mock.calls[1][2].jobId);
  });

  it('enqueueRequisition keys the jobId by golden_profile_id (identifiers only)', async () => {
    const { producer, add } = make({ isConfigured: true });
    await producer.enqueueRequisition(TENANT, REQ, GP);
    expect(add).toHaveBeenCalledWith(
      CANONICAL_RECONCILE_JOB,
      { kind: 'REQUISITION', tenant_id: TENANT, requisition_id: REQ, golden_profile_id: GP },
      expect.objectContaining({ jobId: `${CANONICAL_RECONCILE_JOB}-requisition-${GP}` }),
    );
  });

  it('scheduleBackstop registers ONE repeatable tick under a fixed jobId', async () => {
    const { producer, add } = make({ isConfigured: true });
    await producer.scheduleBackstop();
    expect(add).toHaveBeenCalledWith(
      CANONICAL_RECONCILE_BACKSTOP_JOB,
      {},
      expect.objectContaining({ jobId: CANONICAL_RECONCILE_BACKSTOP_JOB_ID, repeat: expect.any(Object) }),
    );
    expect(CANONICAL_RECONCILE_QUEUE_NAME).toBe('canonical-reconciliation');
  });
});
