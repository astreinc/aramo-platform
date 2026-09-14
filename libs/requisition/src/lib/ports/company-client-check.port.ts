// Company Party/Role (ADR-0032, R7 / CLIENT-workflow invariant) — the port by
// which requisition asks whether a referenced company is a CLIENT, WITHOUT
// taking a dependency on @aramo/company (requisition stays decoupled — see
// requisition.module.ts "No imports of @aramo/company"). apps/api provides the
// company-backed adapter at composition; libs/requisition specs provide a fake.
// This is an in-process DI seam (same-process cross-L3), not a network
// connector, so no Pact/HTTP contract is required — the contract is this
// TypeScript interface.

// String token (NOT a bare class type) — a shared-class provider token can
// collide with app.get(Type,{strict:false}); the string token is collision-safe.
export const COMPANY_CLIENT_CHECK_PORT = 'COMPANY_CLIENT_CHECK_PORT';

export interface CompanyClientCheckPort {
  // True iff the company (within the tenant) holds a CLIENT relationship.
  isClientCompany(args: {
    readonly tenant_id: string;
    readonly company_id: string;
  }): Promise<boolean>;
}
