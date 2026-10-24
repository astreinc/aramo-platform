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

## 5. What shipped (branch `feat/platform-ux-1-admin-console`)

| Commit | Increment |
|---|---|
| `1955370d` | D-0 design reference + this plan |
| `fba7a146` | U-0 StatusPill `muted` tone |
| `9e8ceaa9` | B-1 `/platform/me`, tenant kind/slug, admin invite domain allowlist |
| `14a3c15a` | F-1 tokens + platform component set |
| `d24f350c` | F-2 shell, identity, in-shell access denied, sign-in copy |
| `af71aeac` | F-7 Skills |
| `7c8331b8` | F-6 + F-8 Sign Personal, Matching, Template variables, Platform admins |
| `96224be1` | F-3/F-4/F-5 Dashboard, Tenants, Provision, Tenant detail |
| `afb00e63` | Lead fixes (session props, overlay rule, toast style, stale CSS) |
| `cdf9b2f2` | F-9 Template library + Template Studio |
| `06898e51` | Shell support for the Studio |
| `a74e96b3` | H-1 visual parity / a11y / keyboard / 900px (non-Studio) |
| `34706ee0` | H-1 Studio + stable visual runs |
| `e42c5443` | repo-map regenerate |

## 6. Typed divergences

The visual-suite masks (DV-01…DV-31), the anti-aliasing allowance (AA-01) and the
accessibility design-debt ruling are listed in
`apps/platform-web/e2e/visual/DIVERGENCES.md`. Behavioural divergences beyond those:

- **Lead rulings:** slug generated from the tenant name when empty (handoff §6.2;
  new tenants now get a sign-in address automatically); Provision hidden without
  `:provision` (handoff §6.1); merge copy states the real soft-merge behaviour;
  the template library follows the Template Studio file's frame.
- **Shared frozen components:** toast duration stays at the fe-foundation 3s (Studio
  3.5s as designed); Escape closes a visible toast before a drawer (shared Radix
  toast); sign-in / signed-out pages keep the shared AUTH-SIGNIN-1 rendering (copy
  only per R-17); TENANT_ACCESS_DENIED keeps the shared wrong-account recovery.
- **Local replacements (R-3):** AccountMenu (for UserMenu), the ⌘K trigger (for
  CmdKSearch), the breadcrumb (for Breadcrumb), router links (for RailNavItem).
- **Additions kept from the existing product:** skill Description field and "Merged
  into" row; Clear-review phone-step sentence; variable Status select.
- **Vocabulary (R-18):** one matching copy line reworded.

## 7. Remaining gaps → backend follow-ups (R-13)

Tenant members list; platform admins list; server paging/sorting; unified tenant
timeline (domain + Personal events); template preview for `:read`; PDF pagination +
download; UPLOADED_PDF / HYBRID authoring; tables / H3 / alignment / conditional
blocks; section library; pilot seat usage; `report_count` and Clear/Closed accounts
in the Personal review queue; a long-values preview sample set; slug on the dashboard
onboarding rows; a domain-claim "since" timestamp; a Pact provider verifier for
platform-admin; a contrast-safe design revision (design amendment 2).
