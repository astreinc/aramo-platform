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
    candidate: '01900000-0000-7000-8000-000000000013', // PR-A1a Ruling 3
  },
  scopes: {
    'consent:read': '01900000-0000-7000-8000-000000000020',
    'consent:write': '01900000-0000-7000-8000-000000000021',
    'consent:decision-log:read': '01900000-0000-7000-8000-000000000022',
    'auth:session:read': '01900000-0000-7000-8000-000000000023',
    'identity:user:read': '01900000-0000-7000-8000-000000000024',
    'identity:tenant:read': '01900000-0000-7000-8000-000000000025',
    // PR-A1a Ruling 2 — ATS subset (3)
    'requisition:read': '01900000-0000-7000-8000-000000000060',
    'requisition:read:all': '01900000-0000-7000-8000-000000000061',
    'submittal:create': '01900000-0000-7000-8000-000000000062',
    'submittal:approve': '01900000-0000-7000-8000-000000000063',
    // PR-A1a Ruling 3 — Portal subset (4)
    'portal:profile:read': '01900000-0000-7000-8000-000000000064',
    'portal:profile:edit': '01900000-0000-7000-8000-000000000065',
    'portal:consent:read': '01900000-0000-7000-8000-000000000066',
    'portal:consent:write': '01900000-0000-7000-8000-000000000067',
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
    // PR-A1a Ruling 2/3 — 12 new RoleScope rows (4 tenant_admin, 3 recruiter, 1 viewer, 4 candidate).
    tenant_admin_requisition_read: '01900000-0000-7000-8000-000000000100',
    tenant_admin_requisition_read_all: '01900000-0000-7000-8000-000000000101',
    tenant_admin_submittal_create: '01900000-0000-7000-8000-000000000102',
    tenant_admin_submittal_approve: '01900000-0000-7000-8000-000000000103',
    recruiter_requisition_read: '01900000-0000-7000-8000-000000000104',
    recruiter_submittal_create: '01900000-0000-7000-8000-000000000105',
    recruiter_submittal_approve: '01900000-0000-7000-8000-000000000106',
    viewer_requisition_read: '01900000-0000-7000-8000-000000000107',
    candidate_portal_profile_read: '01900000-0000-7000-8000-000000000108',
    candidate_portal_profile_edit: '01900000-0000-7000-8000-000000000109',
    candidate_portal_consent_read: '01900000-0000-7000-8000-00000000010a',
    candidate_portal_consent_write: '01900000-0000-7000-8000-00000000010b',
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
    // PR-A1a — 1 new role + 7 new scopes = 8 new audit events.
    role_candidate_created: '01900000-0000-7000-8000-00000000005e',
    scope_requisition_read_created: '01900000-0000-7000-8000-00000000005f',
    scope_requisition_read_all_created: '01900000-0000-7000-8000-000000000200',
    scope_submittal_create_created: '01900000-0000-7000-8000-000000000201',
    scope_submittal_approve_created: '01900000-0000-7000-8000-000000000202',
    scope_portal_profile_read_created: '01900000-0000-7000-8000-000000000203',
    scope_portal_profile_edit_created: '01900000-0000-7000-8000-000000000204',
    scope_portal_consent_read_created: '01900000-0000-7000-8000-000000000205',
    scope_portal_consent_write_created: '01900000-0000-7000-8000-000000000206',
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
    // PR-A1a Ruling 2/3 — ATS subset reserved to tenant_admin tier.
    // requisition:read:all is the Aramo divergence from OpenCATS coarse
    // EDIT/DELETE access-level: line recruiters get assigned-only reads.
    'requisition:read',
    'requisition:read:all',
    'submittal:create',
    'submittal:approve',
  ],
  recruiter: [
    'consent:read',
    'consent:write',
    'consent:decision-log:read',
    'auth:session:read',
    // PR-A1a — recruiter is the EDIT-tier; gets submittal create/approve
    // and assigned-only requisition reads. NOT requisition:read:all
    // (Aramo divergence; flagged for Lead confirmation).
    'requisition:read',
    'submittal:create',
    'submittal:approve',
  ],
  viewer: [
    'consent:read',
    'consent:decision-log:read',
    'auth:session:read',
    'requisition:read', // viewer also gets the assigned-only req read
  ],
  // PR-A1a Ruling 3 — new portal-user role; scopes are portal-only.
  candidate: [
    'portal:profile:read',
    'portal:profile:edit',
    'portal:consent:read',
    'portal:consent:write',
  ],
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
  // PR-A1a — 12 new assignments.
  'tenant_admin:requisition:read': SEED_IDS.role_scopes.tenant_admin_requisition_read,
  'tenant_admin:requisition:read:all': SEED_IDS.role_scopes.tenant_admin_requisition_read_all,
  'tenant_admin:submittal:create': SEED_IDS.role_scopes.tenant_admin_submittal_create,
  'tenant_admin:submittal:approve': SEED_IDS.role_scopes.tenant_admin_submittal_approve,
  'recruiter:requisition:read': SEED_IDS.role_scopes.recruiter_requisition_read,
  'recruiter:submittal:create': SEED_IDS.role_scopes.recruiter_submittal_create,
  'recruiter:submittal:approve': SEED_IDS.role_scopes.recruiter_submittal_approve,
  'viewer:requisition:read': SEED_IDS.role_scopes.viewer_requisition_read,
  'candidate:portal:profile:read': SEED_IDS.role_scopes.candidate_portal_profile_read,
  'candidate:portal:profile:edit': SEED_IDS.role_scopes.candidate_portal_profile_edit,
  'candidate:portal:consent:read': SEED_IDS.role_scopes.candidate_portal_consent_read,
  'candidate:portal:consent:write': SEED_IDS.role_scopes.candidate_portal_consent_write,
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

  // 5. Roles (4 entries per §6 + PR-A1a Ruling 3).
  await upsertRole(prisma, SEED_IDS.roles.tenant_admin, 'tenant_admin', 'Tenant administrator — full scope set');
  await upsertRole(prisma, SEED_IDS.roles.recruiter, 'recruiter', 'Domain-operator role for talent and consent management');
  await upsertRole(prisma, SEED_IDS.roles.viewer, 'viewer', 'Read-only role');
  await upsertRole(prisma, SEED_IDS.roles.candidate, 'candidate', 'Portal-user role for talent subjects authenticating via the portal');

  // 6. Scopes (6 pre-A1a + 7 PR-A1a = 13 entries).
  await upsertScope(prisma, SEED_IDS.scopes['consent:read'], 'consent:read', 'Read consent state');
  await upsertScope(prisma, SEED_IDS.scopes['consent:write'], 'consent:write', 'Grant or revoke consent');
  await upsertScope(prisma, SEED_IDS.scopes['consent:decision-log:read'], 'consent:decision-log:read', 'Read consent decision log');
  await upsertScope(prisma, SEED_IDS.scopes['auth:session:read'], 'auth:session:read', 'Read authenticated session info');
  await upsertScope(prisma, SEED_IDS.scopes['identity:user:read'], 'identity:user:read', 'Read user identity');
  await upsertScope(prisma, SEED_IDS.scopes['identity:tenant:read'], 'identity:tenant:read', 'Read tenant identity');
  // PR-A1a ATS subset
  await upsertScope(prisma, SEED_IDS.scopes['requisition:read'], 'requisition:read', 'Read requisitions assigned to the actor');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:read:all'], 'requisition:read:all', 'Read every requisition in the tenant (tenant_admin tier)');
  await upsertScope(prisma, SEED_IDS.scopes['submittal:create'], 'submittal:create', 'Create a talent submittal');
  await upsertScope(prisma, SEED_IDS.scopes['submittal:approve'], 'submittal:approve', 'Approve / confirm a talent submittal');
  // PR-A1a Portal subset (candidate role)
  await upsertScope(prisma, SEED_IDS.scopes['portal:profile:read'], 'portal:profile:read', 'Read own portal profile');
  await upsertScope(prisma, SEED_IDS.scopes['portal:profile:edit'], 'portal:profile:edit', 'Edit own portal profile');
  await upsertScope(prisma, SEED_IDS.scopes['portal:consent:read'], 'portal:consent:read', 'Read own portal consent state');
  await upsertScope(prisma, SEED_IDS.scopes['portal:consent:write'], 'portal:consent:write', 'Grant or revoke own portal consent');

  // 7. RoleScope assignments (13 pre-A1a + 12 PR-A1a = 25 rows total).
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

  // PR-A1a — 1 new role + 7 new scopes = 8 new audit events.
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.role_candidate_created,
    tenant_id: null,
    event_type: 'identity.role.created',
    subject_id: SEED_IDS.roles.candidate,
    payload: { role_id: SEED_IDS.roles.candidate, key: 'candidate' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_requisition_read_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['requisition:read'],
    payload: { scope_id: SEED_IDS.scopes['requisition:read'], key: 'requisition:read' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_requisition_read_all_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['requisition:read:all'],
    payload: { scope_id: SEED_IDS.scopes['requisition:read:all'], key: 'requisition:read:all' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_submittal_create_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['submittal:create'],
    payload: { scope_id: SEED_IDS.scopes['submittal:create'], key: 'submittal:create' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_submittal_approve_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['submittal:approve'],
    payload: { scope_id: SEED_IDS.scopes['submittal:approve'], key: 'submittal:approve' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_portal_profile_read_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['portal:profile:read'],
    payload: { scope_id: SEED_IDS.scopes['portal:profile:read'], key: 'portal:profile:read' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_portal_profile_edit_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['portal:profile:edit'],
    payload: { scope_id: SEED_IDS.scopes['portal:profile:edit'], key: 'portal:profile:edit' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_portal_consent_read_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['portal:consent:read'],
    payload: { scope_id: SEED_IDS.scopes['portal:consent:read'], key: 'portal:consent:read' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_portal_consent_write_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['portal:consent:write'],
    payload: { scope_id: SEED_IDS.scopes['portal:consent:write'], key: 'portal:consent:write' },
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
  if (key === 'candidate') return SEED_IDS.roles.candidate;
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
