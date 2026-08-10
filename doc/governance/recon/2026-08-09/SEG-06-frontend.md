# SEG-06 — FRONTEND PRODUCT-SURFACE MAP (Directive §11)

Baseline: origin/main = ca0974090724b36b130f4d39ea5b1ef486d6adf4 (PR #589).
Working tree HEAD = 3a4a3a4 (PR #588, one merge behind). All PR#589 placement-UI
files + App.tsx + RecruiterShell + e2e/surfaces.spec.ts read via `git show origin/main:<path>`.
READ-ONLY audit. Exact counts, no tildes (PL-64).

## FRONTEND APP INVENTORY (4 frontend apps)
- apps/ats-web        — Recruiter Console (React SPA). WEB SURFACE. PRESENT.
- apps/platform-web   — Platform Console (React SPA). WEB SURFACE. PRESENT.
- apps/portal-web     — Talent Portal (React SPA). WEB SURFACE. PRESENT.
- apps/platform-admin — NestJS backend deployable (src/main.ts NestFactory;
  apps/platform-admin/src/main.ts:12-15). NO WEB SURFACE. It is the D1
  platform-tier API (controllers/dto/cognito). EXCLUDED from route map.
  Divergence type (iii-adjacent): the task named it "if it has a web surface" —
  it does not; it is server-only.

============================================================
## APP 1 — apps/ats-web (Recruiter Console)
Router: apps/ats-web/src/App.tsx (origin/main). 59 `path=` occurrences.
Nav: apps/ats-web/src/shell/RecruiterShell.tsx (origin/main), PRIMARY_NAV /
WORK_NAV / ADMIN_NAV. All routes MOUNTED (wired into <Routes>). No unmounted
route component found. One MOUNTED-but-NAV-ORPHAN route (below).

### Top-level (outside RouteGuard)
| Route | Component | Nav | Scope gate | Notes |
|---|---|---|---|---|
| /login | routes/LoginPage | no | none | public |
| /invitations/accept | routes/InvitationAcceptPage | no | none | PUBLIC, session-less (Invite-S3) |
| /email-verifications/confirm | routes/VerifyEmailConfirmPage | no | none | PUBLIC, session-less (TR-3 B2) |
| /ui-gallery | ui/UiGallery | no | none | DEV-ONLY (`import.meta.env.DEV`); excluded from prod build |
| /ui-shell-preview | ui/ShellPreview | no | none | DEV-ONLY; excluded from prod build |

### Authenticated (/*  under RecruiterShell)
| Route | Component | Nav entry | RouteGuard scope | Owning dir |
|---|---|---|---|---|
| / (index) | dashboard/IndexRoute | "My desk" (nav-gated dashboard:read) | route: none | dashboard |
| search | search/SearchView | "Search" (no scope) | none (view gates per-section) | search |
| tasks | task/MyTasksView | "Tasks" | task:read | task |
| requisitions | requisitions/RequisitionsListView | "Requisitions" | requisition:read | requisitions |
| requisitions/new | requisitions/RequisitionCreateView | no (button) | requisition:create | requisitions |
| requisitions/:reqId | requisitions/RequisitionDetailView | no (deep) | requisition:read | requisitions |
| placements | placement/PlacementBoardView | "Placements" | placement:read | placement (T4-E/E1-d) |
| placements/:placementId | placement/PlacementDetailView | no (deep) | placement:read | placement (T4-E/E1-d) |
| talent | talent/TalentListView | "Talent" | talent:read | talent |
| talent/new | talent/TalentCreateView | no | talent:create | talent |
| talent/:talentId | talent/TalentDetailView | no (deep) | talent:read | talent |
| talent/:talentId/edit | talent/TalentEditView | no (deep) | talent:edit | talent |
| sourcing | sourcing/SourcingPoolView | "Sourcing" | talent:source | sourcing |
| identity/advisories | identity-advisories/IdentityAdvisoriesView | "Identity Advisories" | identity:resolve | identity-advisories |
| identity/portal-disputes | portal-disputes/PortalDisputesView | **NO NAV (orphan)** | identity:resolve | portal-disputes |
| trust/proposals | trust-proposals/TrustProposalsView | "Trust Proposals" | talent:read | trust-proposals |
| talent/:talentId/submittal/:requisitionId | submittals/SubmittalWizard | no (deep) | submittal:create | submittals |
| engagements/:engagementId | engagement/EngagementDetailView | no (deep) | engagement:read | engagement |
| companies | companies/CompaniesListView | "Companies" | company:read | companies |
| companies/new | companies/CompanyCreateView | no | company:create | companies |
| companies/:companyId | companies/CompanyDetailView | no (deep) | company:read | companies |
| companies/:companyId/edit | companies/CompanyEditView | no (deep) | company:edit | companies |
| contacts | contacts/ContactsListView | "Contacts" | contact:read | contacts |
| contacts/:contactId | contacts/ContactDetailView | no (deep) | contact:read | contacts |
| companies/:companyId/contacts/new | contacts/ContactCreateView | no (deep) | contact:create | contacts |
| contacts/:contactId/edit | contacts/ContactEditView | no (deep) | contact:edit | contacts |

### admin/* subtree — AdminGate family guard (tenant:admin:*); single nav "Settings" -> /admin
Renders inside SettingsShell (six-group settings rail). Routes: index(redirect ->
/admin/settings/profile), users(UsersListView), org(OrgHierarchyView),
teams(TeamsListView), teams/:teamId(TeamMembersView),
teams/:teamId/clients(TeamClientsView), settings(SettingsView),
settings/profile(TenantProfileSection), settings/branches(BranchesSection),
settings/localization(LocalizationSection), settings/roles(RolesSection),
settings/security(SecuritySection), settings/domain(DomainVerificationSection),
settings/portal(PortalSection), settings/apply(ApplySection),
settings/email(EmailSection), settings/import(ImportSection),
settings/compliance(ComplianceSection), settings/fields(FieldsSection),
settings/integrations(IntegrationsSection), settings/billing(BillingSection),
settings/audit(AuditSection), tools(AdminSection), consent/:talentId(ConsentView),
companies/:companyId/assignments(CompanyAssignmentsView),
requisitions/:requisitionId/assignments(RequisitionAssignmentsView).
= 26 admin subtree Route entries (incl. index redirect). All MOUNTED; single
nav entry only (per-item gating via the family AdminGate, not per-nav-item).

### ats-web E2E status
- File: apps/ats-web/e2e/surfaces.spec.ts (origin/main blob 920bd60). 7 tests,
  test.describe.serial('ats-web live surfaces').
- Placement test present: "Placements: nav visibility, board reachability, board
  -> detail composition (assignment panel, no END for read-only recruiter)".
- Config: apps/ats-web/playwright.config.ts — LIVE stack (apps/api:3000 +
  auth-service:3001 + real Cognito hosted-UI), credentials externalized
  (RC_E2E_USERNAME/PASSWORD/TOTP_SECRET), workers:1, retries:0.
- Target `e2e` defined at apps/ats-web/project.json (playwright command).
- CI: .github/workflows/ci.yml runs `nx affected -t test` / `run-many -t test`
  (line 230/232). NO reference to playwright/e2e/`-t e2e` in either workflow
  (ci.yml, deploy-public-staging.yml). => E2E STATUS = AUTHORED, NOT EXECUTED
  IN CI (requires live Cognito creds + running backends; manual/local only).
- Component tests EXECUTED in CI (`-t test`): PlacementBoardView.spec.tsx,
  PlacementBoard.spec.tsx, PlacementDetailView.spec.tsx,
  AssignmentLifecyclePanel.spec.tsx, board-derivation.spec.ts,
  placement-assignment-api.spec.tsx, placement-matrix-drift.spec.ts.

============================================================
## APP 2 — apps/platform-web (Platform Console)
Router: apps/platform-web/src/App.tsx. Whole app gated requireScope
"platform:tenant:read" (App.tsx:37). /login short-circuits BEFORE guard
(App.tsx:27-33, not a <Route>). Nav: shell/PlatformShell.tsx (Dashboard,
Tenants).
| Route | Component | Nav | Notes |
|---|---|---|---|
| / | dashboard/DashboardView | "Dashboard" | default post-login |
| /tenants | tenants/TenantsListView | "Tenants" | |
| /tenants/new | tenants/ProvisionTenantView | no (button) | |
| /tenants/:id | tenants/TenantDetailView | no (deep) | lifecycle actions client-gated on platform:tenant:lifecycle:manage; server authoritative (App.tsx:11-16) |
| * | Navigate -> / | n/a | catch-all |
All MOUNTED. E2E: ABSENT (no apps/platform-web/e2e, no playwright.config).
Only unit spec = src/tests/platform-web-negative-control.spec.ts (+ view specs).

============================================================
## APP 3 — apps/portal-web (Talent Portal)
Router: apps/portal-web/src/App.tsx. Passwordless login; unauthenticated renders
LoginPage in place (App.tsx:37-43, not a <Route>). Nav: shell/PortalShell.tsx.
| Route | Component | Nav | Notes |
|---|---|---|---|
| / | records/RecordsListView | "Your records" | authenticated landing |
| /records/:id | records/RecordDetailView | no (deep) | |
| /verifications | verifications/VerificationsView | "Verified identity" | |
| /disputes | disputes/DisputesListView | "Disputes" | |
| /disputes/:id | disputes/DisputeDetailView | no (deep) | |
| /notice | notice/NoticeView | "Notice" | |
| /rights | rights/RightsView | "Delete my identity" | RTBF |
| * | Navigate -> / | n/a | catch-all |
No per-route scope prop (session-gated app-wide by passwordless auth). All
MOUNTED. E2E: ABSENT (no e2e dir / playwright config). Specs: LoginPage.spec.tsx
+ src/tests/portal-web-negative-control.spec.ts (+ view specs).

============================================================
## T4-E PLACEMENT SURFACE — GROUNDED (origin/main)
- Placements nav entry: RecruiterShell.tsx PRIMARY_NAV
  `{ to: '/placements', label: 'Placements', icon: <IconBriefcase />, scope: 'placement:read' }`
  (scope-filtered via hasScope). SECTION_LABEL placements:'Placements'.
- /placements board route: App.tsx -> PlacementBoardView, RouteGuard
  requireScope="placement:read". MOUNTED.
- /placements/:placementId detail route: App.tsx -> PlacementDetailView,
  RouteGuard requireScope="placement:read". MOUNTED.
- Composition (PlacementDetailView.tsx): PageHeader + back-link + Card(PlacementCard,
  scopes=session.scopes) + Card(PlacementEventTimeline) + AssignmentLifecyclePanel.
  Container is orchestration-only; owns NO lifecycle/assignment authority; the
  assignment read stays OWNED by the child panel (single read path).
- API calls (placement-api.ts): listPlacements GET /v1/placements[?filter];
  getPlacement GET /v1/placements/{id}; listPlacementEvents GET
  /v1/placements/{id}/events; getPlacementAssignment GET
  /v1/placements/{id}/assignment; endPlacementAssignment POST
  /v1/placements/{id}/assignment/end.
- Safe-END affordance (AssignmentLifecyclePanel.tsx): canRead =
  hasScope(assignment:read); canEnd = hasScope(assignment:end); showEndControl =
  isActive (lifecycle_state==='ACTIVE') && canEnd. Comment (verbatim): "the END
  control follows assignment:end (a distinct scope — placement:* does NOT satisfy
  it) AND lifecycle_state === 'ACTIVE'." placement:* never satisfies. END is a
  REAL live op (EndAssignmentDialog -> endPlacementAssignment -> POST
  .../assignment/end; end_reason from ASSIGNMENT_END_REASON_VALUES taxonomy
  COMPLETED/WORKER_ENDED/CLIENT_ENDED). Post-success re-reads server truth
  (onEnded -> refresh), never flips lifecycle client-side.
- Transition-write DEFERRED: PlacementCard renders transition affordances ONLY
  when `onAction` is supplied (PlacementCard.tsx: "Transition affordances render
  ONLY when the composition supplies an `onAction` handler ... no dead/inert
  transition button is shown"). PlacementDetailView mounts
  `<PlacementCard placement=... scopes=... />` WITHOUT onAction => placement
  lifecycle transition-write (activate/terminate) is DEFERRED (no dead control).
- Capacity UI ABSENT: AssignmentLifecyclePanel comment "Capacity is out of scope
  on this surface: no capacity field is read and none is derived here." No
  capacity field in placement-api / types on this surface.
- E2E status: COMPONENT-PROVEN (spec files run in CI `-t test`). LIVE E2E is
  AUTHORED in surfaces.spec.ts but NOT executed in CI. The authored live test
  asserts read-only recruiter (no assignment:end) => `assignment-end-action`
  has count 0; it does NOT drive an ACTIVE->END transition. Consistent with
  memory: live-E2E-not-established / ACTIVE->END fixture-blocked.

============================================================
## (1) BACKEND CAPABILITY WITH NO USER-VISIBLE PRODUCT SURFACE (identify only)
- assignment:create / assignment:update — scope family seeded on BE (Track 4
  Inc 1) but ZERO FE reference (grep apps/ats-web/src: no matches). No create/
  update UI; only read + end are wired.
- Capacity truth / derived openings_available (T4-B2) — no capacity UI anywhere;
  explicitly excluded on the placement surface. Backend-only.
- POST /v1/placements/{id}/assignment/end IS now surfaced (END dialog) — NOT in
  this list (was undocumented-route follow-up; product surface exists).
- Live-but-undocumented routes noted in memory (/v1/pipelines, /v1/requisitions):
  /v1/requisitions HAS a FE surface (Requisitions list/detail); pipeline is
  surfaced inside requisition detail (Pipeline tab). Not asserting these as
  no-UI; flagged only that OpenAPI documentation gap is a separate follow-up.

## (2) USER-VISIBLE SURFACE WITH A DEFERRED BACKEND ACTION SEAM (identify only)
- Placement lifecycle transition-write (activate/terminate): PlacementCard has
  the full allowedActions/onAction capability, but PlacementDetailView mounts it
  WITHOUT onAction => affordance intentionally not wired (no transition-write op
  from UI). DEFERRED by design (no inert control shown).
- REQUISITION_NO_OPENINGS FE handling: per memory the frontend dead-handler is
  DEFERRED after T4-B2 retired the 409; not re-verified in this segment (flagged,
  not classified).

## DIVERGENCES (typed; flag, never resolve)
- (ii unverifiable / nav-orphan) /identity/portal-disputes is MOUNTED (App.tsx
  route, identity:resolve) but has NO nav entry in RecruiterShell WORK_NAV and NO
  <Link>/NavLink to it anywhere in apps/ats-web/src (grep: only App.tsx route def
  + its api file). Reachable only by direct URL. FINDING — needs disposition.
- (i vs tasking assumption) task named apps/platform-admin as a possible web
  surface; substrate shows it is a NestJS API deployable (no React/router/index
  route). No web product surface exists there.
- (iii substrate state) Working tree is 1 merge behind origin/main; all placement
  authority read via `git show origin/main` per mandate. No SHA drift observed
  during audit (origin/main stable at ca09740).

## BASELINE + MUTATION STATEMENT
Baseline commit audited: ca0974090724b36b130f4d39ea5b1ef486d6adf4 (origin/main, PR #589).
No mutation performed: no file written/edited in the repo working tree, no git
state changed, no package installed, no environment altered. Only read-only
git show / ls-tree / grep and Read were used. (This segment is read-only recon
evidence and performed no repository mutation.)
