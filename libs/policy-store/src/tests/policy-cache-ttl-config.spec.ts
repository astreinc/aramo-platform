import { describe, expect, it } from 'vitest';

import { PolicyStore } from '../lib/policy-store.js';

// ADR-0024 PR-4d — the cache-TTL config. Default 30s; env-overridable (tests);
// a TTL of 0 (a query per decision) or unbounded/non-finite (the stale-forever
// defect) is REJECTED at construction. PolicyStore reads the env in a field
// initializer, so a fake PrismaService is enough — no query runs.
const fakePrisma = {} as never;

function withEnv(v: string | undefined, fn: () => void): void {
  const saved = process.env['ARAMO_POLICY_CACHE_TTL_MS'];
  if (v === undefined) delete process.env['ARAMO_POLICY_CACHE_TTL_MS'];
  else process.env['ARAMO_POLICY_CACHE_TTL_MS'] = v;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env['ARAMO_POLICY_CACHE_TTL_MS'];
    else process.env['ARAMO_POLICY_CACHE_TTL_MS'] = saved;
  }
}

describe('PolicyStore cache-TTL config (PR-4d)', () => {
  it('constructs with the 30s default when the env is unset', () => {
    withEnv(undefined, () => expect(() => new PolicyStore(fakePrisma)).not.toThrow());
  });

  it('accepts a positive env override (tests run with a short TTL)', () => {
    withEnv('200', () => expect(() => new PolicyStore(fakePrisma)).not.toThrow());
  });

  it('REJECTS a TTL of 0 (a query per decision defeats the cache) — HALT at construction', () => {
    withEnv('0', () => expect(() => new PolicyStore(fakePrisma)).toThrow(/reintroduces the cache-staleness defect/));
  });

  it('REJECTS a negative TTL', () => {
    withEnv('-5', () => expect(() => new PolicyStore(fakePrisma)).toThrow());
  });

  it('REJECTS an unbounded / non-finite TTL', () => {
    withEnv('Infinity', () => expect(() => new PolicyStore(fakePrisma)).toThrow());
    withEnv('not-a-number', () => expect(() => new PolicyStore(fakePrisma)).toThrow());
  });
});
