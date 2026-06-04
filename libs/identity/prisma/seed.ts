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
//
// AUTHZ-1 (2026-06-04) expands the tenant role catalog from 4 to 13. The
// 4 pre-AUTHZ-1 role keys (tenant_admin, recruiter, viewer, candidate)
// are preserved verbatim with their existing scope bundles unchanged
// (DDR D7 additive-migration discipline — A2–A8 permission checks must
// stay green). The DDR display names are carried on Role.description.
// 9 new tenant roles are seeded (tenant_owner, hiring_manager,
// account_manager, interviewer, sourcer, coordinator, finance_hr,
// auditor, external_agency) with bundles assembled from the live
// 43-scope catalog (no new scope keys — gap-and-note discipline).
//
// AUTHZ-2 (2026-06-04) seeds the PLATFORM TIER (a separate namespace
// from the 13-tenant-role / 47-tenant-scope catalog):
//   - 1 sentinel Tenant row (PLATFORM_TENANT_SENTINEL_ID, name='Aramo
//     Platform') backing the platform JWT's tenant_id claim (Lead
//     ruling 2: B1; preserves the closed JWT contract).
//   - 1 platform role (super_admin).
//   - 3 platform:* scopes (Lead ruling 5: the 3-scope minimum set).
//   - 1 RoleScope-per-scope assignment for the super_admin bundle.
//   - 1 role.created + 3 scope.created audit events for the platform
//     surface (all GLOBAL — actor=system, tenant_id=null).
//   - 1 tenant.created audit event for the sentinel Tenant (the only
//     tenant-scoped platform-seed event, carrying its own tenant_id).
// The TENANT catalog (lines above) is UNCHANGED — assertion in §5
// proof step 8: A2–A8 + the AUTHZ-1 13-role bundle stays byte-identical.

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
  // AUTHZ-2 — sentinel Tenant for the platform tier (Lead ruling 2 B1).
  // The UUID matches libs/auth's PLATFORM_TENANT_SENTINEL_ID; both files
  // hold the value literal-for-literal so the JWT-issuance pipeline and
  // the seed agree without a cross-package import (libs/identity does not
  // import @aramo/auth per the substrate dependency direction).
  platform_tenant: '01900000-0000-7000-8000-000000000100',
  roles: {
    tenant_admin: '01900000-0000-7000-8000-000000000010',
    recruiter: '01900000-0000-7000-8000-000000000011',
    viewer: '01900000-0000-7000-8000-000000000012',
    candidate: '01900000-0000-7000-8000-000000000013', // PR-A1a Ruling 3
    // AUTHZ-1 — 9 new tenant roles (closed catalog; 0014..001c).
    tenant_owner: '01900000-0000-7000-8000-000000000014',
    hiring_manager: '01900000-0000-7000-8000-000000000015',
    account_manager: '01900000-0000-7000-8000-000000000016',
    interviewer: '01900000-0000-7000-8000-000000000017',
    sourcer: '01900000-0000-7000-8000-000000000018',
    coordinator: '01900000-0000-7000-8000-000000000019',
    finance_hr: '01900000-0000-7000-8000-00000000001a',
    auditor: '01900000-0000-7000-8000-00000000001b',
    external_agency: '01900000-0000-7000-8000-00000000001c',
    // AUTHZ-2 — 1 platform role (super_admin; platform:* scope namespace).
    super_admin: '01900000-0000-7000-8000-00000000001d',
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
    // PR-A1a-2 full ATS expansion (27 scopes; Ruling 1 uniform divergence).
    // talent (5)
    'talent:read': '01900000-0000-7000-8000-000000000068',
    'talent:create': '01900000-0000-7000-8000-000000000069',
    'talent:edit': '01900000-0000-7000-8000-00000000006a',
    'talent:delete': '01900000-0000-7000-8000-00000000006b',
    'talent:search': '01900000-0000-7000-8000-00000000006c',
    // company (4)
    'company:read': '01900000-0000-7000-8000-00000000006d',
    'company:create': '01900000-0000-7000-8000-00000000006e',
    'company:edit': '01900000-0000-7000-8000-00000000006f',
    'company:delete': '01900000-0000-7000-8000-000000000070',
    // contact (4)
    'contact:read': '01900000-0000-7000-8000-000000000071',
    'contact:create': '01900000-0000-7000-8000-000000000072',
    'contact:edit': '01900000-0000-7000-8000-000000000073',
    'contact:delete': '01900000-0000-7000-8000-000000000074',
    // pipeline (4)
    'pipeline:add': '01900000-0000-7000-8000-000000000075',
    'pipeline:change-status': '01900000-0000-7000-8000-000000000076',
    'pipeline:add-activity': '01900000-0000-7000-8000-000000000077',
    'pipeline:remove': '01900000-0000-7000-8000-000000000078',
    // calendar (3)
    'calendar:event-create': '01900000-0000-7000-8000-000000000079',
    'calendar:event-edit': '01900000-0000-7000-8000-00000000007a',
    'calendar:event-delete': '01900000-0000-7000-8000-00000000007b',
    // activity + examination + requisition (5)
    'activity:read': '01900000-0000-7000-8000-00000000007c',
    'examination:read': '01900000-0000-7000-8000-00000000007d',
    'requisition:create': '01900000-0000-7000-8000-00000000007e',
    'requisition:edit': '01900000-0000-7000-8000-00000000007f',
    'requisition:delete': '01900000-0000-7000-8000-000000000080',
    // tenant admin (2)
    'tenant:admin:user-manage': '01900000-0000-7000-8000-000000000081',
    'tenant:admin:settings': '01900000-0000-7000-8000-000000000082',
    // HK-IDENT-SCOPES — 6 deferred ATS scopes (retires A3/A4/A5a gap bundle).
    'requisition:assign': '01900000-0000-7000-8000-000000000083',
    'attachment:read': '01900000-0000-7000-8000-000000000084',
    'attachment:create': '01900000-0000-7000-8000-000000000085',
    'attachment:delete': '01900000-0000-7000-8000-000000000086',
    'pipeline:read': '01900000-0000-7000-8000-000000000087',
    'activity:create': '01900000-0000-7000-8000-000000000088',
    // AUTHZ-2 — 3 platform-namespace scopes (Lead ruling 5; the minimum set).
    // Bound only to the super_admin platform role; no tenant role holds any
    // platform:* scope. The DDR §13.1 tripwire is enforced by namespace
    // partition + the consumer_type check at the guard layer.
    'platform:tenant:provision': '01900000-0000-7000-8000-000000000089',
    'platform:tenant:read': '01900000-0000-7000-8000-00000000008a',
    'platform:admin:invite': '01900000-0000-7000-8000-00000000008b',
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
    // PR-A1a-2 — 52 new RoleScope rows (27 tenant_admin + 19 recruiter + 6 viewer).
    // tenant_admin gets the full 27 new scopes (incl. all :delete + :read:all + tenant:admin:*).
    tenant_admin_talent_read: '01900000-0000-7000-8000-00000000010c',
    tenant_admin_talent_create: '01900000-0000-7000-8000-00000000010d',
    tenant_admin_talent_edit: '01900000-0000-7000-8000-00000000010e',
    tenant_admin_talent_delete: '01900000-0000-7000-8000-00000000010f',
    tenant_admin_talent_search: '01900000-0000-7000-8000-000000000110',
    tenant_admin_company_read: '01900000-0000-7000-8000-000000000111',
    tenant_admin_company_create: '01900000-0000-7000-8000-000000000112',
    tenant_admin_company_edit: '01900000-0000-7000-8000-000000000113',
    tenant_admin_company_delete: '01900000-0000-7000-8000-000000000114',
    tenant_admin_contact_read: '01900000-0000-7000-8000-000000000115',
    tenant_admin_contact_create: '01900000-0000-7000-8000-000000000116',
    tenant_admin_contact_edit: '01900000-0000-7000-8000-000000000117',
    tenant_admin_contact_delete: '01900000-0000-7000-8000-000000000118',
    tenant_admin_pipeline_add: '01900000-0000-7000-8000-000000000119',
    tenant_admin_pipeline_change_status: '01900000-0000-7000-8000-00000000011a',
    tenant_admin_pipeline_add_activity: '01900000-0000-7000-8000-00000000011b',
    tenant_admin_pipeline_remove: '01900000-0000-7000-8000-00000000011c',
    tenant_admin_calendar_event_create: '01900000-0000-7000-8000-00000000011d',
    tenant_admin_calendar_event_edit: '01900000-0000-7000-8000-00000000011e',
    tenant_admin_calendar_event_delete: '01900000-0000-7000-8000-00000000011f',
    tenant_admin_activity_read: '01900000-0000-7000-8000-000000000120',
    tenant_admin_examination_read: '01900000-0000-7000-8000-000000000121',
    tenant_admin_requisition_create: '01900000-0000-7000-8000-000000000122',
    tenant_admin_requisition_edit: '01900000-0000-7000-8000-000000000123',
    tenant_admin_requisition_delete: '01900000-0000-7000-8000-000000000124',
    tenant_admin_tenant_admin_user_manage: '01900000-0000-7000-8000-000000000125',
    tenant_admin_tenant_admin_settings: '01900000-0000-7000-8000-000000000126',
    // recruiter gets 19 (Ruling 1: NO :delete, NO :read:all, NO pipeline:remove).
    recruiter_talent_read: '01900000-0000-7000-8000-000000000127',
    recruiter_talent_create: '01900000-0000-7000-8000-000000000128',
    recruiter_talent_edit: '01900000-0000-7000-8000-000000000129',
    recruiter_talent_search: '01900000-0000-7000-8000-00000000012a',
    recruiter_company_read: '01900000-0000-7000-8000-00000000012b',
    recruiter_company_create: '01900000-0000-7000-8000-00000000012c',
    recruiter_company_edit: '01900000-0000-7000-8000-00000000012d',
    recruiter_contact_read: '01900000-0000-7000-8000-00000000012e',
    recruiter_contact_create: '01900000-0000-7000-8000-00000000012f',
    recruiter_contact_edit: '01900000-0000-7000-8000-000000000130',
    recruiter_pipeline_add: '01900000-0000-7000-8000-000000000131',
    recruiter_pipeline_change_status: '01900000-0000-7000-8000-000000000132',
    recruiter_pipeline_add_activity: '01900000-0000-7000-8000-000000000133',
    recruiter_calendar_event_create: '01900000-0000-7000-8000-000000000134',
    recruiter_calendar_event_edit: '01900000-0000-7000-8000-000000000135',
    recruiter_activity_read: '01900000-0000-7000-8000-000000000136',
    recruiter_examination_read: '01900000-0000-7000-8000-000000000137',
    recruiter_requisition_create: '01900000-0000-7000-8000-000000000138',
    recruiter_requisition_edit: '01900000-0000-7000-8000-000000000139',
    // viewer gets 6 (assigned reads + talent:search + examination + activity).
    viewer_talent_read: '01900000-0000-7000-8000-00000000013a',
    viewer_talent_search: '01900000-0000-7000-8000-00000000013b',
    viewer_company_read: '01900000-0000-7000-8000-00000000013c',
    viewer_contact_read: '01900000-0000-7000-8000-00000000013d',
    viewer_activity_read: '01900000-0000-7000-8000-00000000013e',
    viewer_examination_read: '01900000-0000-7000-8000-00000000013f',
    // HK-IDENT-SCOPES — 11 new role_scope rows.
    // tenant_admin gets all 6 (recruiter+ includes tenant_admin).
    tenant_admin_requisition_assign: '01900000-0000-7000-8000-000000000140',
    tenant_admin_attachment_read: '01900000-0000-7000-8000-000000000141',
    tenant_admin_attachment_create: '01900000-0000-7000-8000-000000000142',
    tenant_admin_attachment_delete: '01900000-0000-7000-8000-000000000143',
    tenant_admin_pipeline_read: '01900000-0000-7000-8000-000000000144',
    tenant_admin_activity_create: '01900000-0000-7000-8000-000000000145',
    // recruiter gets 5 (all except requisition:assign which is tenant_admin only).
    recruiter_attachment_read: '01900000-0000-7000-8000-000000000146',
    recruiter_attachment_create: '01900000-0000-7000-8000-000000000147',
    recruiter_attachment_delete: '01900000-0000-7000-8000-000000000148',
    recruiter_pipeline_read: '01900000-0000-7000-8000-000000000149',
    recruiter_activity_create: '01900000-0000-7000-8000-00000000014a',
    // AUTHZ-2 — super_admin platform-role bundle (3 RoleScope rows).
    // Offset 0x300..0x302 deliberately leaves a gap above the AUTHZ-1
    // generated range (0x14b..0x1c8 — 122 rows in AUTHZ1_ROLE_SCOPE_ROW_IDS)
    // so the platform-namespace IDs are visually distinct in the audit
    // stream. No tenant RoleScope row uses these IDs.
    super_admin_platform_tenant_provision: '01900000-0000-7000-8000-000000000300',
    super_admin_platform_tenant_read: '01900000-0000-7000-8000-000000000301',
    super_admin_platform_admin_invite: '01900000-0000-7000-8000-000000000302',
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
    // PR-A1a-2 — 27 new scope.created audit events (one per new scope).
    scope_talent_read_created: '01900000-0000-7000-8000-000000000207',
    scope_talent_create_created: '01900000-0000-7000-8000-000000000208',
    scope_talent_edit_created: '01900000-0000-7000-8000-000000000209',
    scope_talent_delete_created: '01900000-0000-7000-8000-00000000020a',
    scope_talent_search_created: '01900000-0000-7000-8000-00000000020b',
    scope_company_read_created: '01900000-0000-7000-8000-00000000020c',
    scope_company_create_created: '01900000-0000-7000-8000-00000000020d',
    scope_company_edit_created: '01900000-0000-7000-8000-00000000020e',
    scope_company_delete_created: '01900000-0000-7000-8000-00000000020f',
    scope_contact_read_created: '01900000-0000-7000-8000-000000000210',
    scope_contact_create_created: '01900000-0000-7000-8000-000000000211',
    scope_contact_edit_created: '01900000-0000-7000-8000-000000000212',
    scope_contact_delete_created: '01900000-0000-7000-8000-000000000213',
    scope_pipeline_add_created: '01900000-0000-7000-8000-000000000214',
    scope_pipeline_change_status_created: '01900000-0000-7000-8000-000000000215',
    scope_pipeline_add_activity_created: '01900000-0000-7000-8000-000000000216',
    scope_pipeline_remove_created: '01900000-0000-7000-8000-000000000217',
    scope_calendar_event_create_created: '01900000-0000-7000-8000-000000000218',
    scope_calendar_event_edit_created: '01900000-0000-7000-8000-000000000219',
    scope_calendar_event_delete_created: '01900000-0000-7000-8000-00000000021a',
    scope_activity_read_created: '01900000-0000-7000-8000-00000000021b',
    scope_examination_read_created: '01900000-0000-7000-8000-00000000021c',
    scope_requisition_create_created: '01900000-0000-7000-8000-00000000021d',
    scope_requisition_edit_created: '01900000-0000-7000-8000-00000000021e',
    scope_requisition_delete_created: '01900000-0000-7000-8000-00000000021f',
    scope_tenant_admin_user_manage_created: '01900000-0000-7000-8000-000000000220',
    scope_tenant_admin_settings_created: '01900000-0000-7000-8000-000000000221',
    // HK-IDENT-SCOPES — 6 new identity.scope.created audit events.
    scope_requisition_assign_created: '01900000-0000-7000-8000-000000000222',
    scope_attachment_read_created: '01900000-0000-7000-8000-000000000223',
    scope_attachment_create_created: '01900000-0000-7000-8000-000000000224',
    scope_attachment_delete_created: '01900000-0000-7000-8000-000000000225',
    scope_pipeline_read_created: '01900000-0000-7000-8000-000000000226',
    scope_activity_create_created: '01900000-0000-7000-8000-000000000227',
    // AUTHZ-1 — 9 new identity.role.created audit events (0228..0230).
    role_tenant_owner_created: '01900000-0000-7000-8000-000000000228',
    role_hiring_manager_created: '01900000-0000-7000-8000-000000000229',
    role_account_manager_created: '01900000-0000-7000-8000-00000000022a',
    role_interviewer_created: '01900000-0000-7000-8000-00000000022b',
    role_sourcer_created: '01900000-0000-7000-8000-00000000022c',
    role_coordinator_created: '01900000-0000-7000-8000-00000000022d',
    role_finance_hr_created: '01900000-0000-7000-8000-00000000022e',
    role_auditor_created: '01900000-0000-7000-8000-00000000022f',
    role_external_agency_created: '01900000-0000-7000-8000-000000000230',
    // AUTHZ-2 — 1 platform tenant.created + 1 super_admin role.created +
    // 3 platform scope.created audit events (0231..0235). The tenant.created
    // event is the only tenant-scoped row in the platform-seed bundle
    // (carries the platform_tenant sentinel id); the other 4 are global.
    platform_tenant_created: '01900000-0000-7000-8000-000000000231',
    role_super_admin_created: '01900000-0000-7000-8000-000000000232',
    scope_platform_tenant_provision_created:
      '01900000-0000-7000-8000-000000000233',
    scope_platform_tenant_read_created: '01900000-0000-7000-8000-000000000234',
    scope_platform_admin_invite_created: '01900000-0000-7000-8000-000000000235',
  },
} as const;

