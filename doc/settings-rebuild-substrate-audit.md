# Settings page rebuild — substrate audit (read-only ground truth)

**Date:** 2026-06-19 · **Baseline:** `main` @ `d5beb26` (post FE-Consolidation)
**Purpose:** Establish what each section of the settings mockup (`aramo-settings-enterprise.html`) can ACTUALLY wire to, before the Lead plans the rebuild. **Ground truth only — no rebuild recommendation.**

> Method: read-only audit across `libs/settings`, `libs/identity`, `libs/consent`, `libs/export`, `libs/import`, `libs/ingestion`, `libs/portal`, `libs/submittal`, `libs/engagement`, `libs/entitlement`, `libs/metering`, `apps/auth-service`, `apps/api`, and the seed/scope catalogs. Citations are file paths in-repo.

## Headline findings (these overturn the brief's expectations)

1. **Import is BUILT**, not absent — `libs/import` is a real recruiter-facing CSV bulk-load pipeline with endpoints.
2. **Audit log: events emit, but there is NO read endpoint.** `IdentityAuditEvent` records 26 event types today; nothing exposes them. This is the one "small backend unlocks a real surface" item.
3. **The settings registry holds only 3 keys.** Most mockup sections need their own model/endpoint — they do **not** map to a registry key.

## Per-section findings table

Status = BUILT / PARTIAL / ABSENT. Classification = how it can be honoured today: **live** (wire to an existing endpoint) · **build-small-backend** (small net-new backend makes it real) · **honest-seam** (no substrate / whole-milestone → render an honest placeholder, never fake-functional).

| # | Mockup section | Status | Wire-target (endpoint + lib) | Build size | Classification |
|---|---|---|---|---|---|
| 1 | Tenant profile | ABSENT (model thin) | `Tenant` = `name` only; no profile endpoint (`libs/identity`) | Medium (cols + GET/PATCH + audit) | build-small-backend |
| 2 | Branches & teams | PARTIAL | Teams/edges **LIVE**: `GET/POST/DELETE /v1/teams`, `/v1/teams/:id/members`, `/v1/management/edges` (`libs/identity` d4a.controller). **Sites/branches = `Site` model only, no CRUD** | Teams: none · Sites: small | teams **live** · branches build-small |
| 3 | Localization | ABSENT | No locale/timezone/language substrate (currency = per-requisition TEXT only; no tenant default) | Whole-milestone (i18n infra) | honest-seam |
| 4 | Users | BUILT | `GET /v1/tenant/users`, `POST …/invitations`, `POST …/:id/disable`, `PATCH …/:id/roles` (`libs/identity` tenant-user); invite + disable sagas w/ Cognito provisioning + rollback | None (re-enable endpoint = small gap) | **live** |
| 5 | Roles & permissions | PARTIAL | 13-role catalog + 60 scopes + RoleScope map + **D5 non-invertibility validator** + **S4 financials gate** all BUILT — but in **seed** (`libs/identity/prisma/seed.ts`). **No roles-catalog GET** (FE hand-mirrors `TENANT_ASSIGNABLE_ROLES`). Scope-per-role **matrix** has no API | Role list: none · matrix API: medium | list **live** (mirror) · matrix build-small |
| 6 | Security & SSO | ABSENT | Cognito hosted-UI only (`apps/auth-service`). No SSO/SAML/OIDC, no MFA-policy, session-policy, password-policy, or IP-allowlist substrate | SSO: whole-milestone · MFA/session: medium | honest-seam |
| 7 | Career portal (branding/domain/jobs-visibility/SEO) | ABSENT | **No substrate.** `libs/portal` = *talent self-service* read API (own profile/consent), NOT an employer job board. No publish flag, custom-domain, or SEO model. **Refusal-layer forbidden** (`doc/03-refusal-layer.md`) | Whole new subsystem | honest-seam |
| 8 | Apply flow (fields/screening/consent-at-apply) | ABSENT | **No substrate.** `libs/submittal` is recruiter-initiated, not talent apply. No application entity, form-field builder, or screening/knockout model. Refusal-layer forbidden | Large milestone | honest-seam |
| 9 | Email & notifications (sending domain/templates/team-notifs) | ABSENT | No engine/template store. Only Cognito's built-in invite email (`apps/api/.../tenant-cognito.adapter.ts`); `libs/engagement` delivery is a **no-op stub** (`send-stub.provider.ts`) | Whole-milestone | honest-seam |
| 10 | Import data | **BUILT** | `GET /v1/imports`, `POST /v1/imports/run`, `DELETE /v1/imports/:id`, `GET /v1/imports/:id/failures` (`libs/import`, CSV bulk-load, partial-commit). Note: `import:*` scopes unseeded (carry HK-IMPORT-SCOPES) | Small (read-only history view) | **live** (read) · build-small (scopes/config) |
| 11a | Data & compliance — Export | BUILT | `GET /v1/exports/:entity_type` (5 ATS entities; `libs/export`; scope `export:read`; R10-bounded; CSV; ≤10k single-shot) | None (cursor pagination deferred) | **live** |
| 11b | Data & compliance — RTBF | PARTIAL | Manual **runbook** `doc/runbooks/talent-rtbf-erasure.md` + résumé-text ON DELETE cascade. `is_anonymized` is a hardcoded `false` placeholder (`libs/consent`); no self-serve endpoint. App IAM intentionally lacks S3 DeleteObject | Anonymization machine: whole-milestone (M6/M7) | honest-seam (surface runbook status) |
| 11c | Data & compliance — Retention | ABSENT | No retention/TTL/purge policy substrate. S3 lifecycle (orphan-sweep) ≠ tenant policy; RDS PITR ≠ data retention | Medium | honest-seam |
| 12 | Custom fields | ABSENT | **No substrate.** All entities fixed-schema; no EAV / field-registry / dynamic attributes. Settings schema flags custom-fields as a future "halt condition" | Large cross-system | honest-seam |
| 13 | Plan & billing | ABSENT | No billing/subscription/Stripe/payment. `libs/entitlement` = capability gates (platform-tier provisioning, all-or-nothing); `libs/metering` = write-only usage-event log (no rollup/read/billing). **Deferred Phase-B track** | Whole-milestone | honest-seam (deferred track) |
| 14 | Audit log | ABSENT (read) | **`IdentityAuditEvent` table + 26 event types emit today** (incl. `identity.tenant_setting.updated`, `identity.tenant_user.disabled`, `…role_assigned/removed`, team/edge/assignment/session events) — but **NO read endpoint, service method, or repo read**. `audit:read` scope unseeded | Small-medium (findByTenant + GET + seed scope) | build-small-backend (trail exists; needs a read API) |

