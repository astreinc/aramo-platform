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
  // Track 8 / T8-CONNECTOR-A — the dedicated connector execution ServiceAccount
  // (machine actor). MUST equal CONNECTOR_SERVICE_ACCOUNT_ID in
  // libs/integration/src/lib/domain/connector-actor.ts. Written as imported_by_id
  // on connector-produced ImportBatches so machine execution is unmistakable. It
  // holds NO connector-management scopes; execution authority is supplied
  // programmatically (requisition:import:write) at the P2 handoff.
  service_account_connector: '01900000-0000-7000-8000-000000000004',
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
    // Portal P3a — candidate verification view + dispute rights (3).
    'portal:verification:read': '01900000-0000-7000-8000-0000000000b2',
    'portal:dispute:read': '01900000-0000-7000-8000-0000000000b3',
    'portal:dispute:write': '01900000-0000-7000-8000-0000000000b4',
    // PR-A1a-2 full ATS expansion (27 scopes; Ruling 1 uniform divergence).
    // talent (5)
    'talent:read': '01900000-0000-7000-8000-000000000068',
    'talent:create': '01900000-0000-7000-8000-000000000069',
    'talent:edit': '01900000-0000-7000-8000-00000000006a',
    'talent:delete': '01900000-0000-7000-8000-00000000006b',
    'talent:search': '01900000-0000-7000-8000-00000000006c',
    'talent:source': '01900000-0000-7000-8000-0000000000b1',
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
    // pipeline (3) — add, change-status, complete (0x77/0x78 = the HYG-removed
    // add-activity/remove; 0x78 reused for the L2-C pipeline:complete slot)
    'pipeline:add': '01900000-0000-7000-8000-000000000075',
    'pipeline:change-status': '01900000-0000-7000-8000-000000000076',
    'pipeline:complete': '01900000-0000-7000-8000-000000000078',
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
    // Lane 2 / L2-F (F1) — Client-Selection owner scopes.
    'client-selection:create': '01900000-0000-7000-8000-0000000000f3',
    'client-selection:read': '01900000-0000-7000-8000-0000000000f1',
    'client-selection:transition': '01900000-0000-7000-8000-0000000000f2',
    // Lane 2 / L2-F (F2) — InterviewSession child scopes.
    'client-selection:interview:schedule': '01900000-0000-7000-8000-0000000000f4',
    'client-selection:interview:transition': '01900000-0000-7000-8000-0000000000f5',
    'activity:create': '01900000-0000-7000-8000-000000000088',
    // AUTHZ-2 — 3 platform-namespace scopes (Lead ruling 5; the minimum set).
    // Bound only to the super_admin platform role; no tenant role holds any
    // platform:* scope. The DDR §13.1 tripwire is enforced by namespace
    // partition + the consumer_type check at the guard layer.
    'platform:tenant:provision': '01900000-0000-7000-8000-000000000089',
    'platform:tenant:read': '01900000-0000-7000-8000-00000000008a',
    'platform:admin:invite': '01900000-0000-7000-8000-00000000008b',
    // Platform-Console Increment-2 PR-1 — tenant lifecycle management scope.
    'platform:tenant:lifecycle:manage': '01900000-0000-7000-8000-0000000000f0',
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
    // R7 BE-prereq — 3 selection-domain scopes (Amendment v1.1 §1
    // Ruling B: outreach SoD). Continues the 0x90 reporting range:
    // 0x9a / 0x9b / 0x9c. Closes the documented A1a-2 deferral
    // (scope.dto.ts:23-25 prior to this PR).
    'selection:read': '01900000-0000-7000-8000-00000000009a',
    'selection:write': '01900000-0000-7000-8000-00000000009b',
    'selection:outreach': '01900000-0000-7000-8000-00000000009c',
    // Search PR-1 — 3 per-entity quick-search scopes (continue the 0x90
    // range: 0x9d / 0x9e / 0x9f). talent:search is REUSED (0x6c above), so
    // only company/requisition/contact get new scope ids. Granted via
    // SEARCH_SEED_BUNDLES (per-entity :read-holder parity; range 0x800+).
    'company:search': '01900000-0000-7000-8000-00000000009d',
    'requisition:search': '01900000-0000-7000-8000-00000000009e',
    'contact:search': '01900000-0000-7000-8000-00000000009f',
    // Tasks backend — 2 scopes (the actionable/assignable to-do; the last
    // core recruiter surface). Next free ids after the 0x9f search range:
    // 0xa0 / 0xa1. Granted via TASK_SEED_BUNDLES (the 9 activity:create
    // operational roles; range 0x81c+, append-don't-renumber).
    'task:read': '01900000-0000-7000-8000-0000000000a0',
    'task:write': '01900000-0000-7000-8000-0000000000a1',
    // Company-Fields v1.1 — the Company COMMERCIAL field-gate scope. Next
    // free id after the 0xa1 task range: 0xa2. Granted via
    // COMMERCIAL_SEED_BUNDLES (tenant_admin + tenant_owner + account_manager;
    // RoleScope range 0x830+, append-don't-renumber).
    'company:read_commercial': '01900000-0000-7000-8000-0000000000a2',
    // Job-Module (LB-4) — 2 requisition:*:financials scopes. Next clear
    // hex after 0xa2 (append-don't-renumber). Granted via
    // FINANCIALS_SEED_BUNDLES (agency tier; mirrors company:read_commercial).
    'requisition:view:financials': '01900000-0000-7000-8000-0000000000a3',
    'requisition:edit:financials': '01900000-0000-7000-8000-0000000000a4',
    // PR-A1 Requisition-Gating Rework — 3 new requisition-gating scopes.
    // Next free ids after the 0xa4 financials range (append-don't-renumber):
    // 0xa5 / 0xa6 / 0xa7. edit:status granted to delivery_manager;
    // profile:generate + profile:edit granted to the 5-role mgmt tier via
    // REQ_GATING_SEED_BUNDLES (RoleScope range 0x839+, append-don't-renumber).
    'requisition:edit:status': '01900000-0000-7000-8000-0000000000a5',
    'requisition:profile:generate': '01900000-0000-7000-8000-0000000000a6',
    'requisition:profile:edit': '01900000-0000-7000-8000-0000000000a7',
    // Settings Rebuild D1 — the 2 read scopes that unlock the settings
    // Import + Export LIVE sections. Both were referenced by their
    // controllers (libs/import, libs/export) but NEVER seeded — every JWT
    // 403'd on /v1/imports and /v1/exports (the substrate-audit gap-and-
    // note: HK-IMPORT-SCOPES + export:read). Next free ids after the 0xa7
    // req-gating range (append-don't-renumber): 0xa8 / 0xa9. Granted via
    // IMPORT_EXPORT_SEED_BUNDLES (RoleScope range 0x900+).
    'import:read': '01900000-0000-7000-8000-0000000000a8',
    'export:read': '01900000-0000-7000-8000-0000000000a9',
    // Settings Rebuild D2 — the audit-log READ scope. The write trail
    // (IdentityAuditEvent, 26 event types) has emitted for many PRs; this
    // scope unlocks GET /v1/tenant/audit-events. Next free id after the 0xa9
    // export range (append-don't-renumber): 0xaa. Granted via
    // AUDIT_READ_SEED_BUNDLES (admin/compliance tier; RoleScope range 0x910+).
    'audit:read': '01900000-0000-7000-8000-0000000000aa',
    // Settings Rebuild D3 — the tenant-profile admin scope. DEDICATED (not the
    // settings scope) by Lead ruling: tenant profile is org-legal-identity
    // (legal name, tax/registration IDs) — a distinct capability from app
    // config, kept separable forever (no future migration) and giving the D2
    // audit log a clean per-scope authorization story. Next free id after the
    // 0xaa audit range (append-don't-renumber): 0xab. Granted via
    // PROFILE_ADMIN_SEED_BUNDLES (tenant_admin + tenant_owner; RoleScope 0x920+).
    'tenant:admin:profile': '01900000-0000-7000-8000-0000000000ab',
    // Settings Rebuild D4 — the sites/branches admin scope. DEDICATED (Lead
    // ruling): sites/branches are org STRUCTURE — a distinct admin capability
    // from config (settings) and legal identity (profile), kept separable so
    // the admin taxonomy stays coherent and the capability is separable later.
    // Next free id after the 0xab profile scope (append-don't-renumber): 0xac.
    // Granted via SITES_ADMIN_SEED_BUNDLES (tenant_admin + tenant_owner;
    // RoleScope 0x930+).
    'tenant:admin:sites': '01900000-0000-7000-8000-0000000000ac',
    // §5 Auth-Hardening D4 — the recruiter-tier MINIMAL assignable-roster read
    // scope (GET /v1/tenant/users/assignable). The users analogue of
    // company:read for the assign pickers; the recruiter-facing counterpart to
    // the admin tenant:admin:user-manage roster. Next free id after the 0xac
    // sites scope (append-don't-renumber): 0xad. Granted via
    // ASSIGNABLE_USERS_SEED_BUNDLES (the 9 work-assigning operational roles;
    // RoleScope 0x940+).
    'tenant:user:read:assignable': '01900000-0000-7000-8000-0000000000ad',
    // §5 Auth-Hardening D4b — the name-resolver directory read scope (GET
    // /v1/tenant/users/directory). id→display_name for ALL tenant users incl.
    // inactive (historical integrity); distinct from the active-only assignable
    // picker scope. Next free id after the 0xad assignable scope (append-don't-
    // renumber): 0xae. Granted via DIRECTORY_SEED_BUNDLES (the 10 list-view
    // viewers; RoleScope 0x950+).
    'tenant:user:read:directory': '01900000-0000-7000-8000-0000000000ae',
    // Domain-Enforcement P2b — the DNS-TXT domain-verification admin scope
    // (GET/POST /v1/tenant/domain-verification + /check). DEDICATED (kept
    // distinct from settings/profile/sites so the admin taxonomy stays
    // coherent). Next free id after the 0xae directory scope (append-don't-
    // renumber): 0xaf. Granted via DOMAIN_ADMIN_SEED_BUNDLES (tenant_admin +
    // tenant_owner; RoleScope 0x960+).
    'tenant:admin:domain': '01900000-0000-7000-8000-0000000000af',
    // TR-2a-3 — identity:resolve (privileged same-human advisory merge). Next
    // free scope id after 0xaf domain (append-don't-renumber): 0xb0. Granted via
    // IDENTITY_RESOLVE_SEED_BUNDLES (tenant_admin + tenant_owner; RoleScope 0x970+).
    'identity:resolve': '01900000-0000-7000-8000-0000000000b0',
    // D3b — Charter §4 Amendment activity redaction. Next clear scope-id after
    // the 0xb0..0xb4 / 0xf0 run (append-don't-renumber): 0xc0.
    'activity:redact': '01900000-0000-7000-8000-0000000000c0',
    // Track 3 / E2 (Pre-Start Requirement) — SEVEN scopes (v1.2.1). Append after
    // 0xc0 (append-don't-renumber): 0xc1..0xc7.
    'pre_start_requirement:read': '01900000-0000-7000-8000-0000000000c1',
    'pre_start_requirement:act': '01900000-0000-7000-8000-0000000000c2',
    'pre_start_requirement:configure': '01900000-0000-7000-8000-0000000000c3',
    'pre_start_requirement:publish': '01900000-0000-7000-8000-0000000000c4',
    'pre_start_requirement:waive_advisory': '01900000-0000-7000-8000-0000000000c5',
    'pre_start_requirement:waive_blocking': '01900000-0000-7000-8000-0000000000c6',
    'pre_start_requirement:read_restricted_evidence': '01900000-0000-7000-8000-0000000000c7',
    'pre_start_requirement:reopen': '01900000-0000-7000-8000-0000000000c8',
    'placement:read': '01900000-0000-7000-8000-0000000000c9',
    'placement:create': '01900000-0000-7000-8000-0000000000ca',
    'placement:transition': '01900000-0000-7000-8000-0000000000cb',
    'placement:activate': '01900000-0000-7000-8000-0000000000cc',
    'placement:terminate': '01900000-0000-7000-8000-0000000000cd',
    'placement:replace': '01900000-0000-7000-8000-0000000000ce',
    // Track 7 / T7-P1 — PermanentPlacement guarantee authority family (next free
    // ids d7/d8; ce consumed by placement:replace, cf-d6 by T4/T5/T8 families).
    'placement:permanent:read': '01900000-0000-7000-8000-0000000000d7',
    'placement:permanent:transition': '01900000-0000-7000-8000-0000000000d8',
    // Track 7 / T7-P2 — the remedy-resolution scope (next free id d9).
    'placement:remedy:resolve': '01900000-0000-7000-8000-0000000000d9',
    // Track 7 / T7-P3 — the guarantee-terms management scope (next free id da).
    'placement:permanent:terms:write': '01900000-0000-7000-8000-0000000000da',
    // Track 4 / T4-D — ContractAssignment authority family.
    'assignment:read': '01900000-0000-7000-8000-0000000000cf',
    'assignment:create': '01900000-0000-7000-8000-0000000000d0',
    'assignment:update': '01900000-0000-7000-8000-0000000000d1',
    'assignment:end': '01900000-0000-7000-8000-0000000000d2',
    // Slice #3 — Assignment Extension: prolong the planned end. SEPARATE authority
    // from assignment:end (opposite powers). AM + admins only.
    'assignment:extend': '01900000-0000-7000-8000-0000000000e1',
    // Track 5 / T5-P1 — assignment commercial-terms authority family.
    'assignment:commercials:read': '01900000-0000-7000-8000-0000000000d3',
    'assignment:commercials:write': '01900000-0000-7000-8000-0000000000d4',
    // Slice #4 — Commercial Approval: exercise commercial AUTHORITY over a
    // proposed revision (margin-approve / client-approve / apply / reject).
    // SEPARATE from commercials:write (propose != approve; SoD). Fresh out-of-
    // family id e2 (append-don't-renumber; e1 = extend, d3/d4 = read/write).
    'assignment:commercials:approve': '01900000-0000-7000-8000-0000000000e2',
    // Track 8 / T8-P2 — canonical requisition ingestion scope family (d5/d6;
    // d3/d4 consumed by T5-P1 assignment:commercials during R-SYNC).
    'requisition:import:read': '01900000-0000-7000-8000-0000000000d5',
    'requisition:import:write': '01900000-0000-7000-8000-0000000000d6',
    // Track 8 / T8-CONNECTOR-A — connector-connection management scope family
    // (da/db; d7/d8/d9 consumed by T7-P1/P2 placement:permanent/remedy).
    // Administration of Settings → Integrations connections.
    // R-SYNC: da/db taken by T7-P3 placement:permanent:terms:write on main;
    // moved to dc/dd (mechanical id reconciliation; grants unchanged).
    'integration:read': '01900000-0000-7000-8000-0000000000dc',
    'integration:write': '01900000-0000-7000-8000-0000000000dd',
    // L2-I (D1) — manage the Pipeline provider-disposition mapping contract (next free 0xf6).
    'integration:pipeline-mapping:write': '01900000-0000-7000-8000-0000000000f6',
    // Requisition Approval sub-workflow — lowest-free suffix 0xdb (df+ free).
    'requisition:approve': '01900000-0000-7000-8000-0000000000db',
    // Offer Lifecycle — suffixes 0xdf, 0xe0; L4/P5 offer:read + offer:read:financial 0xf7, 0xf8.
    'offer:create': '01900000-0000-7000-8000-0000000000df',
    'offer:transition': '01900000-0000-7000-8000-0000000000e0',
    'offer:read': '01900000-0000-7000-8000-0000000000f7',
    'offer:read:financial': '01900000-0000-7000-8000-0000000000f8',
    // Requisition Lane 1-A (Create-Governance) — next-free suffix 0xe3
    // (0xdd/0xe1/0xe2 are taken by integration:write / assignment:extend /
    // assignment:commercials:approve; 0xde freed by the HYG-1 submittal-policy:write
    // removal; highest previously used was 0xe2). CATALOG-ONLY — NO RoleScope grant.
    'requisition:create:establish': '01900000-0000-7000-8000-0000000000e3',
    // COMM-B2 (Aramo-COMM-V1) — operational Communications/Voice scopes.
    'communication:read': '01900000-0000-7000-8000-0000000000e4',
    'communication:voice:call': '01900000-0000-7000-8000-0000000000e5',
    'communication:disposition:write': '01900000-0000-7000-8000-0000000000e6',
    'communication:notes:write': '01900000-0000-7000-8000-0000000000e7',
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
    // Portal P3a — 3 candidate grants (reuse the freed viewer ids 0x13a-0x13c).
    candidate_portal_verification_read: '01900000-0000-7000-8000-00000000013a',
    candidate_portal_dispute_read: '01900000-0000-7000-8000-00000000013b',
    candidate_portal_dispute_write: '01900000-0000-7000-8000-00000000013c',
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
    // recruiter gets 18 (Ruling 1: NO :delete, NO :read:all).
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
    super_admin_platform_tenant_lifecycle_manage: '01900000-0000-7000-8000-000000000307',
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
    // Promotion-Trigger slice-A — talent:source (fresh 0x2e0 slot, above the
    // current audit-event max 0x242).
    scope_talent_source_created: '01900000-0000-7000-8000-0000000002e0',
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
    scope_platform_tenant_lifecycle_manage_created: '01900000-0000-7000-8000-0000000002f0',
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

