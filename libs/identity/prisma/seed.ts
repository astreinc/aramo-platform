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
// AUTHZ-1 (2026-06-04) expanded the tenant role catalog from 4 to 13.
// AUTHZ-1b (2026-06-04) revises the catalog to the staffing-vertical set
// (13 -> 12): retires 5 non-staffing roles (viewer, hiring_manager,
// interviewer, coordinator, external_agency — no A2-A8 regression: every
// guard is scope-keyed, ZERO role-name-keyed on the retired roles), adds
// 4 staffing roles (recruiting_manager, delivery_manager, lead_recruiter,
// back_office), renames finance_hr -> finance (KEY rename; bundle
// preserved). The candidate portal role is preserved. The pre-AUTHZ-1
// keys still in the catalog (tenant_admin, recruiter, candidate) keep
// their existing scope bundles unchanged. No new scope keys are added
// (the management roles' broader visibility comes from the TEAM MODEL
// at D4a/b, NOT a see-all scope here); no schema change.
//
// AUTHZ-2 (2026-06-04) seeds the PLATFORM TIER (a separate namespace
// from the 12-tenant-role / 47-tenant-scope catalog):
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
// The tenant catalog is the AUTHZ-1b 12-role set (the staffing vertical);
// the kept roles' bundles stay byte-identical (DDR D7 additive discipline
// where applicable — no Recruiter bundle change, etc).

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
    // AUTHZ-1b 12-role tenant catalog (the staffing vertical) + 1 platform
    // role (super_admin). Retired keys' UUIDs are reused for the 4 new
    // staffing roles to keep the address space compact; 0012 (was viewer)
    // is left unused as a gap marker.
    tenant_admin: '01900000-0000-7000-8000-000000000010',
    recruiter: '01900000-0000-7000-8000-000000000011',
    candidate: '01900000-0000-7000-8000-000000000013', // PR-A1a Ruling 3
    tenant_owner: '01900000-0000-7000-8000-000000000014',
    delivery_manager: '01900000-0000-7000-8000-000000000015', // AUTHZ-1b (slot reused from retired hiring_manager)
    account_manager: '01900000-0000-7000-8000-000000000016',
    recruiting_manager: '01900000-0000-7000-8000-000000000017', // AUTHZ-1b (slot reused from retired interviewer)
    sourcer: '01900000-0000-7000-8000-000000000018',
    lead_recruiter: '01900000-0000-7000-8000-000000000019', // AUTHZ-1b (slot reused from retired coordinator)
    finance: '01900000-0000-7000-8000-00000000001a', // AUTHZ-1b KEY rename: finance_hr -> finance (UUID preserved)
    auditor: '01900000-0000-7000-8000-00000000001b',
    back_office: '01900000-0000-7000-8000-00000000001c', // AUTHZ-1b (slot reused from retired external_agency)
    // AUTHZ-2 — 1 platform role (super_admin; platform:* scope namespace).
    super_admin: '01900000-0000-7000-8000-00000000001d',
    // Settings S4 — auditor_with_financials. The Auditor/Compliance bundle +
    // the see-all compensation:view:* scopes. Trivially non-invertible
    // (holds every comp scope BY DESIGN — the see-all bypass applies; see
    // SEE_ALL_ROLE_KEYS extension below). Catalog +1 tenant role.
    auditor_with_financials: '01900000-0000-7000-8000-00000000001e',
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
    // AUTHZ-D4a — 4 team-model scopes (Amendment §4/§6; Lead Gate-5 ruling 2
    // narrows company:read:all to TA+TO only — mirrors requisition:read:all).
    'company:assign': '01900000-0000-7000-8000-00000000008c',
    'org:manage': '01900000-0000-7000-8000-00000000008d',
    'team:manage': '01900000-0000-7000-8000-00000000008e',
    'company:read:all': '01900000-0000-7000-8000-00000000008f',
    // AUTHZ-D5 — 6 compensation:view:* scopes (the field-masking scope
    // family). Scope-keyed because the JWT carries `scopes: string[]`
    // only (no role claim) — see libs/field-masking. The grouping per
    // scope is the matrix-level call (compensation-field-map.ts):
    //   view:pay     — pay_rate_* + salary_*   (candidate-economics)
    //   view:bill    — bill_rate_* + placement_fee_* (agency-economics)
    //   view:revenue — bill_rate_* (rate-only; no fee)
    //   view:spread:amount  — margin_amount
    //   view:spread:percent — markup_percent
    //   view:margin:percent — margin_percent
    // THE ENFORCED INVARIANT (libs/field-masking
    // assertNonInvertibleBundle): no role holds both view:pay AND any
    // spread scope (pay + spread = bill). Proven across all bundles by
    // seed.spec / d5-non-invertibility.spec.
    'compensation:view:pay': '01900000-0000-7000-8000-000000000090',
    'compensation:view:bill': '01900000-0000-7000-8000-000000000091',
    'compensation:view:revenue': '01900000-0000-7000-8000-000000000092',
    'compensation:view:spread:amount': '01900000-0000-7000-8000-000000000093',
    'compensation:view:spread:percent': '01900000-0000-7000-8000-000000000094',
    'compensation:view:margin:percent': '01900000-0000-7000-8000-000000000095',
    // D-AUTHZ-COMP-WRITE-1 — 2 compensation:edit:* scopes (continue the
    // D5 0x90 range: 0x96, 0x97). The WRITE-side floor scopes; enforced
    // IN-SERVICE at the requisition repository write methods.
    'compensation:edit:pay': '01900000-0000-7000-8000-000000000096',
    'compensation:edit:bill': '01900000-0000-7000-8000-000000000097',
    // Reporting-Scope-Seed — 2 reporting:* scopes (continue the 0x90
    // range: 0x98, 0x99). Operational reads of the PR-A7 ATS-internal
    // dashboard + per-metric routes. Granted to the 8 OPERATIONAL roles
    // via REPORTING_SEED_BUNDLES; auditor-tier deferred to the
    // Reporting/Audit DDR (Ruling B-iii).
    'dashboard:read': '01900000-0000-7000-8000-000000000098',
    'report:read': '01900000-0000-7000-8000-000000000099',
    // R7 BE-prereq — 3 engagement-domain scopes (Amendment v1.1 §1
    // Ruling B: outreach SoD). Continues the 0x90 reporting range:
    // 0x9a / 0x9b / 0x9c. Closes the documented A1a-2 deferral
    // (scope.dto.ts:23-25 prior to this PR).
    'engagement:read': '01900000-0000-7000-8000-00000000009a',
    'engagement:write': '01900000-0000-7000-8000-00000000009b',
    'engagement:outreach': '01900000-0000-7000-8000-00000000009c',
  },
  // RoleScope ids — one per (role,scope) assignment. Hardcoded sequence
  // 0x30..0x39 (10 assignments: 6 tenant_admin + 4 recruiter; the 3
  // viewer ids 0x3a..0x3c were freed at AUTHZ-1b when viewer was retired).
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
    // AUTHZ-1b: viewer RoleScope ids (0x3a..0x3c, 0x107) freed (role retired).
    // PR-A1a Ruling 2/3 — RoleScope rows (4 tenant_admin, 3 recruiter, 4 candidate).
    tenant_admin_requisition_read: '01900000-0000-7000-8000-000000000100',
    tenant_admin_requisition_read_all: '01900000-0000-7000-8000-000000000101',
    tenant_admin_submittal_create: '01900000-0000-7000-8000-000000000102',
    tenant_admin_submittal_approve: '01900000-0000-7000-8000-000000000103',
    recruiter_requisition_read: '01900000-0000-7000-8000-000000000104',
    recruiter_submittal_create: '01900000-0000-7000-8000-000000000105',
    recruiter_submittal_approve: '01900000-0000-7000-8000-000000000106',
    candidate_portal_profile_read: '01900000-0000-7000-8000-000000000108',
    candidate_portal_profile_edit: '01900000-0000-7000-8000-000000000109',
    candidate_portal_consent_read: '01900000-0000-7000-8000-00000000010a',
    candidate_portal_consent_write: '01900000-0000-7000-8000-00000000010b',
    // PR-A1a-2 — RoleScope rows (27 tenant_admin + 19 recruiter; the 6
    // viewer ids 0x13a..0x13f were freed at AUTHZ-1b when viewer was retired).
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
    // AUTHZ-1b: viewer RoleScope ids (0x13a..0x13f) freed (role retired).
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
    // Offset 0x300..0x302 is the platform tier; AUTHZ-1b moved the
    // AUTHZ-1 generator range to 0x400+ so 0x303..0x3ff is free.
    super_admin_platform_tenant_provision: '01900000-0000-7000-8000-000000000300',
    super_admin_platform_tenant_read: '01900000-0000-7000-8000-000000000301',
    super_admin_platform_admin_invite: '01900000-0000-7000-8000-000000000302',
    // AUTHZ-D4a — 4 RoleScope rows for tenant_admin's new team-model
    // scopes (the other bundle holders go through AUTHZ1_ROLE_SCOPE_ROW_IDS
    // since they live in AUTHZ1_BUNDLES).
    tenant_admin_company_assign: '01900000-0000-7000-8000-000000000303',
    tenant_admin_org_manage: '01900000-0000-7000-8000-000000000304',
    tenant_admin_team_manage: '01900000-0000-7000-8000-000000000305',
    tenant_admin_company_read_all: '01900000-0000-7000-8000-000000000306',
  },
  membership_role_admin: '01900000-0000-7000-8000-000000000040',
  audit_events: {
    tenant_created: '01900000-0000-7000-8000-000000000050',
    user_created: '01900000-0000-7000-8000-000000000051',
    membership_created: '01900000-0000-7000-8000-000000000052',
    external_identity_linked: '01900000-0000-7000-8000-000000000053',
    role_tenant_admin_created: '01900000-0000-7000-8000-000000000054',
    role_recruiter_created: '01900000-0000-7000-8000-000000000055',
    // AUTHZ-1b: role_viewer_created audit id (0x56) freed (role retired).
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
    // AUTHZ-1 / AUTHZ-1b — 9 identity.role.created audit events for the
    // staffing catalog (0228..0230). Retired role events' UUIDs are
    // reused for the 4 new staffing-role events (slot-reuse pattern,
    // same as SEED_IDS.roles above).
    role_tenant_owner_created: '01900000-0000-7000-8000-000000000228',
    role_delivery_manager_created: '01900000-0000-7000-8000-000000000229', // AUTHZ-1b (slot reused from retired hiring_manager)
    role_account_manager_created: '01900000-0000-7000-8000-00000000022a',
    role_recruiting_manager_created: '01900000-0000-7000-8000-00000000022b', // AUTHZ-1b (slot reused from retired interviewer)
    role_sourcer_created: '01900000-0000-7000-8000-00000000022c',
    role_lead_recruiter_created: '01900000-0000-7000-8000-00000000022d', // AUTHZ-1b (slot reused from retired coordinator)
    role_finance_created: '01900000-0000-7000-8000-00000000022e', // AUTHZ-1b KEY rename: finance_hr -> finance (UUID preserved)
    role_auditor_created: '01900000-0000-7000-8000-00000000022f',
    role_back_office_created: '01900000-0000-7000-8000-000000000230', // AUTHZ-1b (slot reused from retired external_agency)
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
    // AUTHZ-D4a — 4 scope.created audit events for the new team-model scopes
    // (0x236..0x239). All global (no tenant_id) per the scope.created mapping.
    scope_company_assign_created: '01900000-0000-7000-8000-000000000236',
    scope_org_manage_created: '01900000-0000-7000-8000-000000000237',
    scope_team_manage_created: '01900000-0000-7000-8000-000000000238',
    scope_company_read_all_created: '01900000-0000-7000-8000-000000000239',
    // AUTHZ-D5 — 6 scope.created audit events for the compensation:view:*
    // scope family (0x23a..0x23f). All global; emitted via A1A2_NEW_SCOPES
    // manifest below.
    scope_compensation_view_pay_created: '01900000-0000-7000-8000-00000000023a',
    scope_compensation_view_bill_created: '01900000-0000-7000-8000-00000000023b',
    scope_compensation_view_revenue_created: '01900000-0000-7000-8000-00000000023c',
    scope_compensation_view_spread_amount_created: '01900000-0000-7000-8000-00000000023d',
    scope_compensation_view_spread_percent_created: '01900000-0000-7000-8000-00000000023e',
    scope_compensation_view_margin_percent_created: '01900000-0000-7000-8000-00000000023f',
    // Settings S4 — 1 identity.role.created audit event for the new
    // auditor_with_financials seed role. No new scope.created events
    // (S4 grants via existing comp scopes — Path B).
    role_auditor_with_financials_created: '01900000-0000-7000-8000-000000000240',
    // D-AUTHZ-COMP-WRITE-1 — 2 identity.scope.created audit events for
    // the compensation:edit:* scopes (continue the 0x240 audit range:
    // 0x241, 0x242). Emitted via A1A2_NEW_SCOPES manifest below.
    scope_compensation_edit_pay_created: '01900000-0000-7000-8000-000000000241',
    scope_compensation_edit_bill_created: '01900000-0000-7000-8000-000000000242',
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
    // AUTHZ-D4a — tenant_admin gets all 4 new team-model scopes (mirrors
    // the requisition:assign/requisition:read:all pattern — TA holds the
    // full operational set plus the see-all + the management mechanisms).
    'company:assign', 'org:manage', 'team:manage', 'company:read:all',
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
  // AUTHZ-1b: viewer ROLE_SCOPE_ASSIGNMENTS block removed (role retired).
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
  // AUTHZ-1b: viewer:* entries removed (role retired).
  // PR-A1a — RoleScope mapping rows for the kept pre-A1a roles + candidate.
  'tenant_admin:requisition:read': SEED_IDS.role_scopes.tenant_admin_requisition_read,
  'tenant_admin:requisition:read:all': SEED_IDS.role_scopes.tenant_admin_requisition_read_all,
  'tenant_admin:submittal:create': SEED_IDS.role_scopes.tenant_admin_submittal_create,
  'tenant_admin:submittal:approve': SEED_IDS.role_scopes.tenant_admin_submittal_approve,
  'recruiter:requisition:read': SEED_IDS.role_scopes.recruiter_requisition_read,
  'recruiter:submittal:create': SEED_IDS.role_scopes.recruiter_submittal_create,
  'recruiter:submittal:approve': SEED_IDS.role_scopes.recruiter_submittal_approve,
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
  // AUTHZ-1b: viewer:* PR-A1a-2 entries removed (role retired).
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
  // AUTHZ-D4a — 4 new tenant_admin RoleScope rows for the team-model scopes.
  'tenant_admin:company:assign': SEED_IDS.role_scopes.tenant_admin_company_assign,
  'tenant_admin:org:manage': SEED_IDS.role_scopes.tenant_admin_org_manage,
  'tenant_admin:team:manage': SEED_IDS.role_scopes.tenant_admin_team_manage,
  'tenant_admin:company:read:all': SEED_IDS.role_scopes.tenant_admin_company_read_all,
};

