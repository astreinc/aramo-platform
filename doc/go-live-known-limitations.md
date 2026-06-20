# Go-Live Known-Limitations Register

Deliberate gaps shipped to production with enforcement/behavior intentionally
deferred. Each entry states what is present, what is NOT yet enforced, and the
trust implication. Reviewed at each go-live gate.

> New entries: append under the relevant area with the date, the PR/branch, and
> an explicit "Risk" line. Do not remove an entry until the deferral is closed
> (link the closing PR).

---

## Companies

### off_limits: display-only, enforcement deferred
- **Date:** 2026-06-16 · **Branch:** `feat/companies-mockup-parity`
- **Present:** `company.off_limits` boolean field; account-hub off-limits banner;
  list facet + form toggle; included in company create/update + search facets.
- **NOT enforced:** the do-not-source flag is **display-only**. Nothing in
  sourcing / talent search / engagement reads `off_limits` to exclude an
  off-limits client's own people from a working set. Setting the flag changes
  what a recruiter *sees*, not what the system *permits*.
- **Risk:** a "do-not-source" banner the system does not enforce is a **trust
  gap** — an operator may rely on it as a guardrail it is not. Treat as
  informational only until enforcement lands.
- **Close criteria:** wire `off_limits` into the sourcing/search predicate so an
  off-limits company's employees are excluded from talent working sets (requires
  the talent→employer→company linkage), with a test proving exclusion.

---

## Requisitions