// Track 8 / T8-CONNECTOR-A — the connector execution ServiceAccount identity.
export const CONNECTOR_SERVICE_ACCOUNT_NAME = 'connector-execution';
export const CONNECTOR_SERVICE_ACCOUNT_DESCRIPTION =
  'Machine actor for provider-neutral connector execution (T8-CONNECTOR-A). Holds no connector-management scopes; imports run with requisition:import:write only.';

// Per-role scope assignments (directive §6 + §9 test 17, locked).
export const ROLE_SCOPE_ASSIGNMENTS = {
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
    // complete set incl. all :delete + tenant:admin:*.
    'talent:read', 'talent:create', 'talent:edit', 'talent:delete', 'talent:search',
    'company:read', 'company:create', 'company:edit', 'company:delete',
    'contact:read', 'contact:create', 'contact:edit', 'contact:delete',
    'pipeline:add', 'pipeline:change-status',
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
    // operational workflow but NO destructive (`*:delete`) and NO
    // see-all (`*:read:all`). Recruiter keeps
    // all :create/:edit + talent:search + pipeline:add/change-status/
    // add-activity + calendar:event-create/edit + activity:read +
    // examination:read + assigned reads.
    'talent:read', 'talent:create', 'talent:edit', 'talent:search',
    'company:read', 'company:create', 'company:edit',
    'contact:read', 'contact:create', 'contact:edit',
    'pipeline:add', 'pipeline:change-status',
    'calendar:event-create', 'calendar:event-edit',
    'activity:read', 'examination:read',
    // PR-A1 Requisition-Gating Rework — recruiter is now READ-ONLY on
    // requisitions: requisition:edit REMOVED (the recruiter:requisition:edit
    // hardcoded RoleScope id 0x139 is freed). Recruiter KEEPS requisition:read
    // + requisition:create (create is untouched by the directive). Combined
    // with the D5 delta below (compensation:edit:pay removed; compensation:
    // view:pay kept; NO compensation:view:bill), the recruiter sees pay but
    // not bill and cannot PATCH (the PATCH path's in-service status-edit-gate
    // rejects 403 — recruiter holds neither requisition:edit nor
    // requisition:edit:status).
    'requisition:create',
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
    // Portal P3a — verification view + dispute rights.
    'portal:verification:read',
    'portal:dispute:read',
    'portal:dispute:write',
  ],
  // AUTHZ-2 — platform-tier super_admin role bundle. The 3 platform:*
  // scopes; NO tenant scopes. The DDR §13.1 tripwire (a platform token
  // never satisfies a tenant guard) is enforced by namespace partition.
  super_admin: [
    'platform:tenant:provision',
    'platform:tenant:read',
    'platform:admin:invite',
    'platform:tenant:lifecycle:manage',
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
  'candidate:portal:verification:read': SEED_IDS.role_scopes.candidate_portal_verification_read,
  'candidate:portal:dispute:read': SEED_IDS.role_scopes.candidate_portal_dispute_read,
  'candidate:portal:dispute:write': SEED_IDS.role_scopes.candidate_portal_dispute_write,
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
  // recruiter: 18 (NO :delete, NO :read:all)
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
  'recruiter:calendar:event-create': SEED_IDS.role_scopes.recruiter_calendar_event_create,
  'recruiter:calendar:event-edit': SEED_IDS.role_scopes.recruiter_calendar_event_edit,
  'recruiter:activity:read': SEED_IDS.role_scopes.recruiter_activity_read,
  'recruiter:examination:read': SEED_IDS.role_scopes.recruiter_examination_read,
  'recruiter:requisition:create': SEED_IDS.role_scopes.recruiter_requisition_create,
  // PR-A1 Requisition-Gating Rework: recruiter:requisition:edit RETIRED
  // (recruiter is now read-only on requisitions). RoleScope id 0x139
  // (SEED_IDS.role_scopes.recruiter_requisition_edit) is freed — the entry
  // is removed here so the seed no longer creates the grant on a fresh DB.
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
  'super_admin:platform:tenant:lifecycle:manage':
    SEED_IDS.role_scopes.super_admin_platform_tenant_lifecycle_manage,
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
export const AUTHZ1_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
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
    'pipeline:add', 'pipeline:change-status',
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
    'pipeline:add', 'pipeline:change-status',
    'calendar:event-create', 'calendar:event-edit',
    'activity:read', 'examination:read',
    'requisition:create', 'requisition:edit',
    'attachment:read', 'attachment:create', 'attachment:delete',
    'pipeline:read', 'activity:create',
    'tenant:admin:user-manage', 'requisition:assign',
    // AUTHZ-D4a — AM is the demand-side / client-ownership anchor.
    'company:assign', 'team:manage',
  ]],
  // sourcer — 15 scopes (intake-focused; NO :delete, NO submittal). Promotion-
  // Trigger slice-A adds talent:source (the sourcer's promote-from-pool capability).
  ['sourcer', [
    'auth:session:read',
    'talent:read', 'talent:create', 'talent:search', 'talent:source',
    'company:read', 'contact:read', 'contact:create',
    'requisition:read',
    'pipeline:read', 'pipeline:add', 'pipeline:change-status',
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
    'pipeline:add', 'pipeline:change-status',
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
    'pipeline:add', 'pipeline:change-status',
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
  // PR-A1 Requisition-Gating Rework: recruiter is now READ-ONLY —
  // compensation:edit:pay REMOVED (recruiter keeps compensation:view:pay
  // so the read field-mask is UNCHANGED: recruiter still sees pay/salary,
  // still NO bill). This is a REMOVAL from the recruiter D5 entry only — no
  // new D5 row is created, so the positional 0x500 id range stays
  // collision-free on re-seed (the recruiter:edit:pay row is simply not
  // re-created on a fresh DB; an existing deployment's row is dropped by
  // the PO's authz-rework re-seed, per the directive carve-out).
  // recruiting_manager / lead_recruiter ADDITIONALLY gain compensation:
  // view:bill via REQ_GATING_SEED_BUNDLES (kept OUT of this bundle to
  // preserve the 0x500 append-don't-renumber range; the d5-non-invertibility
  // proof walks D5 ∪ REQ_GATING_SEED_BUNDLES).
  ['recruiter', ['compensation:view:pay']],
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
// the same UUID on every seed run.
// Total rows (post D-AUTHZ-COMP-WRITE-1 edit scopes + Settings S4
// auditor_with_financials): TA 8 + TO 8 + AM 5 + recruiter 1 + RM 2 +
// LR 2 + back_office 2 + DM 4 + finance 2 + auditor_with_financials 6 = 40.
// PR-A1 Requisition-Gating Rework dropped recruiter 2→1 (compensation:edit:pay
// removed) — a REMOVAL only, no new D5 row, so the 0x500 range is unshifted
// on re-seed (the new comp grant — RM/LR/DM compensation:view:bill — lives in
// REQ_GATING_SEED_BUNDLES at 0x839+, NOT here).
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

// R7 BE-prereq — selection-domain role-scope bundle (Amendment v1.1 §2
// Ruling 2: 8-role grant set, 20 RoleScope rows). Write-tier 6 roles get
// :read + :write + :outreach; read-only 2 roles (delivery_manager / back_office)
// get :read only. The 6 excluded roles (sourcer / finance / auditor /
// auditor_with_financials / candidate / super_admin) hold zero selection
// scopes — they 403 on every selection route.
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
//     + activity:read etc.) — they SEE selection workflow state but neither
//     drive it nor send outreach.
const SELECTION_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['selection:read', 'selection:write', 'selection:outreach']],
  ['tenant_admin', ['selection:read', 'selection:write', 'selection:outreach']],
  ['account_manager', ['selection:read', 'selection:write', 'selection:outreach']],
  ['recruiting_manager', ['selection:read', 'selection:write', 'selection:outreach']],
  ['recruiter', ['selection:read', 'selection:write', 'selection:outreach']],
  ['lead_recruiter', ['selection:read', 'selection:write', 'selection:outreach']],
  ['delivery_manager', ['selection:read']],
  ['back_office', ['selection:read']],
];

// R7 BE-prereq — deterministic RoleScope row IDs for the 20 selection-
// bundle grants above. Disjoint range starting at 0x700 (AUTHZ-1's 0x400+,
// AUTHZ-D5's 0x500+, Reporting's 0x600+ all stay untouched — append-don't-
// renumber per Amendment v1.1 §2). The (role, scope) iteration order in
// SELECTION_SEED_BUNDLES pins the assignment, so a given pair always
// produces the same UUID on every seed run. DO NOT REORDER without
// bumping the offset to a fresh range.
const SELECTION_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x700;
  for (const [role, scopes] of SELECTION_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Search PR-1 — per-entity quick-search role-scope bundle (Lead rulings
// R1/R2). Grants the 3 NEW search scopes (company:search / requisition:search
// / contact:search) following PER-ENTITY :read-HOLDER PARITY: each search
// scope goes to exactly the roles that hold that entity's :read scope (the
// Reporting-Scope-Seed derivation rule — grant the new capability to the
// holders of the adjacent existing one). The entity's existing visibility
// predicate still governs WHAT each role SEES once through the gate; the
// seed grants ACCESS.
//
// talent:search is NOT in this bundle — it is REUSED as-is (already granted
// to its 7 A1a-bundle holders). Its grant set stays the deliberately-narrow
// "Constrained Talent Access" set from the A1a audit (delivery_manager /
// back_office / finance can talent:read a handed record but do NOT search
// the pool). Reconciling R1 ("reuse talent:search") with R2 ("read-parity"):
// reuse is honored literally; read-parity applies to the 3 NEW scopes —
// expanding the deliberately-constrained talent:search is out of scope for
// an additive search PR (flagged in the post-merge record for the Lead).
//
// :read-holder sets (from ROLE_SCOPE_ASSIGNMENTS + AUTHZ1_BUNDLES above):
//   company:read     — TA, recruiter, TO, AM, sourcer, RM, DM, LR, BO        (9)
//   contact:read     — same 9 as company:read                                 (9)
//   requisition:read — the 9 above + finance                                  (10)
// auditor / auditor_with_financials / candidate / super_admin hold none of
// the three :read scopes → hold no :search scope → 403 on any ?q=.
//
// Iteration order pins the deterministic 0x800+ RoleScope row ids — DO NOT
// REORDER without bumping the offset to a fresh range.
const SEARCH_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['company:search', 'requisition:search', 'contact:search']],
  ['tenant_admin', ['company:search', 'requisition:search', 'contact:search']],
  ['account_manager', ['company:search', 'requisition:search', 'contact:search']],
  ['recruiting_manager', ['company:search', 'requisition:search', 'contact:search']],
  ['recruiter', ['company:search', 'requisition:search', 'contact:search']],
  ['lead_recruiter', ['company:search', 'requisition:search', 'contact:search']],
  ['back_office', ['company:search', 'requisition:search', 'contact:search']],
  ['delivery_manager', ['company:search', 'requisition:search', 'contact:search']],
  ['sourcer', ['company:search', 'requisition:search', 'contact:search']],
  ['finance', ['requisition:search']],
];