// AUTHZ-1 / AUTHZ-1b — bundle catalog for the 9 staffing-tenant roles
// added on top of the pre-AUTHZ-1 trio (tenant_admin + recruiter +
// candidate). Each entry is (role_key, scope_keys[]). The list iteration
// order pins the deterministic UUID generation for
// AUTHZ1_ROLE_SCOPE_ROW_IDS below — do not re-order without bumping the
// offset to a fresh range (otherwise existing dev DBs would see
// RoleScope.id collisions on re-seed).
//
// Per-bundle rulings (AUTHZ-1b §2):
//   - tenant_owner: Owner = Admin scope set (position-only distinction).
//   - account_manager: Recruiter's 31 + tenant:admin:user-manage +
//     requisition:assign. AM is the demand-side anchor (client-ownership
//     pods at D4a); requisition:assign is the AM act.
//   - sourcer: intake-focused; NO :delete, NO submittal.
//   - finance: offer-approval surface; compensation visibility is D5.
//     Renamed from finance_hr (KEY rename; bundle preserved verbatim).
//   - auditor: Lead exact set (5 read scopes). report:read seeded by
//     Reporting-Scope-Seed (granted to the 8 OPERATIONAL roles, per
//     Amendment v1.1 Ruling B-iii); the AUDITOR-tier report:read +
//     audit-log:read remain gap-and-noted — deferred to the un-authored
//     Reporting/Audit DDR.
//   - recruiting_manager: Recruiter's 31 + tenant:admin:user-manage; NO
//     requisition:assign (RM manages PEOPLE; assign is the AM's act,
//     which keeps RM and AM functionally distinct). Broader visibility
//     comes from the TEAM MODEL at D4a/b (Axis-1 anchor), not a see-all.
//   - delivery_manager: read + submittal:approve. DM IS the fulfillment
//     quality gate. NO requisition:read:all (see-all is reserved; team
//     oversight visibility comes from D4b).
//   - lead_recruiter: = Recruiter verbatim. The "lead" distinction is
//     purely team-tier visibility via D4b (Axis-1 mid-tier).
//   - back_office: operational-read + activity bundle. The onboarding /
//     timesheet / compliance CAPABILITY scopes (onboarding:*, timesheet:*,
//     compliance:*) DO NOT EXIST yet — gap-and-noted to a future
//     Onboarding/Operations DDR. The role lands with its current-
//     capability bundle so invitations and assignments can reference it.
const AUTHZ1_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  // tenant_owner — 47 scopes (full tenant_admin set incl. AUTHZ-D4a's 4 new
  // scopes; position-only distinction from tenant_admin).
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
    // AUTHZ-D4a — tenant_owner gets the full team-model set (mirrors TA).
    'company:assign', 'org:manage', 'team:manage', 'company:read:all',
  ]],
  // account_manager — 35 scopes (Recruiter's 31 + tenant:admin:user-manage +
  // requisition:assign + AUTHZ-D4a's company:assign + team:manage).
  // AM is the client-ownership anchor (Amendment §5.4 + D4a Lead ruling 6).
  // Three AM-specific delegations on top of Recruiter's operational set:
  // user/membership mgmt; requisition:assign (the management act);
  // company:assign + team:manage (the D4a client-ownership mechanisms).
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
    'tenant:admin:user-manage', 'requisition:assign',
    // AUTHZ-D4a — AM is the demand-side / client-ownership anchor.
    'company:assign', 'team:manage',
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
  // finance — 6 scopes (offer approval; compensation visibility is D5).
  // AUTHZ-1b KEY rename from finance_hr; bundle preserved.
  ['finance', [
    'auth:session:read',
    'talent:read', 'requisition:read', 'submittal:approve',
    'activity:read', 'activity:create',
  ]],
  // auditor — 5 scopes (Lead exact set; AUDITOR-tier report:read +
  // audit-log:read deferred to the Reporting/Audit DDR — note:
  // report:read is seeded for the 8 OPERATIONAL roles via
  // REPORTING_SEED_BUNDLES, NOT for the auditor tier).
  ['auditor', [
    'auth:session:read',
    'consent:decision-log:read',
    'identity:user:read', 'identity:tenant:read',
    'activity:read',
  ]],
  // Settings S4 — auditor_with_financials. The Auditor bundle's 5 read scopes
  // verbatim (compliance-tier reads). The 6 see-all comp scopes are added
  // separately via D5_COMPENSATION_BUNDLES so the RoleScope row-id space
  // stays partitioned (AUTHZ-1 0x400+ for non-comp; D5 0x500+ for comp).
  // Grantable ONLY when the tenant's audit.financials_enabled=true (the S4
  // GATE precondition fires at the role-assign path; see
  // TenantUserLifecycleService.assignTenantUserRoles).
  ['auditor_with_financials', [
    'auth:session:read',
    'consent:decision-log:read',
    'identity:user:read', 'identity:tenant:read',
    'activity:read',
  ]],
  // recruiting_manager — 33 scopes (Recruiter's 31 + tenant:admin:user-manage
  // + AUTHZ-D4a's org:manage; NO requisition:assign / NO company:assign —
  // those are the AM's acts). RM manages PEOPLE (user-manage provisions /
  // manages their reports; org:manage sets the management hierarchy);
  // team-tier visibility at D4b.
  ['recruiting_manager', [
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
    'tenant:admin:user-manage',
    // AUTHZ-D4a — RM is the management-hierarchy operator (Axis-1).
    'org:manage',
  ]],
  // delivery_manager — 12 scopes (the fulfillment quality gate: read +
  // submittal:approve + activity:create). NO requisition:read:all —
  // team-oversight visibility comes from D4b, NOT a see-all scope.
  ['delivery_manager', [
    'auth:session:read', 'consent:read',
    'talent:read', 'company:read', 'contact:read', 'requisition:read',
    'activity:read', 'examination:read', 'pipeline:read', 'attachment:read',
    'submittal:approve', 'activity:create',
  ]],
  // lead_recruiter — 31 scopes (= Recruiter verbatim). Lead-ness is purely
  // team-tier visibility via D4b (Axis-1 mid-tier anchor); no operational
  // delta from Recruiter.
  ['lead_recruiter', [
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
  ]],
  // back_office — 12 scopes (operational-read + activity entry). The
  // onboarding:* / timesheet:* / compliance:* CAPABILITY scopes the role
  // ultimately needs DO NOT EXIST yet — gap-and-noted to a future
  // Onboarding/Operations DDR. The role lands with its current-capability
  // bundle so invitations/assignments can reference it.
  ['back_office', [
    'auth:session:read', 'consent:read', 'consent:decision-log:read',
    'talent:read', 'company:read', 'contact:read', 'requisition:read',
    'activity:read', 'examination:read', 'pipeline:read', 'attachment:read',
    'activity:create',
  ]],
];