### Team scope + owner reassignment: deferred (unbacked)
- **Date:** 2026-06-16 · **Branch:** `feat/companies-mockup-parity`
- **Present:** the rebuilt Requisitions list differentiates breadth SERVER-SIDE
  by the authenticated principal — GET /v1/requisitions applies the A3/D4b
  visibility predicate from the caller's scopes, so a recruiter sees assigned +
  client-visible reqs and a `requisition:read:all` holder sees the full tenant
  set (no query param; the mockup's persona switcher is dropped). The backed
  filter chips (All / Only mine / Only hot / Show closed) and the owner cell
  (which DISPLAYS the real unassigned state) ship.
- **NOT present:** (1) a **"Team" scope** — there is no team-tier read exposed on
  the requisitions surface (the talent `?scope=my_team` analog), so a lead cannot
  pivot the list to "my team's reqs" beyond what their own visibility already
  resolves; (2) **owner reassignment** — recruiters lack an assign scope and
  there is no assignable-users endpoint here, so the owner cell offers no
  reassign action; (3) a **server-side owner-IS-NULL "Unassigned" filter** — the
  repository accepts no owner param, so "Unassigned" is shown per-row but is NOT
  a filter chip. Same shape as the Talent/Companies list deferrals.
- **Risk:** low — these are absent affordances, not unenforced guardrails. A lead
  reviewing breadth relies on principal-driven visibility, which IS enforced.
- **Close criteria:** expose a team-scope read (mirror talent `?scope=my_team`)
  + an `owner_id` filter (incl. IS NULL) on GET /v1/requisitions, and an
  assignable-users endpoint + assign scope for reassignment — then wire the
  "Team" / "Unassigned" chips and an owner reassign control.

### List pagination / facets: deferred (unbacked)
- **Date:** 2026-06-16 · **Branch:** `feat/companies-mockup-parity`
- **Present:** GET /v1/requisitions returns the visibility-scoped set ordered by
  `created_at desc`, **capped at 50** (no cursor). The list shows an honest
  "showing your 50 most recent (pagination coming)" note when the cap is hit.
- **NOT present:** keyset/cursor pagination + facet counts (the talent-records
  `?paged=true` superset has no requisitions analog yet). Client/status/sort
  controls operate over the (capped) loaded set, not the full server set.
- **Risk:** low — truncation is disclosed, not silent.
- **Close criteria:** add a `?paged=true` cursor + facet path to
  GET /v1/requisitions and wire server-side pagination/facets in the list.

### New Requisition — AI intake lane: dark until the per-env Anthropic secret is provisioned
- **Date:** 2026-06-18 · **Branch:** `feat/new-requisition-mockup-parity`
- **Present:** the New Requisition "Draft with AI" lane (POST /v1/requisitions/
  intake) is fully built + correct — it reuses the governed `libs/ai-draft`
  substrate (`claude-sonnet-4-6`, audit, PII-redaction). On a provider/key
  failure it fails **honestly**: the endpoint remaps to `AI_PROVIDER_UNAVAILABLE`
  (502) / `AI_RATE_LIMITED` (429) and the FE shows "AI drafting is unavailable —
  enter the requisition manually." The **manual lane always works**.
- **NOT present (DEPLOY STEP — per-env, out-of-band):** the Anthropic API key is
  resolved ONLY from **AWS Secrets Manager** at `aramo/${ARAMO_ENV}/anthropic-api-key`
  (no env fallback — ADR-0015 Decision 4). The secret must be **provisioned per
  environment** before the AI lane works — exactly like the Cognito / S3 IAM
  out-of-band creds (see "Staging résumé bucket" below). Verified absent for
  `ARAMO_ENV=local` (and account-wide) at authoring: `describe-secret` →
  `ResourceNotFoundException`, so every draft returns `AI_PROVIDER_UNAVAILABLE`
  until it is created. The AI lane is **DARK-BY-CONFIG, not broken** — the code is
  correct and fails honestly. A live draft (the one pre-merge check CI cannot
  cover, since CI has no LLM provider) must be confirmed once the secret is
  provisioned.
- **Provisioning (per env — staging + prod each need their own):**
  `infrastructure/bootstrap/create-anthropic-secret.sh --env <staging|prod> --api-key sk-ant-…`
  then restart the API (the key caches for process lifetime). Runbook:
  [doc/runbooks/bootstrap-anthropic-secret.md](runbooks/bootstrap-anthropic-secret.md).
- **Risk:** none to integrity (no fabricated drafts; honest failure + working
  manual lane). The only effect of the missing secret is the AI lane being
  unavailable until provisioned.
- **Close criteria:** create `aramo/staging/anthropic-api-key` (and the prod
  equivalent) in Secrets Manager during the staging/prod deploy, **ensure the
  Anthropic account has an active credit balance** (a valid key with no credits
  returns a 400 "credit balance too low" — now surfaced honestly as
  `AI_PROVIDER_UNAVAILABLE`, never as a user-input error), restart the API, and
  confirm a live draft populates the editable fields.

---

## Talent

### RTBF / talent erasure: manual, with résumé-object + attachment orphaning
- **Date:** 2026-06-17 · **Branch:** `feat/add-talent-rebuild-resume-s3`
- **Present:** deleting a TalentRecord cascades the résumé **text** row
  (`talent_record.talent_resume_text`, `ON DELETE CASCADE` — ADR-0015). SSN-
  shaped patterns are redacted before that text is stored (D4).
- **NOT enforced:** (1) the **S3 résumé object is not deleted** by any
  application path — `Attachment.storage_key` points at the object, there is no
  `DeleteObject` in the app's IAM policy, and talent-delete does not touch S3;
  (2) **Attachment rows orphan** on talent-delete — `Attachment` references the
  talent by `owner_id` (cross-schema UUID, **no FK** per Architecture §7.3), so
  the cascade does not reach them; (3) the **ADR-0007 anonymization state
  machine is not built** — `is_anonymized` is a hardcoded `false` placeholder,
  and the Core Talent identity is not anonymized by ATS-side delete.
- **Risk:** **a verified right-to-be-forgotten request cannot be fully honored
  by the product alone.** Résumé text purges automatically, but the résumé
  *file* in S3 and its attachment metadata persist. Manual operator action is
  required to complete erasure — see the runbook below.
- **Mitigation (this PR):** the **manual erasure runbook**
  [doc/runbooks/talent-rtbf-erasure.md](runbooks/talent-rtbf-erasure.md)
  specifies how an operator, given a talent id, locates the attachment
  `storage_key`(s) and deletes the S3 object (incl. all versions — the bucket
  is versioned) before deleting the rows.
- **Close criteria:** wire attachment cleanup-by-owner on talent-delete (delete
  rows + tag/delete S3 objects), and build the ADR-0007 anonymization state
  machine. Until then, RTBF is a runbook-driven operator procedure.

### Staging résumé bucket: app IAM principal bound; live real-PII on apply
- **Date:** 2026-06-17 · **Branch:** `feat/staging-resume-bucket-iam`
- **Present (authored, pending manual apply):** the `s3-resume-bucket` module
  (private bucket + dedicated SSE-KMS CMK + versioning + scoped CORS +
  lifecycle/orphan-sweep) was already defined; this branch adds the missing
  **app-principal binding** (`iam-app-principal` module) — a least-privilege
  IAM **user** with the bucket's emitted policy attached (PutObject / GetObject
  / PutObjectTagging on the bucket + KMS GenerateDataKey / Decrypt on its CMK
  ONLY — no `ListBucket`, no `DeleteObject`, no wildcard). CORS allows the real
  staging origin (`https://staging.aramo.app`).
