import { describe, expect, it } from 'vitest';

import { ResetBatchStore } from '../lib/reset-batch.store.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// Track-0 §6 — "ResetBatch has no update or delete surface." Assert it
// structurally: the store exposes `record` (the sole write path) + reads,
// and NO update/delete/remove/upsert. A ResetBatch is history, never mutated.

describe('ResetBatchStore — append-only by construction (§2.1 / §6)', () => {
  const methods = Object.getOwnPropertyNames(ResetBatchStore.prototype).filter(
    (m) => m !== 'constructor',
  );

  it('exposes exactly one write path (`record`) plus reads', () => {
    expect(methods).toContain('record');
    // Reads.
    expect(methods).toContain('getById');
    expect(methods).toContain('listByTenant');
    expect(methods).toContain('findCompletedRealRun');
  });

  it('has NO update / delete / remove / upsert surface', () => {
    for (const forbidden of ['update', 'delete', 'remove', 'upsert', 'save', 'set']) {
      expect(methods).not.toContain(forbidden);
    }
  });

  it('the sole write is `record` — no other method name implies mutation', () => {
    const writes = methods.filter((m) =>
      /^(update|delete|remove|upsert|patch|edit|mutate|drop|purge|clear)/i.test(m),
    );
    expect(writes).toEqual([]);
  });

  it('constructs without touching the database (DI-only)', () => {
    // The store is @Injectable and takes a PrismaService; constructing it
    // opens no connection (lazy $connect). A dummy service suffices.
    const store = new ResetBatchStore({} as unknown as PrismaService);
    expect(store).toBeInstanceOf(ResetBatchStore);
  });
});
