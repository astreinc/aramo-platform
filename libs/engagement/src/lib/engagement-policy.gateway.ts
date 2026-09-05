import type { EngagementPolicyScope } from './domain/engagement-vocab.js';

// COMM-C3 — the engagement-policy persistence PORT (directive R3/R4/R12). The
// Engagement domain owns the publication/read SERVICES but never touches a
// generated Prisma client: raw persistence over the REUSED StoredPolicyVersion
// substrate is an injected adapter (provided by the apps/api composition root via
// raw SQL). This keeps the domain lib free of cross-lib client typing and free of
// I/O, and lets the submit-gate read ride the submit transaction.

/** DI token for the gateway adapter. */
export const ENGAGEMENT_POLICY_GATEWAY = Symbol('ENGAGEMENT_POLICY_GATEWAY');

// StoredPolicyVersion scope layer encoded in `package_name` (the table has no
// scope column, R4 "no second table"): TENANT→base, CLIENT/REQUISITION→ref-suffixed.
const ENGAGEMENT_PACKAGE_BASE = 'engagement-policy';

export function engagementPackageName(scope: EngagementPolicyScope, scopeRef: string | null): string {
  switch (scope) {
    case 'TENANT':
      return ENGAGEMENT_PACKAGE_BASE;
    case 'CLIENT':
      return `${ENGAGEMENT_PACKAGE_BASE}:client:${scopeRef ?? ''}`;
    case 'REQUISITION':
      return `${ENGAGEMENT_PACKAGE_BASE}:requisition:${scopeRef ?? ''}`;
  }
}

/** A raw StoredPolicyVersion row (definition is the opaque, checksummed JSONB). */
export interface StoredPolicyVersionRow {
  readonly package_name: string;
  readonly version: string;
  readonly definition: unknown;
  readonly checksum: string;
  readonly effective_from: Date;
  readonly effective_to: Date | null;
  readonly published_by: string;
  readonly published_at: Date;
}

export interface InsertEngagementVersionInput {
  readonly tenant_id: string;
  readonly package_name: string;
  readonly version: string;
  readonly definition: unknown;
  readonly checksum: string;
  readonly effective_from: Date;
  readonly published_by: string;
}

/**
 * The persistence port. Reads return ALL rows for the given package_names (the
 * domain selects the effective window); the write is atomic (reject duplicate
 * version, close the prior open window, insert the new open version). Tenant
 * isolation is the adapter's responsibility (tenant_id predicate on every op).
 */
export interface EngagementPolicyGateway {
  /** All stored versions for the given scope package_names, tenant-scoped. */
  findVersionRows(
    tenantId: string,
    packageNames: readonly string[],
  ): Promise<StoredPolicyVersionRow[]>;

  /**
   * COMM-C3 amendment — whether the tenant has EVER published ANY engagement
   * policy version (any scope). Distinguishes `never_configured` (DORMANT /
   * non-enforcing) from `configured_but_no_effective_policy` (FAIL-CLOSED). A
   * tenant that has opted into governed engagement cannot silently revert to
   * dormant.
   */
  tenantHasAnyEngagementPolicy(tenantId: string): Promise<boolean>;

  /** Atomic publish (dup-version reject + prior-window close + insert-open). */
  insertVersion(input: InsertEngagementVersionInput): Promise<StoredPolicyVersionRow>;
}

/** The LIKE prefix that matches every engagement scope package_name (any layer). */
export const ENGAGEMENT_PACKAGE_LIKE = 'engagement-policy%';
