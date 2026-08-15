// T8-CONNECTOR-A — the machine/service actor for connector execution
// (directive §21, Architect check #3).
//
// Connector execution runs as a DEDICATED ServiceAccount principal — never a
// recruiter or tenant admin. This id is written as `imported_by_id` on every
// ImportBatch the connector produces, so the persisted import/audit evidence
// makes machine (connector/system) execution unmistakable. It is seeded in
// libs/identity/prisma/seed.ts as a ServiceAccount row (parallel to User) and
// holds ONLY the minimum authority required for canonical requisition import.
export const CONNECTOR_SERVICE_ACCOUNT_ID =
  '01900000-0000-7000-8000-000000000004';

/**
 * The exact minimum effective business authority the connector actor carries
 * into the canonical T8-P2 import command (directive §21). NO tenant:admin:*,
 * NO unrelated broad scopes.
 */
export const CONNECTOR_EXECUTION_SCOPES: readonly string[] = [
  'requisition:import:write',
];

/** The audit label written into ImportBatch.source_filename — NEVER a credential. */
export function connectorImportSourceLabel(providerKey: string, connectionId: string): string {
  return `connector:${providerKey}:${connectionId}`;
}