// AUTHZ-2 — display name for the sentinel Tenant. The name appears in
// /platform/tenants reads to distinguish the sentinel from real tenants
// (Lead ruling 2: a real but seed-only Tenant row, not a freestanding
// constant — keeps the JWT-issuance pipeline + the SessionOrchestrator's
// getTenantsByUser flow unchanged).
export const PLATFORM_TENANT_NAME = 'Aramo Platform';

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
    // PR-A1a-2 — full ATS catalog (27 scopes). tenant_admin gets the
    // complete set incl. all :delete + pipeline:remove + tenant:admin:*.
    'talent:read', 'talent:create', 'talent:edit', 'talent:delete', 'talent:search',
    'company:read', 'company:create', 'company:edit', 'company:delete',
    'contact:read', 'contact:create', 'contact:edit', 'contact:delete',
    'pipeline:add', 'pipeline:change-status', 'pipeline:add-activity', 'pipeline:remove',
    'calendar:event-create', 'calendar:event-edit', 'calendar:event-delete',
    'activity:read', 'examination:read',
    'requisition:create', 'requisition:edit', 'requisition:delete',
    'tenant:admin:user-manage', 'tenant:admin:settings',
    // HK-IDENT-SCOPES — tenant_admin gets all 6 deferred ATS scopes
    // (recruiter+ includes tenant_admin).
    'requisition:assign',
    'attachment:read', 'attachment:create', 'attachment:delete',
    'pipeline:read', 'activity:create',
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
    // PR-A1a-2 Ruling 1 uniform divergence — recruiter gets the full
    // operational workflow but NO destructive (`*:delete`,
    // `pipeline:remove`) and NO see-all (`*:read:all`). Recruiter keeps
    // all :create/:edit + talent:search + pipeline:add/change-status/
    // add-activity + calendar:event-create/edit + activity:read +
    // examination:read + assigned reads.
    'talent:read', 'talent:create', 'talent:edit', 'talent:search',
    'company:read', 'company:create', 'company:edit',
    'contact:read', 'contact:create', 'contact:edit',
    'pipeline:add', 'pipeline:change-status', 'pipeline:add-activity',
    'calendar:event-create', 'calendar:event-edit',
    'activity:read', 'examination:read',
    'requisition:create', 'requisition:edit',
    // HK-IDENT-SCOPES — recruiter gets 5 of the 6 deferred scopes;
    // NOT requisition:assign (tenant_admin only — assignment is an admin act).
    'attachment:read', 'attachment:create', 'attachment:delete',
    'pipeline:read', 'activity:create',
  ],
  viewer: [
    'consent:read',
    'consent:decision-log:read',
    'auth:session:read',
    'requisition:read', // viewer also gets the assigned-only req read
    // PR-A1a-2 — viewer is read-only on the entities recruiter can see
    // plus talent:search + examination:read + activity:read.
    'talent:read', 'talent:search',
    'company:read',
    'contact:read',
    'activity:read', 'examination:read',
  ],
  // PR-A1a Ruling 3 — new portal-user role; scopes are portal-only.
  candidate: [
    'portal:profile:read',
    'portal:profile:edit',
    'portal:consent:read',
    'portal:consent:write',
  ],
  // AUTHZ-2 — platform-tier super_admin role bundle. The 3 platform:*
  // scopes; NO tenant scopes. The DDR §13.1 tripwire (a platform token
  // never satisfies a tenant guard) is enforced by namespace partition.
  super_admin: [
    'platform:tenant:provision',
    'platform:tenant:read',
    'platform:admin:invite',
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
  // PR-A1a-2 — 52 new role_scope rows.
  // tenant_admin: 27 (full catalog)
  'tenant_admin:talent:read': SEED_IDS.role_scopes.tenant_admin_talent_read,
  'tenant_admin:talent:create': SEED_IDS.role_scopes.tenant_admin_talent_create,
  'tenant_admin:talent:edit': SEED_IDS.role_scopes.tenant_admin_talent_edit,
  'tenant_admin:talent:delete': SEED_IDS.role_scopes.tenant_admin_talent_delete,
  'tenant_admin:talent:search': SEED_IDS.role_scopes.tenant_admin_talent_search,
  'tenant_admin:company:read': SEED_IDS.role_scopes.tenant_admin_company_read,
  'tenant_admin:company:create': SEED_IDS.role_scopes.tenant_admin_company_create,
  'tenant_admin:company:edit': SEED_IDS.role_scopes.tenant_admin_company_edit,
  'tenant_admin:company:delete': SEED_IDS.role_scopes.tenant_admin_company_delete,
  'tenant_admin:contact:read': SEED_IDS.role_scopes.tenant_admin_contact_read,
  'tenant_admin:contact:create': SEED_IDS.role_scopes.tenant_admin_contact_create,
  'tenant_admin:contact:edit': SEED_IDS.role_scopes.tenant_admin_contact_edit,
  'tenant_admin:contact:delete': SEED_IDS.role_scopes.tenant_admin_contact_delete,
  'tenant_admin:pipeline:add': SEED_IDS.role_scopes.tenant_admin_pipeline_add,
  'tenant_admin:pipeline:change-status': SEED_IDS.role_scopes.tenant_admin_pipeline_change_status,
  'tenant_admin:pipeline:add-activity': SEED_IDS.role_scopes.tenant_admin_pipeline_add_activity,
  'tenant_admin:pipeline:remove': SEED_IDS.role_scopes.tenant_admin_pipeline_remove,
  'tenant_admin:calendar:event-create': SEED_IDS.role_scopes.tenant_admin_calendar_event_create,
  'tenant_admin:calendar:event-edit': SEED_IDS.role_scopes.tenant_admin_calendar_event_edit,
  'tenant_admin:calendar:event-delete': SEED_IDS.role_scopes.tenant_admin_calendar_event_delete,
  'tenant_admin:activity:read': SEED_IDS.role_scopes.tenant_admin_activity_read,
  'tenant_admin:examination:read': SEED_IDS.role_scopes.tenant_admin_examination_read,
  'tenant_admin:requisition:create': SEED_IDS.role_scopes.tenant_admin_requisition_create,
  'tenant_admin:requisition:edit': SEED_IDS.role_scopes.tenant_admin_requisition_edit,
  'tenant_admin:requisition:delete': SEED_IDS.role_scopes.tenant_admin_requisition_delete,
  'tenant_admin:tenant:admin:user-manage': SEED_IDS.role_scopes.tenant_admin_tenant_admin_user_manage,
  'tenant_admin:tenant:admin:settings': SEED_IDS.role_scopes.tenant_admin_tenant_admin_settings,
  // recruiter: 19 (NO :delete, NO :read:all, NO pipeline:remove)
  'recruiter:talent:read': SEED_IDS.role_scopes.recruiter_talent_read,
  'recruiter:talent:create': SEED_IDS.role_scopes.recruiter_talent_create,
  'recruiter:talent:edit': SEED_IDS.role_scopes.recruiter_talent_edit,
  'recruiter:talent:search': SEED_IDS.role_scopes.recruiter_talent_search,
  'recruiter:company:read': SEED_IDS.role_scopes.recruiter_company_read,
  'recruiter:company:create': SEED_IDS.role_scopes.recruiter_company_create,
  'recruiter:company:edit': SEED_IDS.role_scopes.recruiter_company_edit,
  'recruiter:contact:read': SEED_IDS.role_scopes.recruiter_contact_read,
  'recruiter:contact:create': SEED_IDS.role_scopes.recruiter_contact_create,
  'recruiter:contact:edit': SEED_IDS.role_scopes.recruiter_contact_edit,
  'recruiter:pipeline:add': SEED_IDS.role_scopes.recruiter_pipeline_add,
  'recruiter:pipeline:change-status': SEED_IDS.role_scopes.recruiter_pipeline_change_status,
  'recruiter:pipeline:add-activity': SEED_IDS.role_scopes.recruiter_pipeline_add_activity,
  'recruiter:calendar:event-create': SEED_IDS.role_scopes.recruiter_calendar_event_create,
  'recruiter:calendar:event-edit': SEED_IDS.role_scopes.recruiter_calendar_event_edit,
  'recruiter:activity:read': SEED_IDS.role_scopes.recruiter_activity_read,
  'recruiter:examination:read': SEED_IDS.role_scopes.recruiter_examination_read,
  'recruiter:requisition:create': SEED_IDS.role_scopes.recruiter_requisition_create,
  'recruiter:requisition:edit': SEED_IDS.role_scopes.recruiter_requisition_edit,
  // viewer: 6 (assigned reads + talent:search + examination + activity)
  'viewer:talent:read': SEED_IDS.role_scopes.viewer_talent_read,
  'viewer:talent:search': SEED_IDS.role_scopes.viewer_talent_search,
  'viewer:company:read': SEED_IDS.role_scopes.viewer_company_read,
  'viewer:contact:read': SEED_IDS.role_scopes.viewer_contact_read,
  'viewer:activity:read': SEED_IDS.role_scopes.viewer_activity_read,
  'viewer:examination:read': SEED_IDS.role_scopes.viewer_examination_read,
  // HK-IDENT-SCOPES — 11 new role_scope rows (6 tenant_admin + 5 recruiter).
  'tenant_admin:requisition:assign': SEED_IDS.role_scopes.tenant_admin_requisition_assign,
  'tenant_admin:attachment:read': SEED_IDS.role_scopes.tenant_admin_attachment_read,
  'tenant_admin:attachment:create': SEED_IDS.role_scopes.tenant_admin_attachment_create,
  'tenant_admin:attachment:delete': SEED_IDS.role_scopes.tenant_admin_attachment_delete,
  'tenant_admin:pipeline:read': SEED_IDS.role_scopes.tenant_admin_pipeline_read,
  'tenant_admin:activity:create': SEED_IDS.role_scopes.tenant_admin_activity_create,
  'recruiter:attachment:read': SEED_IDS.role_scopes.recruiter_attachment_read,
  'recruiter:attachment:create': SEED_IDS.role_scopes.recruiter_attachment_create,
  'recruiter:attachment:delete': SEED_IDS.role_scopes.recruiter_attachment_delete,
  'recruiter:pipeline:read': SEED_IDS.role_scopes.recruiter_pipeline_read,
  'recruiter:activity:create': SEED_IDS.role_scopes.recruiter_activity_create,
  // AUTHZ-2 — super_admin platform-role bundle (3 RoleScope rows).
  'super_admin:platform:tenant:provision':
    SEED_IDS.role_scopes.super_admin_platform_tenant_provision,
  'super_admin:platform:tenant:read':
    SEED_IDS.role_scopes.super_admin_platform_tenant_read,
  'super_admin:platform:admin:invite':
    SEED_IDS.role_scopes.super_admin_platform_admin_invite,
};