// Search PR-1 — deterministic RoleScope row ids for the 28 search-bundle
// grants (9 roles × 3 + finance × 1). Disjoint range starting at 0x800
// (AUTHZ-1 0x400+, D5 0x500+, Reporting 0x600+, Selection 0x700+ all stay
// untouched — append-don't-renumber). The (role, scope) iteration order in
// SEARCH_SEED_BUNDLES pins the assignment, so a given pair always produces
// the same UUID on every seed run.
const SEARCH_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x800;
  for (const [role, scopes] of SEARCH_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Tasks backend — RoleScope grants. task:read + task:write to the 9
// OPERATIONAL roles (the activity:create holders — the tier that creates
// follow-ups). auditor / auditor_with_financials / finance (activity:read but
// NOT create) are excluded from v1; read can widen later. candidate /
// super_admin hold neither. 9 roles × 2 scopes = 18 rows.
const TASK_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['task:read', 'task:write']],
  ['tenant_admin', ['task:read', 'task:write']],
  ['account_manager', ['task:read', 'task:write']],
  ['recruiting_manager', ['task:read', 'task:write']],
  ['recruiter', ['task:read', 'task:write']],
  ['lead_recruiter', ['task:read', 'task:write']],
  ['back_office', ['task:read', 'task:write']],
  ['delivery_manager', ['task:read', 'task:write']],
  ['sourcer', ['task:read', 'task:write']],
];

// Deterministic RoleScope row ids for the 18 task-bundle grants. Disjoint
// range starting at 0x81c (the next free after Search PR-1's 0x800..0x81b;
// AUTHZ-1 0x400+, D5 0x500+, Reporting 0x600+, Selection 0x700+, Search
// 0x800+ all stay untouched — append-don't-renumber). The (role, scope)
// iteration order pins the assignment.
const TASK_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x81c;
  for (const [role, scopes] of TASK_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Company-Fields v1.1 — company:read_commercial grant bundle. The agency-
// economics tier ONLY (Amendment v1.1 F3): tenant_admin + tenant_owner +
// account_manager. NOT base recruiter, NOT the delivery tier
// (recruiting_manager / lead_recruiter / delivery_manager) — margin
// visibility there would be scope creep (the seed.spec grant-table proof
// asserts the 3 present + those absent).
const COMMERCIAL_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_admin', ['company:read_commercial']],
  ['tenant_owner', ['company:read_commercial']],
  ['account_manager', ['company:read_commercial']],
];

// Deterministic RoleScope row ids for the 3 commercial grants. Disjoint
// range 0x830+ (the next clear range after Tasks' 0x81c..0x82d; all prior
// ranges untouched — append-don't-renumber).
const COMMERCIAL_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x830;
  for (const [role, scopes] of COMMERCIAL_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Job-Module (LB-4) — requisition:*:financials grant bundle. The SAME
// agency-economics tier as company:read_commercial (tenant_admin +
// tenant_owner + account_manager). NOT base recruiter, NOT the delivery
// tier — financial-planning visibility there would be scope creep (the
// seed.spec grant-table proof asserts the 3 present + base/delivery
// absent). Each role gets BOTH the view (read-mask) and edit (write-gate)
// financial scope.
export const FINANCIALS_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_admin', ['requisition:view:financials', 'requisition:edit:financials']],
  ['tenant_owner', ['requisition:view:financials', 'requisition:edit:financials']],
  ['account_manager', ['requisition:view:financials', 'requisition:edit:financials']],
];

// Deterministic RoleScope row ids for the 6 financials grants. Disjoint
// range 0x833+ (the next clear range after Commercial's 0x830..0x832; all
// prior ranges untouched — append-don't-renumber).
const FINANCIALS_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x833;
  for (const [role, scopes] of FINANCIALS_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// PR-A1 Requisition-Gating Rework — the consolidated grant DELTA bundle.
// Carries every NET-NEW (role, scope) grant of the rework in ONE additive
// bundle with a disjoint RoleScope id range (0x839+, append-don't-renumber —
// the prior ranges, incl. D5's 0x500 and Financials' 0x833, stay untouched).
// Keeping the additions HERE (rather than editing D5 / Financials inline)
// preserves every existing positional id, so a prod re-seed creates only the
// genuinely-new rows below and never collides on an id already held by a
// different (role, scope).
//
// The matrix (Directive v1.0 §2 as amended by v1.1, Option C for DM):
//   - profile:generate + profile:edit → the 5-role management tier
//     (TA + TO + AM + recruiting_manager + lead_recruiter). Base recruiter
//     does NOT hold them (it lost requisition:edit and gains nothing here).
//   - recruiting_manager / lead_recruiter ADD compensation:view:bill (they
//     already hold view:pay + edit:pay via D5; view:bill is NOT a spread
//     scope, so the D5 non-invertibility invariant still holds — proven in
//     d5-non-invertibility.spec by walking D5 ∪ this bundle).
//   - delivery_manager (status-only editor): requisition:edit:status (the
//     net-new restrict-to-subset scope) + compensation:view:bill +
//     requisition:view:financials. DM does NOT get compensation:view:pay
//     (Amendment v1.1: pay + DM's existing spread scopes would break the D5
//     invariant) and does NOT get requisition:edit / :edit:financials.
export const REQ_GATING_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_admin', ['requisition:profile:generate', 'requisition:profile:edit']],
  ['tenant_owner', ['requisition:profile:generate', 'requisition:profile:edit']],
  ['account_manager', ['requisition:profile:generate', 'requisition:profile:edit']],
  ['recruiting_manager', ['compensation:view:bill', 'requisition:profile:generate', 'requisition:profile:edit']],
  ['lead_recruiter', ['compensation:view:bill', 'requisition:profile:generate', 'requisition:profile:edit']],
  ['delivery_manager', ['requisition:edit:status', 'compensation:view:bill', 'requisition:view:financials']],
  // PR-A1 grant amend (Lead-authorized, pre-push) — ADD requisition:edit:status
  // to the 3 roles that ALREADY hold requisition:edit (recruiting_manager /
  // lead_recruiter / account_manager). EXPLICIT, not new power: they could
  // already edit status via the full-edit path. The status-only restrict-to-
  // subset gate is UNCHANGED — it only restricts a holder of edit:status
  // WITHOUT requisition:edit (= delivery_manager only); these 3 hold BOTH, so
  // the restrict branch never applies and delivery_manager remains the ONLY
  // status-only role. Appended as SEPARATE tuples so the existing 0x839..0x847
  // ids do not renumber (these take 0x848..0x84a); the write loop upserts by
  // (role, scope), so a role appearing twice is harmless.
  ['recruiting_manager', ['requisition:edit:status']],
  ['lead_recruiter', ['requisition:edit:status']],
  ['account_manager', ['requisition:edit:status']],
];

// Deterministic RoleScope row ids for the 18 PR-A1 grants. Disjoint range
// 0x839+ (the next clear id after Financials' 0x833..0x838; all prior ranges
// untouched — append-don't-renumber). 18 rows: TA 2 + TO 2 + AM 2 + RM 3 +
// LR 3 + DM 3 (0x839..0x847) + the edit:status grant amend RM/LR/AM
// (0x848..0x84a).
const REQ_GATING_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x839;
  for (const [role, scopes] of REQ_GATING_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Settings Rebuild D1 — Import/Export read-scope bundle. Closes the
// substrate-audit gap-and-note (import:read + export:read referenced by
// their controllers but never seeded → the settings Import + Export LIVE
// sections would 403 for every JWT). Two tiers, mirroring the controllers'
// documented tiering:
//   - import:read → the 8-role OPERATIONAL tier (recruiter+; identical set
//     to REPORTING_SEED_BUNDLES). Every recruiter can audit imports in
//     their tenant (the import history is not sensitive; RequireSiteMatch
//     + visibility still govern WHAT each row shows).
//   - export:read → tenant_admin + tenant_owner ONLY. The settings Export
//     surface is admin-gated; the A3/D4b predicate governs WHAT each role
//     exports. (The export controller documents recruiter+ AND tenant_admin
//     as eligible; this D1 grant seeds only the admin tier the settings
//     surface needs — a later increment may widen it.)
// 10 RoleScope rows: import:read × 8 + export:read × 2.
export const IMPORT_EXPORT_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['import:read', 'export:read']],
  ['tenant_admin', ['import:read', 'export:read']],
  ['account_manager', ['import:read']],
  ['recruiting_manager', ['import:read']],
  ['recruiter', ['import:read']],
  ['lead_recruiter', ['import:read']],
  ['back_office', ['import:read']],
  ['delivery_manager', ['import:read']],
];

// Deterministic RoleScope row ids for the 10 Import/Export grants. Disjoint
// range 0x900+ (the next clear range after REQ_GATING's 0x839..0x84a; all
// prior ranges untouched — append-don't-renumber). The (role, scope)
// iteration order pins the assignment, so a given pair always produces the
// same UUID on every seed run. DO NOT REORDER without bumping the offset.
const IMPORT_EXPORT_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x900;
  for (const [role, scopes] of IMPORT_EXPORT_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Settings Rebuild D2 — audit-log READ scope bundle. audit:read is an
// admin/compliance surface: granted to tenant_admin + tenant_owner ONLY (a
// recruiter does not read the tenant audit log). 2 RoleScope rows.
export const AUDIT_READ_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['audit:read']],
  ['tenant_admin', ['audit:read']],
];

// Deterministic RoleScope row ids for the 2 audit:read grants. Disjoint range
// 0x910+ (the next clear range after IMPORT_EXPORT's 0x900..0x909; all prior
// ranges untouched — append-don't-renumber).
const AUDIT_READ_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x910;
  for (const [role, scopes] of AUDIT_READ_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Settings Rebuild D3 — tenant-profile admin scope bundle. DEDICATED scope
// (Lead ruling): tenant:admin:profile → tenant_admin + tenant_owner ONLY (the
// same tier as settings/audit; NOT recruiters). 2 RoleScope rows.
export const PROFILE_ADMIN_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['tenant:admin:profile']],
  ['tenant_admin', ['tenant:admin:profile']],
];

// Deterministic RoleScope row ids for the 2 tenant:admin:profile grants.
// Disjoint range 0x920+ (the next clear range after AUDIT_READ's 0x910..0x911;
// all prior ranges untouched — append-don't-renumber).
const PROFILE_ADMIN_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x920;
  for (const [role, scopes] of PROFILE_ADMIN_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Settings Rebuild D4 — sites/branches admin scope bundle. DEDICATED scope
// (Lead ruling): tenant:admin:sites → tenant_admin + tenant_owner ONLY (the
// same admin tier as settings/audit/profile; NOT recruiters). 2 RoleScope rows.
export const SITES_ADMIN_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['tenant:admin:sites']],
  ['tenant_admin', ['tenant:admin:sites']],
];

// Deterministic RoleScope row ids for the 2 tenant:admin:sites grants.
// Disjoint range 0x930+ (the next clear range after PROFILE_ADMIN's
// 0x920..0x921; all prior ranges untouched — append-don't-renumber).
const SITES_ADMIN_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x930;
  for (const [role, scopes] of SITES_ADMIN_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// §5 Auth-Hardening D4 — tenant:user:read:assignable grant bundle. The 9
// WORK-ASSIGNING operational roles (identical to TASK_SEED_BUNDLES' grant set —
// the tier that creates/assigns follow-ups + assignments). These exactly cover
// every holder of the assignment scopes the pickers run under (company:assign =
// AM/TA/TO; requisition:assign = TA; org:manage = RM/TA/TO; team:manage =
// AM/TA/TO; task:write = all 9) — so every assign-a-teammate picker resolves a
// real roster, no 403. auditor / auditor_with_financials / finance (read-only,
// non-assigning) + candidate + super_admin are excluded. 9 roles × 1 = 9 rows.
export const ASSIGNABLE_USERS_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['tenant:user:read:assignable']],
  ['tenant_admin', ['tenant:user:read:assignable']],
  ['account_manager', ['tenant:user:read:assignable']],
  ['recruiting_manager', ['tenant:user:read:assignable']],
  ['recruiter', ['tenant:user:read:assignable']],
  ['lead_recruiter', ['tenant:user:read:assignable']],
  ['back_office', ['tenant:user:read:assignable']],
  ['delivery_manager', ['tenant:user:read:assignable']],
  ['sourcer', ['tenant:user:read:assignable']],
];

// Deterministic RoleScope row ids for the 9 assignable-roster grants. Disjoint
// range 0x940+ (the next clear range after SITES_ADMIN's 0x930..0x931; all
// prior ranges untouched — append-don't-renumber).
const ASSIGNABLE_USERS_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x940;
  for (const [role, scopes] of ASSIGNABLE_USERS_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// §5 Auth-Hardening D4b — tenant:user:read:directory grant bundle. The 10
// LIST-VIEW VIEWERS who render authorship/ownership/assignee names: the 9
// work-assigning roles (= ASSIGNABLE_USERS_SEED_BUNDLES) PLUS finance, which
// holds requisition:read + talent:read (sees those lists) but is not a
// work-assigning role (so it is NOT in the assignable picker — that is exactly
// why the name-resolver is a distinct scope, not a reuse of assignable).
// auditor/candidate/super_admin do not see the name-rendering lists. 10 × 1 = 10.
export const DIRECTORY_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['tenant:user:read:directory']],
  ['tenant_admin', ['tenant:user:read:directory']],
  ['account_manager', ['tenant:user:read:directory']],
  ['recruiting_manager', ['tenant:user:read:directory']],
  ['recruiter', ['tenant:user:read:directory']],
  ['lead_recruiter', ['tenant:user:read:directory']],
  ['back_office', ['tenant:user:read:directory']],
  ['delivery_manager', ['tenant:user:read:directory']],
  ['sourcer', ['tenant:user:read:directory']],
  ['finance', ['tenant:user:read:directory']],
];

