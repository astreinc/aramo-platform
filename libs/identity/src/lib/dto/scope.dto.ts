// Seed scope catalog (directive §6, initial catalog).
// Format <domain>:<action>; matches regex
// /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_:-]*$/ per §9 test 18.
// Adding a scope key requires a directive amendment.
//
// PR-A1a Ruling 2 / Ruling 3 expansion (2026-06-01): adds a minimal
// representative set of ATS + Portal scopes proving the catalog
// expansion mechanism. The full 36-scope ATS/Portal catalog from the
// Gate-5 prompt §5 is deferred to PR-A1a-2 (PL-62 split per Ruling 7);
// the 7 scopes added here exercise (a) the recruiter→submittal:create
// /:approve enforcement proof for §6, (b) the tenant_admin-only
// requisition:read:all divergence from the OpenCATS floor, and
// (c) the candidate-role portal:profile / portal:consent surface.
// PR-A1a-2 expansion (2026-06-01) extends the catalog with the full ATS
// scope surface per directive §3.1. Ruling 1 uniform divergence: every
// `:delete` (destructive) and every `:read:all` (see-all) is reserved to
// `tenant_admin`. Recruiter keeps the full operational workflow —
// `:create` / `:edit` / `talent:search` / `pipeline:add|change-status|
// add-activity` / `calendar:event-create|edit` / assigned `:read`.
// Viewer is read-only on the domain entities recruiter can see (+ search +
// examination/activity reads).
//
// Note: the selection-domain scopes shipped at R7 BE-prereq (3 scopes:
// selection:read/write/outreach; outreach SoD per Lead ruling). The
// remaining `submittal:read` deferral (the bare GET /v1/submittals/:id
// route) stays a separate carry — own follow-on PR.
export const SEED_SCOPE_KEYS = [
  // Existing pre-A1a catalog
  'consent:read', // EXIT_HYG (HYG-1) — live internal ConsentController surface; keep-or-gate is a Consent/Portal-lane ruling. See Dead-Residue Ledger.
  'consent:write', // EXIT_HYG (HYG-1) — same; owning-lane ruling required.
  'consent:decision-log:read',
  'auth:session:read', // ACTIVE_RESERVED — baseline session-established marker; gate role superseded by consumer_type gating, retained pending the F31 scope-registry design.
  'identity:user:read', // ACTIVE_RESERVED — Lead-ratified auditor/compliance bundle; read surface deferred to the Reporting/Audit DDR (no live handler yet).
  'identity:tenant:read', // ACTIVE_RESERVED — same auditor/compliance bundle; read surface deferred.
  // PR-A1a ATS subset (3)
  'requisition:read',           // assigned-to-me (default recruiter); see :all below
  'requisition:read:all',       // see-all (tenant_admin only — Aramo divergence from OpenCATS coarse EDIT/DELETE tier)
  'submittal:create',           // recruiter
  'submittal:approve',          // recruiter
  // PR-A1a Portal subset (4) — for the `candidate` role
  'portal:profile:read',
  'portal:profile:edit',
  'portal:consent:read',
  'portal:consent:write',
  // Portal P3a — candidate verification view + dispute rights (3).
  'portal:verification:read',
  'portal:dispute:read',
  'portal:dispute:write',
  // PR-A1a-2 ATS expansion (27 scopes; Ruling 1 uniform divergence).
  // talent domain (6)
  'talent:read',                // recruiter+ (assigned)
  'talent:create',              // recruiter+
  'talent:edit',                // recruiter+
  'talent:delete',              // tenant_admin only (Ruling 1 destructive)
  'talent:search',              // recruiter+ (Constrained Talent Access per A1a audit)
  'talent:source',              // sourcer+ — promote a sourced L2 subject into an ATS TalentRecord (Promotion-Trigger slice-A)
  // company domain (4)
  'company:read',               // recruiter+
  'company:create',             // recruiter+
  'company:edit',               // recruiter+
  'company:delete',             // tenant_admin only
  // contact domain (4)
  'contact:read',               // recruiter+
  'contact:create',             // recruiter+
  'contact:edit',               // recruiter+
  'contact:delete',             // tenant_admin only
  // pipeline domain (4)
  'pipeline:add',               // recruiter+
  'pipeline:change-status',     // recruiter+
  'pipeline:complete',          // CATALOG_ONLY_ZERO_GRANT — L2-C SB-3 system-only COMPLETE capability; NO human role grant (held by system/downstream identities only)
  // calendar domain (3)
  'calendar:event-create',      // recruiter+
  'calendar:event-edit',        // recruiter+ (own events)
  'calendar:event-delete',      // tenant_admin only
  // activity + examination + requisition (5)
  'activity:read',              // back_office+
  'examination:read',           // ACTIVE_RESERVED — examination-read gate reserved by the OpenAPI contract (x-required-scope on 5 routes); no live handler yet. back_office+ (read-only Core output).
  'requisition:create',         // recruiter+
  'requisition:edit',           // recruiter+
  'requisition:delete',         // tenant_admin only
  // tenant admin (2)
  'tenant:admin:user-manage',   // tenant_admin only
  'tenant:admin:settings',      // tenant_admin only
  // HK-IDENT-SCOPES — 6 deferred ATS scopes (retires A3/A4/A5a gap bundle).
  // attachment:delete is recruiter+ via a BOUNDED Ruling 1 carve-out
  // (detach is a junction/link delete, NOT entity destruction).
  'requisition:assign',         // tenant_admin only (assignment is an admin act)
  'attachment:read',            // recruiter+
  'attachment:create',          // recruiter+
  'attachment:delete',          // recruiter+ (Ruling 1 carve-out — junction/link delete)
  'pipeline:read',              // recruiter+
  // Lane 2 / L2-F (F1) — the Client-Selection owner (enforced in ClientSelectionController +
  // the apps/api create-from-submittal orchestration). GRANTED to the ATS delivery matrix
  // (recruiter, account_manager, tenant_admin, tenant_owner) — mirrors placement:create.
  'client-selection:create',     // recruiter+ (create-from-submittal orchestration)
  // Lane 2 / L2-F (F2) — InterviewSession child (enforced in ClientSelectionController).
  'client-selection:interview:schedule',   // recruiter+ (idempotency-gated schedule)
  'client-selection:interview:transition', // recruiter+ (session CAS transition)
  'client-selection:read',       // recruiter+
  'client-selection:transition', // recruiter+
  'activity:create',            // recruiter+
  // AUTHZ-D4a — 4 team-model mechanism + see-all scopes (DDR Amendment v1.1
  // §4/§6; Lead Gate-5 ruling 2 narrows company:read:all to TA+TO only to
  // mirror requisition:read:all — the see-all stays reserved to the top tier,
  // and operational-tier breadth comes from D4b's predicate, not a see-all).
  'company:assign',             // account_manager + tenant_admin + tenant_owner (mirrors requisition:assign as AM act; RM does NOT get it)
  'org:manage',                 // recruiting_manager + tenant_admin + tenant_owner (Axis-1 management-edge mgmt; distinct from tenant:admin:user-manage which is user provisioning)
  'team:manage',                // account_manager + tenant_admin + tenant_owner (Axis-2 pod create/membership/ownership; AM is the pod operator per §5.4)
  'company:read:all',           // tenant_admin + tenant_owner ONLY (mirrors requisition:read:all; see-all reserved to top tier)
  // Company-Fields v1.1 — field-gate scope for the Company COMMERCIAL layer
  // (fee_model / markup / perm-fee / payment_terms / credit_status /
  // currency). Mirrors the compensation field-masking pattern (apps/api
  // interceptor omits the fields for non-holders; the company repo strips
  // them on write). ONE scope governs read AND write (commercial fields are
  // pre-fill defaults — no see-but-not-edit split). Granted to the
  // agency-economics tier: tenant_admin + tenant_owner + account_manager
  // (NOT base recruiter; NOT the delivery tier).
  'company:read_commercial',    // tenant_admin + tenant_owner + account_manager (agency margin = client economics)
  // AUTHZ-2 — platform-tier scopes (a SEPARATE namespace from the 47 tenant
  // scopes above; Lead ruling 5 — the 3-scope minimum set). The bundle is
  // assigned only to the platform `super_admin` role; no tenant role holds
  // any platform:* scope, and no platform role holds any tenant scope. The
  // DDR §13.1 tripwire is enforced by namespace partition + the consumer_type
  // check at the guard layer. Deferrals (gap-and-noted to later platform
  // PRs): platform:tenant:deactivate, platform:tenant:entitlement:edit,
  // platform:billing:*, platform:audit:read.
  'platform:tenant:provision',  // super_admin only — create tenant + entitlement seed + Tenant-Owner invite
  'platform:tenant:read',       // super_admin only — list/read tenants for the platform view
  'platform:admin:invite',      // super_admin only — invite another platform admin (against the platform Cognito pool)
  // F-2 reconciliation — Platform-Console Increment-2 PR-1 added this to
  // PLATFORM_SCOPE_KEYS + SEED_IDS.scopes + upsertScope but never to this
  // catalog, so SEED_SCOPE_KEYS drifted 1 below the id-map. Now reconciled;
  // the scope-catalog parity guard no longer needs an exemption.
  'platform:tenant:lifecycle:manage',  // super_admin only — suspend/reactivate/offboard/close operator endpoints
  // AUTHZ-D5 — 6 compensation:view:* scopes (the field-masking scope
  // family). The FINAL authorization PR — field-level masking of the
  // requisition read DTO's compensation surface (D4b masked WHICH
  // RECORDS; D5 masks WHICH FIELDS). Keyed at the response interceptor
  // (apps/api CompensationFieldMaskInterceptor) via libs/field-masking.
  // The LOCKED role-to-view matrix lives at libs/identity/prisma/seed.ts
  // D5_COMPENSATION_BUNDLES. THE ENFORCED INVARIANT: no role holds both
  // view:pay AND any spread scope (proven by seed.spec).
  'compensation:view:pay',              // recruiter / recruiting_manager / lead_recruiter / back_office / TA + TO
  'compensation:view:bill',             // account_manager + TA + TO (with placement_fee_*)
  'compensation:view:revenue',          // account_manager + finance + delivery_manager + TA + TO (bill_rate_* only)
  'compensation:view:spread:amount',    // delivery_manager + TA + TO (margin_amount; NOT view:pay holders)
  'compensation:view:spread:percent',   // account_manager + delivery_manager + TA + TO
  'compensation:view:margin:percent',   // account_manager + finance + delivery_manager + TA + TO
  // D-AUTHZ-COMP-WRITE-1 — 2 compensation:edit:* scopes (the WRITE-side
  // floor; closes the D5 write-path circumvention). Enforced IN-SERVICE
  // at the requisition repository (create / update / createForImport)
  // BEFORE the Prisma write + BEFORE audit. The minimum-coherent write
  // set: the 4 derived/subset view scopes (revenue / spread:* /
  // margin:%) gate read-only DERIVED fields — no writeable surface.
  'compensation:edit:pay',              // recruiter / RM / LR / back_office / TA + TO (mirrors view:pay's writeable subset)
  'compensation:edit:bill',             // account_manager + TA + TO (mirrors view:bill's writeable subset; AM is the agency-economics author)
  // Reporting-Scope-Seed — 2 reporting:* scopes (PR-A7 gap-and-note
  // closure). dashboard:read gates GET /v1/dashboard (the ATS-internal
  // composition route); report:read gates the 4 GET /v1/reports/*
  // per-metric routes. ATS-internal-only by design (libs/reporting
  // seam-exclusion: includes_core_submittal_placements: false). Granted
  // to the 8 OPERATIONAL roles only (TA / TO / AM / RM / recruiter[floor]
  // / LR / BO / DM). NOT granted to auditor / auditor_with_financials —
  // the auditor-tier compliance-read surface (report:read at the
  // auditor tier + audit-log:read) is deferred to the un-authored
  // Reporting/Audit DDR (Reporting-Scope-Seed v1.1 Ruling B-iii).
  'dashboard:read',                     // 8 operational roles (recruiter floor; tenant_admin/owner/AM/RM/LR/BO/DM)
  'report:read',                        // 8 operational roles (mirrors dashboard:read; auditor-tier deferred to Reporting/Audit DDR)
  // R7 BE-prereq — selection-domain scopes (closes the A1a-2 deferral).
  // 3-scope split per Lead Amendment v1.1 §1 Ruling B (outreach SoD):
  // outreach is the only selection write with EXTERNAL side-effects
  // (AI draft + consent-at-send + outbound delivery + LLM cost) — gets
  // its OWN scope so "record-but-not-send" is encodable.
  'selection:read',                    // 8 roles: write-tier 6 + read-only 2 (delivery_manager / back_office)
  'selection:write',                   // 6 write-tier roles: TA / TO / AM / RM / LR / recruiter (floor)
  'selection:outreach',                // 6 write-tier roles (mirrors :write; outreach SoD encoding)
  // Search PR-1 — per-entity quick-search scopes (Lead rulings R1/R2). The
  // ?q= text-search parameter on the per-entity LIST endpoints is gated on
  // these scopes WHEN q is present (the no-q LIST keeps its existing :read
  // gate). talent:search ALREADY exists (above) and is REUSED for
  // /v1/talent-records?q= — its grant set stays the A1a "Constrained Talent
  // Access" deliberately-narrow set (NOT expanded to talent:read parity; see
  // seed.ts SEARCH note). These 3 NEW scopes follow per-entity :read-holder
  // parity (R2): each is granted to the roles that hold the entity's :read
  // scope. The trigram match still NARROWS within the entity's existing
  // visibility predicate — search grants ACCESS, the resolver governs WHAT
  // is seen.
  'company:search',                     // 9 company:read holders (TA/TO/AM/RM/recruiter/LR/BO/DM/sourcer)
  'requisition:search',                 // 10 requisition:read holders (the 9 above + finance)
  'contact:search',                     // 9 contact:read holders (mirrors company:read set)
  // Tasks backend (2) — the actionable/assignable to-do (the last core
  // recruiter surface). Granted to the 9 activity:create operational roles.
  'task:read',                          // 9 operational roles
  'task:write',                         // 9 operational roles
  // Job-Module (LB-4) — 2 requisition:*:financials scopes (the 3rd
  // consumer of the field-masking + edit-gate pattern; rule-of-three
  // discharged by promoting omitFieldsByScopeMap). A DISTINCT financial-
  // PLANNING surface (target_margin_percent / markup_percent_target /
  // rate_card_id / min|max_bill_rate / min|max_pay_rate) — NOT the 13
  // compensation actuals, so kept OUT of the D5 non-invertibility family
  // (own scope, own field set). view:financials masks the read DTO via
  // libs/field-masking financials-field-map; edit:financials write-gates
  // at the requisition repository (create / update / createForImport)
  // BEFORE the Prisma write. Granted to the agency-economics tier
  // (tenant_admin + tenant_owner + account_manager) — MIRRORS
  // company:read_commercial; NOT base recruiter, NOT the delivery tier.
  'requisition:view:financials',        // tenant_admin + tenant_owner + account_manager (read-mask)
  'requisition:edit:financials',        // tenant_admin + tenant_owner + account_manager (write-gate)
  // PR-A1 Requisition-Gating Rework — 3 requisition-gating scopes (consolidates
  // the 7-role gating matrix; Directive v1.0 as amended by v1.1). Allocated
  // from 0xa5 (next free after requisition:edit:financials 0xa4).
  //   - edit:status is the NET-NEW status-only edit tier (INVERTED gate:
  //     restrict-to-subset). A holder of requisition:edit:status WITHOUT
  //     requisition:edit may PATCH only the `status` field; any other field
  //     → 403. Granted to delivery_manager ONLY (full editors use
  //     requisition:edit, which covers status as before).
  //   - profile:generate gates the AI JD+GoldenProfile draft/confirm
  //     endpoints (re-gated off requisition:edit per #226); profile:edit
  //     gates editing the generated GoldenProfile. Both granted to the
  //     5-role management tier (TA + TO + AM + recruiting_manager +
  //     lead_recruiter); base recruiter does NOT hold them.
  'requisition:edit:status',            // delivery_manager only (status-only edit tier; restrict-to-subset gate)
  'requisition:profile:generate',       // TA + TO + AM + recruiting_manager + lead_recruiter (AI JD/profile draft+confirm)
  'requisition:profile:edit',           // TA + TO + AM + recruiting_manager + lead_recruiter (edit the generated GoldenProfile)
  // Settings Rebuild D1 — the 2 read scopes behind the settings Import +
  // Export LIVE sections (closes the substrate-audit gap-and-note: both were
  // referenced by their controllers but never in this catalog).
  'import:read',                        // recruiter+ operational tier (read CSV-import history + failures)
  'export:read',                        // tenant_admin + tenant_owner (CSV export of the 5 R10-bounded ATS entities)
  // Settings Rebuild D2 — the audit-log read scope (GET /v1/tenant/audit-events).
  'audit:read',                         // tenant_admin + tenant_owner (admin/compliance read of the audit trail)
  // Settings Rebuild D3 — the tenant-profile admin scope (GET/PATCH /v1/tenant/profile).
  'tenant:admin:profile',               // tenant_admin + tenant_owner (DEDICATED; org legal identity, kept separable from settings)
  // Settings Rebuild D4 — the sites/branches admin scope (CRUD /v1/tenant/sites).
  'tenant:admin:sites',                 // tenant_admin + tenant_owner (DEDICATED; org STRUCTURE — sub-tenant branch partitions + hierarchy)
  // §5 Auth-Hardening D4 — the recruiter-tier MINIMAL assignable-roster read
  // (GET /v1/tenant/assignable-users). The users analogue of company:read for
  // the assign pickers; NOT the admin tenant:admin:user-manage surface.
  'tenant:user:read:assignable',        // 9 work-assigning operational roles (the task:read/:write tier); minimal roster only (id+display_name)
  // §5 Auth-Hardening D4b — the recruiter-tier name-RESOLVER read
  // (GET /v1/tenant/users/directory). The "whose-name-is-this" half: id→name
  // for ALL tenant users INCL. inactive/departed (historical integrity), so it
  // is DISTINCT from the active-only assignable picker. Minimal id+display_name.
  'tenant:user:read:directory',         // 10 list-view viewers (the 9 assignable roles + finance, who reads the req/talent lists); name-resolution only
  // Domain-Enforcement P2b — the DNS-TXT domain-verification admin scope
  // (GET/POST /v1/tenant/domain-verification + /check).
  'tenant:admin:domain',                // tenant_admin + tenant_owner (DEDICATED; prove DNS ownership of the locked domain — informational, gates nothing)
  // TR-2a-3 — privileged within-tenant identity-resolution (same-human advisory
  // merge / dismiss / un-merge). tenant_admin + tenant_owner ONLY (NOT recruiters).
  'identity:resolve',                   // tenant_admin + tenant_owner (DEDICATED; approve/dismiss/reverse a same-human match advisory — the merge action)
  // D3b — Charter §4 Amendment activity redaction. author-OR-scope: any author
  // redacts their own note; this scope grants cross-author redaction to the
  // oversight tier. NOT admin-only — a lead reviewing their pod's feed is the
  // one who spots a note that shouldn't be there. Redaction is auditable and
  // reversible-never, not destructive; it is not gated like *:delete.
  'activity:redact',                    // tenant_owner + tenant_admin + recruiting_manager + lead_recruiter
  // Track 3 / E2 (Pre-Start Requirement) — SEVEN scopes (v1.2.1). read/act → the 8
  // operational roles; configure/publish → tenant_admin + tenant_owner;
  // waive_advisory → AM/RM/DM; waive_blocking + read_restricted_evidence are
  // REGISTERED WITH ZERO GRANTS (§13c-1). NO scope.created (scope-seed precedent).
  'pre_start_requirement:read',
  'pre_start_requirement:act',
  'pre_start_requirement:configure',
  'pre_start_requirement:publish',
  'pre_start_requirement:waive_advisory',
  'pre_start_requirement:waive_blocking',
  'pre_start_requirement:read_restricted_evidence',
  'pre_start_requirement:reopen',
  'pre_start_requirement:verify',
  // Track 3 / E1-b — PlacementProcess HTTP surface. Dedicated placement:* scopes
  // (E1-b Approval Record §2 — no ATS-scope reuse). The transition route enforces
  // the 14-edge matrix; the authority split is DERIVED from that matrix under the
  // ratified classification: ordinary progression=transition, live/capacity=activate,
  // terminal/irreversible=terminate. Granted by the ratified #577 placement role
  // matrix (PLACEMENT_SEED_BUNDLES): recruiter holds read/create/transition;
  // account_manager/tenant_admin/tenant_owner additionally hold activate/terminate
  // (+ replace, E4).
  'placement:read',
  'placement:create',
  'placement:transition',
  'placement:activate',
  'placement:terminate',
  // Track 3 / E4 — replacement authorization; granted (E4 matrix) to
  // account_manager/tenant_admin/tenant_owner, required in conjunction with
  // placement:create for a replacement create.
  'placement:replace',
  // Track 7 / T7-P1 — PermanentPlacement guarantee authority. Dedicated least-
  // privilege scopes (§8): read governs the guarantee read surface; transition
  // governs the guarantee lifecycle (GUARANTEE_ACTIVE -> GUARANTEE_SATISFIED) AND
  // is the second leg of the PERMANENT STARTED conjunction (mirroring
  // assignment:commercials:write for CONTRACT). NEVER satisfied by generic
  // placement:* / assignment:*. Role posture mirrors the placement authoritative
  // tier: read -> all four grant-receiving roles; transition ->
  // account_manager/tenant_admin/tenant_owner (the tier holding placement:activate).
  // Falloff/remedy (T7-P2) and guarantee-terms management (T7-P3) authorities follow.
  'placement:permanent:read',
  'placement:permanent:transition',
  // Track 7 / T7-P3 — the DEDICATED guarantee-terms management authority (§3.7). Governs
  // creating/revising the reusable requisition-keyed guarantee-term versions (POST
  // /v1/permanent-placement-guarantee-terms/requisitions/:requisitionId[/revise]). Reads use
  // placement:permanent:read. GRANTED to account_manager, tenant_admin, tenant_owner; recruiter
  // excluded (least privilege — terms authorship is authority-separated from operational work).
  'placement:permanent:terms:write',
  // Track 7 / T7-P2 — the DEDICATED remedy-resolution authority (§3.6). Governs the
  // evidence-gated remedy completion (POST /v1/placements/:id/permanent/remedy/complete)
  // — a high-consequence act authority-separated from the guarantee lifecycle:
  // placement:permanent:transition does NOT satisfy it. GRANTED to account_manager,
  // tenant_admin, tenant_owner; recruiter excluded. Falloff itself uses permanent:transition.
  'placement:remedy:resolve',
  // Track 4 / T4-D — ContractAssignment authority (the authoritative post-start
  // commitment). Dedicated family: reuse of requisition:assign / company:assign
  // (user<->entity assignment) and generic placement:* is rejected as semantically
  // wrong (§7). Role posture MIRRORS the placement authoritative tier
  // (ASSIGNMENT_SEED_BUNDLES): read -> all four grant-receiving roles; create/
  // update/end -> account_manager/tenant_admin/tenant_owner only (the tier holding
  // placement:activate/terminate). recruiter does operational placement work, NOT
  // authoritative post-start assignment mutation.
  'assignment:read',
  'assignment:end',
  'assignment:extend',
  // Track 5 / T5-P1 — assignment commercial-terms (Assignment Rate Version)
  // authority. Dedicated financial permissions (Amendment A2 DEC-4): NEVER
  // satisfied by placement:*, requisition-financials, or the generic
  // assignment mutation authority. commercials:write is the second leg of the FORWARD
  // STARTED conjunction; commercials:read independently governs financial
  // disclosure (least visibility — assignment:read does NOT grant it).
  'assignment:commercials:read',
  'assignment:commercials:write',
  // Slice #4 — Commercial Approval: exercise commercial AUTHORITY over a proposed
  // revision (margin-approve / client-approve / apply / reject). SEPARATE from
  // commercials:write (propose != approve; segregation of duties).
  'assignment:commercials:approve',
  // Track 8 / T8-P2 — provider-neutral canonical requisition ingestion (VMS
  // Integration). Distinct from the generic CSV `import:*` family: this governs
  // the external-system requisition ingestion surface (/v1/requisition-imports).
  // read -> recruiter/account_manager/tenant_admin/tenant_owner (mirrors
  // assignment:read); write -> account_manager/tenant_admin/tenant_owner only
  // (authoritative-tier act, recruiter excluded — mirrors the authoritative tier).
  'requisition:import:read',
  'requisition:import:write',
  // Track 8 / T8-CONNECTOR-A — provider-neutral connector-connection MANAGEMENT
  // (Settings → Integrations). Distinct from requisition:import:* (which governs
  // P3 ingestion monitoring): this governs connector connection administration
  // (list/configure/enable/disable). read + write GRANTED to tenant_admin +
  // tenant_owner ONLY (administrative tier; recruiter/account_manager excluded).
  // The connector ServiceAccount does NOT hold these — its execution authority
  // is requisition:import:write only.
  'integration:read',
  'integration:write',
  // L2-I (D1) — manage the per-connection PIPELINE provider-disposition MAPPING contract
  // (author/version the provider-token → canonical-Pipeline-action/reason mapping). A NARROW
  // administrative permission for the mapping contract itself — NOT pipeline mutation
  // (distinct from pipeline:change-status) and NOT the broad integration:write. GRANTED to
  // tenant_admin + tenant_owner ONLY (administrative tier; recruiter/account_manager excluded).
  'integration:pipeline-mapping:write',
  // COMM-C3 — Tenant Engagement Policy administration (Settings → Recruiting).
  // read: view the effective engagement policy + evidence-channel capabilities.
  // write: publish a new immutable engagement-policy version. Dedicated admin
  // scopes (R16); NOT reused from communication/integration authority. GRANTED to
  // tenant_admin + tenant_owner only.
  'engagement:policy:read',
  'engagement:policy:write',
  // Requisition Approval sub-workflow — decide the pending_approval → open /
  // → draft (APPROVE / REJECT) governed transitions.
  'requisition:approve',
  // Offer Lifecycle — the dedicated pre-placement offer aggregate: create a
  // DRAFT offer, and drive its governed transitions (send/negotiate/accept/…).
  'offer:create',
  'offer:transition',
  // L4 / P5 — read the Offer resource; read its Talent-facing compensation snapshot.
  'offer:read',
  'offer:read:financial',
  // Requisition Lane 1-A (Create-Governance) — the functional create qualifier
  // that unlocks the governed establishment mode (MANUAL-ESTABLISH + SYSTEM).
  // CATALOG-ONLY in v1: granted to NO human tenant role (recruiter/RM/DM/AM
  // never receive it, so no human bypasses draft->approval via the manual
  // path); held programmatically by system/bootstrap identities + passed by
  // test/seed helpers. The INTEGRATION import path does NOT use this — it
  // reuses the existing requisition:import:write.
  'requisition:create:establish',
  // COMM-B2 (Aramo-COMM-V1 R-COMM-SCOPES) — operational Communications/Voice
  // scopes. Frontline recruiting work (NOT admin-tier like integration:*):
  // GRANTED to recruiter, account_manager, tenant_admin, tenant_owner
  // (R-COMM-ROLES). `communication:read` gates the read skeleton shipped in B2;
  // voice:call / disposition:write / notes:write are granted now but their
  // routes land in later slices (B5/B7).
  'communication:read',
  'communication:voice:call',
  'communication:disposition:write',
  'communication:notes:write',
] as const;
export type SeedScopeKey = (typeof SEED_SCOPE_KEYS)[number];

// AUTHZ-2 — the platform-namespace scope subset, used by tests + the
// EntitlementGuard / RolesGuard separation proofs to assert that no tenant
// role bundle contains any of these and no platform role bundle contains
// anything outside this subset.
export const PLATFORM_SCOPE_KEYS = [
  'platform:tenant:provision',
  'platform:tenant:read',
  'platform:admin:invite',
  // Platform-Console Increment-2 PR-1 — tenant lifecycle management, SEPARATE
  // from provision (provisioning power ≠ lifecycle power). Gates the
  // suspend/reactivate/start-offboarding/close operator endpoints. super_admin
  // holds it; finer-grained platform roles are a future seed-only addition.
  'platform:tenant:lifecycle:manage',
] as const;
export type PlatformScopeKey = (typeof PLATFORM_SCOPE_KEYS)[number];

// Scope-key format regex (directive §9 test 18). Authoritative reference
// for both validation and tests.
export const SCOPE_KEY_FORMAT = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_:-]*$/;

// ScopeDto — public shape of the Scope entity.
export interface ScopeDto {
  id: string;
  key: string;
  description: string | null;
  created_at: string;
}
