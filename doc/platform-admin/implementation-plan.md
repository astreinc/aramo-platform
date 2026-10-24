# Platform Admin console and Template Studio — implementation plan

**Governing directive:** `Aramo-PLATFORM-UX-1-Platform-Admin-and-Template-Studio-Directive-v1_0-LOCKED` (SHA `e94fa124…`, OneDrive `Aramo/locked/`).
**Design reference:** `doc/design-reference/platform-admin/` (pinned by `MANIFEST.sha256`).
**Baseline:** `origin/main` `680907fc`. No platform-web, platform-admin, fe-foundation or document-templates-web changes since the audited `45d30da9`.

This plan is updated at Gate 5 with what shipped, the typed divergences and the remaining gaps.

## 1. Routes (directive R-12)

| Route | Screen | Gate | Increment |
|---|---|---|---|
| `/login`, `/signed-out` | Sign-in (`SignInPage` + `errorCopy`), Signed out | none | F-2 |
| `/` | Dashboard | `platform:tenant:read` (entry gate) | F-3 |
| `/tenants` | Tenants list (`?status&kind&q`) | entry | F-4 |
| `/tenants/new` | Provision (3 steps) | `platform:tenant:provision` | F-4 |
| `/tenants/:id?tab=overview\|lifecycle\|sign\|domain\|people` | Tenant detail | entry; Domain tab `:lifecycle:manage`; People tab `:provision` | F-5 |
| `/personal-review` | Sign Personal review queue + drawer | `platform:tenant:lifecycle:manage` | F-6 |
| `/personal-invites` | Pilot invites | `platform:tenant:lifecycle:manage` | F-6 |
| `/skills`, `/skills/:id`, `/skills/review-queue`, `/skills/proposals`, `/skills/proposals/:id` | Skills | `platform:skill:read` | F-7 |
| `/matching` | Matching policy | `platform:matching_policy:read` | F-8 |
| `/template-variables` | Template variables | `platform:document_template:read` | F-8 |
| `/admins` | Platform admins | `platform:admin:invite` | F-8 |
| `/document-templates` | Template library | `platform:document_template:read` | F-9 |
| `/document-templates/:id` | Template Studio (replaces the detail view) | `platform:document_template:read` | F-9 |

Access denied is a shell state rendered inside `PlatformShell` (R-5), not a route. `*` redirects to `/`.

## 2. Endpoint map

| Screen / action | Client | Endpoint | Backend |
|---|---|---|---|
| Identity (env bar, account menu, access denied) | `getMe` | `GET /platform/me` | platform-admin (**B-1a, new**) |
| Dashboard | `getDashboard` | `GET /platform/dashboard` | platform-admin |
| Tenants list | `listTenants` | `GET /platform/tenants?status&q` (+ `kind`, **B-1b**) | platform-admin |
| Provision | `provisionTenant` | `POST /platform/tenants` (`slug` now exposed in UI) | platform-admin |
| Tenant detail | `getTenant`, `getTenantAudit`, `getTenantSign` | `GET /platform/tenants/:id` (+ `slug`, **B-1b**), `/audit`, `/sign` | platform-admin |
| Owner invite | `resendOwnerInvite` | `POST …/:id/resend-owner-invite` | platform-admin |
| Lifecycle | `suspend` / `reactivate` / `startOffboarding` / `close` | `POST …/:id/{suspend,reactivate,start-offboarding,close}` | platform-admin |
| Domain tab | new client functions (F-5) | `GET …/:id/domain`; `POST …/domain/{release,promote,exception}`; `DELETE …/domain/exception` | platform-admin (UI new) |
| People tab | new client function (F-5) | `POST /platform/tenants/:id/invitations` | platform-admin (UI new) |
| Sign Personal | `listPersonalReview`, `personalReviewAction`, `listPersonalReports`, `decidePersonalReport`, `issuePersonalInvite` | `/platform/personal-review`, `…/personal/*`, `/platform/personal-reports/:id/decide`, `/platform/personal-invites` | platform-admin |
| Platform admins | new client function (F-8) | `POST /platform/admins/invitations` (domain allowlist, **B-1c**) | platform-admin (UI new) |
| Skills | `skills-api.ts` (22 functions) | `/platform/skills*`, `/platform/skill-review-queue`, `/platform/skill-proposals*` | apps/api |
| Matching | `matching-policy-api.ts` | `/platform/matching-policy*` | apps/api |
| Templates, variables | `document-templates-api.ts` (+ `getVersion`, F-9) | `/platform/document-templates*`, `/platform/template-variables*` | apps/api |

## 3. Data gaps (directive R-13): designed empty/disabled state, no backend work here

- Tenant members list (People tab)
- Platform admins list
- Server paging and sorting (tenants, skills, templates, variables)
- Unified tenant timeline (domain and Personal events)
- Template preview for `:read` users (`:read` sees the published version only)
- PDF pagination and download
- UPLOADED_PDF / HYBRID authoring
- Tables, H3, alignment and conditional blocks in the Studio
- Section library storage and usage counts
- Pilot seat count

## 4. Label and column decisions (directive R-9)

- **Alias types:** Abbreviation, Common name, Legacy name, Vendor variant, Spelling variant.
- **Relationship types:** Related to, Compatible with, Parent of, Built on, Requires, Supersedes. Direction comes from the server's `directionality`.
- **Relationship sources:** Vendor documentation, Admin curated, Imported taxonomy, AI recommended.
- **Skill/alias/version status:** Active / Inactive.
- **Registry:** the Aliases column is dropped. **Review queue:** First seen is dropped. Both are typed divergences.

## 5. Typed divergences

To be filled per increment at Gate 5.