// Deterministic RoleScope row ids for the 10 directory grants. Disjoint range
// 0x950+ (the next clear range after ASSIGNABLE_USERS' 0x940..0x948; all prior
// ranges untouched — append-don't-renumber).
const DIRECTORY_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x950;
  for (const [role, scopes] of DIRECTORY_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Domain-Enforcement P2b — tenant:admin:domain grant bundle. DEDICATED scope:
// tenant:admin:domain → tenant_admin + tenant_owner ONLY (the same admin tier as
// settings/audit/profile/sites; NOT recruiters). 2 RoleScope rows.
export const DOMAIN_ADMIN_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['tenant:admin:domain']],
  ['tenant_admin', ['tenant:admin:domain']],
];

// Deterministic RoleScope row ids for the 2 tenant:admin:domain grants. Disjoint
// range 0x960+ (the next clear range after DIRECTORY's 0x950..0x959; all prior
// ranges untouched — append-don't-renumber).
const DOMAIN_ADMIN_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x960;
  for (const [role, scopes] of DOMAIN_ADMIN_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// TR-2a-3 — identity:resolve grant bundle. DEDICATED scope: identity:resolve →
// tenant_admin + tenant_owner ONLY (the admin tier; NOT recruiters — merging two
// humans is a privileged data-governance act). 2 RoleScope rows. Mirrors the
// tenant:admin:domain bundle exactly.
export const IDENTITY_RESOLVE_SEED_BUNDLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tenant_owner', ['identity:resolve']],
  ['tenant_admin', ['identity:resolve']],
  // Promotion-Trigger slice B-api (PO-ruled) — the sourcer sees AND resolves
  // merge advisories from the sourcing surface, so identity:resolve joins the
  // sourcer bundle. Appended (→ row id 0x972) so tenant_owner/tenant_admin ids
  // (0x970/0x971) do not shift.
  ['sourcer', ['identity:resolve']],
];

// Deterministic RoleScope row ids for the 3 identity:resolve grants. Disjoint
// range 0x970+ (the next clear range after DOMAIN's 0x960..0x961; all prior
// ranges untouched — append-don't-renumber).
const IDENTITY_RESOLVE_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x970;
  for (const [role, scopes] of IDENTITY_RESOLVE_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// D3b — Charter §4 Amendment activity redaction. `activity:redact` granted to
// the oversight tier (PO ruling (b): admin + supervisory). Author-or-scope: any
// author redacts their own note without this scope; the scope is the
// cross-author path for a lead reviewing their pod's feed.
export const ACTIVITY_REDACT_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['tenant_owner', ['activity:redact']],
  ['tenant_admin', ['activity:redact']],
  ['recruiting_manager', ['activity:redact']],
  ['lead_recruiter', ['activity:redact']],
];

// Deterministic RoleScope row ids for the 4 activity:redact grants. Next clear
// range after IDENTITY_RESOLVE's 0x970..0x972 (append-don't-renumber): 0x980+.
const ACTIVITY_REDACT_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x980;
  for (const [role, scopes] of ACTIVITY_REDACT_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Track 3 / E2 (Pre-Start Requirement) — role grants (v1.2.1 §13c). EIGHT
// grant-receiving roles, 23 RoleScope rows. `waive_blocking` and
// `read_restricted_evidence` appear in NO bundle — REGISTERED WITH ZERO GRANTS
// (§13c-1): a blocking waiver and screening-evidence access are granted only by a
// named human decision, never inherited from a bundle.
export const PRE_START_REQUIREMENT_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['recruiter', ['pre_start_requirement:read', 'pre_start_requirement:act']],
  ['sourcer', ['pre_start_requirement:read', 'pre_start_requirement:act']],
  ['lead_recruiter', ['pre_start_requirement:read', 'pre_start_requirement:act']],
  ['account_manager', ['pre_start_requirement:read', 'pre_start_requirement:act', 'pre_start_requirement:waive_advisory']],
  ['recruiting_manager', ['pre_start_requirement:read', 'pre_start_requirement:act', 'pre_start_requirement:waive_advisory']],
  ['delivery_manager', ['pre_start_requirement:read', 'pre_start_requirement:act', 'pre_start_requirement:waive_advisory']],
  ['tenant_admin', ['pre_start_requirement:read', 'pre_start_requirement:act', 'pre_start_requirement:configure', 'pre_start_requirement:publish']],
  ['tenant_owner', ['pre_start_requirement:read', 'pre_start_requirement:act', 'pre_start_requirement:configure', 'pre_start_requirement:publish']],
];

// Deterministic RoleScope row ids for the 23 pre_start_requirement grants. Fresh
// disjoint range after ACTIVITY_REDACT's 0x980..0x983 (append-don't-renumber): 0x990+.
const PRE_START_REQUIREMENT_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x990;
  for (const [role, scopes] of PRE_START_REQUIREMENT_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Track 3 / E1-b (PlacementProcess) — the ratified placement role matrix.
// FOUR grant-receiving roles, 21 RoleScope rows. Placement scopes were
// REGISTERED WITH ZERO GRANTS at E1-b; the #577 matrix granted the first five,
// and Track 3 / E4 adds the sixth, placement:replace.
//   - recruiter: read + create + transition (operational placement work; the
//     ordinary-progression edges). NO activate, NO terminate, NO replace.
//   - account_manager: recruiter's three + activate + terminate + replace.
//     activate asserts a placement has STARTED; terminate covers consequential/
//     terminal outcomes (NO_SHOW/FELL_THROUGH); replace authorizes creating a
//     successor placement against a terminal predecessor (E4 — a conjunction
//     with create, never an alternative creation path). All follow the business
//     meaning, not the (currently capacity-inert) implementation.
//   - tenant_admin: the full six.
//   - tenant_owner: mirrors tenant_admin (Owner = Admin scope set, position-only
//     distinction — the same invariant every scope family upholds). NOT the
//     "SaaS Owner"; the platform/SaaS operator role (super_admin) receives NONE.
// super_admin and every other tenant-operational role receive ZERO placement
// grants (fail-closed; no prose-hierarchy inheritance). recruiting_manager: zero.
export const PLACEMENT_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['recruiter', ['placement:read', 'placement:create', 'placement:transition']],
  ['account_manager', ['placement:read', 'placement:create', 'placement:transition', 'placement:activate', 'placement:terminate', 'placement:replace']],
  ['tenant_admin', ['placement:read', 'placement:create', 'placement:transition', 'placement:activate', 'placement:terminate', 'placement:replace']],
  ['tenant_owner', ['placement:read', 'placement:create', 'placement:transition', 'placement:activate', 'placement:terminate', 'placement:replace']],
];

// Deterministic RoleScope row ids for the 21 placement grants (E4: +3 replace).
// Fresh disjoint range after PRE_START_REQUIREMENT's 0x990..0x9a6
// (append-don't-renumber the earlier families): 0xa00+.
const PLACEMENT_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0xa00;
  for (const [role, scopes] of PLACEMENT_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Track 7 / T7-P1 — the PermanentPlacement guarantee role matrix (§8). Role posture
// MIRRORS the ratified placement AUTHORITATIVE tier (grounded from
// PLACEMENT_SEED_BUNDLES, not invented): placement:permanent:read -> all four
// grant-receiving roles (as placement:read); placement:permanent:transition ->
// account_manager/tenant_admin/tenant_owner only (the tier holding
// placement:activate — authoritative post-start guarantee mutation, and the second
// leg of the PERMANENT STARTED conjunction). recruiter does operational placement
// work but NOT authoritative guarantee mutation. super_admin/recruiting_manager/all
// others: ZERO. Separate bundle + row-id range so PLACEMENT's 0xa00 grants are NOT
// renumbered (append-don't-renumber).
export const PERMANENT_PLACEMENT_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['recruiter', ['placement:permanent:read']],
  ['account_manager', ['placement:permanent:read', 'placement:permanent:transition']],
  ['tenant_admin', ['placement:permanent:read', 'placement:permanent:transition']],
  ['tenant_owner', ['placement:permanent:read', 'placement:permanent:transition']],
];

// Deterministic RoleScope row ids for the 7 permanent-placement grants. Fresh
// disjoint range after REQUISITION_IMPORT's 0xc00 (append-don't-renumber): 0xd00+.
const PERMANENT_PLACEMENT_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0xd00;
  for (const [role, scopes] of PERMANENT_PLACEMENT_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Track 7 / T7-P2 — the remedy-resolution role matrix (§3.6). GRANTED to
// account_manager, tenant_admin, tenant_owner only (recruiter excluded — high-consequence
// evidence-gated completion). Separate bundle + row-id range (0xe00+) so PERMANENT's 0xd00
// grants are NOT renumbered (append-don't-renumber).
export const PERMANENT_REMEDY_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['account_manager', ['placement:remedy:resolve']],
  ['tenant_admin', ['placement:remedy:resolve']],
  ['tenant_owner', ['placement:remedy:resolve']],
];

// Deterministic RoleScope row ids for the 3 remedy grants. Range 0xe00+.
const PERMANENT_REMEDY_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0xe00;
  for (const [role, scopes] of PERMANENT_REMEDY_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Track 7 / T7-P3 — the guarantee-terms management role matrix (§3.7). GRANTED to
// account_manager, tenant_admin, tenant_owner only (recruiter excluded — terms authorship is
// authority-separated; reads use placement:permanent:read). Separate bundle + row-id range
// (0xf00+) so PERMANENT's 0xd00 and REMEDY's 0xe00 grants are NOT renumbered
// (append-don't-renumber).
export const PERMANENT_TERMS_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['account_manager', ['placement:permanent:terms:write']],
  ['tenant_admin', ['placement:permanent:terms:write']],
  ['tenant_owner', ['placement:permanent:terms:write']],
];

// Deterministic RoleScope row ids for the 3 guarantee-terms grants. Range 0xf00+.
const PERMANENT_TERMS_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0xf00;
  for (const [role, scopes] of PERMANENT_TERMS_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Track 4 / T4-D — the ContractAssignment role matrix. Role posture MIRRORS the
// ratified placement AUTHORITATIVE tier (grounded from PLACEMENT_SEED_BUNDLES,
// not invented): assignment:read -> all four grant-receiving roles (as placement:
// read); assignment:create/update/end -> account_manager/tenant_admin/tenant_owner
// only (the tier holding placement:activate/terminate — authoritative post-start
// commitment mutation). recruiter does operational placement work but NOT
// authoritative assignment mutation. super_admin/recruiting_manager/all others: ZERO.
export const ASSIGNMENT_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['recruiter', ['assignment:read']],
  ['account_manager', ['assignment:read', 'assignment:create', 'assignment:update', 'assignment:end', 'assignment:commercials:read', 'assignment:commercials:write']],
  ['tenant_admin', ['assignment:read', 'assignment:create', 'assignment:update', 'assignment:end', 'assignment:commercials:read', 'assignment:commercials:write']],
  ['tenant_owner', ['assignment:read', 'assignment:create', 'assignment:update', 'assignment:end', 'assignment:commercials:read', 'assignment:commercials:write']],
  // Slice #3 — assignment:extend appended LAST (append-don't-renumber): the positional
  // 0xb00+ id generator gives these fresh trailing ids WITHOUT shifting the existing
  // 0xb00..0xb12 grants, so a prod re-seed collides with nothing.
  ['account_manager', ['assignment:extend']],
  ['tenant_admin', ['assignment:extend']],
  ['tenant_owner', ['assignment:extend']],
  // Slice #4 — assignment:commercials:approve appended LAST (append-don't-renumber):
  // the positional 0xb00+ id generator gives these fresh trailing ids (0xb16..0xb18)
  // WITHOUT shifting the existing 0xb00..0xb15 grants, so a prod re-seed collides
  // with nothing (the #683 assignment:extend precedent).
  ['account_manager', ['assignment:commercials:approve']],
  ['tenant_admin', ['assignment:commercials:approve']],
  ['tenant_owner', ['assignment:commercials:approve']],
];

// Deterministic RoleScope row ids for the 19 assignment grants (13 Track-4 +
// 6 Track-5 commercials read/write on account_manager/tenant_admin/tenant_owner).
// Fresh disjoint range 0xb00+ (append-don't-renumber; placement occupies
// 0xa00..0xa14). The generator iterates ASSIGNMENT_SEED_BUNDLES so the new grants
// extend the map automatically.
const ASSIGNMENT_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0xb00;
  for (const [role, scopes] of ASSIGNMENT_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Track 8 / T8-P2 — canonical requisition ingestion role-matrix. read -> the
// four requisition-adjacent roles (as assignment:read); write -> the
// authoritative tier only (account_manager/tenant_admin/tenant_owner, recruiter
// excluded — bulk external ingestion is a management act, mirrors
// assignment:create). No wildcard widening.
export const REQUISITION_IMPORT_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['recruiter', ['requisition:import:read']],
  ['account_manager', ['requisition:import:read', 'requisition:import:write']],
  ['tenant_admin', ['requisition:import:read', 'requisition:import:write']],
  ['tenant_owner', ['requisition:import:read', 'requisition:import:write']],
];

// Deterministic RoleScope row ids for the 7 requisition-import grants. Fresh
// disjoint range 0xc00+ (append-don't-renumber; assignment occupies 0xb00+).
// DO NOT REORDER without bumping the offset.
const REQUISITION_IMPORT_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0xc00;
  for (const [role, scopes] of REQUISITION_IMPORT_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Track 8 / T8-CONNECTOR-A — connector-connection MANAGEMENT role-matrix.
// integration:read + integration:write granted to tenant_admin + tenant_owner
// ONLY (administrative tier; recruiter/account_manager/others excluded — no
// wildcard widening). The connector ServiceAccount is a separate execution
// identity and does NOT appear here.
export const INTEGRATION_MANAGEMENT_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['tenant_admin', ['integration:read', 'integration:write']],
  ['tenant_owner', ['integration:read', 'integration:write']],
];

