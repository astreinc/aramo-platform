import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TalentRecordRepository } from '../lib/talent-record.repository.js';

// ATI-SEP-1 D4 — a talent.profile_updated for an ATS evidence edit is appended
// AFTER the talent_evidence commit (no shared transaction across schemas). The
// append is retried inline (first try + 3 retries); exhaustion is logged at
// error with the talent id and never thrown (the edit already committed).

function repoWith(create: ReturnType<typeof vi.fn>) {
  return new TalentRecordRepository({ talentEventOutbox: { create } } as never);
}

const ARGS = { tenant_id: 't-1', talent_record_id: 'talent-1', changed_fields: ['skills'], correlation_id: 'rq' };

describe('ATI-SEP-1 D4 — post-commit evidence-edit event append', () => {
  it('a transient failure is retried until the row is written', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue({});
    await repoWith(create).recordProfileUpdated(ARGS);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('a persistent failure: 4 attempts, logged at error with the talent id + field names, not thrown', async () => {
    const create = vi.fn().mockRejectedValue(new Error('outbox down'));
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(repoWith(create).recordProfileUpdated(ARGS)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'talent_profile_updated_append_failed',
        talent_id: 'talent-1',
        changed_fields: ['skills'],
        attempts: 4,
      }),
    );
    error.mockRestore();
  });
});