- **On apply, this bucket holds real résumé PII** — the **RTBF obligation is in
  force**: the manual-erasure runbook
  [doc/runbooks/talent-rtbf-erasure.md](runbooks/talent-rtbf-erasure.md) is the
  only path to honor a verified erasure (the app principal deliberately has **no
  `DeleteObject`** — deletion is an operator action with elevated creds), and
  because the bucket is **versioned**, erasure must delete **all object
  versions**, exactly as the runbook specifies.
- **NOT done in this PR (deliberate):** the `terraform apply` is **manual and
  HALT-gated** — it requires real AWS creds (S3 + IAM + KMS write) in the apply
  shell, which were absent here (`InvalidClientTokenId`), so apply was not run.
  Access keys for the IAM user are generated **out-of-band into the secret
  store** (never committed/Terraform-state) per the module README. Encryption-
  at-rest (SSE-KMS) and lifecycle/orphan-sweep are part of the existing module
  and active once applied.
- **Risk:** none until applied; on apply, standard live-PII posture applies
  (RTBF runbook is the operator control).
- **Close criteria:** run the gated apply with real creds, generate + store the
  principal's access key, verify the end-to-end round-trip (presign → browser
  PUT → object lands → parse → create+attach), and migrate the principal from
  an IAM user to an instance/task role when a compute platform lands in IaC.

### Consent capture: UI captured at create, grant deferred (Core-keying)
- **Date:** 2026-06-17 · **Branch:** `feat/add-talent-rebuild-resume-s3`
- **Present:** the Add-Talent flow captures the real 5-scope consent model
  (`profile_storage`, `resume_processing`, `matching`, `contacting`,
  `cross_tenant_visibility` — the `libs/consent` `CONSENT_SCOPES` enum) plus the
  R7 attestation, and **gates the save** on the two required scopes + the
  attestation. The grant endpoint (`POST /v1/consent/grant`) exists and is real.
- **NOT enforced:** the grant is **NOT fired at create**. `POST /v1/consent/grant`
  keys on a **Core `talent_id`** (`@IsUUID`); a freshly-created ATS
  `TalentRecord` has a nullable `core_talent_id` that is unset at create.
  Minting a thin Core Talent + overlay at ATS-create to populate it was
  evaluated and **rejected** — it would break the locked LINK-NOT-CREATE
  invariant (`ats-batch4b-talent-link.integration.spec.ts`: bit-identical
  `talent.*` row-counts under ATS ops) and Proof 6 (the single authorized
  `.talent.create(` call site lives in canonicalization only). Firing the grant
  keyed to the ATS record id instead would be a **wrong-key write** (consent-
  data corruption) and is explicitly not done.
- **Risk:** low for data integrity (no bad rows written); moderate for
  completeness — operator-captured consent intent is held with the record but
  not yet persisted as consent events until the Core identity is provisioned.
- **Close criteria:** provision the Core Talent identity through the authorized
  canonicalization/ingestion seam (NOT the ATS adapter), then fire the 5-scope
  grants keyed to the resulting `core_talent_id`. Closing this also closes the
  engagement-composer `findOverlayByTenant` overlay carry.

### Work history & education capture: deferred (seam)
- **Date:** 2026-06-17 · **Branch:** `feat/add-talent-rebuild-resume-s3`
- **Present:** a read-only "Work history & education — capture coming soon"
  reserved seam on the Add-Talent form.
- **NOT present:** structured work-history / education capture. The résumé
  parser extracts neither (`TalentRecordPrefill` omits them), there is no
  `talent-evidence` write controller, and `POST /v1/talent-records` stores
  neither. Rendering editable entries would be fabricated (nothing persists).