// Deterministic RoleScope row ids for the 4 connector-management grants. Fresh
// disjoint range 0xc10+ (append-don't-renumber; requisition-import occupies
// 0xc00..0xc06). DO NOT REORDER without bumping the offset.
const INTEGRATION_MANAGEMENT_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0xc10;
  for (const [role, scopes] of INTEGRATION_MANAGEMENT_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// L2-I (D1) — the Pipeline provider-disposition MAPPING administration grant. A SEPARATE
// bundle (append-don't-renumber): integration:pipeline-mapping:write granted to tenant_admin +
// tenant_owner ONLY (administrative tier, mirroring integration:read/write; recruiter/
// account_manager/others excluded — no wildcard widening). The connector ServiceAccount does
// NOT hold it. Fresh disjoint RoleScope id range 0xf10+ (highest prior grant range is 0xf08).
export const PIPELINE_MAPPING_ADMIN_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['tenant_admin', ['integration:pipeline-mapping:write']],
  ['tenant_owner', ['integration:pipeline-mapping:write']],
];
const PIPELINE_MAPPING_ADMIN_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0xf10;
  for (const [role, scopes] of PIPELINE_MAPPING_ADMIN_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Requisition Approval sub-workflow — APPROVE/REJECT authority role-matrix.
// requisition:approve granted to account_manager + tenant_admin + tenant_owner
// (the manager tier, mirroring requisition:edit:financials); a recruiter holding
// requisition:edit CANNOT approve — approval is a segregated-duty authority.
export const APPROVAL_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['account_manager', ['requisition:approve']],
  ['tenant_admin', ['requisition:approve']],
  ['tenant_owner', ['requisition:approve']],
];

// Deterministic RoleScope row ids for the 3 approval grants. Fresh disjoint
// range 0xc30+ (submittal-policy occupies 0xc20+). DO NOT REORDER.
const APPROVAL_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0xc30;
  for (const [role, scopes] of APPROVAL_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Offer Lifecycle — offer aggregate authority role-matrix. offer:create +
// offer:transition granted to recruiter + account_manager + tenant_admin +
// tenant_owner (mirrors placement:create / placement:transition — the offer is
// the pre-placement stage of the same hire-spine tier). L4/P5: offer:read (read
// the Offer) + offer:read:financial (see the Talent-facing compensation snapshot)
// granted to the same four — recruiters negotiate offers, so they set/see the
// pay. The two are SEPARATE capabilities: absence of offer:read:financial keeps
// the comp snapshot MASKED (fail-closed), so a future read-only principal (portal
// / reporting) can hold offer:read WITHOUT financial visibility.
export const OFFER_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['recruiter', ['offer:create', 'offer:transition', 'offer:read', 'offer:read:financial']],
  ['account_manager', ['offer:create', 'offer:transition', 'offer:read', 'offer:read:financial']],
  ['tenant_admin', ['offer:create', 'offer:transition', 'offer:read', 'offer:read:financial']],
  ['tenant_owner', ['offer:create', 'offer:transition', 'offer:read', 'offer:read:financial']],
];

// Deterministic RoleScope row ids for the 8 offer grants. Fresh disjoint range
// 0xc40+ (submittal-policy 0xc20, approval 0xc30). DO NOT REORDER.
const OFFER_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0xc40;
  for (const [role, scopes] of OFFER_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// COMM-B2 (Aramo-COMM-V1 R-COMM-ROLES) — operational Communications/Voice grants.
// The four communication:* scopes are frontline recruiting work, so ALL FOUR are
// granted to recruiter + account_manager + tenant_admin + tenant_owner (unlike the
// admin-tier integration:* which excludes recruiter). tenant_admin/tenant_owner
// ALSO retain integration:read/write (granted separately above) — not re-granted here.
export const COMMUNICATION_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['recruiter', ['communication:read', 'communication:voice:call', 'communication:disposition:write', 'communication:notes:write']],
  ['account_manager', ['communication:read', 'communication:voice:call', 'communication:disposition:write', 'communication:notes:write']],
  ['tenant_admin', ['communication:read', 'communication:voice:call', 'communication:disposition:write', 'communication:notes:write']],
  ['tenant_owner', ['communication:read', 'communication:voice:call', 'communication:disposition:write', 'communication:notes:write']],
];

// Deterministic RoleScope row ids for the 16 communication grants. Fresh disjoint
// range 0xc50+ (offer occupies 0xc40..0xc4f — 4 roles x 4 scopes after L4/P5 added
// offer:read + offer:read:financial). DO NOT REORDER without bumping the offset.
const COMMUNICATION_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0xc50;
  for (const [role, scopes] of COMMUNICATION_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Lane 2 / L2-F (F1) — the ClientSelectionProcess role matrix. The three
// client-selection:* scopes (create/read/transition) are frontline ATS delivery
// work, so ALL THREE are granted to recruiter + account_manager + tenant_admin +
// tenant_owner — mirrors placement:create/read/transition (the operational tier).
// There is no higher activate/terminate/replace tier at F1, so every grant-receiving
// role gets the full three. super_admin and every other role receive ZERO (fail-closed;
// no prose-hierarchy inheritance). 12 grants.
export const CLIENT_SELECTION_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['recruiter', ['client-selection:create', 'client-selection:read', 'client-selection:transition']],
  ['account_manager', ['client-selection:create', 'client-selection:read', 'client-selection:transition']],
  ['tenant_admin', ['client-selection:create', 'client-selection:read', 'client-selection:transition']],
  ['tenant_owner', ['client-selection:create', 'client-selection:read', 'client-selection:transition']],
];

