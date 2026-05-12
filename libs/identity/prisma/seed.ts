// Deterministic bootstrap seed for the identity module.
//
// Per directive §8: produces the foundational identity state (one tenant,
// one admin user, one membership with tenant_admin, three roles, six scopes,
// role-scope assignments, one ServiceAccount, one ExternalIdentity, and one
// IdentityAuditEvent row per creation).
//
// Idempotent: re-running produces no errors, no duplicates, identical state.
// Determinism: all UUIDs and the cognito provider_subject are hardcoded so
// integration tests can rely on stable IDs.

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/client/client.js';

// =============================================================================
// Fixed seed UUIDs (hardcoded constants per directive §8).
// =============================================================================
export const SEED_IDS = {
  tenant: '01900000-0000-7000-8000-000000000001',
  user_admin: '01900000-0000-7000-8000-000000000002',
  service_account_system: '01900000-0000-7000-8000-000000000003',
  external_identity_admin: '01900000-0000-7000-8000-000000000004',
  membership_admin: '01900000-0000-7000-8000-000000000005',
  roles: {
    tenant_admin: '01900000-0000-7000-8000-000000000010',
    recruiter: '01900000-0000-7000-8000-000000000011',
    viewer: '01900000-0000-7000-8000-000000000012',
  },
  scopes: {
    'consent:read': '01900000-0000-7000-8000-000000000020',
    'consent:write': '01900000-0000-7000-8000-000000000021',
    'consent:decision-log:read': '01900000-0000-7000-8000-000000000022',
    'auth:session:read': '01900000-0000-7000-8000-000000000023',
    'identity:user:read': '01900000-0000-7000-8000-000000000024',
    'identity:tenant:read': '01900000-0000-7000-8000-000000000025',
  },
  // RoleScope ids — one per (role,scope) assignment. Hardcoded sequence
  // ...030..03c (13 assignments total: 6 tenant_admin + 4 recruiter + 3 viewer).
  role_scopes: {
    tenant_admin_consent_read: '01900000-0000-7000-8000-000000000030',
    tenant_admin_consent_write: '01900000-0000-7000-8000-000000000031',
    tenant_admin_consent_decision_log_read: '01900000-0000-7000-8000-000000000032',
    tenant_admin_auth_session_read: '01900000-0000-7000-8000-000000000033',
    tenant_admin_identity_user_read: '01900000-0000-7000-8000-000000000034',
    tenant_admin_identity_tenant_read: '01900000-0000-7000-8000-000000000035',
    recruiter_consent_read: '01900000-0000-7000-8000-000000000036',
    recruiter_consent_write: '01900000-0000-7000-8000-000000000037',
    recruiter_consent_decision_log_read: '01900000-0000-7000-8000-000000000038',
    recruiter_auth_session_read: '01900000-0000-7000-8000-000000000039',
    viewer_consent_read: '01900000-0000-7000-8000-00000000003a',
    viewer_consent_decision_log_read: '01900000-0000-7000-8000-00000000003b',
    viewer_auth_session_read: '01900000-0000-7000-8000-00000000003c',
  },
  membership_role_admin: '01900000-0000-7000-8000-000000000040',
  audit_events: {
    tenant_created: '01900000-0000-7000-8000-000000000050',
    user_created: '01900000-0000-7000-8000-000000000051',
    membership_created: '01900000-0000-7000-8000-000000000052',
    external_identity_linked: '01900000-0000-7000-8000-000000000053',
    role_tenant_admin_created: '01900000-0000-7000-8000-000000000054',
    role_recruiter_created: '01900000-0000-7000-8000-000000000055',
    role_viewer_created: '01900000-0000-7000-8000-000000000056',
    scope_consent_read_created: '01900000-0000-7000-8000-000000000057',
    scope_consent_write_created: '01900000-0000-7000-8000-000000000058',
    scope_consent_decision_log_read_created: '01900000-0000-7000-8000-000000000059',
    scope_auth_session_read_created: '01900000-0000-7000-8000-00000000005a',
    scope_identity_user_read_created: '01900000-0000-7000-8000-00000000005b',
    scope_identity_tenant_read_created: '01900000-0000-7000-8000-00000000005c',
    service_account_created: '01900000-0000-7000-8000-00000000005d',
  },
} as const;

