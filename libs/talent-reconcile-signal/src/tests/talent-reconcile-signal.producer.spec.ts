import { describe, expect, it, vi } from 'vitest';

import { TalentReconcileProducer } from '../lib/talent-reconcile-signal.producer.js';
import {
  TALENT_RECONCILE_BACKSTOP_JOB,
  TALENT_RECONCILE_BACKSTOP_JOB_ID,
  TALENT_RECONCILE_JOB,
  TALENT_RECONCILE_QUEUE_NAME,
} from '../lib/talent-reconcile-signal.queue.constants.js';

// TALENT-INTEL-1 TI-1F-C — the Talent-profile reconcile push producer contract.
// Proves the write-isolation guarantees WITHOUT Redis/Postgres:
//   • a CONFIRM is NEVER coupled to reconciliation (Redis-gated no-op when
//     unconfigured; enqueue errors swallowed, never re-thrown → CONFIRM succeeds);
//   • duplicate signals are harmless (stable idempotent jobId dedups);
//   • the backstop tick registers once under a fixed jobId.

const TENANT = '10000000-0000-7000-8000-000000000001';
const TALENT = '20000000-0000-7000-8000-00000000000a';

function make(parts: { isConfigured?: boolean; add?: ReturnType<typeof vi.fn> } = {}) {
  const add = parts.add ?? vi.fn().mockResolvedValue({ id: 'job' });
  const queue = { add } as never;
  const redisConfig = { isConfigured: parts.isConfigured ?? true } as never;
  const logger = { log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const producer = new TalentReconcileProducer(queue, redisConfig, logger as never);
  return { producer, add, logger };
}

describe('TalentReconcileProducer — Redis-gate (CONFIRM never coupled to Redis)', () => {
  it('enqueueTalent + scheduleBackstop are silent no-ops when Redis is unconfigured', async () => {
    const { producer, add } = make({ isConfigured: false });
    await expect(producer.enqueueTalent(TENANT, TALENT)).resolves.toBeUndefined();
    await expect(producer.scheduleBackstop()).resolves.toBeUndefined();
    expect(add).not.toHaveBeenCalled();
  });
});

describe('TalentReconcileProducer — best-effort (enqueue error never re-thrown)', () => {
  it('enqueueTalent swallows a queue.add rejection and logs it (the CONFIRM still succeeds)', async () => {
    const add = vi.fn().mockRejectedValue(new Error('redis exploded'));
    const { producer, logger } = make({ isConfigured: true, add });
    await expect(producer.enqueueTalent(TENANT, TALENT)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'talent_reconcile_enqueue_failed' }),
    );
  });
});

describe('TalentReconcileProducer — idempotent enqueue (duplicate delivery harmless)', () => {
  it('enqueueTalent uses a stable per-talent jobId + identifiers-only payload', async () => {
    const { producer, add } = make({ isConfigured: true });
    await producer.enqueueTalent(TENANT, TALENT);
    await producer.enqueueTalent(TENANT, TALENT); // duplicate signal
    expect(add).toHaveBeenCalledTimes(2);
    for (const call of add.mock.calls) {
      expect(call[0]).toBe(TALENT_RECONCILE_JOB);
      expect(call[1]).toEqual({ kind: 'TALENT', tenant_id: TENANT, talent_id: TALENT });
      expect(call[2]).toMatchObject({ jobId: `${TALENT_RECONCILE_JOB}-talent-${TALENT}` });
    }
    expect(add.mock.calls[0][2].jobId).toBe(add.mock.calls[1][2].jobId);
  });

  it('scheduleBackstop registers ONE repeatable tick under a fixed jobId', async () => {
    const { producer, add } = make({ isConfigured: true });
    await producer.scheduleBackstop();
    expect(add).toHaveBeenCalledWith(
      TALENT_RECONCILE_BACKSTOP_JOB,
      {},
      expect.objectContaining({ jobId: TALENT_RECONCILE_BACKSTOP_JOB_ID, repeat: expect.any(Object) }),
    );
    expect(TALENT_RECONCILE_QUEUE_NAME).toBe('talent-reconcile');
  });
});