// Deterministic RoleScope row ids for the 12 client-selection grants. Fresh disjoint
// range 0x1000+ (append-don't-renumber; the highest prior family, permanent-terms,
// occupies 0xf00..0xf08). DO NOT REORDER without bumping the offset.
const CLIENT_SELECTION_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x1000;
  for (const [role, scopes] of CLIENT_SELECTION_SEED_BUNDLES) {
    for (const scope of scopes) {
      map[`${role}:${scope}`] =
        `01900000-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
      i++;
    }
  }
  return map;
})();

// Lane 2 / L2-F (F2) — the InterviewSession role matrix. The two interview:* scopes
// (schedule/transition) are frontline ATS delivery work, granted to the SAME four roles
// as the F1 client-selection scopes (recruiter/account_manager/tenant_admin/tenant_owner).
// 2 scopes × 4 roles = 8 grants. super_admin + all others ZERO (fail-closed).
export const CLIENT_SELECTION_INTERVIEW_SEED_BUNDLES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  ['recruiter', ['client-selection:interview:schedule', 'client-selection:interview:transition']],
  ['account_manager', ['client-selection:interview:schedule', 'client-selection:interview:transition']],
  ['tenant_admin', ['client-selection:interview:schedule', 'client-selection:interview:transition']],
  ['tenant_owner', ['client-selection:interview:schedule', 'client-selection:interview:transition']],
];

// Deterministic RoleScope row ids for the 8 interview grants. Fresh disjoint range
// 0x100c+ (append-don't-renumber; the F1 client-selection family occupies 0x1000..0x100b).
const CLIENT_SELECTION_INTERVIEW_SEED_ROLE_SCOPE_ROW_IDS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  let i = 0x100c;
  for (const [role, scopes] of CLIENT_SELECTION_INTERVIEW_SEED_BUNDLES) {
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
/**
 * Options for {@link runIdentitySeed}.
 *
 * `includeDevFixtures` (default `true`) gates ONLY the dev/bootstrap fixtures —
 * the `Aramo Dev Tenant`, the `admin@aramo.dev` user, that user's membership /
 * membership-role / external-identity, and the four audit rows describing those
 * creations. It does NOT touch the catalog (scopes, roles, RoleScope grants),
 * the system ServiceAccount, the `Aramo Platform` sentinel tenant, or the
 * catalog-describing role/scope audit rows — those are seeded unconditionally
 * and remain byte-identical regardless of this flag.
 *
 * Defaulting `true` preserves every existing caller (dev seed, integration
 * specs) verbatim. The Astre single-box seed passes `false` so the first prod
 * DB is `catalog + Astre + owner` ONLY — clean from creation, never
 * seeded-then-scrubbed (Single-Box Directive 3 §F).
 */
export interface RunIdentitySeedOptions {
  includeDevFixtures?: boolean;
}

export async function runIdentitySeed(
  prisma: IdentityPrismaClient,
  options: RunIdentitySeedOptions = {},
): Promise<{
  service_account_id: string;
}> {
  const { includeDevFixtures = true } = options;

  // 1. Tenant (idempotent upsert keyed on stable id). DEV-FIXTURE — gated.
  if (includeDevFixtures) {
    await prisma.tenant.upsert({
      where: { id: SEED_IDS.tenant },
      update: {},
      create: {
        id: SEED_IDS.tenant,
        name: SEED_TENANT_NAME,
        is_active: true,
      },
    });
  }

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

  // 2. User (admin). DEV-FIXTURE — gated.
  if (includeDevFixtures) {
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
  }

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

  // Track 8 / T8-CONNECTOR-A — the dedicated connector execution ServiceAccount
  // (machine actor). A true service identity, separate from any human. It holds
  // NO connector-management scopes; its P2-handoff authority is supplied
  // programmatically (requisition:import:write).
  await prisma.serviceAccount.upsert({
    where: { id: SEED_IDS.service_account_connector },
    update: {},
    create: {
      id: SEED_IDS.service_account_connector,
      name: CONNECTOR_SERVICE_ACCOUNT_NAME,
      description: CONNECTOR_SERVICE_ACCOUNT_DESCRIPTION,
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
  // Portal P3a — candidate verification view + dispute rights (3). Declared in
  // SEED_IDS.scopes (0xb2-0xb4) and granted to the candidate role, but the
  // creation calls were missing (D-SEED-SCOPES-1) → RoleScope_scope_id_fkey.
  await upsertScope(prisma, SEED_IDS.scopes['portal:verification:read'], 'portal:verification:read', 'Read own portal verification state');
  await upsertScope(prisma, SEED_IDS.scopes['portal:dispute:read'], 'portal:dispute:read', 'Read own portal disputes');
  await upsertScope(prisma, SEED_IDS.scopes['portal:dispute:write'], 'portal:dispute:write', 'Open or withdraw own portal disputes');
  // PR-A1a-2 — full ATS catalog (27 new scopes; Ruling 1 uniform divergence applied at role-mapping level).
  await upsertScope(prisma, SEED_IDS.scopes['talent:read'], 'talent:read', 'Read a talent record (assigned by default)');
  await upsertScope(prisma, SEED_IDS.scopes['talent:create'], 'talent:create', 'Create a talent record');
  await upsertScope(prisma, SEED_IDS.scopes['talent:edit'], 'talent:edit', 'Edit a talent record');
  await upsertScope(prisma, SEED_IDS.scopes['talent:delete'], 'talent:delete', 'Delete a talent record (tenant_admin only — Ruling 1)');
  await upsertScope(prisma, SEED_IDS.scopes['talent:search'], 'talent:search', 'Search the talent index (Constrained Talent Access)');
  await upsertScope(prisma, SEED_IDS.scopes['talent:source'], 'talent:source', 'Promote a sourced L2 subject into an ATS talent record (sourcer)');
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
  await upsertScope(prisma, SEED_IDS.scopes['pipeline:complete'], 'pipeline:complete', 'Lane 2 / L2-C (SB-3) — the SYSTEM-ONLY capability to COMPLETE a pipeline episode (qualified → completed, a DOWNSTREAM_OUTCOME disposition carrying lineage). CATALOG-ONLY: GRANTED to NO human tenant role (recruiter/account_manager/tenant_admin/tenant_owner never receive it, mirroring requisition:create:establish); held programmatically by system/downstream identities only (L2-G wires the Placement STARTED → COMPLETE trigger). NO scope.created (scope-seed precedent); NO RoleScope grant.');
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
  // Lane 2 / L2-F (F1) — Client-Selection owner scopes.
  await upsertScope(prisma, SEED_IDS.scopes['client-selection:create'], 'client-selection:create', 'Lane 2 / L2-F (F1) — create a ClientSelectionProcess from a Submittal (POST /v1/client-selection, apps/api create-from-submittal orchestration). GRANTED to recruiter, account_manager, tenant_admin, tenant_owner (the ATS delivery matrix; mirrors placement:create). NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['client-selection:read'], 'client-selection:read', 'Lane 2 / L2-F (F1) — read a ClientSelectionProcess (GET /v1/client-selection/:id). GRANTED to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['client-selection:transition'], 'client-selection:transition', 'Lane 2 / L2-F (F1) — drive a ClientSelectionProcess state transition (POST /v1/client-selection/:id/transition, CAS-guarded). GRANTED to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  // Lane 2 / L2-F (F2) — InterviewSession child scopes.
  await upsertScope(prisma, SEED_IDS.scopes['client-selection:interview:schedule'], 'client-selection:interview:schedule', 'Lane 2 / L2-F (F2) — schedule an InterviewSession under a ClientSelectionProcess (POST /v1/client-selection/:id/interviews, idempotency-gated). GRANTED to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['client-selection:interview:transition'], 'client-selection:interview:transition', 'Lane 2 / L2-F (F2) — drive an InterviewSession state transition (POST /v1/client-selection/interview-sessions/:id/transition, CAS-guarded). GRANTED to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['activity:create'], 'activity:create', 'Create a manual activity entry');
  // AUTHZ-2 — 3 platform-namespace scopes (Lead ruling 5; separate from
  // the 47 tenant scopes above).
  await upsertScope(prisma, SEED_IDS.scopes['platform:tenant:provision'], 'platform:tenant:provision', 'Platform-tier: create a tenant + entitlement seed + Tenant-Owner invite (super_admin only)');
  await upsertScope(prisma, SEED_IDS.scopes['platform:tenant:read'], 'platform:tenant:read', 'Platform-tier: list/read tenants for the platform-admin view (super_admin only)');
  await upsertScope(prisma, SEED_IDS.scopes['platform:admin:invite'], 'platform:admin:invite', 'Platform-tier: invite another platform admin against the platform Cognito pool (super_admin only)');
  await upsertScope(prisma, SEED_IDS.scopes['platform:tenant:lifecycle:manage'], 'platform:tenant:lifecycle:manage', 'Platform-tier: manage tenant lifecycle — suspend/reactivate/offboard/close (super_admin only)');
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
  // R7 BE-prereq — 3 selection-domain scopes (closes the A1a-2 deferral).
  // 3-scope split (Amendment v1.1 §1 Ruling B; outreach SoD). The 8 selection
  // routes gate via @RequireScopes(...) — read on the 3 GETs (incl. the new
  // LIST), write on create/transitions/response/conversation, outreach on the
  // outreach route. NO scope.created audit events (mirrors the Reporting-Scope-
  // Seed precedent).
  await upsertScope(prisma, SEED_IDS.scopes['selection:read'], 'selection:read', 'Read selections (GET /v1/selections LIST, GET /v1/selections/:id, GET /v1/selections/:id/events). 8 roles: write-tier 6 + read-only 2 (delivery_manager / back_office). D4b-composed at read time (selection visible iff its requisition_id is in the actor visible-requisition set).');
  await upsertScope(prisma, SEED_IDS.scopes['selection:write'], 'selection:write', 'Mutate selections (POST create / transitions / response / conversation). 6 roles: TA / TO / AM / RM / LR / recruiter[floor]. Write-path visibility: the controller (create) + the repo findByTenantAndId (the 4 mutate-existing) compose D4b — invisible-requisition selections return 404.');
  await upsertScope(prisma, SEED_IDS.scopes['selection:outreach'], 'selection:outreach', 'Send outbound selection outreach (POST /v1/selections/:id/outreach). Separate from :write per outreach SoD — the only selection write with external side-effects (AI draft + consent-at-send + outbound delivery + LLM cost). Same 6 roles as :write.');
  // Search PR-1 — 3 per-entity quick-search scopes (Lead rulings R1/R2).
  // Gate the ?q= trigram filter on the per-entity LIST endpoints WHEN q is
  // present (the no-q LIST keeps its :read gate). talent:search is REUSED
  // (seeded above) for /v1/talent-records?q=. Granted via SEARCH_SEED_BUNDLES
  // (per-entity :read-holder parity). NO scope.created audit events (mirrors
  // the Reporting / Selection-Scope-Seed precedent).
  await upsertScope(prisma, SEED_IDS.scopes['company:search'], 'company:search', 'Quick-search companies by name (GET /v1/companies?q=). Trigram (ILIKE-contains) match ANDed with the D4b company visibility predicate — narrows within the visible set. Granted to the 9 company:read holders.');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:search'], 'requisition:search', 'Quick-search requisitions by title (GET /v1/requisitions?q=). Trigram (ILIKE-contains) match ANDed with the A3-OR-D4b requisition visibility predicate. Granted to the 10 requisition:read holders (the 9 + finance).');
  await upsertScope(prisma, SEED_IDS.scopes['contact:search'], 'contact:search', 'Quick-search contacts by name (GET /v1/contacts?q=). Trigram (ILIKE-contains) match over first_name/last_name ANDed with the D4b contact visibility predicate. Granted to the 9 contact:read holders.');
  await upsertScope(prisma, SEED_IDS.scopes['task:read'], 'task:read', 'Read tasks (GET /v1/tasks my-tasks + by-entity, GET /v1/tasks/:id). Every read ANDs the linked-entity visibility (a task on a non-visible owner is absent). Granted to the 9 operational roles.');
  await upsertScope(prisma, SEED_IDS.scopes['task:write'], 'task:write', 'Create / update / delete tasks (POST + PATCH + DELETE /v1/tasks). Create asserts the owner entity is visible (404 if not); the assignee must be an active within-tenant user. Granted to the 9 operational roles.');
  // Company-Fields v1.1 — the Company COMMERCIAL field-gate scope. Read:
  // apps/api field-masking interceptor omits the 6 commercial fields
  // (fee_model / markup / perm-fee / payment_terms / credit_status /
  // currency) for non-holders. Write: the company repository strips those
  // fields for non-holders (never persisted; an existing value is never
  // nulled). ONE scope governs read AND write. Granted to tenant_admin +
  // tenant_owner + account_manager.
  await upsertScope(prisma, SEED_IDS.scopes['company:read_commercial'], 'company:read_commercial', 'View + edit the Company COMMERCIAL fields (fee_model, default_contract_markup_pct, default_perm_fee_pct, payment_terms, credit_status, default_currency). Field-gate (not a route gate): non-holders see the company but with the commercial fields omitted, and any commercial field they submit on save is stripped. Granted to the agency-economics tier (tenant_admin + tenant_owner + account_manager).');

  // Job-Module (LB-4) — the requisition financial-planning field-gate scopes.
  await upsertScope(prisma, SEED_IDS.scopes['requisition:view:financials'], 'requisition:view:financials', 'View the Requisition FINANCIAL-PLANNING fields (target_margin_percent, markup_percent_target, rate_card_id, min/max_bill_rate, min/max_pay_rate). Read field-mask via libs/field-masking: non-holders see the requisition with these fields omitted from the JSON. A DISTINCT surface from the 13 compensation actuals (kept out of the D5 non-invertibility family). Granted to the agency-economics tier (tenant_admin + tenant_owner + account_manager).');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:edit:financials'], 'requisition:edit:financials', 'Write the Requisition FINANCIAL-PLANNING fields. Write-gate enforced IN-SERVICE at the requisition repository (create / update / createForImport) BEFORE the Prisma write: a caller writing any financial field without this scope is rejected 403, and a null-clear counts as a write. Granted to the agency-economics tier (tenant_admin + tenant_owner + account_manager).');

  // PR-A1 Requisition-Gating Rework — 3 new requisition-gating scopes.
  await upsertScope(prisma, SEED_IDS.scopes['requisition:edit:status'], 'requisition:edit:status', 'Edit ONLY the status field of a requisition (the status-only edit tier). INVERTED restrict-to-subset gate enforced IN-SERVICE at the requisition repository PATCH path: a holder of requisition:edit:status WITHOUT requisition:edit may PATCH only the status field; any other field in the request is rejected 403. A holder of requisition:edit is unaffected (edits status as before). Granted to delivery_manager.');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:profile:generate'], 'requisition:profile:generate', 'Generate the AI JD + GoldenProfile for a requisition (the draft + confirm endpoints; re-gated off requisition:edit per PR-A1). Granted to the 5-role management tier (tenant_admin + tenant_owner + account_manager + recruiting_manager + lead_recruiter); base recruiter does NOT hold it.');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:profile:edit'], 'requisition:profile:edit', 'Edit the generated GoldenProfile content for a requisition. Granted to the 5-role management tier (tenant_admin + tenant_owner + account_manager + recruiting_manager + lead_recruiter).');

  // Settings Rebuild D1 — the 2 read scopes behind the settings Import +
  // Export LIVE sections. NO scope.created audit events (mirrors the
  // Reporting / Selection / Search / Task scope-seed precedent).
  await upsertScope(prisma, SEED_IDS.scopes['import:read'], 'import:read', 'Read the CSV bulk-import history + per-batch failures (GET /v1/imports, GET /v1/imports/:id, GET /v1/imports/:id/failures). Read-only audit of imports; the write/revert surface gates on import:create / import:delete (unseeded — a later increment). Granted to the operational tier (recruiter+: tenant_admin + tenant_owner + account_manager + recruiting_manager + recruiter + lead_recruiter + back_office + delivery_manager). RequireSiteMatch + the actor visibility still govern WHAT each row shows.');
  await upsertScope(prisma, SEED_IDS.scopes['export:read'], 'export:read', 'Export the 5 R10-bounded ATS entities as CSV (GET /v1/exports/:entity_type). The A3/D4b visibility predicate at the service layer governs WHAT each role exports; R10 keeps the column set ATS-only (no Core-judgment field). Granted to tenant_admin + tenant_owner (the settings Export surface is admin-gated).');
  await upsertScope(prisma, SEED_IDS.scopes['audit:read'], 'audit:read', 'Read the tenant audit log (GET /v1/tenant/audit-events) — the keyset-paginated, filterable read over the IdentityAuditEvent trail (who did what, when). Tenant-scoped (never cross-tenant); detail is redacted of values the viewer\'s scopes don\'t permit. Granted to tenant_admin + tenant_owner (the admin/compliance tier; NOT recruiters). NO scope.created audit event (mirrors the Reporting/Selection/Search/Task/Settings-D1 scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['tenant:admin:profile'], 'tenant:admin:profile', 'Read + edit the tenant profile (GET/PATCH /v1/tenant/profile) — the org legal identity (legal/display name, address, tax/registration IDs, primary contact, logo). DEDICATED scope (Lead ruling): kept distinct from tenant:admin:settings so org-legal-identity and app-config stay separable, and the audit trail (identity.tenant_profile.updated) carries a clean per-scope authorization story. Granted to tenant_admin + tenant_owner ONLY (NOT recruiters). NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['tenant:admin:sites'], 'tenant:admin:sites', 'Manage sites/branches (CRUD /v1/tenant/sites) — the org STRUCTURE: sub-tenant branch partitions + the parent/child branch hierarchy. DEDICATED scope (Lead ruling): kept distinct from tenant:admin:settings (config) and tenant:admin:profile (legal identity) so the admin taxonomy stays coherent and sites stay separable later. Emits identity.site.created/updated/deactivated (field names only). Granted to tenant_admin + tenant_owner ONLY (NOT recruiters). NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['tenant:admin:domain'], 'tenant:admin:domain', 'Prove DNS-TXT ownership of the tenant\'s locked domain (GET/POST /v1/tenant/domain-verification + /check) — request a verification token, publish it in a DNS TXT record, and have Aramo resolve+match it to mark the domain VERIFIED. INFORMATIONAL in P2b (gates nothing — P1\'s invite domain-lock works regardless of verification status). DEDICATED scope: kept distinct from settings/profile/sites so the admin taxonomy stays coherent. Emits identity.domain.verification.requested/verified. Granted to tenant_admin + tenant_owner ONLY (NOT recruiters). NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['identity:resolve'], 'identity:resolve', 'Resolve a within-tenant same-human MATCH ADVISORY (TR-2a-3): approve (execute the pointer-only merge of two ResolutionSubjects), dismiss (not the same human), or reverse (un-merge). POST /v1/talent/identity/advisories/:id/{approve,dismiss,reverse} + GET the reviewer queue. PRIVILEGED, tenant-scoped data-governance — NOT recruiter self-serve. Merging a contradicted advisory requires an explicit acknowledgment + justification (audited on the advisory). Granted to tenant_admin + tenant_owner ONLY. NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['activity:redact'], 'activity:redact', 'Redact a logged note (Charter §4 Amendment — redact-never-delete): clear the note body while author, timestamp and row survive, recording who/when/why. POST /v1/activities/:id/redact. Author-or-scope: any author redacts their own note without this scope; the scope is the CROSS-author path for the oversight tier (a lead reviewing their pod\'s feed). Granted to tenant_owner + tenant_admin + recruiting_manager + lead_recruiter. NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['tenant:user:read:directory'], 'tenant:user:read:directory', 'Resolve user_id → display_name for ANY tenant user INCLUDING inactive/departed (GET /v1/tenant/users/directory). The name-resolution half of the two-jobs split: distinct from tenant:user:read:assignable (the active-only assignable picker) because authorship/ownership/assignee names in list+detail views must still render for departed users (historical integrity). Minimal {user_id, display_name} ONLY — name lookup, NOT a roster, NOT admin data (no email/status/roles/audit). Batch-capable (?user_ids=). Granted to the 10 list-view viewers (the 9 work-assigning roles + finance, who reads the requisition/talent lists). NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['tenant:user:read:assignable'], 'tenant:user:read:assignable', 'Read the MINIMAL assignable-user roster (GET /v1/tenant/users/assignable) — id + display_name of ACTIVE tenant members only, for the assign-a-teammate pickers (task / requisition / pod). The recruiter-tier counterpart to tenant:admin:user-manage: it serves a deliberately narrow roster (least-data), NOT the admin UserView (no email/status/roles/audit). The users analogue of company:read for the company-assign picker. Granted to the 9 work-assigning operational roles (the task:read/:write tier: tenant_owner, tenant_admin, account_manager, recruiting_manager, recruiter, lead_recruiter, back_office, delivery_manager, sourcer). NO scope.created audit event (scope-seed precedent).');

  // Track 3 / E2 (Pre-Start Requirement) — SEVEN scopes (v1.2.1). NO scope.created
  // audit events (scope-seed precedent, §13d-1 F-1). Two are registered with zero
  // default grants (§13c-1).
  await upsertScope(prisma, SEED_IDS.scopes['pre_start_requirement:read'], 'pre_start_requirement:read', 'Track 3 / E2 — view pre-start requirement instances and their status for a placement. Granted to the 8 operational roles (recruiter, sourcer, lead_recruiter, account_manager, recruiting_manager, delivery_manager, tenant_admin, tenant_owner). NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['pre_start_requirement:act'], 'pre_start_requirement:act', 'Track 3 / E2 — satisfy, fail or progress-to-IN_PROGRESS a pre-start requirement instance (the ordinary operational work path). Does NOT include reopen (§13-R v1.2.2 — reopen is its own zero-grant scope). Granted to the 8 operational roles. NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['pre_start_requirement:configure'], 'pre_start_requirement:configure', 'Track 3 / E2 — create and edit DRAFT definition sets. Distinct from :publish at the capability/API/audit layers. Granted to tenant_admin + tenant_owner ONLY. NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['pre_start_requirement:publish'], 'pre_start_requirement:publish', 'Track 3 / E2 — publish a definition set (make it govern live placements). Kept separate from :configure so editing a draft is not authority to make it live (§13b); granted to tenant_admin + tenant_owner by default to avoid a fresh-tenant bootstrap deadlock (§14 A1). NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['pre_start_requirement:waive_advisory'], 'pre_start_requirement:waive_advisory', 'Track 3 / E2 — waive a NON-BLOCKING (advisory) requirement. Granted to account_manager + recruiting_manager + delivery_manager. Does NOT imply waive_blocking. NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['pre_start_requirement:waive_blocking'], 'pre_start_requirement:waive_blocking', 'Track 3 / E2 — waive a BLOCKING requirement (override a background check, drug screen or I-9 — a compliance act with legal exposure). REGISTERED WITH ZERO DEFAULT GRANTS (§13c-1): a tenant grants it explicitly to a named holder; a tenant with no holder cannot perform a blocking waiver, which is correct, not a gap. NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['pre_start_requirement:read_restricted_evidence'], 'pre_start_requirement:read_restricted_evidence', 'Track 3 / E2 — view evidence_reference for restricted requirement types (screening evidence). Gated independently of :read (§13b). REGISTERED WITH ZERO DEFAULT GRANTS (§13c-1): granted only by a named human decision, never inherited from a bundle. NO scope.created audit event (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['pre_start_requirement:reopen'], 'pre_start_requirement:reopen', 'Track 3 / E2 — reopen a resolved/failed pre-start requirement instance back to PENDING (a privileged audited action; §13-R v1.2.2). Lifted OUT of :act because reopening reverses a recorded compliance outcome. REGISTERED WITH ZERO DEFAULT GRANTS (§13c-1): granted only by a named human decision, never inherited from a bundle — not to any recruiter role, configure/publish holders, tenant_admin, tenant_owner, waiver holders, auditor or super_admin. NO scope.created audit event (scope-seed precedent).');
  // Track 3 / E1-b — PlacementProcess authorization (E1-b Approval Record §2). read
  // gates GET, create gates POST /v1/placements; the generic transition route
  // requires the class scope DERIVED from the target edge under the ratified
  // classification. ALL FOUR non-read scopes ship with ZERO DEFAULT GRANTS — no
  // ratified placement role matrix exists yet; an unassigned scope is recoverable,
  // a silently broad grant is not. NO scope.created (scope-seed precedent).
  await upsertScope(prisma, SEED_IDS.scopes['placement:read'], 'placement:read', 'Track 3 / E1-b — read a PlacementProcess (GET /v1/placements/:id). GRANTED by the ratified #577 placement role matrix (PLACEMENT_SEED_BUNDLES) to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['placement:create'], 'placement:create', 'Track 3 / E1-b — create a PlacementProcess on the client-selection/offer fact (POST /v1/placements). GRANTED (#577 matrix) to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['placement:transition'], 'placement:transition', 'Track 3 / E1-b — ORDINARY non-terminal PlacementProcess progression (the 5 committed-tier edges: offer->accepted, accepted->pre_start, pre_start->ready_to_start, pre_start->blocked, blocked->pre_start). GRANTED (#577 matrix) to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['placement:activate'], 'placement:activate', 'Track 3 / E1-b — the edge that establishes the authoritative live/committed placement (ready_to_start->started). Distinct authority from ordinary progression (§2). GRANTED (#577 matrix) to account_manager, tenant_admin, tenant_owner only; recruiter excluded. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['placement:terminate'], 'placement:terminate', 'Track 3 / E1-b — terminal/irreversible PlacementProcess termination (the edges into NO_SHOW/FELL_THROUGH). GRANTED (#577 matrix) to account_manager, tenant_admin, tenant_owner only; recruiter excluded. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['placement:replace'], 'placement:replace', 'Track 3 / E4 — authorize CREATING a replacement PlacementProcess against a terminal predecessor (POST /v1/placements with replaces_placement_process_id). Required IN CONJUNCTION with placement:create, never as an alternative creation path (§3). GRANTED (E4 ratified matrix) to account_manager, tenant_admin and tenant_owner only; recruiter, super_admin, recruiting_manager and all others ZERO (Owner=Admin mirror). NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['placement:permanent:read'], 'placement:permanent:read', 'Track 7 / T7-P1 — read a PermanentPlacement and its immutable guarantee snapshot (GET /v1/placements/:id/permanent). Dedicated least-privilege authority; placement:* / assignment:* NEVER satisfy it. GRANTED (PERMANENT_PLACEMENT_SEED_BUNDLES) to recruiter, account_manager, tenant_admin, tenant_owner (mirrors placement:read). NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['placement:permanent:transition'], 'placement:permanent:transition', 'Track 7 / T7-P1 — transition the PermanentPlacement guarantee lifecycle (POST /v1/placements/:id/permanent/transition; P1 edge GUARANTEE_ACTIVE->GUARANTEE_SATISFIED) AND the second leg of the PERMANENT STARTED conjunction (with placement:activate). Dedicated authority; assignment:commercials:write / placement:* NEVER substitute. GRANTED (PERMANENT_PLACEMENT_SEED_BUNDLES) to account_manager, tenant_admin, tenant_owner only; recruiter excluded (mirrors placement:activate). NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['placement:remedy:resolve'], 'placement:remedy:resolve', 'Track 7 / T7-P2 — resolve a permanent-placement remedy obligation with governed evidence (POST /v1/placements/:id/permanent/remedy/complete). DEDICATED high-consequence authority, authority-separated from the guarantee lifecycle; placement:permanent:transition / placement:* NEVER satisfy it. GRANTED (PERMANENT_REMEDY_SEED_BUNDLES) to account_manager, tenant_admin, tenant_owner only; recruiter excluded. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['placement:permanent:terms:write'], 'placement:permanent:terms:write', 'Track 7 / T7-P3 — create/revise the reusable requisition-keyed guarantee-term versions (POST /v1/permanent-placement-guarantee-terms/requisitions/:requisitionId[/revise]). DEDICATED terms-authorship authority, authority-separated from operational work; reads use placement:permanent:read and placement:* NEVER satisfy it. GRANTED (PERMANENT_TERMS_SEED_BUNDLES) to account_manager, tenant_admin, tenant_owner only; recruiter excluded. NO scope.created (scope-seed precedent).');
  // Track 4 / T4-D — ContractAssignment authority family. Role posture mirrors the
  // placement authoritative tier (ASSIGNMENT_SEED_BUNDLES). NO scope.created (scope-seed precedent).
  await upsertScope(prisma, SEED_IDS.scopes['assignment:read'], 'assignment:read', 'Track 4 / T4-D — read a ContractAssignment (the authoritative post-start commitment) and its derived capacity. GRANTED to recruiter, account_manager, tenant_admin, tenant_owner (mirrors placement:read). NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['assignment:create'], 'assignment:create', 'Track 4 / T4-D — create an authoritative ContractAssignment (post-start commitment; the forward STARTED path and, gated separately, T4-A2 backfill). GRANTED to account_manager, tenant_admin, tenant_owner only; recruiter excluded (authoritative-tier act). NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['assignment:update'], 'assignment:update', 'Track 4 / T4-D — update an authoritative ContractAssignment. GRANTED to account_manager, tenant_admin, tenant_owner only; recruiter excluded. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['assignment:end'], 'assignment:end', 'Track 4 / T4-D — end a ContractAssignment (ACTIVE->ENDED, with the ratified end reason: normal completion / worker-ended / client-ended). GRANTED to account_manager, tenant_admin, tenant_owner only; recruiter excluded. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['assignment:extend'], 'assignment:extend', 'Slice #3 — extend an ACTIVE ContractAssignment planned end (expected_end_at moves strictly forward; NO lifecycle transition). SEPARATE authority from assignment:end (extend and terminate are opposite powers, granted independently). GRANTED to account_manager, tenant_admin, tenant_owner only; recruiter excluded. NO scope.created (scope-seed precedent).');
  // Track 5 / T5-P1 — assignment commercial-terms authority family. Dedicated
  // financial permissions (Amendment A2 DEC-4): NEVER satisfied by placement:*,
  // requisition-financials, or generic assignment:create/update. NO scope.created (scope-seed precedent).
  await upsertScope(prisma, SEED_IDS.scopes['assignment:commercials:read'], 'assignment:commercials:read', 'Track 5 / T5-P1 — read the actual commercial terms (Assignment Rate Version: pay/bill/currency/period and derived margin) of a ContractAssignment. Independent financial-disclosure gate (least visibility: assignment:read does NOT grant it). GRANTED to account_manager, tenant_admin, tenant_owner only; recruiter excluded (financial data). NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['assignment:commercials:write'], 'assignment:commercials:write', 'Track 5 / T5-P1 — record the initial actual commercial terms of a ContractAssignment. The SECOND leg of the FORWARD STARTED conjunction (required IN CONJUNCTION with placement:activate, never alone; placement:* and requisition-financials never substitute). GRANTED to account_manager, tenant_admin, tenant_owner only; recruiter excluded. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['assignment:commercials:approve'], 'assignment:commercials:approve', 'Slice #4 — Commercial Approval: exercise commercial AUTHORITY over a proposed revision (margin-approve / client-approve / apply / reject a CommercialRevisionProposal). SEPARATE authority from assignment:commercials:write (propose != approve): a proposer must not self-approve the economics of their own proposal (segregation of duties). GRANTED to account_manager, tenant_admin, tenant_owner only; recruiter excluded. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:import:read'], 'requisition:import:read', 'Track 8 / T8-P2 — read the canonical requisition-import batch history + per-record failures (GET /v1/requisition-imports, GET /v1/requisition-imports/:id). Provider-neutral external-system requisition ingestion; distinct from the generic CSV import:* family. GRANTED to recruiter, account_manager, tenant_admin, tenant_owner (mirrors assignment:read). NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:import:write'], 'requisition:import:write', 'Track 8 / T8-P2 — run a canonical requisition import (POST /v1/requisition-imports): validate + map provider-neutral records through the governed createForImport path. GRANTED to account_manager, tenant_admin, tenant_owner only; recruiter excluded (bulk external ingestion is an authoritative-tier act, mirrors assignment:create). NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['integration:read'], 'integration:read', 'Track 8 / T8-CONNECTOR-A — read provider-neutral connector connections (Settings → Integrations): list/status/last-sync/error summary. Connector connection ADMINISTRATION; distinct from requisition:import:read (P3 ingestion monitoring). GRANTED to tenant_admin, tenant_owner only. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['integration:write'], 'integration:write', 'Track 8 / T8-CONNECTOR-A — administer provider-neutral connector connections (create/configure-credential/enable/disable). Never returns raw secret material. GRANTED to tenant_admin, tenant_owner only; recruiter/account_manager excluded (administrative tier). The connector ServiceAccount does NOT hold this — execution authority is requisition:import:write only. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['integration:pipeline-mapping:write'], 'integration:pipeline-mapping:write', 'Lane 2 / L2-I (D1) — manage the per-connection PIPELINE provider-disposition MAPPING contract: author/version the provider-token → canonical Pipeline recruiter-action / non-system disposition-reason mapping (POST /v1/integrations/:connectionId/pipeline-provider-mappings). A NARROW administrative permission for the mapping contract itself — NOT pipeline mutation (distinct from pipeline:change-status) and NOT the broad integration:write. GRANTED to tenant_admin, tenant_owner only; recruiter/account_manager excluded. The connector ServiceAccount does NOT hold it. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['communication:read'], 'communication:read', 'COMM-V1 (COMM-B2) — read Communications/Voice surface: provider capabilities, the caller own provider-identity mapping, and a communication interaction by id. Frontline recruiting read (NOT admin-tier). GRANTED to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['communication:voice:call'], 'communication:voice:call', 'COMM-V1 — initiate an outbound voice call from a Talent record (POST /v1/communications/calls; route lands in COMM-B5). Server-side contacting-consent gate precedes any provider execution. GRANTED to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['communication:disposition:write'], 'communication:disposition:write', 'COMM-V1 — record the recruiting disposition of a communication interaction (route lands in COMM-B7). GRANTED to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['communication:notes:write'], 'communication:notes:write', 'COMM-V1 — write recruiter notes on a communication interaction (route lands in COMM-B7). GRANTED to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:approve'], 'requisition:approve', 'Requisition Approval sub-workflow — decide a requisition approval: the governed APPROVE (pending_approval -> open) and REJECT (pending_approval -> draft) transitions, enforced IN-SERVICE at the requisition repository (a 403 costs no policy decision + no write). APPROVE additionally enforces segregation of duties (the approver must differ from the recruiter who submitted for approval). GRANTED to account_manager, tenant_admin, tenant_owner only (manager tier, mirrors requisition:edit:financials); recruiter excluded — a recruiter cannot approve. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['offer:create'], 'offer:create', 'Offer Lifecycle — create a DRAFT Offer (POST /v1/offers), the dedicated pre-placement offer aggregate. GRANTED to recruiter, account_manager, tenant_admin, tenant_owner (mirrors placement:create — the offer is the pre-placement stage of the same hire-spine tier). NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['offer:transition'], 'offer:transition', 'Offer Lifecycle — drive an Offer governed transition (PATCH /v1/offers/:id): send / negotiate / revise / accept / decline / expire / rescind, along the legal DRAFT->SENT->NEGOTIATION->ACCEPTED/DECLINED/EXPIRED/RESCINDED edges (the DB trigger + ADR-0024 offer-lifecycle policy enforce legality). GRANTED to recruiter, account_manager, tenant_admin, tenant_owner (mirrors placement:transition). NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['offer:read'], 'offer:read', 'Offer Lifecycle / L4-P5 — read the Offer resource (GET /v1/offers, GET /v1/offers/:id). Grants the offer metadata + lifecycle state; the Talent-facing compensation snapshot is MASKED unless the caller ALSO holds offer:read:financial (fail-closed field-level masking). GRANTED to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['offer:read:financial'], 'offer:read:financial', 'Offer Lifecycle / L4-P5 — read the structured Talent-facing Offer compensation snapshot (pay/salary presented to the talent) on the Offer read surface. A SEPARATE capability from offer:read: its absence keeps the comp snapshot masked. Covers Talent-facing compensation ONLY — NOT bill rate, margin, markup, or internal commercial planning (those remain under their existing financial authorities). GRANTED to recruiter, account_manager, tenant_admin, tenant_owner. NO scope.created (scope-seed precedent).');
  await upsertScope(prisma, SEED_IDS.scopes['requisition:create:establish'], 'requisition:create:establish', 'Requisition Lane 1-A (Create-Governance) — the functional create qualifier that unlocks the governed initial-state establishment mode (MANUAL-ESTABLISH + SYSTEM). Grants authority to ENTER the governed establishment mode; never permits arbitrary statuses (the establishment-authorization gate still bounds { draft, open }). CATALOG-ONLY in v1: GRANTED to NO human tenant role (recruiter / recruiting_manager / delivery_manager / account_manager never receive it, so no human bypasses draft->approval via the manual create path); held programmatically by system/bootstrap establishment identities + passed by bootstrap/test helpers only. The INTEGRATION import path does NOT use this scope — it reuses the existing requisition:import:write. NO scope.created (scope-seed precedent); NO RoleScope grant.');

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
  // 2 read-only × 1) per SELECTION_SEED_BUNDLES. UUID range 0x700+
  // (append-don't-renumber per Amendment v1.1 §2 — AUTHZ-1's 0x400+,
  // AUTHZ-D5's 0x500+, Reporting's 0x600+ all stay untouched). Closes
  // the documented A1a-2 selection-scope deferral and enables the R7 FE.
  for (const [roleKey, scopeKeys] of SELECTION_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = SELECTION_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`R7 Selection-Scope-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // 7f. Search PR-1 RoleScope assignments — 28 rows (9 roles × 3 search
  // scopes + finance × 1) per SEARCH_SEED_BUNDLES. UUID range 0x800+
  // (append-don't-renumber — AUTHZ-1's 0x400+, AUTHZ-D5's 0x500+,
  // Reporting's 0x600+, Selection's 0x700+ all stay untouched). Grants the
  // 3 NEW company/requisition/contact :search scopes by per-entity
  // :read-holder parity; talent:search is REUSED (granted in 7/7b above).
  for (const [roleKey, scopeKeys] of SEARCH_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = SEARCH_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`Search-Scope-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // 7g. Tasks backend RoleScope assignments — 18 rows (9 operational roles ×
  // task:read + task:write) per TASK_SEED_BUNDLES. UUID range 0x81c+
  // (append-don't-renumber — the 0x400/0x500/0x600/0x700/0x800 ranges all
  // stay untouched).
  for (const [roleKey, scopeKeys] of TASK_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = TASK_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`Tasks-Scope-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // 7h. Company-Fields v1.1 — company:read_commercial RoleScope assignments —
  // 3 rows (tenant_admin + tenant_owner + account_manager) per
  // COMMERCIAL_SEED_BUNDLES. UUID range 0x830+ (append-don't-renumber). Base
  // recruiter + the delivery tier are deliberately NOT granted (F3).
  for (const [roleKey, scopeKeys] of COMMERCIAL_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = COMMERCIAL_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`Commercial-Scope-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // 7i. Job-Module (LB-4) — requisition:*:financials RoleScope assignments —
  // 6 rows (tenant_admin + tenant_owner + account_manager, each × view+edit)
  // per FINANCIALS_SEED_BUNDLES. UUID range 0x833+ (append-don't-renumber).
  // Base recruiter + the delivery tier are deliberately NOT granted.
  for (const [roleKey, scopeKeys] of FINANCIALS_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = FINANCIALS_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`Financials-Scope-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // 7j. PR-A1 Requisition-Gating Rework — the consolidated grant DELTA
  // (15 rows) per REQ_GATING_SEED_BUNDLES. UUID range 0x839+
  // (append-don't-renumber — every prior range, incl. D5's 0x500 and
  // Financials' 0x833, is untouched). Carries: profile:generate +
  // profile:edit for the 5-role mgmt tier; compensation:view:bill for
  // recruiting_manager / lead_recruiter / delivery_manager; and the net-new
  // requisition:edit:status + requisition:view:financials for
  // delivery_manager (the status-only editor; Option C — NO compensation:
  // view:pay). The recruiter REMOVALS (requisition:edit, compensation:
  // edit:pay) are handled by omission upstream (ROLE_SCOPE_ASSIGNMENTS +
  // D5_COMPENSATION_BUNDLES), not here.
  for (const [roleKey, scopeKeys] of REQ_GATING_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = REQ_GATING_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`PR-A1 Req-Gating-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Settings Rebuild D1 — Import/Export read-scope grants (10 rows;
  // import:read × 8 operational + export:read × 2 admin). Range 0x900+.
  for (const [roleKey, scopeKeys] of IMPORT_EXPORT_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = IMPORT_EXPORT_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`Settings-D1 Import/Export-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Settings Rebuild D2 — audit:read grants (2 rows; tenant_admin +
  // tenant_owner). Range 0x910+.
  for (const [roleKey, scopeKeys] of AUDIT_READ_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = AUDIT_READ_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`Settings-D2 Audit-Read-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Settings Rebuild D3 — tenant:admin:profile grants (2 rows; tenant_admin +
  // tenant_owner). Range 0x920+.
  for (const [roleKey, scopeKeys] of PROFILE_ADMIN_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = PROFILE_ADMIN_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`Settings-D3 Profile-Admin-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Settings Rebuild D4 — tenant:admin:sites grants (2 rows; tenant_admin +
  // tenant_owner). Range 0x930+.
  for (const [roleKey, scopeKeys] of SITES_ADMIN_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = SITES_ADMIN_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`Settings-D4 Sites-Admin-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // §5 Auth-Hardening D4 — tenant:user:read:assignable grants (9 rows; the
  // work-assigning operational tier). Range 0x940+.
  for (const [roleKey, scopeKeys] of ASSIGNABLE_USERS_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = ASSIGNABLE_USERS_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`AuthHardening-D4 Assignable-Users-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // §5 Auth-Hardening D4b — tenant:user:read:directory grants (10 rows; the
  // list-view viewers = the 9 + finance). Range 0x950+.
  for (const [roleKey, scopeKeys] of DIRECTORY_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = DIRECTORY_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`AuthHardening-D4b Directory-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Domain-Enforcement P2b — tenant:admin:domain grants (2 rows; tenant_admin +
  // tenant_owner). Range 0x960+.
  for (const [roleKey, scopeKeys] of DOMAIN_ADMIN_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = DOMAIN_ADMIN_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`Domain-Enforcement-P2b Domain-Admin-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // TR-2a-3 — identity:resolve grants (2 rows; tenant_admin + tenant_owner).
  // Range 0x970+.
  for (const [roleKey, scopeKeys] of IDENTITY_RESOLVE_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = IDENTITY_RESOLVE_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`TR-2a-3 Identity-Resolve-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // D3b — Charter §4 Amendment activity:redact grants (4 rows; tenant_owner +
  // tenant_admin + recruiting_manager + lead_recruiter). Range 0x980+.
  for (const [roleKey, scopeKeys] of ACTIVITY_REDACT_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = ACTIVITY_REDACT_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`D3b Activity-Redact-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Track 3 / E2 (Pre-Start Requirement) grants (23 rows; 8 roles). Range 0x990+.
  // waive_blocking + read_restricted_evidence get NO rows (§13c-1, registered-unassigned).
  for (const [roleKey, scopeKeys] of PRE_START_REQUIREMENT_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = PRE_START_REQUIREMENT_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`E2 Pre-Start-Requirement-Seed: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Track 3 / E1-b + E4 (PlacementProcess) placement role-matrix grants (21 rows;
  // 4 roles). Range 0xa00+. recruiter gets read/create/transition; account_
  // manager/tenant_admin/tenant_owner get the full six (E4 adds placement:replace).
  // super_admin + every other role get NO rows (fail-closed; no prose-hierarchy
  // inheritance).
  for (const [roleKey, scopeKeys] of PLACEMENT_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = PLACEMENT_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`E1-b Placement-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Track 7 / T7-P1 — PermanentPlacement guarantee role-matrix grants (7 rows;
  // range 0xd00+). read -> all four grant-receiving roles; transition -> the
  // authoritative tier only (recruiter excluded). Separate range so PLACEMENT's
  // 0xa00 grants are not renumbered.
  for (const [roleKey, scopeKeys] of PERMANENT_PLACEMENT_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = PERMANENT_PLACEMENT_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`T7-P1 Permanent-Placement-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Track 7 / T7-P2 — remedy-resolution role-matrix grants (3 rows; range 0xe00+).
  // account_manager/tenant_admin/tenant_owner only (recruiter excluded).
  for (const [roleKey, scopeKeys] of PERMANENT_REMEDY_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = PERMANENT_REMEDY_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`T7-P2 Permanent-Remedy-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Track 7 / T7-P3 — guarantee-terms management role-matrix grants (3 rows; range 0xf00+).
  // account_manager/tenant_admin/tenant_owner only (recruiter excluded).
  for (const [roleKey, scopeKeys] of PERMANENT_TERMS_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = PERMANENT_TERMS_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`T7-P3 Permanent-Terms-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Track 4 / T4-D — ContractAssignment role-matrix grants (13 rows; range 0xb00+).
  // Mirrors the placement authoritative tier: recruiter gets assignment:read only;
  // account_manager/tenant_admin/tenant_owner get read/create/update/end.
  for (const [roleKey, scopeKeys] of ASSIGNMENT_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = ASSIGNMENT_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`T4-D Assignment-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Track 8 / T8-P2 — canonical requisition-import role-matrix grants (7 rows;
  // range 0xc00+). read -> the four requisition-adjacent roles; write -> the
  // authoritative tier only (recruiter excluded).
  for (const [roleKey, scopeKeys] of REQUISITION_IMPORT_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = REQUISITION_IMPORT_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`T8-P2 Requisition-Import-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Track 8 / T8-CONNECTOR-A — connector-connection management grants (4 rows;
  // range 0xc10+). integration:read + integration:write -> tenant_admin +
  // tenant_owner ONLY (recruiter/account_manager excluded).
  for (const [roleKey, scopeKeys] of INTEGRATION_MANAGEMENT_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = INTEGRATION_MANAGEMENT_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`T8-CONNECTOR-A Integration-Management-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // L2-I (D1) — Pipeline provider-disposition MAPPING administration grants (2 rows;
  // range 0xf10+). integration:pipeline-mapping:write -> tenant_admin + tenant_owner ONLY.
  for (const [roleKey, scopeKeys] of PIPELINE_MAPPING_ADMIN_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = PIPELINE_MAPPING_ADMIN_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(`L2-I Pipeline-Mapping-Admin-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`);
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Requisition Approval sub-workflow — approval-authority grants (3 rows; range
  // 0xc30+). requisition:approve -> account_manager + tenant_admin + tenant_owner
  // (recruiter excluded; approval is a segregated-duty authority).
  for (const [roleKey, scopeKeys] of APPROVAL_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId =
        APPROVAL_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(
          `Approval-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`,
        );
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Offer Lifecycle — offer authority grants (8 rows; range 0xc40+).
  // offer:create + offer:transition -> recruiter + account_manager + tenant_admin
  // + tenant_owner (mirrors the placement:create/transition tier).
  for (const [roleKey, scopeKeys] of OFFER_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = OFFER_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(
          `Offer-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`,
        );
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // COMM-B2 (Aramo-COMM-V1 R-COMM-ROLES) — Communications/Voice grants (16 rows;
  // range 0xc50+). The four communication:* scopes -> recruiter + account_manager
  // + tenant_admin + tenant_owner (frontline recruiting work; NOT admin-tier).
  for (const [roleKey, scopeKeys] of COMMUNICATION_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = COMMUNICATION_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(
          `Communication-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`,
        );
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Lane 2 / L2-F (F1) — ClientSelectionProcess grants (12 rows; range 0x1000+).
  // The three client-selection:* scopes -> recruiter + account_manager + tenant_admin
  // + tenant_owner (frontline ATS delivery work; mirrors placement:create/read/transition).
  for (const [roleKey, scopeKeys] of CLIENT_SELECTION_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = CLIENT_SELECTION_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(
          `ClientSelection-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`,
        );
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // Lane 2 / L2-F (F2) — InterviewSession grants (8 rows; range 0x100c+). The two
  // interview:* scopes -> the same four ATS delivery roles as F1.
  for (const [roleKey, scopeKeys] of CLIENT_SELECTION_INTERVIEW_SEED_BUNDLES) {
    const role_id = roleIdForKey(roleKey);
    for (const scopeKey of scopeKeys) {
      const rsId = CLIENT_SELECTION_INTERVIEW_SEED_ROLE_SCOPE_ROW_IDS[`${roleKey}:${scopeKey}`];
      if (rsId === undefined) {
        throw new Error(
          `ClientSelection-Interview-Role-Matrix: Missing generated RoleScope id for ${roleKey}:${scopeKey}`,
        );
      }
      const scope_id = scopeIdForKey(scopeKey);
      await prisma.roleScope.upsert({
        where: { role_id_scope_id: { role_id, scope_id } },
        update: {},
        create: { id: rsId, role_id, scope_id },
      });
    }
  }

  // 3 + 8 + 4 + the four creation-audit rows below are ALL DEV-FIXTURE —
  // they describe the admin@aramo.dev user's membership, role, external
  // identity, and the audit trail of the Aramo-Dev-Tenant/admin creation.
  // Gated as one block; the catalog-describing role/scope audit rows that
  // follow are UNCONDITIONAL (catalog) and remain outside this guard.
  if (includeDevFixtures) {
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

    // 10. IdentityAuditEvent — one row per dev-fixture creation.
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
  }

  // The catalog-describing audit rows (role/scope creations) — UNCONDITIONAL.
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
    id: SEED_IDS.audit_events.scope_platform_tenant_lifecycle_manage_created,
    tenant_id: null,
    event_type: 'identity.scope.created',
    subject_id: SEED_IDS.scopes['platform:tenant:lifecycle:manage'],
    payload: {
      scope_id: SEED_IDS.scopes['platform:tenant:lifecycle:manage'],
      key: 'platform:tenant:lifecycle:manage',
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
    { audit_id: SEED_IDS.audit_events.scope_talent_source_created, key: 'talent:source' },
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
