import { describe, expect, it } from 'vitest';

import { RequisitionLifecycleEventStore } from '../lib/requisition-lifecycle-event.store.js';

// ADR-0024 §D17c — APPEND-ONLY. A lifecycle event is history, not state: the
// store exposes a single write path (`record`) plus reads, and NO update or
// delete surface. This asserts the invariant at the code boundary — a
// reflection test that fails the moment a mutation method is added.

describe('RequisitionLifecycleEventStore — append-only surface (§D17c)', () => {
  const methods = Object.getOwnPropertyNames(
    RequisitionLifecycleEventStore.prototype,
  ).filter((m) => m !== 'constructor');

  it('exposes the single write path `record`', () => {
    expect(methods).toContain('record');
  });

  it('exposes NO update/delete/remove/mutate/patch/edit surface', () => {
    const forbidden = methods.filter((m) =>
      /update|delete|remove|mutate|patch|edit|upsert|destroy/i.test(m),
    );
    expect(forbidden).toEqual([]);
  });

  it('the surface is exactly {record} + the three read methods, nothing else', () => {
    expect(methods.sort()).toEqual([
      'getById',
      'listByCorrelation',
      'listByRequisition',
      'record',
    ]);
  });
});