## Answers to the 10 specific questions

1. **Settings registry.** `GET /v1/tenant/settings` + `PUT /v1/tenant/settings/:key`, scope `tenant:admin:settings`, emits `identity.tenant_setting.updated` (app-layer two-call seam). **KNOWN_SETTINGS = 3 keys**: `compensation.display_default` (spread|markup|both, default both) and `audit.financials_enabled` (bool, default false) are user-facing; `metrics.goals` is `internal:true` and filtered from GET (recruiter desk reads it directly). New key = registry entry + co-located validator, **no migration** (JSONB row). → Only **comp-display** and **financials-toggle** map to registry keys; every other mockup section needs its own model/endpoint.
2. **Users/Roles/Security.** Invite saga (Cognito AdminCreateUser + identity tx + rollback), disable saga (identity-first + Cognito + re-enable compensation), D5 union-non-invertibility validator, and the S4 financials-grant gate are all **BUILT** in `libs/identity`. Re-enable has no public endpoint (known gap). **SSO/MFA/session/password/IP policy: entirely absent** — Cognito hosted-UI is the whole auth story.
3. **Career portal / apply / screening.** **No substrate**, and explicitly **refusal-layer forbidden**. `portal` consumer = talent self-service; `submittal` = recruiter-initiated. No public job board, apply form, or screening/knockout model.
4. **Email & notifications.** **No engine.** Only Cognito's built-in invite email (not tenant-configurable) + an engagement delivery **stub** (no SES/SendGrid). No template store, sending-domain/DKIM, or team-notification-prefs model.
5. **Import.** **BUILT** (`libs/import`) — the brief's "expected: no" is incorrect. Distinct from `libs/ingestion` (passive raw-payload store + dedup, backend-only).
6. **Data & compliance.** Export **live** (`/v1/exports/:entity_type`, ATS-only, R10-bounded). RTBF = **manual runbook** + text cascade; anonymization machine unbuilt (`is_anonymized` placeholder). Retention **absent**.
7. **Custom fields.** **No substrate** — fixed schema on every entity; no EAV/field-registry.
8. **Branding / Localization.** Branding = **FE Confident-Blue tokens only**, no backend (no logo/color per-tenant model). i18n/locale/timezone **absent**.
9. **Billing.** Confirmed **deferred separate track**. `entitlement` + `metering` are internal (capability gating + write-only usage log), not billing.
10. **Audit log.** A real **write trail exists** — `IdentityAuditEvent` with 26 event types emitting best-effort across identity/settings/team-model lifecycle — but **no queryable read API** (no `findByTenant`, no `GET /v1/audit*`, `audit:read` scope unseeded). This is the single highest-leverage "build-small-backend unlocks a real surface" item.

## Shape for the rebuild plan (counts, not advice)

- **Live now (4):** Users · Teams/org (the Branches-&-teams *teams* half) · Import (read) · Export.
- **Build-small-backend (≈5):** Tenant profile · Sites/branches CRUD · Roles scope-matrix API · **Audit-log read endpoint** · registry keys for any new toggles.
- **Honest-seam / no substrate (≈7):** Localization · Security & SSO · Career portal · Apply flow · Email & notifications · Custom fields · Plan & billing · (RTBF/retention — compliance is partial: export is live, the rest is seam).

## Key file references

- Settings: `libs/settings/src/lib/known-settings.ts`, `tenant-setting.service.ts`; `apps/api/src/controllers/tenant-settings.controller.ts`
- Users/roles: `libs/identity/src/lib/tenant-user/` (management controller, lifecycle service, role-bundle-validator, audit-financials-gate port), `libs/identity/prisma/seed.ts`; FE mirror `apps/ats-web/src/users/types.ts`
- Teams/org/sites: `libs/identity/src/lib/d4a.controller.ts`; `libs/identity/prisma/schema.prisma` (`Site`, `Team`, `TeamMembership`, `ManagementEdge`)
- Auth: `apps/auth-service/src/app/auth/`; `apps/api/src/cognito/tenant-cognito.adapter.ts`
- Consent: `libs/consent/src/lib/consent.controller.ts`
- Export: `libs/export/src/lib/export.controller.ts`; Import: `libs/import/src/lib/import.controller.ts`; Ingestion: `libs/ingestion/`
- Billing-adjacent: `libs/entitlement/`, `libs/metering/`
- Audit trail (write-only): `libs/identity/src/lib/audit/identity-audit.repository.ts` (EVENT_TYPES catalog)
- RTBF: `doc/runbooks/talent-rtbf-erasure.md`; refusal layer: `doc/03-refusal-layer.md`