// AUTHZ-1 / AUTHZ-1b — role.created audit-event manifest for the 9
// staffing-tenant roles. Pattern mirrors the A1A2_NEW_SCOPES manifest
// used for scope.created events; the closed-list test validates catalog
// shape, not each audit event individually.
const AUTHZ1_ROLE_AUDIT_EVENTS: Array<{
  audit_id: string;
  role_id: string;
  key: string;
}> = [
  { audit_id: SEED_IDS.audit_events.role_tenant_owner_created, role_id: SEED_IDS.roles.tenant_owner, key: 'tenant_owner' },
  { audit_id: SEED_IDS.audit_events.role_delivery_manager_created, role_id: SEED_IDS.roles.delivery_manager, key: 'delivery_manager' },
  { audit_id: SEED_IDS.audit_events.role_account_manager_created, role_id: SEED_IDS.roles.account_manager, key: 'account_manager' },
  { audit_id: SEED_IDS.audit_events.role_recruiting_manager_created, role_id: SEED_IDS.roles.recruiting_manager, key: 'recruiting_manager' },
  { audit_id: SEED_IDS.audit_events.role_sourcer_created, role_id: SEED_IDS.roles.sourcer, key: 'sourcer' },
  { audit_id: SEED_IDS.audit_events.role_lead_recruiter_created, role_id: SEED_IDS.roles.lead_recruiter, key: 'lead_recruiter' },
  { audit_id: SEED_IDS.audit_events.role_finance_created, role_id: SEED_IDS.roles.finance, key: 'finance' },
  { audit_id: SEED_IDS.audit_events.role_auditor_created, role_id: SEED_IDS.roles.auditor, key: 'auditor' },
  { audit_id: SEED_IDS.audit_events.role_back_office_created, role_id: SEED_IDS.roles.back_office, key: 'back_office' },
  // Settings S4 — 1 new role.created event for auditor_with_financials.
  { audit_id: SEED_IDS.audit_events.role_auditor_with_financials_created, role_id: SEED_IDS.roles.auditor_with_financials, key: 'auditor_with_financials' },
];

