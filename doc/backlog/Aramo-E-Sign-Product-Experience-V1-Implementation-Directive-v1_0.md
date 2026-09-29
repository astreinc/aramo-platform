# Aramo — E-Sign Product Experience V1 Implementation Directive v1.0

**Directive ID:** `Aramo-E-Sign-Product-Experience-V1-Implementation-Directive-v1_0`
**State:** RATIFIED — IMPLEMENT GO (PO/Architect, baseline `130bfb65`). D-1…D-5 APPROVED as proposed. Gate-5 discipline in force: implement + verify locally, NO commit/push/PR/merge. Sequence `F1 ∥ F2 → F3 ∥ PX-3-auth → PX-1 ∥ PX-2`, chronological RED-first per slice.
**Nature:** Implementation directive — the actionable build spec for the independent E-Sign product V1
**Implements:** `Aramo-E-Sign-Product-Experience-V1-Backlog-Directive-v1_0` (now ACTIVATED)
**Governed by (precedence, highest first):** `Aramo-E-Sign-Independent-Digital-Signature-Platform-Directive-v1_0` → `Aramo-E-Sign-Dedicated-Prod-and-Subscription-Backlog-Directive-v1_0` → the Backlog directive above → this directive
**Baseline:** `origin/main` = `130bfb6550ba7b00123fea2f83cd7b5fd8739faa` (`130bfb65`, PR #855 E-Sign OC merged, 2026-09-28). Gate-0 recon captured against this SHA.
**Applies to:** `apps/esign-service`, `libs/esign`, `apps/sign-web`, a NEW `apps/esign-web`, `libs/documents-rendering`, `libs/object-storage`, `libs/entitlement`, `libs/identity`, `libs/auth`/`libs/auth-core`, `libs/documents-contracts`, `apps/auth-service`, deploy/nginx + docker-compose.prod.yml + CI config
**Authority boundary:** authorizes V1 build within the slices below ONLY. Does NOT authorize billing, self-service signup UX, per-user product entitlement, multi-signer, templates, a public E-Sign API/SDK, or an identity-assurance engine. Each remains deferred per the Backlog directive §20–21.
**Canonical filing target:** Aramo `locked/` (`-LOCKED` suffix on ratification)
**Repo visibility target:** `doc/backlog/`

---

## 0. Reading order

Read this directive WITH the Gate-0 recon report (in-session) and the three governing directives. Every substrate claim below carries a `path:line` from the recon so implementers verify against code, not prose. Deviations from directive text are reported as **typed divergences**, never silently absorbed (CLAUDE.md Gate discipline).

---

## 1. V1 goal (ratified, unchanged)

> An authorized sender uploads a PDF, identifies one signer, places required signature + date fields visually, sends it, and the recipient reviews the ACTUAL document and signs it through `sign.aramo.ai` — producing an executed PDF + execution certificate. A party that is NOT an Aramo ATS tenant can do this by subscribing to E-Sign alone.

End-state proof (§17) is the acceptance bar. Everything between is scoped to reach exactly that, no more.

---

## 2. What the recon proved (the starting substrate)

**Proven and load-bearing (DO NOT REBUILD — §14):** token exchange→session (tenant resolved server-side from the capability token), disclosure acceptance, typed/drawn signature capture + fill, complete + `envelope_status` state machine, evidence manifest (DOC-3/4 sealed), the **`SignatureField` placement model** (`libs/esign/prisma/schema.prisma:95-118` — page/x/y/w/h/type/required/signer, all present), the **pdf-lib coordinate renderer** that stamps at x/y (`libs/documents-rendering/src/lib/pdf-lib-document-rendering.adapter.ts:106-129`), executed-artifact production + write-back + generic completion event + durable outbox/retry (OC), the ATS-neutral opaque-UUID schema (zero cross-schema FKs), and the provider-neutral `SignatureProviderPort` (Pact-verified, 2 consumers).

**Structurally absent (the V1 build):**
1. **No PDF ingestion / no E-Sign-owned source bytes** — `addDocument` takes a `document_ref`/`document_revision_ref` UUID pair only (`libs/esign/src/lib/esign.repository.ts:22-30,152-155`); source bytes are pulled from Core Documents (`apps/api`) at completion via `DOCUMENTS_API_URL` (`apps/esign-service/src/app/document-source-http.adapter.ts:12-25`). A standalone subscriber has **no Core Documents** to hold their PDF.
2. **No field-definition API** — `addField` is dead outside tests (`libs/esign/src/lib/esign.repository.ts:179` vs sole caller `libs/esign/src/tests/esign-flow.integration.spec.ts:54`); `CreateEnvelopeRequest` carries no fields array. Consequence: the live executed PDF is **unstamped** because `placements` is always empty (`execution.service.ts:74-98`).
3. **No signer document exposure** — `exchange` returns 3 UUIDs only (`esign-http.controller.ts:120-130`); no signer endpoint returns source bytes/URL or a field list. The signer cannot see the document.
4. **No standalone account seam** — `esign` capability exists but is RESERVED/inert (`libs/entitlement/src/lib/capability.ts:5-9`); entitlement is per-TENANT (`entitlement` migration PK `(tenant_id, capability)`); no E-Sign `consumer_type`/login; no Sender/Viewer role (13 ATS-shaped roles, `role-catalog.view.ts:38-60`); every envelope-create caller is talent-bound + recruiter-gated (`rtr-orchestrator.service.ts:80-129`, `offer-document-orchestrator.service.ts:95-142`); esign-service has **no caller auth** (`app.module.ts:63-66`).
5. **No sender ingress/app** — `esign.aramo.ai` has no nginx block/env/app; sign.aramo.ai exists but `DEPLOY=NO until provisioned` (`deploy/nginx/templates/aramo.conf.template:194-216`).

---

## 3. Program shape — 3 foundations, 3 lanes

```
E-SIGN PRODUCT EXPERIENCE V1
│
├── FOUNDATIONS (platform seams; land first)
│     F1  E-Sign document-source OWNERSHIP  (upload + store + freeze bytes)
│     F2  Field-DEFINITION API + DTO         (reach the existing model + renderer)
│     F3  Signer-scoped source + field reads (token-authorized viewer data)
│
├── PX-1  Sender / Authoring  (apps/esign-web + authenticated command API + esign.aramo.ai)
├── PX-2  Signer Productization (PDF viewer + positioned fields + real disclosure + date)
└── PX-3  Standalone Account Seam (E-Sign-only tenant, entitlement, org, Sender/Viewer roles)
```

**Dependency order:** `F1 ∥ F2 → F3 ∥ PX-3-auth → PX-1 ∥ PX-2`.

---

## 4. DECISION POINTS (ratify before the dependent slice starts)

Each fork is real; the recommendation is the minimal path consistent with the Independent-Platform directive. Ratify (or override) at the named slice.

**D-1 — E-Sign source-document ownership shape (blocks F1).**
Recommend: introduce an **E-Sign-owned source store** behind a `DocumentSourceProviderPort` with a `source_mode` discriminator on `EnvelopeDocument` — `OWNED` (bytes uploaded to E-Sign object storage) vs `CORE_REF` (existing Core Documents pull, unchanged for ATS). ADD-not-rename: add nullable `source_mode`, `source_object_key` columns; the current `document_ref`/`document_revision_ref` remain for `CORE_REF`. E-Sign gains a `DocumentStoragePort` binding to `libs/object-storage` — reversing today's "E-Sign holds no DocumentStoragePort" posture *only for OWNED mode*. This is permitted by Independent-Platform §16 (E-Sign owns its signing-domain persistence) and is the pivotal V1 enabler.
*Alternative (rejected for V1): route standalone uploads through Core Documents — reintroduces ATS/Core coupling the standalone product must not depend on.*

**D-2 — Authenticated sender command surface location (blocks PX-1 + PX-3-auth).**
Recommend: a **new authenticated sender surface ON esign-service** (`v1/esign/sender/*`) that verifies a shared-identity JWT (auth-service-minted) and enforces the `esign` capability, keeping the existing `v1/esign/envelopes` internal service-to-service surface and `v1/esign/signing` capability surface intact — three explicit auth zones. This keeps E-Sign an independent authenticated platform (Independent-Platform §13A) rather than routing the standalone product through the ATS `apps/api`. Requires esign-service to take a new cross-lib dep on `libs/auth` (3-place wiring per CLAUDE.md).
*Alternative (allowed if Architect prefers): a thin authenticated command controller in `apps/api` that proxies `SIGNATURE_PROVIDER_PORT`. Rejected as default because it couples the standalone product to Core.*

**D-3 — Standalone identity representation (blocks PX-3).**
Recommend: model a standalone subscriber as **its own tenant** with capability bundle `[esign]` and NO `ats` — `{ATS=NO, E-Sign=YES}` is representable at **tenant grain today** (`entitlement` migration:8-14). Add a new `consumer_type` for the E-Sign sender (closed enum currently 4: recruiter|portal|ingestion|platform — `auth-context.types.ts:14`) and new org roles `esign_owner`/`esign_admin`/`esign_sender`/`esign_viewer`. **Per-USER product entitlement stays DEFERRED** — not required when the E-Sign org is its own tenant.
*This is the single biggest scope-limiter: it keeps V1 out of the per-user entitlement rework.*

**D-4 — Sender console host (blocks PX-1 ingress).**
Recommend: a **dedicated new `apps/esign-web`** (own `scope:esign-sender` wall) + `esign.aramo.ai` nginx server_name block, mirroring the sign-web bake/serve pattern — NOT reuse of platform-web/portal-web (single-scope walls) or platform-admin (a Nest backend). (Recon D-Q3.)

**D-5 — Account-mismatch / signer login recognition.**
Ratify: **OUT of V1.** The signer stays capability-only; no login recognition, no mismatch UI. The identity-assurance policy is a later directive (Backlog §21). Records this as a deliberate deferral, not an omission.

---

## 5. FOUNDATION F1 — E-Sign document-source ownership

**Objective:** an envelope can be created from a **directly uploaded PDF** owned by E-Sign, with zero Core Documents/ATS dependency; the ATS `CORE_REF` path is untouched.

**Build:**
- **Migration (D-1, ADD-not-rename):** `EnvelopeDocument` gains nullable `source_mode String` (`OWNED`|`CORE_REF`), `source_object_key String?`, `content_type String?`, `byte_size Int?`. `document_ref`/`document_revision_ref` become nullable-of-meaning for `OWNED`. Register the migration in EVERY curated integration-spec migration list (find by repo-wide grep of the filename — curated lists are NOT all flat arrays; add a separate `resolve()` const, never a 2nd arg) and, if any returned shape changes, in `pact/provider/src/verify-api.ts` / `verify-esign.ts`.
- **Object storage:** bind an E-Sign `DocumentStoragePort` to `libs/object-storage` (new cross-lib dep → 3-place wiring: `tsconfig.base.json` path + `vitest.shared.ts` alias + importing lib `tsconfig.lib.json` dist-paths). New bucket for E-Sign source PDFs; provision via IaC from the Mac (never Terraform from the box), with CORS if browser-direct upload is used (heed the prod résumé-upload CORS trap).
- **Upload + freeze:** on upload, compute `source_sha256` (reuse the existing integrity anchor), store bytes under `source_object_key`, freeze (immutable once attached). No bytes in Postgres.
- **Source resolution:** `DocumentSourceProviderPort` returns bytes for BOTH modes — `OWNED` from object storage, `CORE_REF` via the existing `DocumentSourceHttpAdapter` (unchanged). `ExecutionService.produce` (`execution.service.ts:62-129`) calls the port mode-agnostically.

**RED-first acceptance (per boundary, chronological):**
1. Prove (RED) an envelope today cannot be created from raw bytes (no upload path) → implement OWNED upload → GREEN: an envelope references an E-Sign-owned frozen PDF with a valid sha256, no `DOCUMENTS_API_URL` call.
2. Prove ATS `CORE_REF` path byte-identical behavior post-change (regression guard).

---

## 6. FOUNDATION F2 — Field-definition API + DTO

**Objective:** a sender can define positioned signature + date fields over the API; the existing model + renderer light up end-to-end.

**Build:**
- Extend the command contract: `CreateEnvelopeRequest.documents[].fields[]` OR a dedicated `POST /v1/esign/.../envelopes/:id/fields` (Architect's call at ratification; prefer fields-in-create for V1 single-signer simplicity). Each field: `{ field_type, page_number, x, y, width?, height?, required?, signer_ref }` — mapping straight to the existing `AddFieldInput` (`esign.repository.ts:41-52`). Wire `createEnvelope` to call `addField` (today it calls only `addDocument`+`addSigner`, `native-aramo-signature.provider.ts:45-49`).
- Validate coordinates against page bounds at define time (the renderer already bounds-checks at stamp time, `pdf-lib-...adapter.ts:110-112`).
- No schema migration (model is complete). This is API/DTO/port + a Pact contract update.

**RED-first acceptance:**
1. Prove (RED) `addField` has no production caller and the executed PDF is unstamped (placements empty) → implement define-fields → GREEN: a SIGNATURE + SIGN_DATE field is created via the API and the produced executed PDF carries a visible stamp at the given coordinates (assert on rendered bytes / placement count > 0, not just a 200).

---

## 7. FOUNDATION F3 — Signer-scoped source + field-list reads

**Objective:** the signer SPA can fetch the frozen source PDF and its positioned fields, authorized by the capability token only (no tenant_id from the browser).

**Build:**
- New token-authorized signer routes on `v1/esign/signing` (the ONLY surface sign-web may reach, `vite.config.ts:19`):
  - `GET source` → frozen source PDF bytes or a short-lived signed URL, resolved from the session's envelope (mode-agnostic via F1's port).
  - field-list for the session → the signer's positioned fields (`field_id, field_type, page_number, x, y, width, height, required`) — populate the currently-unused `SignField` type (`sign-api.ts:11-16`).
- Enrich the `exchange`/session response (or a new `GET session`) with document metadata (page count, title) — extend `SessionContext` return WITHOUT leaking tenant_id (keep the deliberate drop at `esign-http.controller.ts:126`).
- Security: source bytes are delivered ONLY inside a valid, disclosure-gated signer session; never expose the provider `:id/executed`/`:id/evidence` routes to the signer proxy.

**RED-first acceptance:**
1. Prove (RED) `exchange` returns 3 ids and no signer route yields source/fields → implement → GREEN: a valid session token retrieves the frozen source bytes + a non-empty positioned field list; an invalid/expired token is denied; no tenant_id is required or accepted from the client.

---

## 8. PX-1 — Sender / Authoring experience (`esign.aramo.ai`)

**Objective:** an authenticated sender: upload PDF → add one signer → place signature+date fields visually → preview → send → track status → view/download execution evidence.

**Build:**
- **New app `apps/esign-web`** (D-4): React/Vite SPA, tag `scope:esign-sender`, own port pair (next free after sign-web 4204/4304), talks only to the authenticated sender command API. Enrol in nginx bake (`deploy/nginx/Dockerfile`), a new `${NGINX_ESIGN_SERVER_NAME}` server_name block (`aramo.conf.template`), compose env (`docker-compose.prod.yml`), and `ci/scripts/verify-frontdoor-conf.ts` host-tag list. Ship `DEPLOY=NO until provisioned` like sign-web.
- **Authenticated sender command API (D-2):** `v1/esign/sender/*` on esign-service — JWT-verified, `esign`-capability-enforced — exposing: create-envelope (with uploaded document + fields), send, list/track envelopes, get evidence, download executed. Reuses F1/F2 underneath.
- **FE surfaces:** upload control; single-recipient form; a **visual field-placement canvas over the rendered PDF** (signature + date); preview; send; a status/track view; executed-document + certificate download.

**RED-first acceptance:**
1. An `esign`-entitled sender authenticates, uploads a PDF, places a signature+date field, and sends — producing an envelope in SENT with a signer capability issued. A caller lacking `esign` capability is denied (fail-closed). No ATS/talent/requisition entity is involved at any step.

## 9. PX-2 — Signer productization

**Objective:** the signer reviews the ACTUAL PDF with fields in their true positions, applies signature + date, completes — layered on the retained flow (§14), never replacing it.

**Build (additive to `apps/sign-web`):**
- Mount a **PDF viewer** in the `SIGN` stage (`App.tsx:120-153`, between the `<h2>` and the capture controls) fed by F3's source read.
- Render **positioned field overlays** from F3's field list (replacing the hand-typed field id at `App.tsx:126`); the signer clicks a field to fill it.
- Add a **date field** capture and ship **real disclosure text** (replace the placeholder hash `doc4-esign-disclosure-v1` at `App.tsx:15` with actual disclosure content + its true hash).
- Keep exchange→disclosure→typed/drawn capture→complete untouched (do-not-rebuild).

**RED-first acceptance:**
1. Opening a valid signer link renders the actual PDF + positioned signature/date fields; the signer signs + dates and completes; the executed PDF carries the stamps at those coordinates; the generic completion event fires unchanged. Opening a tokenless URL still shows the empty-state guard.

## 10. PX-3 — Standalone account seam

**Objective:** prove `{ATS=NO, E-Sign=YES} → enter sender console → create/send envelope` — the minimum account substrate, no billing.

**Build (D-3):**
- A standalone E-Sign **tenant** provisionable with capability bundle `[esign]` (no `ats`); make the `esign` capability **load-bearing** — enforce `@RequireCapability('esign')` on the `v1/esign/sender/*` surface (today inert, `entitlement.guard.ts:48-54`).
- New `consumer_type` for the E-Sign sender + a login path via the shared auth-service (Cognito → RS256 JWT), so a non-ATS user can authenticate. (New consumer_type = cross-cutting; touches the closed enum + guard + seed — inventory every site.)
- New E-Sign org roles `esign_owner`/`esign_admin`/`esign_sender`/`esign_viewer` in the identity role catalog (`role-catalog.view.ts`), each with a scope set; `esign_sender` grants create/send/void/track/download. Honor scope-add discipline: ≈5 seed touchpoints, catalog↔id-map bijection, seed-scrub's two catalog constants, run FULL affected integration before push.
- **Deferred (record explicitly):** self-service signup UX, billing/plans/metering, per-user entitlement, org CRUD beyond what proves the seam.

**RED-first acceptance:**
1. Prove (RED) no E-Sign-only user can authenticate + create an envelope today → implement → GREEN: a user in an `[esign]`-only tenant with `esign_sender` authenticates into the console and sends an envelope; a user without the `esign` capability is denied; no ATS data exists for that tenant at any point.

---

## 11. Auth & trust-context rules (invariant across all slices)

1. **Three distinct auth zones on esign-service:** internal service-to-service (`v1/esign/envelopes`, unchanged) · authenticated sender (`v1/esign/sender`, JWT + `esign` capability) · capability signer (`v1/esign/signing`, token only). Never merge them.
2. Sender surface = authenticated; signer surface = capability-authenticated. The signer NEVER needs an account; the capability link is the authority for the envelope (Backlog §11–12).
3. Raw signing capability material stays inside E-Sign; the sender console never receives a raw signing token (Independent-Platform §7).
4. sign-web stays `scope:sign` (no ATS/Documents/Portal imports); `apps/esign-web` stays `scope:esign-sender`. The signer surface never gains authoring/upload (Backlog §7, R-3).
5. Send authority derives from `esign` capability + org role, never bare Aramo authentication (Backlog §10).

## 12. Contracts & CI obligations (non-negotiable)

- **Pact both directions** (Independent-Platform §24/§31): new sender-command contract + new signer source/field-list contract, real consumers/providers, no synthetic contracts. Run FULL `pact:consumer` before `pact:provider`; baseline on clean origin/main (stash + `prisma:generate`) to split regression from debt.
- **api-surface-manifest**: classify every new route; new live route/scope MUST register in the manifest + `verify-orphan-scopes` or contract-parity/static-governance FAILS.
- **OpenAPI**: add the new routes; `openapi:lint` (redocly) is required; 3.1 nullable = `type: [x,'null']`.
- **Vocabulary**: Tier-2 clean (this program uses `account`/`recipient`/`signer`/`sender`; never the banned literals).
- **env-passthrough parity**: any new env var read by code + in `.env.prod.example` MUST appear in `docker-compose.prod.yml` `environment:` (confirm via `docker compose config`).
- **repo-map**: `git add` new src → `repo-map:generate` → RE-`git add` the 3 json → commit (working-tree staleness ships CI-red).
- **`.nxignore`/vitest**: heed the worktree-scan Docker-saturation traps; run integration with `--root apps/<x> --no-file-parallelism` + sourced `.env`.
- **Local wall before push**: `ARAMO_RUN_INTEGRATION=1 nx run api` locally; new cross-lib dep = 3-place wiring; new Nest ctor arg = grep every `createTestingModule` + `new` site; `git diff HEAD --stat` empty before push.

## 13. Migrations & data-model changes (summary)
- **F1:** `EnvelopeDocument` +`source_mode`,`source_object_key`,`content_type`,`byte_size` (nullable, ADD-not-rename). New object-storage bucket (IaC from Mac).
- **F2/F3:** none (SignatureField model complete) — API/DTO/port + contracts only.
- **PX-3:** identity — new `consumer_type` value, new role catalog entries + scopes + seed; entitlement — make `esign` enforceable (no schema change; guard wiring). Overloaded columns: ADD-not-rename. `identity_index`: NO `tenant_id`, NO PII, ever.

## 14. DO NOT REBUILD (grounded)
Token exchange→session (tenant server-resolved) · disclosure acceptance · typed/drawn capture + fill · complete + `envelope_status` machine + envelope lifecycle guard · evidence manifest (DOC-3/4 SEALED — do not reopen) · `SignatureField` placement model · pdf-lib coordinate renderer + `ExecutionService.produce` · executed-artifact + write-back + generic completion event + durable outbox/retry (OC) · ATS-neutral opaque-UUID schema (keep zero cross-schema FKs) · provider-neutral `SignatureProviderPort` (extend, don't replace) · DOC-5 RTR gate / DOC-6 Offer evidence-only (untouched). Additive work layers ON TOP; a refactor that supersedes a path removes it in the SAME PR (no legacy parking).

## 15. Explicitly OUT of V1
Multi-signer / signing order · organization or counterparty (non-individual) signing · templates · reminders/expiry-config/bulk-send · field types beyond signature/date/initials/text · public E-Sign API/SDK/developer portal (`api.esign.aramo.ai`) · billing/pricing/tiers/metering · **per-user** product entitlement · self-service signup UX · account-mismatch / signer-login identity-assurance (D-5) · external provider (DocuSign/Adobe) · dedicated-DB or dedicated-box cutover · WORM/legal-hold · Model-C Offer acceptance · reopening Core Documents ownership or the Documents contract boundary.

## 16. Build sequence & Gate discipline
- Sequence: `F1 ∥ F2 → F3 ∥ PX-3-auth → PX-1 ∥ PX-2`. Each slice is chronological RED-first per boundary (failing proof → verbatim RED → implement → GREEN, interleaved, no approval pause; non-vacuous = assert before value existed + exact after).
- **Gate 5** stops with local implementation + verified diff — no commit/push/PR. **Gate 6** is a separate commit-plan turn. Each work item = dedicated branch off `origin/main`; update-branch (merge main IN) before first push; flakes → re-run, never fix-forward. Merge via governed queue (deployment-gate sole required check); two-check before merge (exact-SHA green ∥ empty FIX_NOW at head).
- Gate-6 reports carry proof CONTENT (each proof by name: `file:line` + test), not merge mechanics.

## 17. Completion definition (proof-based)
V1 is complete only when PROVEN, not configured:
1. An `esign`-entitled sender in an **`[esign]`-only tenant** (no ATS data) authenticates into `esign.aramo.ai`, uploads a PDF, places signature+date fields visually, and sends.
2. E-Sign issues a signer capability and delivers the link; the source PDF is **E-Sign-owned** (no Core Documents dependency for the standalone path).
3. The signer opens `sign.aramo.ai/s/<token>`, **reviews the actual PDF** with positioned fields, signs + dates, completes — with no account.
4. E-Sign produces the executed PDF **visibly stamped at the field coordinates** + an execution certificate.
5. The generic completion event flows unchanged; for the ATS consumer the existing RTR/Offer path still works byte-for-byte (regression).
6. Trust contexts stayed separate: signer surface never exposed authoring; no raw token left E-Sign; send authority came from `esign` capability + role, not a bare login.
7. All CI walls green; Pact both directions; no cross-schema FK introduced.

## 18. Trap register (honor; from the substrate memory)
Curated-migration-list count is untrustworthy — grep the filename repo-wide; add a separate `resolve()` const, never a 2nd arg (ENOTDIR) · `splitDdl` is comment-blind (no `;` in `--` lines) · Prisma 7 P2002 shape at `meta.driverAdapterError…` · `NULL=NULL` never true in immutability triggers · new cross-lib dep = 3-place wiring · new Nest ctor arg ripples hand-wired test modules · nx cache hides type errors (cold `--skip-nx-cache` is truth) · local-run-link symlinks shadow the vitest source alias · lockfile regen on macOS prunes linux natives (never `rm` package-lock) · object-storage bucket needs CORS (prod résumé-upload trap) · Terraform only from the Mac · repo-map staging order · scope-add seed touchpoints + seed-scrub two constants · env-passthrough must reach the compose `environment:`.

---

*End of directive. V1 turns the proven E-Sign engine into an independent product by landing three platform foundations (document-source ownership, field-definition API, signer document exposure) and three lanes (sender console, signer productization, standalone account seam), keeping the authenticated-sender and capability-authenticated-signer trust contexts strictly separate, with per-user entitlement, billing, and identity-assurance deliberately deferred. No code begins until the PO issues the implement GO and the RED-first Gate flow runs slice by slice.*