export const SEED_COGNITO_SUB = 'fixed-dev-cognito-sub-01';
export const SEED_TENANT_NAME = 'Aramo Dev Tenant';
export const SEED_ADMIN_EMAIL = 'admin@aramo.dev';
export const SEED_ADMIN_DISPLAY_NAME = 'Aramo Dev Admin';
export const SEED_SERVICE_ACCOUNT_NAME = 'system-bootstrap';
export const SEED_SERVICE_ACCOUNT_DESCRIPTION =
  'System actor for seed/migration audit events';

// Per-role scope assignments (directive §6 + §9 test 17, locked).
const ROLE_SCOPE_ASSIGNMENTS = {
  tenant_admin: [
    'consent:read',
    'consent:write',
    'consent:decision-log:read',
    'auth:session:read',
    'identity:user:read',
    'identity:tenant:read',
  ],
  recruiter: [
    'consent:read',
    'consent:write',
    'consent:decision-log:read',
    'auth:session:read',
  ],
  viewer: ['consent:read', 'consent:decision-log:read', 'auth:session:read'],
} as const;

const ROLE_SCOPE_ROW_IDS: Record<string, string> = {
  'tenant_admin:consent:read': SEED_IDS.role_scopes.tenant_admin_consent_read,
  'tenant_admin:consent:write': SEED_IDS.role_scopes.tenant_admin_consent_write,
  'tenant_admin:consent:decision-log:read':
    SEED_IDS.role_scopes.tenant_admin_consent_decision_log_read,
  'tenant_admin:auth:session:read': SEED_IDS.role_scopes.tenant_admin_auth_session_read,
  'tenant_admin:identity:user:read': SEED_IDS.role_scopes.tenant_admin_identity_user_read,
  'tenant_admin:identity:tenant:read':
    SEED_IDS.role_scopes.tenant_admin_identity_tenant_read,
  'recruiter:consent:read': SEED_IDS.role_scopes.recruiter_consent_read,
  'recruiter:consent:write': SEED_IDS.role_scopes.recruiter_consent_write,
  'recruiter:consent:decision-log:read':
    SEED_IDS.role_scopes.recruiter_consent_decision_log_read,
  'recruiter:auth:session:read': SEED_IDS.role_scopes.recruiter_auth_session_read,
  'viewer:consent:read': SEED_IDS.role_scopes.viewer_consent_read,
  'viewer:consent:decision-log:read': SEED_IDS.role_scopes.viewer_consent_decision_log_read,
  'viewer:auth:session:read': SEED_IDS.role_scopes.viewer_auth_session_read,
};

interface IdentityPrismaClient {
  tenant: typeof PrismaClient.prototype.tenant;
  user: typeof PrismaClient.prototype.user;
  serviceAccount: typeof PrismaClient.prototype.serviceAccount;
  externalIdentity: typeof PrismaClient.prototype.externalIdentity;
  userTenantMembership: typeof PrismaClient.prototype.userTenantMembership;
  role: typeof PrismaClient.prototype.role;
  scope: typeof PrismaClient.prototype.scope;
  roleScope: typeof PrismaClient.prototype.roleScope;
  userTenantMembershipRole: typeof PrismaClient.prototype.userTenantMembershipRole;
  identityAuditEvent: typeof PrismaClient.prototype.identityAuditEvent;
}