// AUTHZ-1 / AUTHZ-1b — generate the 188 staffing-catalog RoleScope row
// IDs deterministically. Offset bumped from 0x14b to 0x400 at AUTHZ-1b:
// the AUTHZ-1b bundles total 188 rows (101 kept + 87 from the 4 new
// staffing roles), which would have run past 0x14b + 187 = 0x206 into
// the audit_events 0x200..0x235 range. 0x400 is a fresh range clearly
// above all currently-used SEED_IDS spans. The (role, scope) iteration
// order in AUTHZ1_BUNDLES pins the assignment, so a given (role, scope)
// pair always produces the same UUID on every seed run. seed.spec.ts
// walks SEED_IDS for UUID validity; the AUTHZ-1 ids live in this
// separate map but each value is a UUID string by construction.
const AUTHZ1_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x400;
  for (const [role, scopes] of AUTHZ1_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// AUTHZ-D5 — the LOCKED role-to-view matrix (commit plan §2). Discrete
// bundle structure separate from ROLE_SCOPE_ASSIGNMENTS + AUTHZ1_BUNDLES
// so existing RoleScope UUIDs are not shifted. UUIDs generated from a
// disjoint range (0x500+) below to keep the address space clean.
//
// THE ENFORCED INVARIANT (libs/field-masking assertNonInvertibleBundle):
// no role holds both compensation:view:pay AND any spread scope. The
// matrix below satisfies this mechanically — every entry with view:pay
// has zero spread scopes; every entry with a spread scope has no
// view:pay. The see-all tier (tenant_admin, tenant_owner) is exempt by
// design (holds every scope; "inversion" is intended, not a leak).
//
// THE ACCEPTED-DERIVATION (soft, by-design): account_manager holds
// view:bill + view:spread:percent + view:margin:percent + view:revenue
// — they can compute pay = bill − (bill × margin%). This is the matrix
// intent (AM's incentive IS margin); a UI default, not a security
// boundary. Recorded so the EEO DDR (Settings, the hard-boundary case)
// does not inherit this softness.
//
// Roles with NO comp scopes (sourcer, auditor, candidate, super_admin)
// are absent from this table — the field-masking interceptor omits
// every comp field for them.
// D-AUTHZ-COMP-WRITE-1 — bundle extension (ruling 7): grant edit ONLY
// where the role authors that compensation data:
//   - see-all tier (TA / TO) + edit:pay + edit:bill (writes everything).
//   - recruiter / recruiting_manager / lead_recruiter / back_office +
//     edit:pay (mirror view:pay; candidate-economics authors).
//   - account_manager + edit:bill (mirror view:bill; agency-economics
//     author; NO edit:pay — preserves the soft-derivation read-side
//     symmetry on the write side).
//   - delivery_manager / finance / auditor_with_financials — NO edit
//     scopes (read-only/review/audit roles; least-privilege + SoD —
//     an audit role writing what it audits is a separation-of-duties
//     violation). If a workflow emerges later that demands write, add
//     it deliberately with that workflow, not speculatively.
//   - sourcer / candidate / super_admin / auditor — absent from the
//     table (no comp surface).
export const D5_COMPENSATION_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  // see-all tier (TA + TO) — every comp scope. Mirrors the requisition:read:all
  // pattern at D4b: top-tier roles see everything; operational tiers get the
  // narrower per-side cuts below.
  ['tenant_admin', [
    'compensation:view:pay',
    'compensation:view:bill',
    'compensation:view:revenue',
    'compensation:view:spread:amount',
    'compensation:view:spread:percent',
    'compensation:view:margin:percent',
    // D-AUTHZ-COMP-WRITE-1 — see-all writes everything.
    'compensation:edit:pay',
    'compensation:edit:bill',
  ]],
  ['tenant_owner', [
    'compensation:view:pay',
    'compensation:view:bill',
    'compensation:view:revenue',
    'compensation:view:spread:amount',
    'compensation:view:spread:percent',
    'compensation:view:margin:percent',
    'compensation:edit:pay',
    'compensation:edit:bill',
  ]],
  // account_manager — agency-economics side. bill + fee + the two
  // percent spread views + revenue. NO view:pay (the invariant holds);
  // pay is derivable from bill − margin (the soft-boundary, by design).
  // D-AUTHZ-COMP-WRITE-1: + edit:bill (AM is the agency-economics author;
  // mirrors view:bill). NO edit:pay — preserves the soft-derivation
  // read-side symmetry on the write side.
  ['account_manager', [
    'compensation:view:bill',
    'compensation:view:revenue',
    'compensation:view:spread:percent',
    'compensation:view:margin:percent',
    'compensation:edit:bill',
  ]],
  // recruiter / recruiting_manager / lead_recruiter — candidate-economics
  // side. pay + salary. NO spread scopes (the invariant holds).
  // D-AUTHZ-COMP-WRITE-1: + edit:pay (the candidate-economics authors).
  ['recruiter', ['compensation:view:pay', 'compensation:edit:pay']],
  ['recruiting_manager', ['compensation:view:pay', 'compensation:edit:pay']],
  ['lead_recruiter', ['compensation:view:pay', 'compensation:edit:pay']],
  // back_office — operational pay visibility (onboarding / payroll-facing).
  // Same shape as recruiter for the matrix; no spread.
  // D-AUTHZ-COMP-WRITE-1: + edit:pay (payroll-facing write surface).
  ['back_office', ['compensation:view:pay', 'compensation:edit:pay']],
  // delivery_manager — fulfillment-economics. All spread + margin views +
  // revenue. NO view:pay (the invariant holds); pay is derivable by the
  // same soft-boundary as AM (intended).
  // D-AUTHZ-COMP-WRITE-1: NO edit scopes (read-only review role; a
  // separate write workflow would add it deliberately).
  ['delivery_manager', [
    'compensation:view:revenue',
    'compensation:view:spread:amount',
    'compensation:view:spread:percent',
    'compensation:view:margin:percent',
  ]],
  // finance — offer-approval / margin-reporting surface. margin% + revenue.
  // NO view:pay (the invariant holds); narrower than AM by design (Finance
  // sees the headline ratio + the revenue, NOT the spread itself).
  // D-AUTHZ-COMP-WRITE-1: NO edit scopes (read-only offer-approval role).
  ['finance', [
    'compensation:view:revenue',
    'compensation:view:margin:percent',
  ]],
  // Roles intentionally absent (zero comp scopes): sourcer (intake-focused;
  // doesn't negotiate); auditor (NONE by default — grantable via Settings
  // toggle, not seeded); candidate (portal-tier — no requisition read);
  // super_admin (platform-tier — no tenant requisition surface).
  //
  // Settings S4 — auditor_with_financials. The compliance see-all-comp
  // grant. Holds every compensation:view:* scope (the see-all-comp set);
  // mirrors the see-all tier (TA/TO) shape for COMP visibility. Joins the
  // SEE_ALL_ROLE_KEYS bypass in role-bundle-validator so the D5 union
  // check exempts unions involving this role (holding view:pay alongside
  // every spread is the grant's whole point — NOT a leak). Non-
  // invertibility is asserted trivially via assertNonInvertibleBundle's
  // {seeAll:true} arg in d5-non-invertibility.spec. The role's GRANT to
  // any membership is gated by the audit.financials_enabled
  // KNOWN_SETTING via the S4 GATE precondition at the role-assign path
  // (TenantUserLifecycleService.assignTenantUserRoles); the SEED of the
  // role itself is unconditional.
  // D-AUTHZ-COMP-WRITE-1: NO edit scopes — an audit role writing what it
  // audits is a separation-of-duties violation. Read-only.
  ['auditor_with_financials', [
    'compensation:view:pay',
    'compensation:view:bill',
    'compensation:view:revenue',
    'compensation:view:spread:amount',
    'compensation:view:spread:percent',
    'compensation:view:margin:percent',
  ]],
];