- **Risk:** low — absent affordance, disclosed as coming. Work history /
  education legitimately arrive as Core evidence satellites (TalentWorkHistory /
  TalentEducation).
- **Close criteria:** build the Core evidence satellites + write endpoints, then
  wire parse + capture.

### Duplicate detection: deferred (seam)
- **Date:** 2026-06-17 · **Branch:** `feat/add-talent-rebuild-resume-s3`
- **Present:** a "Duplicate check — Coming soon" reserved seam on the Add-Talent
  rail.
- **NOT present:** any duplicate-detection endpoint. The mockup's "no likely
  matches" result is not backed by anything, so it is not rendered (no
  fabricated result).
- **Risk:** low — disclosed as coming; the create flow never claims a dedup
  check ran.
- **Close criteria (fast-follow):** add a simple verified-email/profile-URL
  duplicate-surfacing read and wire it into the rail (surface-only; never
  silent-merge).

---

## Tasks

### Team / manager "pod oversight" scope: deferred (no team tier on this surface)
- **Date:** 2026-06-17 · **Branch:** `feat/tasks-mockup-parity`
- **Present:** the rebuilt Tasks workspace is **assignee-scoped** — it lists the
  authenticated principal's own tasks (`assignee_id = me`, server-side via
  GET /v1/tasks). The mockup's "Viewing as" persona selector and its per-persona
  fabricated data are **removed entirely** (role differentiation is server-side
  from the principal, not a client toggle).
- **NOT present:** a **Lead/manager "pod/team oversight" view** — there is no
  team-tier read that lets a lead see their pod's tasks. The Tasks backend
  resolves visibility from the linked entity, not from a team membership, and no
  team-scoped task read exists.
- **Risk:** low — an absent affordance, not an unenforced guardrail. Each
  principal sees exactly the tasks assigned to them; nothing is over-shown.
- **Close criteria:** expose a team-scoped task read (the AUTHZ-D4a team-model
  substrate exists) + an oversight scope, then add a "My team" pivot.

### Auto-generated tasks (`source='auto'`): reserved seam (eventing deferred)
- **Date:** 2026-06-17 · **Branch:** `feat/tasks-mockup-parity`
- **Present:** the Task model carries `source ∈ {manual, auto}` (default
  `manual`); the workspace renders a disabled **"Auto-generated tasks — coming
  with Aramo Core"** reserved seam.
- **NOT present:** any workflow→task auto-generation. `source='auto'` is RESERVED
  and **never written** by any v1 write path — generating tasks from workflow
  events (e.g. a stalled submittal) needs the eventing substrate, which is
  deferred. Go-live is **manual tasks only**; no fabricated auto-tasks are shown.
- **Risk:** low — the seam is disabled and disclosed; no fake auto-task data.
- **Close criteria:** land the eventing substrate, then a workflow→task
  generator that writes `source='auto'` tasks; light up the affordance.

### /tasks-origin task creation (quick-add): reserved seam (owner-picker carry)
- **Date:** 2026-06-17 · **Branch:** `feat/tasks-mockup-parity`
- **Present:** the workspace's quick-add bar renders for parity (with the real
  Type/Priority closed-set selects) as a **disabled reserved seam**, routing
  creation to a record's Tasks tab. Real task create/edit — now including
  **type, priority, and the expanded status lifecycle** — is wired on the
  per-entity (talent / requisition / company / contact) Tasks tabs.
- **NOT present:** creating a task **from the /tasks page** itself. A Task is
  polymorphic on a **required owner** (`owner_type` + `owner_id`, NOT NULL); an
  owner-less task is not backed, and the directive's backed-surface list does not
  include /tasks-origin creation. Faking an owner-less create is explicitly not
  done. (Carries the pre-existing owner-picker-create deferral.)
- **Risk:** low — the seam is disabled and disclosed; creation works from the
  backed owner-context path.
- **Close criteria:** add an owner-picker (entity type + entity search across the
  four targets) to a /tasks "New task" dialog, then enable the quick-add.

