import { describe, expect, it } from 'vitest';

import { recordUsage } from '../lib/record-usage.js';

// PR-A1c — recordUsage helper unit test (always runs; no testcontainer).
//
// White-box assertion that the helper builds the expected $executeRaw
// shape — same table, same columns, same interpolation count. Drives
// the function through a stub that captures the tagged-template
// arguments, so future drift in the INSERT shape (e.g. a column rename
// or a missed interpolation) trips this check independent of the
// PG-transactional integration test in
// transactional-guarantee.integration.spec.ts.

describe('recordUsage — shape', () => {
  function makeStub() {
    const captured: { strings: string[]; values: unknown[] } = {
      strings: [],
      values: [],
    };
    const stub = {
      $executeRaw: (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        captured.strings = [...strings];
        captured.values = values;
        return Promise.resolve(1);
      },
    };
    return { stub, captured };
  }

  it('builds an INSERT into metering."UsageEvent" with the locked column list', () => {
    const { stub, captured } = makeStub();
    recordUsage(stub, {
      tenant_id: '11111111-1111-7111-8111-111111111111',
      event_type: 'engagement.state_transition',
    });
    const sql = captured.strings.join('?');
    expect(sql).toContain('INSERT INTO metering."UsageEvent"');
    expect(sql).toContain('id, tenant_id, event_type, quantity, occurred_at');
    expect(sql).toContain('NOW()');
  });

  it('interpolates 4 values: id, tenant_id, event_type, quantity', () => {
    const { stub, captured } = makeStub();
    recordUsage(stub, {
      tenant_id: '11111111-1111-7111-8111-111111111111',
      event_type: 'submittal.state_transition',
      quantity: 3,
    });
    expect(captured.values).toHaveLength(4);
    // captured.values[0] is the uuidv7-generated id (string); we only
    // assert it's a non-empty string here.
    expect(typeof captured.values[0]).toBe('string');
    expect((captured.values[0] as string).length).toBeGreaterThan(0);
    expect(captured.values[1]).toBe('11111111-1111-7111-8111-111111111111');
    expect(captured.values[2]).toBe('submittal.state_transition');
    expect(captured.values[3]).toBe(3);
  });

  it('defaults quantity to 1 when omitted', () => {
    const { stub, captured } = makeStub();
    recordUsage(stub, {
      tenant_id: '11111111-1111-7111-8111-111111111111',
      event_type: 'engagement.state_transition',
    });
    expect(captured.values[3]).toBe(1);
  });

  it('returns the value from prisma.$executeRaw (so callers can place it in $transaction([...]))', async () => {
    const stub = {
      $executeRaw: () => Promise.resolve(42 as unknown as number),
    };
    const result = recordUsage(stub, {
      tenant_id: '11111111-1111-7111-8111-111111111111',
      event_type: 'engagement.state_transition',
    });
    await expect(result as unknown as Promise<number>).resolves.toBe(42);
  });
});