// AUTHZ-D5 — deterministic RoleScope row IDs for the comp-bundle grants
// above. Disjoint range starting at 0x500 (AUTHZ-1's 0x400+ range +
// AUTHZ-D4a's 0x303+ range stay untouched — no shift). The (role, scope)
// iteration order pins the assignment, so a given pair always produces
// the same UUID on every seed run. Total rows: 6+6+4+1+1+1+1+4+2 = 26.
const D5_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x500;
  for (const [role, scopes] of D5_COMPENSATION_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Reporting-Scope-Seed — operational reporting reads (Amendment v1.1
// Rulings B-iii + C + D). Closes the PR-A7 gap-and-note: GET /v1/dashboard
// + the 4 GET /v1/reports/* routes were built with @RequireScopes guards
// on dashboard:read / report:read, but the two scopes were never seeded —
// every JWT 403'd on the reporting surface (R1 dropped the recruiter-home
// dashboard for this reason and filed a carry).
//
// 8 operational roles × 2 scopes = 16 grants at a FRESH 0x600+
// deterministic sub-range. APPEND-DON'T-RENUMBER: the AUTHZ1_BUNDLES
// (0x400+) and D5 (0x500+) ranges stay untouched. Iteration order pins
// the assignment, so a given (role, scope) pair always produces the same
// UUID on every seed run. DO NOT REORDER without bumping the offset to a
// fresh range.
//
// AUDITOR / auditor_with_financials NOT in this list — the auditor-tier
// compliance-read surface (report:read at the auditor tier + audit-log:read)
// is deferred to the un-authored Reporting/Audit DDR. Sourcer + finance
// also OUT: sourcer is intake-focused (the dashboard is the recruiter-home);
// finance has requisition:read but NOT pipeline:read (the pipeline rollup
// isn't in its scope).
//
// The derivation rule: grant to the roles that hold the requisition +
// pipeline read scopes the rollups derive from. The A3/D4b composed-
// visibility predicate in ReportingService then governs WHAT each role
// SEES once through the gate — the seed grants ACCESS, not visibility.
const REPORTING_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['dashboard:read', 'report:read']],
  ['tenant_admin', ['dashboard:read', 'report:read']],
  ['account_manager', ['dashboard:read', 'report:read']],
  ['recruiting_manager', ['dashboard:read', 'report:read']],
  ['recruiter', ['dashboard:read', 'report:read']],
  ['lead_recruiter', ['dashboard:read', 'report:read']],
  ['back_office', ['dashboard:read', 'report:read']],
  ['delivery_manager', ['dashboard:read', 'report:read']],
];