// Seed entrypoint. Returns the system ServiceAccount id (handy for callers
// that want to verify which actor wrote the audit events).
export async function runIdentitySeed(prisma: IdentityPrismaClient): Promise<{
  service_account_id: string;
}> {
  // 1. Tenant (idempotent upsert keyed on stable id).
  await prisma.tenant.upsert({
    where: { id: SEED_IDS.tenant },
    update: {},
    create: {
      id: SEED_IDS.tenant,
      name: SEED_TENANT_NAME,
      is_active: true,
    },
  });

  // 2. User (admin).
  await prisma.user.upsert({
    where: { id: SEED_IDS.user_admin },
    update: {},
    create: {
      id: SEED_IDS.user_admin,
      email: SEED_ADMIN_EMAIL,
      display_name: SEED_ADMIN_DISPLAY_NAME,
      is_active: true,
    },
  });

  // 9. ServiceAccount (system actor for audit events).
  // Created before any audit row so audit rows can reference it as actor_id.
  await prisma.serviceAccount.upsert({
    where: { id: SEED_IDS.service_account_system },
    update: {},
    create: {
      id: SEED_IDS.service_account_system,
      name: SEED_SERVICE_ACCOUNT_NAME,
      description: SEED_SERVICE_ACCOUNT_DESCRIPTION,
      is_active: true,
    },
  });

  // 5. Roles (3 entries per §6).
  await upsertRole(prisma, SEED_IDS.roles.tenant_admin, 'tenant_admin', 'Tenant administrator — full scope set');
  await upsertRole(prisma, SEED_IDS.roles.recruiter, 'recruiter', 'Domain-operator role for talent and consent management');
  await upsertRole(prisma, SEED_IDS.roles.viewer, 'viewer', 'Read-only role');

  // 6. Scopes (6 entries per §6).
  await upsertScope(prisma, SEED_IDS.scopes['consent:read'], 'consent:read', 'Read consent state');
  await upsertScope(prisma, SEED_IDS.scopes['consent:write'], 'consent:write', 'Grant or revoke consent');
  await upsertScope(prisma, SEED_IDS.scopes['consent:decision-log:read'], 'consent:decision-log:read', 'Read consent decision log');
  await upsertScope(prisma, SEED_IDS.scopes['auth:session:read'], 'auth:session:read', 'Read authenticated session info');
  await upsertScope(prisma, SEED_IDS.scopes['identity:user:read'], 'identity:user:read', 'Read user identity');
  await upsertScope(prisma, SEED_IDS.scopes['identity:tenant:read'], 'identity:tenant:read', 'Read tenant identity');

  // 7. RoleScope assignments (13 rows total).
  for (const [roleKey, scopeKeys] of Object.entries(ROLE_SCOPE_ASSIGNMENTS)) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`Missing fixed RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // 3. Membership.
  await prisma.userTenantMembership.upsert({
    where: {
      user_id_tenant_id: {
        user_id: SEED_IDS.user_admin,
        tenant_id: SEED_IDS.tenant,
      },
    },
    update: {},
    create: {
      id: SEED_IDS.membership_admin,
      user_id: SEED_IDS.user_admin,
      tenant_id: SEED_IDS.tenant,
      is_active: true,
    },
  });

  // 8. UserTenantMembershipRole — assign tenant_admin to the seed membership.
  await prisma.userTenantMembershipRole.upsert({
    where: {
      membership_id_role_id: {
        membership_id: SEED_IDS.membership_admin,
        role_id: SEED_IDS.roles.tenant_admin,
      },
    },
    update: {},
    create: {
      id: SEED_IDS.membership_role_admin,
      membership_id: SEED_IDS.membership_admin,
      role_id: SEED_IDS.roles.tenant_admin,
    },
  });

  // 4. ExternalIdentity (cognito provider).
  await prisma.externalIdentity.upsert({
    where: {
      provider_provider_subject: {
        provider: 'cognito',
        provider_subject: SEED_COGNITO_SUB,
      },
    },
    update: {},
    create: {
      id: SEED_IDS.external_identity_admin,
      provider: 'cognito',
      provider_subject: SEED_COGNITO_SUB,
      user_id: SEED_IDS.user_admin,
      email_snapshot: SEED_ADMIN_EMAIL,
    },
  });

  // 10. IdentityAuditEvent — one row per creation.
  // tenant_id assignment follows directive §6 event_type → index-category mapping.
  // actor_type: 'system'; actor_id: the system ServiceAccount id.
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.tenant_created,
    tenant_id: SEED_IDS.tenant, // tenant-scoped event
    event_type: 'identity.tenant.created',
    subject_id: SEED_IDS.tenant,
    payload: { tenant_id: SEED_IDS.tenant, name: SEED_TENANT_NAME },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.user_created,
    tenant_id: null, // global event
    event_type: 'identity.user.created',
    subject_id: SEED_IDS.user_admin,
    payload: { user_id: SEED_IDS.user_admin, email: SEED_ADMIN_EMAIL },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.membership_created,
    tenant_id: SEED_IDS.tenant, // tenant-scoped event
    event_type: 'identity.membership.created',
    subject_id: SEED_IDS.user_admin,
    payload: {
      membership_id: SEED_IDS.membership_admin,
      user_id: SEED_IDS.user_admin,
      tenant_id: SEED_IDS.tenant,
    },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.external_identity_linked,
    tenant_id: null, // global event
    event_type: 'identity.external_identity.linked',
    subject_id: SEED_IDS.user_admin,
    payload: {
      external_identity_id: SEED_IDS.external_identity_admin,
      provider: 'cognito',
      provider_subject: SEED_COGNITO_SUB,
      user_id: SEED_IDS.user_admin,
    },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.role_tenant_admin_created,
    tenant_id: null,
    event_type: 'identity.role.created',
    subject_id: SEED_IDS.roles.tenant_admin,
    payload: { role_id: SEED_IDS.roles.tenant_admin, key: 'tenant_admin' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.role_recruiter_created,
    tenant_id: null,
    event_type: 'identity.role.created',
    subject_id: SEED_IDS.roles.recruiter,
    payload: { role_id: SEED_IDS.roles.recruiter, key: 'recruiter' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.role_viewer_created,
    tenant_id: null,
    event_type: 'identity.role.created',
    subject_id: SEED_IDS.roles.viewer,
    payload: { role_id: SEED_IDS.roles.viewer, key: 'viewer' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_consent_read_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['consent:read'],
    payload: { scope_id: SEED_IDS.scopes['consent:read'], key: 'consent:read' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_consent_write_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['consent:write'],
    payload: { scope_id: SEED_IDS.scopes['consent:write'], key: 'consent:write' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_consent_decision_log_read_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['consent:decision-log:read'],
    payload: {
      scope_id: SEED_IDS.scopes['consent:decision-log:read'],
      key: 'consent:decision-log:read',
    },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_auth_session_read_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['auth:session:read'],
    payload: { scope_id: SEED_IDS.scopes['auth:session:read'], key: 'auth:session:read' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_identity_user_read_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['identity:user:read'],
    payload: {
      scope_id: SEED_IDS.scopes['identity:user:read'],
      key: 'identity:user:read',
    },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_identity_tenant_read_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['identity:tenant:read'],
    payload: {
      scope_id: SEED_IDS.scopes['identity:tenant:read'],
      key: 'identity:tenant:read',
    },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.service_account_created,
    tenant_id: null,
    event_type: 'identity.service_account.created',
    subject_id: SEED_IDS.service_account_system,
    payload: {
      service_account_id: SEED_IDS.service_account_system,
      name: SEED_SERVICE_ACCOUNT_NAME,
    },
  });

  return { service_account_id: SEED_IDS.service_account_system };
}

async function upsertRole(
  prisma: IdentityPrismaClient,
  id: string,
  key: string,
  description: string,
): Promise<void> {
  await prisma.role.upsert({
    where: { id },
    update: {},
    create: { id, key, description, is_active: true },
  });
}

async function upsertScope(
  prisma: IdentityPrismaClient,
  id: string,
  key: string,
  description: string,
): Promise<void> {
  await prisma.scope.upsert({
    where: { id },
    update: {},
    create: { id, key, description },
  });
}

function roleIdForKey(key: string): string {
  if (key === 'tenant_admin') return SEED_IDS.roles.tenant_admin;
  if (key === 'recruiter') return SEED_IDS.roles.recruiter;
  if (key === 'viewer') return SEED_IDS.roles.viewer;
  throw new Error(`Unknown role key in seed: ${key}`);
}

function scopeIdForKey(key: string): string {
  const id = (SEED_IDS.scopes as Record<string, string>)[key];
  if (id === undefined) {
    throw new Error(`Unknown scope key in seed: ${key}`);
  }
  return id;
}

interface AuditUpsertInput {
  id: string;
  tenant_id: string | null;
  event_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
}

async function upsertAudit(
  prisma: IdentityPrismaClient,
  input: AuditUpsertInput,
): Promise<void> {
  await prisma.identityAuditEvent.upsert({
    where: { id: input.id },
    update: {},
    create: {
      id: input.id,
      tenant_id: input.tenant_id,
      actor_id: SEED_IDS.service_account_system,
      actor_type: 'system',
      event_type: input.event_type,
      subject_id: input.subject_id,
      event_payload: input.payload as never,
    },
  });
}

// CLI entrypoint — `npm run prisma:seed-identity` invokes this file.
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error('DATABASE_URL is not configured');
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    await prisma.$connect();
    await runIdentitySeed(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

// ESM detection: only run main() when invoked as the entrypoint.
const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  /seed\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error('identity seed failed:', err);
    process.exit(1);
  });
}