### Bulk "Reassign": deferred (no assignable-users roster + assign scope)
- **Date:** 2026-06-17 · **Branch:** `feat/tasks-mockup-parity`
- **Present:** the bulk action bar ships **Complete** (status→done), **Reschedule**
  (due→tomorrow) and **Snooze** (due +1 day) — all backed via PATCH /v1/tasks/:id.
  Per-task reassignment remains available via the edit dialog's assignee picker
  (when the admin-gated roster is readable; graceful fallback otherwise).
- **NOT present:** **bulk Reassign** — rendered DISABLED with its reason. It needs
  a recruiter-accessible assignable-users roster + an assign scope (the roster is
  currently `tenant:admin`-gated; the per-task picker already falls back to
  "unassigned" for non-admins).
- **Risk:** low — disabled affordance, not faked.
- **Close criteria:** expose a recruiter-accessible assignable-users endpoint +
  an assign scope, then wire bulk reassign.

---

## Contacts

The Contacts page (list + detail) is a backend build (Contact-spec amendment
v1.0 added `relationship_role`, `preference`, `last_activity_at`) plus a wired
FE rebuild. The list pages server-side (`?paged=true` keyset + facets + total);
"My contacts" is a SERVER-ENFORCED `owner_id` predicate (the corrected pattern,
not a client filter). The following are deliberate gaps.

### "Team" scope tab: deferred (no team-of-contacts signal)
- **Date:** 2026-06-18 · **Branch:** `feat/contacts-mockup-parity`
- **Present:** the scope control ships **My contacts / All** — both real (My =
  server `owner_id` predicate; All = tenant-scoped within D4b visibility).
- **NOT present:** the mockup's **Team** scope. Only `owner_id` is modelled on a
  contact; there is no team-of-contacts signal to back a "Team" view. Rendered
  by omission (no faked broken tab), consistent with the Companies page.
- **Risk:** low — no fabricated scope.
- **Close criteria:** a team→contact visibility signal (e.g. via the D4a team
  models), then a Team scope that resolves it server-side.

### Bulk "Add to list": deferred (saved-list scope carry)
- **Date:** 2026-06-18 · **Branch:** `feat/contacts-mockup-parity`
- **Present:** the bulk bar ships **Assign to me** (PATCH /v1/contacts/:id
  `{ owner_id }`, `contact:edit`). "Add to list" is rendered **DISABLED** with its
  reason; export is a permanent disabled note (consent moat).
- **NOT present:** saved-list membership — recruiters hold no saved-list scope.
- **Risk:** low — disabled affordance, not faked.
- **Close criteria:** grant a recruiter saved-list scope + a list-membership
  write path, then enable "Add to list".

### Owner picker beyond "Assign to me": deferred (assignable-users carry)
- **Date:** 2026-06-18 · **Branch:** `feat/contacts-mockup-parity`
- **Present:** the ONE backed reassignment is **Assign to me** (owner ← acting
  recruiter). Owner names render via the admin-gated tenant-users probe (graceful
  403 fallback to "—").
- **NOT present:** assigning to **another** user (no recruiter-accessible
  assignable-users roster + assign scope — the recurring carry).
- **Risk:** low.
- **Close criteria:** the recruiter-accessible assignable-users endpoint + assign
  scope (shared with the Tasks/Companies carry), then an owner picker.

### Cold-call list: BUILT REAL (not a seam)
- **Date:** 2026-06-18 · **Branch:** `feat/contacts-mockup-parity`
- **Present:** the **Cold-call list** mode is a REAL server filter+sort —
  contactable (`preference != do_not_contact`, null = contactable) AND a non-empty
  work phone, ordered by `last_activity_at` ascending (never-contacted first). The
  amendment added `last_activity_at` precisely so this is not a seam. Do-not-contact
  records are excluded server-side.
- **NOT present:** any sourcing/sequence AUTOMATION — it is a CRM queue (sort over
  existing data), not a dialer or sequence engine.
- **Risk:** low.

### `contact.last_activity_at`: read-model column, write-back deferred
- **Date:** 2026-06-18 · **Branch:** `feat/contacts-mockup-parity`
- **Present:** `last_activity_at` is a denormalized recency column (SAME pattern as
  `company.last_activity_at`), seeded so the cold-call queue + "going quiet 14d+"
  facet demonstrate, and used as a REAL server sort/filter.