// Reporting-Scope-Seed — deterministic RoleScope row IDs for the 16
// reporting-bundle grants above. Disjoint range starting at 0x600
// (AUTHZ-1's 0x400+ range and AUTHZ-D5's 0x500+ range stay untouched —
// no shift to existing RoleScope.id assignments). The (role, scope)
// iteration order in REPORTING_SEED_BUNDLES pins the assignment, so a
// given pair always produces the same UUID on every seed run.
const REPORTING_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x600;
  for (const [role, scopes] of REPORTING_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// R7 BE-prereq — engagement-domain role-scope bundle (Amendment v1.1 §2
// Ruling 2: 8-role grant set, 20 RoleScope rows). Write-tier 6 roles get
// :read + :write + :outreach; read-only 2 roles (delivery_manager / back_office)
// get :read only. The 6 excluded roles (sourcer / finance / auditor /
// auditor_with_financials / candidate / super_admin) hold zero engagement
// scopes — they 403 on every engagement route.
//
// Bundle composition rationale:
//   - tenant_owner / tenant_admin: full operational tier; write-tier baseline.
//   - account_manager (35-scope demand-side anchor): has submittal:create +
//     pipeline mgmt — legitimately engages talent on owned clients.
//   - recruiting_manager (33-scope mgmt operator): has submittal:create +
//     pipeline mgmt + team-tier visibility.
//   - lead_recruiter (= Recruiter verbatim per AUTHZ1_BUNDLES comment):
//     write-tier mirror of recruiter.
//   - recruiter (the FLOOR): the workflow's primary actor.
//   - delivery_manager / back_office (read-only): fulfillment-quality + ops
//     read; mirror their existing broad-read bundles (talent:read + pipeline:read
//     + activity:read etc.) — they SEE engagement workflow state but neither
//     drive it nor send outreach.
const ENGAGEMENT_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['engagement:read', 'engagement:write', 'engagement:outreach']],
  ['tenant_admin', ['engagement:read', 'engagement:write', 'engagement:outreach']],
  ['account_manager', ['engagement:read', 'engagement:write', 'engagement:outreach']],
  ['recruiting_manager', ['engagement:read', 'engagement:write', 'engagement:outreach']],
  ['recruiter', ['engagement:read', 'engagement:write', 'engagement:outreach']],
  ['lead_recruiter', ['engagement:read', 'engagement:write', 'engagement:outreach']],
  ['delivery_manager', ['engagement:read']],
  ['back_office', ['engagement:read']],
];