// AUTHZ-1 — bundle catalog for the 9 new tenant roles. Each entry is
// (role_key, scope_keys[]). The list iteration order pins the deterministic
// UUID generation for AUTHZ1_ROLE_SCOPE_ROW_IDS below — do not re-order
// without bumping the offset to a fresh range (otherwise existing dev DBs
// would see RoleScope.id collisions on re-seed).
//
// Per-bundle Lead rulings (AUTHZ-1 §4):
//   - tenant_owner: Owner = Admin scope set (position-only distinction).
//   - hiring_manager: read + approve + feedback; NO :delete, NO :read:all.
//   - account_manager: Recruiter's 31 + tenant:admin:user-manage + requisition:assign.
//   - interviewer: narrowest (Lead exact set: talent:read + activity:create + activity:read).
//   - sourcer: intake-focused; NO :delete, NO submittal.
//   - coordinator: Lead exact set (calendar:event-create + calendar:event-edit +
//     talent:read + activity:create). calendar:event-delete deferred — Ruling 1
//     reserves entity-destruction to tenant_admin; reschedule is an edit.
//   - finance_hr: offer approval surface; compensation visibility is D5.
//   - auditor: Lead exact set (5 read scopes). report:read + audit-log:read
//     gap-and-noted — deferred to the Reporting/Audit DDR.
//   - external_agency: most restricted; D4 will enforce explicitly-shared
//     visibility on these reads.
const AUTHZ1_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  // tenant_owner — 43 scopes (full tenant_admin set; position-only distinction).
  ['tenant_owner', [
    'consent:read', 'consent:write', 'consent:decision-log:read',
    'auth:session:read', 'identity:user:read', 'identity:tenant:read',
    'requisition:read', 'requisition:read:all',
    'submittal:create', 'submittal:approve',
    'talent:read', 'talent:create', 'talent:edit', 'talent:delete', 'talent:search',
    'company:read', 'company:create', 'company:edit', 'company:delete',
    'contact:read', 'contact:create', 'contact:edit', 'contact:delete',
    'pipeline:add', 'pipeline:change-status', 'pipeline:add-activity', 'pipeline:remove',
    'calendar:event-create', 'calendar:event-edit', 'calendar:event-delete',
    'activity:read', 'examination:read',
    'requisition:create', 'requisition:edit', 'requisition:delete',
    'tenant:admin:user-manage', 'tenant:admin:settings',
    'requisition:assign',
    'attachment:read', 'attachment:create', 'attachment:delete',
    'pipeline:read', 'activity:create',
  ]],
  // hiring_manager — 12 scopes (read + approve + feedback).
  ['hiring_manager', [
    'auth:session:read', 'consent:read',
    'talent:read', 'company:read', 'contact:read', 'requisition:read',
    'activity:read', 'examination:read', 'pipeline:read', 'attachment:read',
    'submittal:approve', 'activity:create',
  ]],
  // account_manager — 33 scopes (Recruiter's 31 + tenant:admin:user-manage + requisition:assign).
  ['account_manager', [
    'consent:read', 'consent:write', 'consent:decision-log:read',
    'auth:session:read',
    'requisition:read', 'submittal:create', 'submittal:approve',
    'talent:read', 'talent:create', 'talent:edit', 'talent:search',
    'company:read', 'company:create', 'company:edit',
    'contact:read', 'contact:create', 'contact:edit',
    'pipeline:add', 'pipeline:change-status', 'pipeline:add-activity',
    'calendar:event-create', 'calendar:event-edit',
    'activity:read', 'examination:read',
    'requisition:create', 'requisition:edit',
    'attachment:read', 'attachment:create', 'attachment:delete',
    'pipeline:read', 'activity:create',
    // AM-specific delegations on top of Recruiter's operational set.
    'tenant:admin:user-manage', 'requisition:assign',
  ]],
  // interviewer — 3 scopes (Lead exact set; calendar:read gap deferred).
  ['interviewer', [
    'talent:read', 'activity:read', 'activity:create',
  ]],
  // sourcer — 14 scopes (intake-focused; NO :delete, NO submittal).
  ['sourcer', [
    'auth:session:read',
    'talent:read', 'talent:create', 'talent:search',
    'company:read', 'contact:read', 'contact:create',
    'requisition:read',
    'pipeline:read', 'pipeline:add', 'pipeline:change-status', 'pipeline:add-activity',
    'activity:read', 'activity:create',
  ]],
  // coordinator — 4 scopes (Lead exact set; calendar:event-delete deferred).
  ['coordinator', [
    'calendar:event-create', 'calendar:event-edit',
    'talent:read', 'activity:create',
  ]],
  // finance_hr — 6 scopes (offer approval; compensation visibility is D5).
  ['finance_hr', [
    'auth:session:read',
    'talent:read', 'requisition:read', 'submittal:approve',
    'activity:read', 'activity:create',
  ]],
  // auditor — 5 scopes (Lead exact set; report:read + audit-log:read deferred).
  ['auditor', [
    'auth:session:read',
    'consent:decision-log:read',
    'identity:user:read', 'identity:tenant:read',
    'activity:read',
  ]],
  // external_agency — 2 scopes (most restricted; D4 will enforce sharing).
  ['external_agency', [
    'talent:read', 'requisition:read',
  ]],
];