- **NOT present:** an automatic write-back — logging a contact activity does NOT
  yet update `last_activity_at` (mirrors Company; "wired later"). Runtime contacts
  without seeded recency read as "No contact" (sorted first in the cold-call queue).
- **Risk:** low — honest null display; no fabricated recency.
- **Close criteria:** wire the activity-enrichment path (groupBy over
  `subject_type='contact'`, like the talent `findLastActivityForTalentIds`) to
  maintain the column on activity writes.

### Per-contact "open reqs" / "Hiring for": omitted (cross-schema edge deferred)
- **Date:** 2026-06-18 · **Branch:** `feat/contacts-mockup-parity`
- **Present:** the detail surfaces real fields only (role, company, communication,
  recency, account team).
- **NOT present:** the mockup's per-contact open-req count + "Hiring for" list.
  Resolving requisitions-by-contact would add a new `contact → requisition`
  cross-schema read edge (contact currently imports only `@aramo/company`); out of
  scope to avoid edge churn. NOT faked.
- **Risk:** low — no fabricated req counts.
- **Close criteria:** a requisitions-by-contact read (own edge or composed in
  apps/api), then surface the count + list.

### Mockup affordances with no backing field: omitted
- **Date:** 2026-06-18 · **Branch:** `feat/contacts-mockup-parity`
- **Omitted (no Contact field):** the **"Primary contact"** flag and the
  **Department** facet — neither is a backend column; rendered by omission, not
  faked. Talent-pipeline **stage pills** from the mockup are CUT (a contact is
  not in a talent pipeline). The list **row→detail navigation** replaces the
  mockup's preview drawer (the drawer is a non-essential parity gap, deferred).
- **Risk:** low.

## Auth

