import type { TenantService } from '@aramo/identity';
import {
  buildHostAuthProfileSeedRows,
  type HostAuthProfileDto,
  type HostClass,
  type HostAuthProfileSeedRow,
} from '@aramo/auth-storage';

import { HostAuthProfileService } from '../app/auth/host-auth-profile.service.js';
import { HostBaseResolver } from '../app/auth/host-base-resolver.service.js';

// Auth-Decoupling PR-1 — shared unit fixtures for the §3 host auth-profile
// verification specs (behaviour-parity, fail-open, slug null-case). ONE helper
// per the standing rail: the fake store, the fake tenant read, and the two
// HostBaseResolver wirings (legacy-via-empty-registry vs registry-active) are
// uniform across all three specs. NOT a *.spec.ts, so it is not collected.

// A minimal active tenant as HostAuthProfileService reads it — only
// identity_provider is consulted.
export interface FakeTenant {
  identity_provider: string | null;
}

// slug → active tenant (null ⇒ no active tenant for that slug). Mirrors
// TenantService.findActiveBySlug's contract for the classifier's single read.
export function fakeTenantService(bySlug: Record<string, FakeTenant>): TenantService {
  return {
    findActiveBySlug: async (slug: string): Promise<FakeTenant | null> =>
      bySlug[slug] ?? null,
  } as unknown as TenantService;
}

function seedToDto(row: HostAuthProfileSeedRow): HostAuthProfileDto {
  return {
    ...row,
    created_at: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-19T00:00:00.000Z',
  };
}

// A HostAuthProfileStore whose active rows are the seed rows for `env`. Pass an
// empty override to model an EMPTY registry; pass `throws: true` to fault-inject.
export function fakeStore(opts?: {
  env?: Record<string, string | undefined>;
  empty?: boolean;
  throws?: boolean;
}): { activeByClass(): Promise<Map<HostClass, HostAuthProfileDto>> } {
  return {
    activeByClass: async (): Promise<Map<HostClass, HostAuthProfileDto>> => {
      if (opts?.throws === true) throw new Error('registry-unavailable');
      const map = new Map<HostClass, HostAuthProfileDto>();
      if (opts?.empty === true) return map;
      for (const row of buildHostAuthProfileSeedRows(opts?.env ?? process.env)) {
        map.set(row.host_class, seedToDto(row));
      }
      return map;
    },
  };
}

// HostBaseResolver whose registry is ACTIVE (seeded from env).
export function resolverWithRegistry(
  tenants: TenantService,
  env?: Record<string, string | undefined>,
): HostBaseResolver {
  const store = fakeStore({ env }) as never;
  const classifier = new HostAuthProfileService(store, tenants);
  return new HostBaseResolver(tenants, classifier);
}

// HostBaseResolver whose registry always MISSES (empty) — i.e. the pre-PR-1
// legacy path, reached by fall-through. This is the "before" oracle.
export function resolverLegacy(tenants: TenantService): HostBaseResolver {
  const store = fakeStore({ empty: true }) as never;
  const classifier = new HostAuthProfileService(store, tenants);
  return new HostBaseResolver(tenants, classifier);
}

// HostBaseResolver whose registry always THROWS — proves fail-open fall-through.
export function resolverFaulting(tenants: TenantService): HostBaseResolver {
  const store = fakeStore({ throws: true }) as never;
  const classifier = new HostAuthProfileService(store, tenants);
  return new HostBaseResolver(tenants, classifier);
}

export { HostAuthProfileService };
