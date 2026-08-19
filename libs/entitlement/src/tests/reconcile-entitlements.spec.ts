import { describe, it, expect, vi } from 'vitest';

import type { Capability } from '../lib/capability.js';
import { DEFAULT_TENANT_CAPABILITIES } from '../lib/capability.js';
import {
  reconcileTenantEntitlements,
  resolveReconcileTarget,
  type EntitlementReconcileDeps,
} from '../lib/reconcile-entitlements.js';

const ASTRE = '019000a0-0000-7000-8000-000000000001';
const TENANT_B = '22222222-2222-7222-8222-222222222222';

// A fake entitlement store backed by an in-memory per-tenant Set. grant is
// additive + idempotent (mirrors createMany skipDuplicates over the composite
// PK) and records every call for isolation assertions.
function makeDeps(args: {
  exists: Set<string>;
  initial?: Record<string, Capability[]>;
  grantThrows?: boolean;
}): {
  deps: EntitlementReconcileDeps;
  store: Map<string, Set<Capability>>;
  grantCalls: Array<{ tenant_id: string; capabilities: readonly Capability[] }>;
} {
  const store = new Map<string, Set<Capability>>();
  for (const [t, caps] of Object.entries(args.initial ?? {})) {
    store.set(t, new Set(caps));
  }
  const grantCalls: Array<{
    tenant_id: string;
    capabilities: readonly Capability[];
  }> = [];
  const deps: EntitlementReconcileDeps = {
    tenantExists: vi.fn(async (id: string) => args.exists.has(id)),
    getCapabilities: vi.fn(async (id: string) => new Set(store.get(id) ?? [])),
    grantCapabilities: vi.fn(async (a) => {
      grantCalls.push(a);
      if (args.grantThrows) throw new Error('grant failed');
      const set = store.get(a.tenant_id) ?? new Set<Capability>();
      for (const c of a.capabilities) set.add(c);
      store.set(a.tenant_id, set);
    }),
  };
  return { deps, store, grantCalls };
}

describe('resolveReconcileTarget — explicit tenant id, no implicit default (test C)', () => {
  it('throws on undefined (no default)', () => {
    expect(() => resolveReconcileTarget(undefined)).toThrow(/explicit target tenant id is required/i);
  });
  it('throws on empty / whitespace', () => {
    expect(() => resolveReconcileTarget('')).toThrow(/required/i);
    expect(() => resolveReconcileTarget('   ')).toThrow(/required/i);
  });
  it('throws on a non-UUID value', () => {
    expect(() => resolveReconcileTarget('not-a-uuid')).toThrow(/not a valid UUID/i);
  });
  it('returns the trimmed id for a valid UUID', () => {
    expect(resolveReconcileTarget(`  ${ASTRE}  `)).toBe(ASTRE);
  });
});

describe('reconcileTenantEntitlements — fail-closed + additive idempotent', () => {
  it('fails closed when the tenant does not exist and writes nothing (test E)', async () => {
    const { deps, grantCalls } = makeDeps({ exists: new Set() });
    await expect(
      reconcileTenantEntitlements(deps, {
        tenantId: ASTRE,
        required: DEFAULT_TENANT_CAPABILITIES,
      }),
    ).rejects.toThrow(/does not exist/i);
    expect(grantCalls).toHaveLength(0);
  });

  it('grants the full canonical bundle to the actual target id when empty (test F6)', async () => {
    const { deps, store, grantCalls } = makeDeps({ exists: new Set([ASTRE]) });
    const r = await reconcileTenantEntitlements(deps, {
      tenantId: ASTRE,
      required: DEFAULT_TENANT_CAPABILITIES,
    });
    expect([...r.granted].sort()).toEqual(['ats', 'core', 'portal']);
    expect([...r.final].sort()).toEqual(['ats', 'core', 'portal']);
    // written to the target id, not any other
    expect(grantCalls).toHaveLength(1);
    expect(grantCalls[0]?.tenant_id).toBe(ASTRE);
    expect([...(store.get(ASTRE) ?? [])].sort()).toEqual(['ats', 'core', 'portal']);
  });

  it('adds ONLY the missing members on a partial bundle (test D)', async () => {
    const { deps, grantCalls } = makeDeps({
      exists: new Set([ASTRE]),
      initial: { [ASTRE]: ['core'] },
    });
    const r = await reconcileTenantEntitlements(deps, {
      tenantId: ASTRE,
      required: DEFAULT_TENANT_CAPABILITIES,
    });
    expect([...r.already_present].sort()).toEqual(['core']);
    expect([...r.granted].sort()).toEqual(['ats', 'portal']);
    expect(grantCalls).toHaveLength(1);
    expect([...(grantCalls[0]?.capabilities ?? [])].sort()).toEqual(['ats', 'portal']);
  });

  it('is a no-op (grants nothing) when already complete — idempotent rerun (test 7)', async () => {
    const { deps, grantCalls } = makeDeps({
      exists: new Set([ASTRE]),
      initial: { [ASTRE]: ['core', 'ats', 'portal'] },
    });
    const r = await reconcileTenantEntitlements(deps, {
      tenantId: ASTRE,
      required: DEFAULT_TENANT_CAPABILITIES,
    });
    expect(r.granted).toHaveLength(0);
    expect(grantCalls).toHaveLength(0);
  });

  it('never writes another tenant (isolation — test 9)', async () => {
    const { deps, store, grantCalls } = makeDeps({
      exists: new Set([ASTRE, TENANT_B]),
      initial: { [TENANT_B]: ['core', 'ats', 'portal'] },
    });
    await reconcileTenantEntitlements(deps, {
      tenantId: ASTRE,
      required: DEFAULT_TENANT_CAPABILITIES,
    });
    for (const call of grantCalls) expect(call.tenant_id).toBe(ASTRE);
    // Tenant B is untouched.
    expect([...(store.get(TENANT_B) ?? [])].sort()).toEqual(['ats', 'core', 'portal']);
    expect(store.has(ASTRE)).toBe(true);
  });

  it('propagates a grant failure (fail closed — test 11)', async () => {
    const { deps } = makeDeps({ exists: new Set([ASTRE]), grantThrows: true });
    await expect(
      reconcileTenantEntitlements(deps, {
        tenantId: ASTRE,
        required: DEFAULT_TENANT_CAPABILITIES,
      }),
    ).rejects.toThrow(/grant failed/);
  });

  it('regression (test 12): never grants to a hardcoded constant — only the supplied id', async () => {
    const WRONG = '01900000-0000-7000-8000-000000000001';
    const { deps, grantCalls } = makeDeps({ exists: new Set([ASTRE]) });
    await reconcileTenantEntitlements(deps, {
      tenantId: ASTRE,
      required: DEFAULT_TENANT_CAPABILITIES,
    });
    expect(grantCalls.every((c) => c.tenant_id === ASTRE)).toBe(true);
    expect(grantCalls.some((c) => c.tenant_id === WRONG)).toBe(false);
  });
});