// AUTHZ-1 — role.created audit-event manifest for the 9 new roles.
// Pattern mirrors the A1A2_NEW_SCOPES manifest used for scope.created
// events; the closed-list test validates catalog shape, not each audit
// event individually.
const AUTHZ1_ROLE_AUDIT_EVENTS: Array<{
  audit_id: string;
  role_id: string;
  key: string;
}> = [
  { audit_id: SEED_IDS.audit_events.role_tenant_owner_created, role_id: SEED_IDS.roles.tenant_owner, key: 'tenant_owner' },
  { audit_id: SEED_IDS.audit_events.role_hiring_manager_created, role_id: SEED_IDS.roles.hiring_manager, key: 'hiring_manager' },
  { audit_id: SEED_IDS.audit_events.role_account_manager_created, role_id: SEED_IDS.roles.account_manager, key: 'account_manager' },
  { audit_id: SEED_IDS.audit_events.role_interviewer_created, role_id: SEED_IDS.roles.interviewer, key: 'interviewer' },
  { audit_id: SEED_IDS.audit_events.role_sourcer_created, role_id: SEED_IDS.roles.sourcer, key: 'sourcer' },
  { audit_id: SEED_IDS.audit_events.role_coordinator_created, role_id: SEED_IDS.roles.coordinator, key: 'coordinator' },
  { audit_id: SEED_IDS.audit_events.role_finance_hr_created, role_id: SEED_IDS.roles.finance_hr, key: 'finance_hr' },
  { audit_id: SEED_IDS.audit_events.role_auditor_created, role_id: SEED_IDS.roles.auditor, key: 'auditor' },
  { audit_id: SEED_IDS.audit_events.role_external_agency_created, role_id: SEED_IDS.roles.external_agency, key: 'external_agency' },
];