### Cognito-side refresh-token revocation (AdminUserGlobalSignOut): deferred — defense-in-depth
- **Date:** 2026-06-20 · **Branch:** `feat/auth-hardening-d3-sso-logout`
- **Present (§5 Auth-Hardening D3):** logout now terminates **both** sessions —
  (1) the LOCAL app session (`POST /auth/:consumer/logout` clears cookies +
  revokes Aramo's own refresh token; preserved) and (2) the **Cognito SSO
  session** (`GET /auth/:consumer/logout` 302-redirects the browser to the
  Cognito hosted-UI `/logout?client_id=…&logout_uri=<registered>`, which clears
  Cognito's SSO cookie). Step 2 closes the named **re-entry-without-reauth**
  hole (shared-machine risk). The return URL is the registered
  `AUTH_COGNITO_SIGNOUT_REDIRECT` env (throws if unset) — config, never input,
  so it is open-redirect-safe.
- **NOT added (deliberate, defense-in-depth only):** Cognito-side
  **`AdminUserGlobalSignOut`** (server-side invalidation of the user's Cognito
  refresh tokens). The §A.3 "confirm + add GlobalSignOut" question was resolved
  by the architecture: **Aramo discards Cognito's access + refresh tokens at the
  token exchange** and brokers its OWN session (Aramo access JWT + Aramo refresh
  token). So the Aramo session-resurrection vector is Aramo's own refresh token
  — **already revoked** by the local logout — and the re-entry hole is the
  Cognito SSO cookie — **closed by the hosted-UI logout redirect**. A held
  *Cognito* refresh token cannot directly resurrect an Aramo session (entry
  requires the full PKCE callback). `AdminUserGlobalSignOut` is therefore
  **not load-bearing** here.
- **Risk:** low. Both named vectors are closed. The residual is a captured
  Cognito refresh token remaining valid *at Cognito* until its own TTL — it
  grants no Aramo session on its own.
- **Why deferred (scope):** adding it needs **auth-service's first Cognito-admin
  SDK surface** (port+adapter, like `TenantCognitoPort`), a new
  **`user_id → cognito sub` reverse-lookup** (none exists today), **consumer→pool
  routing** (tenant vs platform pool), and **IAM** (`cognito-idp:AdminUserGlobalSignOut`).
  That exceeds a redirect+revocation addition (D3 §G HALT trigger).
- **Close criteria:** build `AdminUserGlobalSignOut` alongside the platform-admin
  Cognito-admin work (Step-3): add the reverse-lookup + a tenant/platform-pool-
  routed admin port in auth-service, invoke it (best-effort) from the logout path.

### Cognito "Allowed sign-out URL": per-env config dependency (Step-4 deploy)
- **Date:** 2026-06-20 · **Branch:** `feat/auth-hardening-d3-sso-logout`
- **Present:** the logout redirect reads `AUTH_COGNITO_SIGNOUT_REDIRECT` and
  throws if unset (no hardcoded fallback).
- **NOT done in this PR (out-of-band, per env):** the Cognito app client must
  register this URL as an **"Allowed sign-out URL"** (mirrors the redirect URL).
  Needs registering **locally + staging + prod** pools, or the hosted-UI
  `/logout` rejects the `logout_uri`.
- **Risk:** none until deploy; if unregistered, logout's Cognito redirect fails
  the return hop (the SSO cookie is still cleared by Cognito, but the bounce-back
  to the app errors).
- **Close criteria:** register the per-env sign-out URL on each pool's app
  client and set `AUTH_COGNITO_SIGNOUT_REDIRECT` in each env.

### Literal "can't re-enter without re-auth" browser confirmation: deferred to staging
- **Date:** 2026-06-20 · **Branch:** `feat/auth-hardening-d3-sso-logout`
- **Present:** the logout **logic** is fully proven here (Cognito mocked) — local
  clear preserved, the correct Cognito `/logout` URL built (client_id + the
  registered `logout_uri`, well-formed, not user-supplied), idempotent, both
  consumers (recruiter + admin).
- **NOT proven locally (honest boundary):** the end-to-end *log-out → confirm you
  cannot re-enter without re-authenticating* check needs **real Cognito** (local
  has no SSO session to terminate end-to-end). Not faked.
- **Close criteria:** verify the literal re-entry-blocked behavior in staging
  against the real Cognito pool.

### Recruiter assignable roster: task picker LIVE; 5 pickers + name-resolver deferred (D4)
- **Date:** 2026-06-20 · **Branch:** `feat/auth-hardening-d4-assignable-users`
- **Present:** `GET /v1/tenant/assignable-users` (recruiter-scoped
  `tenant:user:read:assignable`, the 9 work-assigning roles) — a MINIMAL
  `{user_id, display_name}` roster, active-only, tenant-scoped (cross-tenant
  impossible), R10-alphabetical. Param-gated: no `company_id` → broad active
  roster; `company_id=X` → active + mapped-to-client-X (`company.UserClientAssignment`)
  + req-carrying role (`recruiter`/`lead_recruiter`), for the requisition picker.
  The **task assignee picker is wired end-to-end** (the most common recruiter
  gap — assigning tasks — is closed; the admin-gated 403-fallback removed).
- **NOT wired yet (deferred, Lead-sequenced):** the 5 assignment/org/team
  pickers — Company/Requisition assignments, AddEdgeDialog, CreateTeamDialog,
  TeamMembersView. They DUAL-USE the roster (picker Combobox + assigned-user
  NAME display), so wiring them before the name-resolver source exists would
  build them twice (interim-degraded, then final). Held for ONE clean pass after
  the name-resolver slice. Until then those pickers keep the existing admin-
  endpoint probe (a recruiter gets the graceful raw-UUID fallback there — the
  documented interim).
- **Name-resolver endpoint — BUILT (§5 D4b):** `GET /v1/tenant/users/directory`
  resolves `user_id→display_name` for ALL tenant users **incl. inactive/departed**
  (historical integrity), minimal projection, batch-capable (`?user_ids=`), under
  the new recruiter-tier `tenant:user:read:directory` scope (the 10 list-view
  viewers). The endpoint exists; **the FE repoint is what remains** (below).
- **STILL deferred (the repoint pass, NEXT directive):** the 7 list/detail
  name-resolvers + the 5 assignment views' assigned-name display still call the
  admin probe. Until they repoint to the directory endpoint, recruiter
  name-resolution in those views is a silent no-op (shows the id / no name).
- **Risk:** low — the named recruiter gap (task assignment) is closed; the
  remainder are disclosed interim affordances, not unenforced guardrails.
- **Close criteria:** author the name-resolver slice, then repoint the 7 list-
  views + the 5 pickers (Combobox → assignable, name → directory) in one pass.
