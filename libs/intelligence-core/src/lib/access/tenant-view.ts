import type { Assertion, AssertionLink, ExternalTalentReference, SubjectIdentifier, TenantKey } from '../repositories/types.js';
import { TI_ORIGINATED_SOURCE_KINDS } from '../vocabulary.js';

// ATI-SEP-1 T6/T10 — what ONE tenant may see of a subject (ADR-0036 §6). Shared
// by the read API, the proposal generator, disputes and contradiction resolution
// so every surface applies the same rule:
//   TI_CROSS_TENANT_READ_ENABLED=false (default, pending Legal L-1) → the tenant's
//     own assertions + TI-originated ones; its own identifiers + TI verifications
//     of values it holds;
//   true → the full Golden set.
// Pure: no I/O.

export const TI_CROSS_TENANT_READ_ENABLED_ENV = 'TI_CROSS_TENANT_READ_ENABLED';

export function crossTenantReadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[TI_CROSS_TENANT_READ_ENABLED_ENV] ?? '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

export function isOwnAssertion(a: Pick<Assertion, 'source_system_id' | 'source_tenant_id'>, tenant: TenantKey): boolean {
  return a.source_system_id === tenant.source_system_id && a.source_tenant_id === tenant.source_tenant_id;
}

export function isTiOriginated(a: Pick<Assertion, 'source_kind'>): boolean {
  return TI_ORIGINATED_SOURCE_KINDS.includes(a.source_kind);
}

/** May `tenant` see this assertion (given the cross-tenant flag)? */
export function assertionVisibleTo(a: Pick<Assertion, 'source_system_id' | 'source_tenant_id' | 'source_kind'>, tenant: TenantKey, crossTenant: boolean): boolean {
  return crossTenant || isOwnAssertion(a, tenant) || isTiOriginated(a);
}

export function tenantViewAssertions<T extends Pick<Assertion, 'source_system_id' | 'source_tenant_id' | 'source_kind'>>(
  all: T[],
  tenant: TenantKey,
  crossTenant: boolean,
): T[] {
  return all.filter((a) => assertionVisibleTo(a, tenant, crossTenant));
}

/** ACTIVE identifiers of the view. A TI verification is visible only for a value the tenant itself holds — never a new contact. */
export function tenantViewIdentifiers(
  all: SubjectIdentifier[],
  references: ExternalTalentReference[],
  tenant: TenantKey,
  crossTenant: boolean,
): SubjectIdentifier[] {
  const active = all.filter((i) => i.status === 'ACTIVE');
  if (crossTenant) return active;
  const ownRefs = new Set(
    references.filter((r) => r.source_system_id === tenant.source_system_id && r.source_tenant_id === tenant.source_tenant_id).map((r) => r.id),
  );
  const own = active.filter((i) => i.source_reference_id !== null && ownRefs.has(i.source_reference_id));
  const ownKeys = new Set(own.map((i) => `${i.identifier_type}|${i.normalized_value}`));
  const tiVerified = active.filter((i) => i.source_reference_id === null && ownKeys.has(`${i.identifier_type}|${i.normalized_value}`));
  return [...own, ...tiVerified];
}

/** Both orders of every RECONCILES link (contradiction resolution, T10 M-3) — the projection never pairs them again. */
export function reconciledPairs(links: AssertionLink[]): Set<string> {
  const out = new Set<string>();
  for (const l of links) {
    if (l.link_type !== 'RECONCILES') continue;
    out.add(`${l.from_assertion_id}|${l.to_assertion_id}`).add(`${l.to_assertion_id}|${l.from_assertion_id}`);
  }
  return out;
}

/** The distinct (source system, tenant) pairs holding an ACTIVE reference. */
export function activeReferenceTenants(references: ExternalTalentReference[]): TenantKey[] {
  const out = new Map<string, TenantKey>();
  for (const r of references) {
    if (r.status !== 'ACTIVE') continue;
    out.set(`${r.source_system_id}|${r.source_tenant_id}`, { source_system_id: r.source_system_id, source_tenant_id: r.source_tenant_id });
  }
  return [...out.values()];
}
