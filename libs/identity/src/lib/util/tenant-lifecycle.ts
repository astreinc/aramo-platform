// Platform-Console Increment-2 PR-1 — tenant lifecycle state machine.
//
// String statuses enforced in application code (the repo convention:
// invite_status / domain_verification_status), NOT a Prisma enum — adding a
// state stays a code change. The transition table below is EXACTLY the
// architecture doc Part II §A table (repo path
// doc/architecture/aramo-platform-console-enterprise-architecture.md).

export const TENANT_STATUSES = [
  'PROVISIONED',
  'ACTIVE',
  'SUSPENDED',
  'OFFBOARDING',
  'CLOSED',
] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export function isTenantStatus(v: string): v is TenantStatus {
  return (TENANT_STATUSES as readonly string[]).includes(v);
}

// Legal transitions (doc Part II §A). `— → PROVISIONED` (provision) is the
// birth state (Tenant.status default), not a transition through this table.
export const TENANT_TRANSITIONS: Readonly<Record<TenantStatus, readonly TenantStatus[]>> = {
  PROVISIONED: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['SUSPENDED', 'OFFBOARDING'],
  SUSPENDED: ['ACTIVE', 'OFFBOARDING'],
  OFFBOARDING: ['CLOSED'],
  CLOSED: [], // terminal
};

export function isLegalTransition(from: TenantStatus, to: TenantStatus): boolean {
  return TENANT_TRANSITIONS[from].includes(to);
}

// Login-gate semantics (doc Part II §A login-gate table). Only these two states
// deny a tenant-consumer session mint; PROVISIONED/ACTIVE/OFFBOARDING mint
// normally (PROVISIONED MUST mint so the owner's first-login flow proceeds —
// blocking it would deadlock activation).
export const MINT_DENYING_STATUSES: ReadonlySet<TenantStatus> = new Set([
  'SUSPENDED',
  'CLOSED',
]);

// The system ServiceAccount id used as actor_id for automatic (actor_type=
// 'system') lifecycle writes — the inline activation on owner acceptance. MUST
// equal SEED_IDS.service_account_system in libs/identity/prisma/seed.ts (the
// audit actor_id is a plain uuid column, not an FK, but the row exists via the
// seed so the actor resolves).
export const SYSTEM_SERVICE_ACCOUNT_ID =
  '01900000-0000-7000-8000-000000000003';

// The owner role key whose acceptance activates a PROVISIONED tenant (R10).
export const TENANT_OWNER_ROLE_KEY = 'tenant_owner';

