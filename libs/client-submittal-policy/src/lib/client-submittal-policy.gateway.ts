// CSP PR-2 — the client-submittal-policy persistence PORT. The domain owns the
// resolve / compile / decide + publish SERVICES but never touches a generated Prisma
// client: raw persistence over the REUSED StoredPolicyVersion substrate is an
// injected adapter (provided by the apps/api composition root via raw SQL). Mirrors
// the engagement pattern (R4 "no second table"); tenant isolation is the adapter's
// responsibility (tenant_id predicate on every op).

/** DI token for the gateway adapter. */
export const CLIENT_SUBMITTAL_POLICY_GATEWAY = Symbol('CLIENT_SUBMITTAL_POLICY_GATEWAY');

export type ClientSubmittalPolicyScope = 'TENANT' | 'CLIENT' | 'REQUISITION';
// Canonical least-specific -> most-specific order (the merge/compose order §D4).
export const CLIENT_SUBMITTAL_POLICY_SCOPES: readonly ClientSubmittalPolicyScope[] = ['TENANT', 'CLIENT', 'REQUISITION'];

// StoredPolicyVersion scope layer encoded in `package_name` (the table has no scope
// column): TENANT->base, CLIENT/REQUISITION->ref-suffixed. CLIENT scopeRef is the
// company_id (client key §D2); REQUISITION scopeRef is the requisition_id.
const CLIENT_SUBMITTAL_PACKAGE_BASE = 'client-submittal-policy';
/** The LIKE prefix that matches every client-submittal scope package_name. */
export const CLIENT_SUBMITTAL_PACKAGE_LIKE = 'client-submittal-policy%';

export function clientSubmittalPackageName(scope: ClientSubmittalPolicyScope, scopeRef: string | null): string {
  switch (scope) {
    case 'TENANT':
      return CLIENT_SUBMITTAL_PACKAGE_BASE;
    case 'CLIENT':
      return `${CLIENT_SUBMITTAL_PACKAGE_BASE}:client:${scopeRef ?? ''}`;
    case 'REQUISITION':
      return `${CLIENT_SUBMITTAL_PACKAGE_BASE}:requisition:${scopeRef ?? ''}`;
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

export interface InsertClientSubmittalVersionInput {
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
 * version, close the prior open window, insert the new open version).
 */
export interface ClientSubmittalPolicyGateway {
  /** All stored versions for the given scope package_names, tenant-scoped. */
  findVersionRows(tenantId: string, packageNames: readonly string[]): Promise<StoredPolicyVersionRow[]>;

  /** Atomic publish (dup-version reject + prior-window close + insert-open). */
  insertVersion(input: InsertClientSubmittalVersionInput): Promise<StoredPolicyVersionRow>;
}