// R7 BE-prereq — deterministic RoleScope row IDs for the 20 engagement-
// bundle grants above. Disjoint range starting at 0x700 (AUTHZ-1's 0x400+,
// AUTHZ-D5's 0x500+, Reporting's 0x600+ all stay untouched — append-don't-
// renumber per Amendment v1.1 §2). The (role, scope) iteration order in
// ENGAGEMENT_SEED_BUNDLES pins the assignment, so a given pair always
// produces the same UUID on every seed run. DO NOT REORDER without
// bumping the offset to a fresh range.
const ENGAGEMENT_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x700;
  for (const [role, scopes] of ENGAGEMENT_SEED_BUNDLES) {
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

  // 5. Roles (14 entries: 13 tenant roles [12 AUTHZ-1b + 1 S4
  // auditor_with_financials] + 1 AUTHZ-2 platform role).
  // Descriptions carry the DDR display name + intent. The Role.key strings
  // are PRESERVED across AUTHZ-1b for the kept roles (tenant_admin,
  // recruiter, candidate, tenant_owner, account_manager, sourcer, auditor)
  // — A2–A8 permission checks reference these keys verbatim and must stay
  // green. finance_hr is renamed to finance (grep-confirmed zero JWT/guard
  // refs). upsertRole's update path is {} so descriptions update only on
  // fresh seeds; pre-existing rows retain whatever description they were
  // first seeded with. That is acceptable — the catalog contract is the
  // (key, scope-bundle) pair, verified by test 17. The display-name re-map
  // is observed on fresh dev/test DBs (every integration spec starts a
  // fresh Postgres container).
  await upsertRole(prisma, SEED_IDS.roles.tenant_admin, 'tenant_admin', 'Tenant Admin — administrative operator of the tenant (users, roles, settings; full scope set)');
  await upsertRole(prisma, SEED_IDS.roles.recruiter, 'recruiter', 'Recruiter — core operator (assigned requisitions/talents; no destructive scopes, no see-all)');
  await upsertRole(prisma, SEED_IDS.roles.candidate, 'candidate', 'Candidate — portal-user role for talent subjects authenticating via the portal');
  // AUTHZ-1 / AUTHZ-1b — 9 staffing-tenant roles.
  await upsertRole(prisma, SEED_IDS.roles.tenant_owner, 'tenant_owner', 'Tenant Owner — singular top authority within a tenant (same scope set as Tenant Admin; org-position distinction)');
  await upsertRole(prisma, SEED_IDS.roles.account_manager, 'account_manager', 'Account Manager — client-ownership anchor (D4a Axis-2 pods); Recruiter operational set + tenant:admin:user-manage + requisition:assign');
  await upsertRole(prisma, SEED_IDS.roles.sourcer, 'sourcer', 'Sourcer — intake-focused; adds talents and manages the pipeline-sourcing surface');
  await upsertRole(prisma, SEED_IDS.roles.finance, 'finance', 'Finance — offer-approval surface (compensation visibility is D5)');
  await upsertRole(prisma, SEED_IDS.roles.auditor, 'auditor', 'Auditor/Compliance — read-only audit logs, decision logs, sessions, identity');
  await upsertRole(prisma, SEED_IDS.roles.recruiting_manager, 'recruiting_manager', 'Recruiting Manager — people-management anchor (D4a Axis-1); Recruiter operational set + tenant:admin:user-manage (no requisition:assign — that is the AM act)');
  await upsertRole(prisma, SEED_IDS.roles.delivery_manager, 'delivery_manager', 'Delivery Manager — fulfillment quality gate; read + submittal:approve (no see-all — team-oversight visibility comes from D4b)');
  await upsertRole(prisma, SEED_IDS.roles.lead_recruiter, 'lead_recruiter', 'Lead Recruiter — operationally a Recruiter; lead-ness is team-tier visibility via D4b (Axis-1 mid-tier)');
  await upsertRole(prisma, SEED_IDS.roles.back_office, 'back_office', 'Back Office — operational-read + activity entry (the onboarding/timesheet/compliance capability scopes are deferred to the Onboarding/Operations DDR)');
  // Settings S4 — Auditor/Compliance + see-all comp. Grantable ONLY when
  // the tenant's audit.financials_enabled=true (the GATE precondition
  // fires WRITE-TIME at the role-assign path).
  await upsertRole(prisma, SEED_IDS.roles.auditor_with_financials, 'auditor_with_financials', 'Auditor with Financials — compliance reads + every compensation:view:* (the see-all-comp grant; gated by audit.financials_enabled)');
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
  // AUTHZ-D4a — 4 team-model scopes (Amendment §4/§6). Lead Gate-5 ruling 2
  // narrowed company:read:all to TA+TO only (mirrors requisition:read:all).
  await upsertScope(prisma, SEED_IDS.scopes['company:assign'], 'company:assign', 'Assign / unassign a user to a client (account_manager + tenant_admin + tenant_owner; mirrors requisition:assign as the AM act)');
  await upsertScope(prisma, SEED_IDS.scopes['org:manage'], 'org:manage', 'Set / clear a management edge (Axis-1 hierarchy; recruiting_manager + tenant_admin + tenant_owner; distinct from tenant:admin:user-manage which is user provisioning)');
  await upsertScope(prisma, SEED_IDS.scopes['team:manage'], 'team:manage', 'Create / manage a pod + its membership + its client-ownership (Axis-2; account_manager + tenant_admin + tenant_owner; AM is the pod operator)');
  await upsertScope(prisma, SEED_IDS.scopes['company:read:all'], 'company:read:all', 'Read every company in the tenant (tenant_admin + tenant_owner only; the see-all stays reserved to the top tier — operational breadth comes from D4b)');
  // AUTHZ-D5 — 6 compensation:view:* scopes (the field-masking scope
  // family). Keyed at the response interceptor (apps/api
  // CompensationFieldMaskInterceptor) via libs/field-masking. See the
  // commit plan §2 / the locked role-to-view matrix in D5_COMPENSATION_BUNDLES.
  await upsertScope(prisma, SEED_IDS.scopes['compensation:view:pay'], 'compensation:view:pay', 'View pay_rate_* + salary_* on the requisition read (candidate-economics anchor; recruiter / recruiting_manager / lead_recruiter / back_office / TA + TO)');
  await upsertScope(prisma, SEED_IDS.scopes['compensation:view:bill'], 'compensation:view:bill', 'View bill_rate_* + placement_fee_* on the requisition read (agency-economics anchor; account_manager + TA + TO)');
  await upsertScope(prisma, SEED_IDS.scopes['compensation:view:revenue'], 'compensation:view:revenue', 'View bill_rate_* on the requisition read (revenue view; account_manager + finance + delivery_manager + TA + TO; rate-only, no placement fee)');
  await upsertScope(prisma, SEED_IDS.scopes['compensation:view:spread:amount'], 'compensation:view:spread:amount', 'View margin_amount on the requisition read (the $ spread; delivery_manager + TA + TO; NOT grantable together with view:pay — D5 enforced invariant)');
  await upsertScope(prisma, SEED_IDS.scopes['compensation:view:spread:percent'], 'compensation:view:spread:percent', 'View markup_percent on the requisition read (account_manager + delivery_manager + TA + TO; NOT grantable together with view:pay)');
  await upsertScope(prisma, SEED_IDS.scopes['compensation:view:margin:percent'], 'compensation:view:margin:percent', 'View margin_percent on the requisition read (account_manager + finance + delivery_manager + TA + TO; NOT grantable together with view:pay)');
  // D-AUTHZ-COMP-WRITE-1 — 2 compensation:edit:* scopes (the WRITE-side
  // floor; closes the D5 write-path circumvention). Enforced IN-SERVICE
  // at the requisition repository (create / update / createForImport)
  // BEFORE the Prisma write + BEFORE audit. The minimum-coherent write
  // set: the 4 derived/subset view scopes (revenue / spread:* /
  // margin:%) gate read-only DERIVED fields — no writeable surface.
  await upsertScope(prisma, SEED_IDS.scopes['compensation:edit:pay'], 'compensation:edit:pay', 'Write pay_rate_* + salary_* on a requisition (candidate-economics author; recruiter / RM / LR / back_office + TA + TO; NOT grantable together with any compensation:view:spread:* — D-AUTHZ-COMP-WRITE-1 view∪edit invariant: writing pay + reading spread reconstructs bill)');
  await upsertScope(prisma, SEED_IDS.scopes['compensation:edit:bill'], 'compensation:edit:bill', 'Write bill_rate_* + placement_fee_* on a requisition (agency-economics author; account_manager + TA + TO)');
  // Reporting-Scope-Seed — 2 reporting:* scopes (close the PR-A7
  // gap-and-note: dashboard.controller.ts:28). Description copy per
  // Amendment v1.1 Ruling E (the ATS-internal seam-exclusion is explicit
  // in the dashboard:read description).
  await upsertScope(prisma, SEED_IDS.scopes['dashboard:read'], 'dashboard:read', 'Read the ATS-internal dashboard composition (tenant counts, requisition/pipeline rollups, ATS-internal placement count, upcoming events, recent activity). ATS-domain only; no Core/examination read.');
  await upsertScope(prisma, SEED_IDS.scopes['report:read'], 'report:read', 'Read per-metric ATS-internal reports (tenant-counts, requisition-rollup, pipeline-rollup, placement-count).');
  // R7 BE-prereq — 3 engagement-domain scopes (closes the A1a-2 deferral).
  // 3-scope split (Amendment v1.1 §1 Ruling B; outreach SoD). The 8 engagement
  // routes gate via @RequireScopes(...) — read on the 3 GETs (incl. the new
  // LIST), write on create/transitions/response/conversation, outreach on the
  // outreach route. NO scope.created audit events (mirrors the Reporting-Scope-
  // Seed precedent).
  await upsertScope(prisma, SEED_IDS.scopes['engagement:read'], 'engagement:read', 'Read engagements (GET /v1/engagements LIST, GET /v1/engagements/:id, GET /v1/engagements/:id/events). 8 roles: write-tier 6 + read-only 2 (delivery_manager / back_office). D4b-composed at read time (engagement visible iff its requisition_id is in the actor visible-requisition set).');
  await upsertScope(prisma, SEED_IDS.scopes['engagement:write'], 'engagement:write', 'Mutate engagements (POST create / transitions / response / conversation). 6 roles: TA / TO / AM / RM / LR / recruiter[floor]. Write-path visibility: the controller (create) + the repo findByTenantAndId (the 4 mutate-existing) compose D4b — invisible-requisition engagements return 404.');
  await upsertScope(prisma, SEED_IDS.scopes['engagement:outreach'], 'engagement:outreach', 'Send outbound engagement outreach (POST /v1/engagements/:id/outreach). Separate from :write per outreach SoD — the only engagement write with external side-effects (AI draft + consent-at-send + outbound delivery + LLM cost). Same 6 roles as :write.');

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

  // 7c. AUTHZ-D5 RoleScope assignments — 26 rows for the compensation
  // bundle grants per the LOCKED role-to-view matrix
  // (D5_COMPENSATION_BUNDLES). UUID range 0x500+ (disjoint from
  // ROLE_SCOPE_ROW_IDS' 0x30-0x3xx and AUTHZ1_ROLE_SCOPE_ROW_IDS' 0x400+
  // — no shift to existing RoleScope.id assignments).
  for (const [roleKey, scopeKeys] of D5_COMPENSATION_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = D5_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`AUTHZ-D5: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // 7d. Reporting-Scope-Seed RoleScope assignments — 16 rows (8 roles ×
  // 2 scopes) per REPORTING_SEED_BUNDLES. UUID range 0x600+ (disjoint
  // from the 0x30-0x3xx trio range, AUTHZ-1's 0x400+, AUTHZ-D5's 0x500+
  // — no shift to existing RoleScope.id assignments). Closes the R1
  // dashboard:read carry and the PR-A7 reporting-scope gap-and-note.
  for (const [roleKey, scopeKeys] of REPORTING_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = REPORTING_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`Reporting-Scope-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // 7e. R7 BE-prereq RoleScope assignments — 20 rows (6 write-tier × 3 +
  // 2 read-only × 1) per ENGAGEMENT_SEED_BUNDLES. UUID range 0x700+
  // (append-don't-renumber per Amendment v1.1 §2 — AUTHZ-1's 0x400+,
  // AUTHZ-D5's 0x500+, Reporting's 0x600+ all stay untouched). Closes
  // the documented A1a-2 engagement-scope deferral and enables the R7 FE.
  for (const [roleKey, scopeKeys] of ENGAGEMENT_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = ENGAGEMENT_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`R7 Engagement-Scope-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
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
  // AUTHZ-1b: role_viewer_created audit upsert removed (role retired).
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
    // AUTHZ-D4a — 4 new scope.created audit events for the team-model scopes.
    { audit_id: SEED_IDS.audit_events.scope_company_assign_created, key: 'company:assign' },
    { audit_id: SEED_IDS.audit_events.scope_org_manage_created, key: 'org:manage' },
    { audit_id: SEED_IDS.audit_events.scope_team_manage_created, key: 'team:manage' },
    { audit_id: SEED_IDS.audit_events.scope_company_read_all_created, key: 'company:read:all' },
    // AUTHZ-D5 — 6 new scope.created audit events for the compensation:view:* scopes.
    { audit_id: SEED_IDS.audit_events.scope_compensation_view_pay_created, key: 'compensation:view:pay' },
    { audit_id: SEED_IDS.audit_events.scope_compensation_view_bill_created, key: 'compensation:view:bill' },
    { audit_id: SEED_IDS.audit_events.scope_compensation_view_revenue_created, key: 'compensation:view:revenue' },
    { audit_id: SEED_IDS.audit_events.scope_compensation_view_spread_amount_created, key: 'compensation:view:spread:amount' },
    { audit_id: SEED_IDS.audit_events.scope_compensation_view_spread_percent_created, key: 'compensation:view:spread:percent' },
    { audit_id: SEED_IDS.audit_events.scope_compensation_view_margin_percent_created, key: 'compensation:view:margin:percent' },
    // D-AUTHZ-COMP-WRITE-1 — 2 new scope.created audit events for the
    // compensation:edit:* WRITE-side scopes.
    { audit_id: SEED_IDS.audit_events.scope_compensation_edit_pay_created, key: 'compensation:edit:pay' },
    { audit_id: SEED_IDS.audit_events.scope_compensation_edit_bill_created, key: 'compensation:edit:bill' },
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