// AUTHZ-1 — generate the 122 new RoleScope row IDs deterministically.
// Offset 0x14b continues the pre-AUTHZ-1 sequence (last HK-IDENT-SCOPES
// entry was 0x14a). The (role, scope) iteration order in AUTHZ1_BUNDLES
// pins the assignment, so a given (role, scope) pair always produces the
// same UUID on every seed run. seed.spec.ts walks SEED_IDS for UUID
// validity; the AUTHZ-1 ids live in this separate map but each value is
// a UUID string by construction.
const AUTHZ1_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x14b;
  for (const [role, scopes] of AUTHZ1_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

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

  // 1b. AUTHZ-2 — sentinel "Aramo Platform" Tenant (Lead ruling 2 B1).
  // The platform JWT's tenant_id claim references this row; the
  // SessionOrchestrator's getTenantsByUser flow finds it for super_admin
  // users so the singleton membership path is reused (no separate platform
  // orchestrator). The row is is_active=true so the platform tier is
  // operable; deactivation is the rollback marker.
  await prisma.tenant.upsert({
    where: { id: SEED_IDS.platform_tenant },
    update: {},
    create: {
      id: SEED_IDS.platform_tenant,
      name: PLATFORM_TENANT_NAME,
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

  // 5. Roles (13 entries: 4 pre-AUTHZ-1 + 9 AUTHZ-1).
  // Descriptions carry the DDR display name + intent. The Role.key
  // strings are PRESERVED unchanged per AUTHZ-1 §1 (A2–A8 permission
  // checks reference these keys verbatim and must stay green).
  // upsertRole's update path is {} so descriptions update only on fresh
  // seeds; pre-existing rows retain whatever description they were
  // first seeded with. That is acceptable for AUTHZ-1 — the catalog
  // contract is the (key, scope-bundle) pair, which is verified by
  // test 17. The display-name re-map is observed on fresh dev/test DBs
  // (every integration spec starts a fresh Postgres container).
  await upsertRole(prisma, SEED_IDS.roles.tenant_admin, 'tenant_admin', 'Tenant Admin — administrative operator of the tenant (users, roles, settings; full scope set)');
  await upsertRole(prisma, SEED_IDS.roles.recruiter, 'recruiter', 'Recruiter — core operator (assigned requisitions/talents; no destructive scopes, no see-all)');
  await upsertRole(prisma, SEED_IDS.roles.viewer, 'viewer', 'Viewer — generic read-only role across the operational entities');
  await upsertRole(prisma, SEED_IDS.roles.candidate, 'candidate', 'Candidate — portal-user role for talent subjects authenticating via the portal');
  // AUTHZ-1 — 9 new tenant roles.
  await upsertRole(prisma, SEED_IDS.roles.tenant_owner, 'tenant_owner', 'Tenant Owner — singular top authority within a tenant (same scope set as Tenant Admin; org-position distinction)');
  await upsertRole(prisma, SEED_IDS.roles.hiring_manager, 'hiring_manager', 'Hiring Manager — views jobs/candidates, gives feedback, approves submittal stages');
  await upsertRole(prisma, SEED_IDS.roles.account_manager, 'account_manager', 'Account Manager — recruiter-manager; operational scope plus user-manage and requisition:assign');
  await upsertRole(prisma, SEED_IDS.roles.interviewer, 'interviewer', 'Interviewer — narrowest tenant role; views assigned candidates and records interview feedback');
  await upsertRole(prisma, SEED_IDS.roles.sourcer, 'sourcer', 'Sourcer — intake-focused; adds talents and manages the pipeline-sourcing surface');
  await upsertRole(prisma, SEED_IDS.roles.coordinator, 'coordinator', 'Coordinator — calendar/scheduling logistics for interviews and events');
  await upsertRole(prisma, SEED_IDS.roles.finance_hr, 'finance_hr', 'Finance/HR — offer-approval surface (compensation visibility is D5)');
  await upsertRole(prisma, SEED_IDS.roles.auditor, 'auditor', 'Auditor/Compliance — read-only audit logs, decision logs, sessions, identity');
  await upsertRole(prisma, SEED_IDS.roles.external_agency, 'external_agency', 'External Agency — most restricted; sees explicitly-shared talents and requisitions only');
  // AUTHZ-2 — 1 platform role (super_admin; platform:* scope namespace).
  await upsertRole(prisma, SEED_IDS.roles.super_admin, 'super_admin', 'Super Admin — platform-tier operator (Aramo SaaS). Provisions tenants, invites Tenant Owners + platform admins. Holds ONLY platform:* scopes; never a tenant scope.');

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
  // PR-A1a-2 — full ATS catalog (27 new scopes; Ruling 1 uniform divergence applied at role-mapping level).
  await upsertScope(prisma, SEED_IDS.scopes['talent:read'], 'talent:read', 'Read a talent record (assigned by default)');
  await upsertScope(prisma, SEED_IDS.scopes['talent:create'], 'talent:create', 'Create a talent record');
  await upsertScope(prisma, SEED_IDS.scopes['talent:edit'], 'talent:edit', 'Edit a talent record');
  await upsertScope(prisma, SEED_IDS.scopes['talent:delete'], 'talent:delete', 'Delete a talent record (tenant_admin only — Ruling 1)');
  await upsertScope(prisma, SEED_IDS.scopes['talent:search'], 'talent:search', 'Search the talent index (Constrained Talent Access)');
  await upsertScope(prisma, SEED_IDS.scopes['company:read'], 'company:read', 'Read a company record');
  await upsertScope(prisma, SEED_IDS.scopes['company:create'], 'company:create', 'Create a company record');
  await upsertScope(prisma, SEED_IDS.scopes['company:edit'], 'company:edit', 'Edit a company record');
  await upsertScope(prisma, SEED_IDS.scopes['company:delete'], 'company:delete', 'Delete a company record (tenant_admin only — Ruling 1)');
  await upsertScope(prisma, SEED_IDS.scopes['contact:read'], 'contact:read', 'Read a contact record');
  await upsertScope(prisma, SEED_IDS.scopes['contact:create'], 'contact:create', 'Create a contact record');
  await upsertScope(prisma, SEED_IDS.scopes['contact:edit'], 'contact:edit', 'Edit a contact record');
  await upsertScope(prisma, SEED_IDS.scopes['contact:delete'], 'contact:delete', 'Delete a contact record (tenant_admin only — Ruling 1)');
  await upsertScope(prisma, SEED_IDS.scopes['pipeline:add'], 'pipeline:add', 'Add a talent to a pipeline');
  await upsertScope(prisma, SEED_IDS.scopes['pipeline:change-status'], 'pipeline:change-status', 'Change a pipeline entry status');
  await upsertScope(prisma, SEED_IDS.scopes['pipeline:add-activity'], 'pipeline:add-activity', 'Add an activity to a pipeline entry');
  await upsertScope(prisma, SEED_IDS.scopes['pipeline:remove'], 'pipeline:remove', 'Remove a talent from a pipeline (tenant_admin only — Ruling 1 destructive)');
  await upsertScope(prisma, SEED_IDS.scopes['calendar:event-create'], 'calendar:event-create', 'Create a calendar event');
  await upsertScope(prisma, SEED_IDS.scopes['calendar:event-edit'], 'calendar:event-edit', 'Edit a calendar event (own events)');
  await upsertScope(prisma, SEED_IDS.scopes['calendar:event-delete'], 'calendar:event-delete', 'Delete a calendar event (tenant_admin only — Ruling 1)');
  await upsertScope(prisma, SEED_IDS.scopes['activity:read'], 'activity:read', 'Read the activity log');
  await upsertScope(prisma, SEED_IDS.scopes['examination:read'], 'examination:read', 'Read examination output (read-only Core output)');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:create'], 'requisition:create', 'Create a requisition');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:edit'], 'requisition:edit', 'Edit a requisition');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:delete'], 'requisition:delete', 'Delete a requisition (tenant_admin only — Ruling 1)');
  await upsertScope(prisma, SEED_IDS.scopes['tenant:admin:user-manage'], 'tenant:admin:user-manage', 'Tenant admin: manage users and memberships');
  await upsertScope(prisma, SEED_IDS.scopes['tenant:admin:settings'], 'tenant:admin:settings', 'Tenant admin: manage tenant settings');
  // HK-IDENT-SCOPES — 6 deferred ATS scopes (retires A3/A4/A5a gap bundle).
  // attachment:delete carries a BOUNDED Ruling 1 carve-out: detach is a
  // junction/link delete (unlinks a file from its owner), NOT entity
  // destruction. Recruiter+ per amendment HK-IDENT-SCOPES §2. The bound
  // is junction deletes only; entity deletes remain tenant_admin-only.
  await upsertScope(prisma, SEED_IDS.scopes['requisition:assign'], 'requisition:assign', 'Assign/unassign a user to a requisition (tenant_admin only — assignment is an admin act)');
  await upsertScope(prisma, SEED_IDS.scopes['attachment:read'], 'attachment:read', 'Read attachments scoped to an owner');
  await upsertScope(prisma, SEED_IDS.scopes['attachment:create'], 'attachment:create', 'Attach a file to an owner');
  await upsertScope(prisma, SEED_IDS.scopes['attachment:delete'], 'attachment:delete', 'Detach a file from its owner (recruiter+ via bounded Ruling 1 carve-out — junction/link delete, not entity destruction)');
  await upsertScope(prisma, SEED_IDS.scopes['pipeline:read'], 'pipeline:read', 'Read pipelines / pipeline history');
  await upsertScope(prisma, SEED_IDS.scopes['activity:create'], 'activity:create', 'Create a manual activity entry');
  // AUTHZ-2 — 3 platform-namespace scopes (Lead ruling 5; separate from
  // the 47 tenant scopes above).
  await upsertScope(prisma, SEED_IDS.scopes['platform:tenant:provision'], 'platform:tenant:provision', 'Platform-tier: create a tenant + entitlement seed + Tenant-Owner invite (super_admin only)');
  await upsertScope(prisma, SEED_IDS.scopes['platform:tenant:read'], 'platform:tenant:read', 'Platform-tier: list/read tenants for the platform-admin view (super_admin only)');
  await upsertScope(prisma, SEED_IDS.scopes['platform:admin:invite'], 'platform:admin:invite', 'Platform-tier: invite another platform admin against the platform Cognito pool (super_admin only)');

  // 7. RoleScope assignments — pre-AUTHZ-1 (88 rows: 13 + 12 + 52 + 11).
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

  // 7b. AUTHZ-1 RoleScope assignments — 122 rows for the 9 new roles.
  // Uses AUTHZ1_BUNDLES as the source of truth + the deterministic
  // AUTHZ1_ROLE_SCOPE_ROW_IDS generator.
  for (const [roleKey, scopeKeys] of AUTHZ1_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = AUTHZ1_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`AUTHZ-1: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
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

  // AUTHZ-1 — 9 new identity.role.created audit events. The catalog
  // expansion adds NO new scope rows, so no scope.created events here.
  for (const entry of AUTHZ1_ROLE_AUDIT_EVENTS) {
    await upsertAudit(prisma, {
      id: entry.audit_id,
      tenant_id: null,
      event_type: 'identity.role.created',
      subject_id: entry.role_id,
      payload: { role_id: entry.role_id, key: entry.key },
    });
  }

  // AUTHZ-2 — 1 platform tenant.created (tenant-scoped, carries the
  // sentinel id) + 1 role.created (super_admin, global) + 3 scope.created
  // (the 3 platform:* scopes, global). The tenant-scoped/global split
  // mirrors the pre-existing pattern; assertMappingObeyed enforces it at
  // write time.
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.platform_tenant_created,
    tenant_id: SEED_IDS.platform_tenant,
    event_type: 'identity.tenant.created',
    subject_id: SEED_IDS.platform_tenant,
    payload: {
      tenant_id: SEED_IDS.platform_tenant,
      name: PLATFORM_TENANT_NAME,
      source: 'authz-2.seed',
    },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.role_super_admin_created,
    tenant_id: null,
    event_type: 'identity.role.created',
    subject_id: SEED_IDS.roles.super_admin,
    payload: { role_id: SEED_IDS.roles.super_admin, key: 'super_admin' },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_platform_tenant_provision_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['platform:tenant:provision'],
    payload: {
      scope_id: SEED_IDS.scopes['platform:tenant:provision'],
      key: 'platform:tenant:provision',
    },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_platform_tenant_read_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['platform:tenant:read'],
    payload: {
      scope_id: SEED_IDS.scopes['platform:tenant:read'],
      key: 'platform:tenant:read',
    },
  });
  await upsertAudit(prisma, {
    id: SEED_IDS.audit_events.scope_platform_admin_invite_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['platform:admin:invite'],
    payload: {
      scope_id: SEED_IDS.scopes['platform:admin:invite'],
      key: 'platform:admin:invite',
    },
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

  // PR-A1a-2 — 27 new identity.scope.created audit events (one per new scope).
  // Pattern is uniform; the closed-list test validates the catalog shape,
  // not the audit events individually.
  const A1A2_NEW_SCOPES: Array<{ audit_id: string; key: string }> = [
    { audit_id: SEED_IDS.audit_events.scope_talent_read_created, key: 'talent:read' },
    { audit_id: SEED_IDS.audit_events.scope_talent_create_created, key: 'talent:create' },
    { audit_id: SEED_IDS.audit_events.scope_talent_edit_created, key: 'talent:edit' },
    { audit_id: SEED_IDS.audit_events.scope_talent_delete_created, key: 'talent:delete' },
    { audit_id: SEED_IDS.audit_events.scope_talent_search_created, key: 'talent:search' },
    { audit_id: SEED_IDS.audit_events.scope_company_read_created, key: 'company:read' },
    { audit_id: SEED_IDS.audit_events.scope_company_create_created, key: 'company:create' },
    { audit_id: SEED_IDS.audit_events.scope_company_edit_created, key: 'company:edit' },
    { audit_id: SEED_IDS.audit_events.scope_company_delete_created, key: 'company:delete' },
    { audit_id: SEED_IDS.audit_events.scope_contact_read_created, key: 'contact:read' },
    { audit_id: SEED_IDS.audit_events.scope_contact_create_created, key: 'contact:create' },
    { audit_id: SEED_IDS.audit_events.scope_contact_edit_created, key: 'contact:edit' },
    { audit_id: SEED_IDS.audit_events.scope_contact_delete_created, key: 'contact:delete' },
    { audit_id: SEED_IDS.audit_events.scope_pipeline_add_created, key: 'pipeline:add' },
    { audit_id: SEED_IDS.audit_events.scope_pipeline_change_status_created, key: 'pipeline:change-status' },
    { audit_id: SEED_IDS.audit_events.scope_pipeline_add_activity_created, key: 'pipeline:add-activity' },
    { audit_id: SEED_IDS.audit_events.scope_pipeline_remove_created, key: 'pipeline:remove' },
    { audit_id: SEED_IDS.audit_events.scope_calendar_event_create_created, key: 'calendar:event-create' },
    { audit_id: SEED_IDS.audit_events.scope_calendar_event_edit_created, key: 'calendar:event-edit' },
    { audit_id: SEED_IDS.audit_events.scope_calendar_event_delete_created, key: 'calendar:event-delete' },
    { audit_id: SEED_IDS.audit_events.scope_activity_read_created, key: 'activity:read' },
    { audit_id: SEED_IDS.audit_events.scope_examination_read_created, key: 'examination:read' },
    { audit_id: SEED_IDS.audit_events.scope_requisition_create_created, key: 'requisition:create' },
    { audit_id: SEED_IDS.audit_events.scope_requisition_edit_created, key: 'requisition:edit' },
    { audit_id: SEED_IDS.audit_events.scope_requisition_delete_created, key: 'requisition:delete' },
    { audit_id: SEED_IDS.audit_events.scope_tenant_admin_user_manage_created, key: 'tenant:admin:user-manage' },
    { audit_id: SEED_IDS.audit_events.scope_tenant_admin_settings_created, key: 'tenant:admin:settings' },
    // HK-IDENT-SCOPES — 6 new scope.created audit events.
    { audit_id: SEED_IDS.audit_events.scope_requisition_assign_created, key: 'requisition:assign' },
    { audit_id: SEED_IDS.audit_events.scope_attachment_read_created, key: 'attachment:read' },
    { audit_id: SEED_IDS.audit_events.scope_attachment_create_created, key: 'attachment:create' },
    { audit_id: SEED_IDS.audit_events.scope_attachment_delete_created, key: 'attachment:delete' },
    { audit_id: SEED_IDS.audit_events.scope_pipeline_read_created, key: 'pipeline:read' },
    { audit_id: SEED_IDS.audit_events.scope_activity_create_created, key: 'activity:create' },
  ];
  for (const entry of A1A2_NEW_SCOPES) {
    const scope_id = (SEED_IDS.scopes as Record<string, string>)[entry.key];
    if (scope_id === undefined) {
      throw new Error(`PR-A1a-2 catalog mismatch: missing SEED_IDS.scopes[${entry.key}]`);
    }
    await upsertAudit(prisma, {
      id: entry.audit_id,
      tenant_id: null,
      event_type: 'identity.scope.created',
      subject_id: scope_id,
      payload: { scope_id, key: entry.key },
    });
  }

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
  // AUTHZ-1: 13-role catalog. Looks up the seeded role id by key.
  const id = (SEED_IDS.roles as Record<string, string>)[key];
  if (id === undefined) {
    throw new Error(`Unknown role key in seed: ${key}`);
  }
  return id;
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
