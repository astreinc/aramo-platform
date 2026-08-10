# SEG-08 — LEDGER→SUBSTRATE RECONCILIATION + COMPLETION MAP (Directive §13 + §14)

**Auditor:** substrate auditor (READ-ONLY). **Baseline:** `origin/main` = `ca0974090724b36b130f4d39ea5b1ef486d6adf4` (PR #589). Working tree detached at `3a4a3a4` (#588, one merge behind); all authority reads via `git show origin/main:<path>`.
**Primary source:** `Aramo-Requisition-Enterprise-Program-Planning-Package-v1_0.md` §7 (the Track 0–10 numbering) + `Aramo-Master-Execution-Ledger-v1_1.md` PART 3 (per-track articulation) + `Aramo-Master-Execution-Ledger-v1_6.md` (current-state, Track 1–4 only) + Track2 directive + Cross-Core annotation + Phase-1 Plan v1.6 + Charter v1.4.

---

## NUMBERING-SCHEME FINDING (read first — a naming trap the tasking risks conflating)

There are THREE independent "T#/Track#" numbering schemes in the corpus. They DO NOT correspond:

1. **Requisition Enterprise Program Tracks 0–10** — the tasking's subject. Defined ONLY in `Aramo-Requisition-Enterprise-Program-Planning-Package-v1_0.md:332-354` (§7 dependency graph) and articulated in `Aramo-Master-Execution-Ledger-v1_1.md:46-116`. This is the "Track 2/5/6/7/8/9/10" the directive means.
2. **Cross-Core T1/T4/T5** — `Aramo-Cross-Core-T1-T4-T5-Rescoping-Annotation-v1_0-LOCKED.md`. These are Core↔ATS integration tracks (assessment-read path, R9 gate, judgment-out). `Cross-Core T4/T5 ≠ Program Track 4/5`. Do NOT cite the Cross-Core annotation as a source for Program Track 5.
3. **Phase-1 Delivery Plan Milestones M1–M7 / Charter Steps 1–6** — a different decomposition entirely (M6 maturation, M6.5 portal, M7 hardening; Charter go-live steps).

The Master Execution Ledger **v1.6** (current) contains NO §13-style per-track entry for Program Tracks 5–10 — it tracks only Tracks 1–4. The authoritative remaining-sequence text for Tracks 5–10 lives in **Ledger v1_1 PART 3** (marked `[S]` = specified, substrate-not-reconned) which v1.6 supersedes for T1–T4 but does NOT re-state for T5–T10. **DIVERGENCE (iii) substrate-moved / ledger-not-carried: the current ledger does not carry Tracks 5–10; they survive only in v1_1.**

---

## §13 — PER-TRACK LEDGER→SUBSTRATE RECONCILIATION

### Program Track 0 — RESET + ARCHIVE
- **LEDGER SAYS:** program-enabling reset/archive, "First … blocks all schema change" (`Planning-Package:333-335`); T0 built+tested against controlled data, prod execution separately approved (`Planning-Package:435`).
- **SUBSTRATE:** `libs/tenant-reset` present; 20 delete targets (Ledger v1.6:80 `origin/main`@95611f3 post-Track4), 0 restore paths. Reset is one-way (Ledger v1.6:138).
- **STATUS:** CAPABILITY-ALREADY-BUILT (built; NOT executed against Astre prod — deployment/exec withheld).
- **CHANGE SURFACE:** none new; execution-authorization only.

### Program Track 1 — REQUISITION LIFECYCLE
- **LEDGER SAYS:** status supersession, governed transitions, events, `job_domain` re-point, Pipeline disposition (`Planning-Package:336-338`; `Ledger-v1_1:46-50`).
- **SUBSTRATE:** `RecruitingStatus` 9-value enum, `job_domain.Requisition` retired (`Ledger-v1_1:48`). MEMORY: Track 1 CLOSED.
- **STATUS:** CAPABILITY-ALREADY-BUILT / LEDGER current (v1_1 marks ✅ COMPLETE).
- **CHANGE SURFACE:** none.

### Program Track 2 — SELECTION RENAME (engagement → selection)  ⭐ IN-SCOPE DETAIL
- **LEDGER SAYS:** `libs/engagement` → `libs/selection`, `TalentJobEngagement` → `TalentSelection`; "v1.0 called this 'mechanical' and said it blocked Track 3. Both were wrong." (`Ledger-v1_1:52-60`). Directive §0: "**[G] `libs/engagement/src/index.ts` exports 45+ symbols**" (`Aramo-Track2-Directive-v1_0-LOCKED.md:16`); "Track 2 may be deferred until after Track 3 without cost" (`:37`).
- **CURRENT SUBSTRATE (grounded @ ca09740):**
  - `libs/selection` **ABSENT** (`ls libs/selection` → not present). Rename NOT-STARTED.
  - `libs/engagement/src/index.ts` exports **38 distinct symbols across 34 `export` statements** — NOT "45+". Full symbol list captured (EngagementModule/Controller/Repository/EventRepository/OutboxRepository + aliased EngagementUnpublishedOutboxEvent + PrismaService + 3 views/inputs + 5 create/transition/list DTOs + 8 message-delivery DTOs/payloads + 5 delivery-port symbols + 6 response/conversation DTOs/payloads + 5 state/event-value symbols).
  - Delivery port present and correctly NOT selection-named (`DeliveryProvider`, `DELIVERY_PROVIDER_TOKEN`, `SendStubDeliveryProvider`) — matches directive §1 "DOES NOT RENAME".
  - **Consumer count:** 25 files outside `libs/engagement/` import `@aramo/engagement` (incl. tsconfig path files + negative-control fixtures + real consumers: `apps/api/src/app.module.ts`, `record-reconcile.orchestrator.ts`, `apps/ats-web/src/engagement/{legal-transitions,types}.ts`, `libs/evidence/*` (module+repository+3 specs), `libs/outbox-publisher/*` (module+processor+spec), `libs/reporting/src/lib/reporting.service.ts`, `libs/submittal/src/tests/submittal.repository.integration.spec.ts`).
  - **SCHEMA ENTANGLEMENT (confirms tasking warning):** submittal-owned models physically declare the engagement Postgres schema — `libs/submittal/prisma/schema.prisma:102` `model TalentSubmittalRecord` → `:170` `@@schema("engagement")`; `:226` `model TalentSubmittalEvent` → `:253` `@@schema("engagement")`. Only submittal's `OutboxEvent` (`:186`→`:195`) uses `@@schema("submittal")`. So an `engagement`→`selection` Postgres-schema rename drags/orphans submittal tables the directive §4 PROHIBITS touching.
- **STATUS:** **NOT-STARTED** (nature = NAMING/STABILIZATION-ONLY + REQUIRES-MIGRATION [PG schema rename] + REQUIRES-PO-RULING [submittal-table entanglement]). Directive is filed and ready; deferred by its own §0 ruling.
- **CHANGE SURFACE:** `libs/engagement`→`libs/selection` (module/controller/repos/DTOs/state machine) · Prisma `engagement` schema rename · 3-place nx wiring · 25 consumer import updates (grounded) · outbox-publisher coupling · 2 triggers (BEFORE-UPDATE + events immutability) · literal-path specs · Pact if any HTTP path carries "engagement" (directive §R5 → `pact/provider/src/verify-api.ts`).

### Program Track 3 — PLACEMENT + PRE-START
- **LEDGER SAYS:** absent lifecycle (offer→acceptance→pre-start), fallthrough taxonomy, replacement authorization, capacity reservation (`Planning-Package:340-342,118-121`).
- **SUBSTRATE:** E1-a/b/c/d, E2, E3, E4, E6, E7 all merged (Ledger v1.6:325; MEMORY Track 3 CORE SEAMS COMPLETE). `libs/placement` with PlacementProcess/PlacementProcessEvent/OutboxEvent.
- **STATUS:** CAPABILITY-ALREADY-BUILT (core seams). Registered follow-ups open (E6 Class-B reads, STARTED post-start attrition gap).
- **CHANGE SURFACE:** none for core; follow-ups separate PRs.

### Program Track 4 — CONTRACT ASSIGNMENT (capacity becomes true)
- **LEDGER SAYS:** `ContractAssignment` lifecycle, capacity CONSUMPTION, signed `capacity_balance`, `CapacityStatus` lands here, Pipeline sheds `openings_available` decrement (`Ledger-v1_1:90-92`).
- **SUBSTRATE:** Increment 1 (#586) + B2 (#588) MERGED. `libs/placement/prisma/schema.prisma:234` `model ContractAssignment`; B2 dropped stored `openings_available`, public value now DERIVED `max(capacity_balance,0)` (Ledger v1.6 §0.2:56; MEMORY T4-B2). `assignment:read` (#587), assignment UI (#589).
- **STATUS:** CAPABILITY-ALREADY-BUILT for Inc1+B2. Track 4 NOT fully complete — `assignment:create`/`update` behavioral ops DEFERRED (catalog/seed/role-matrix only). HARD DEPLOY-ORDER: B2 req-reads depend on `placement.ContractAssignment`; prod lacks chain → migration-before-application required (Ledger v1.6:56; MEMORY).
- **CHANGE SURFACE:** create/update live ops (deferred); deployment ordering.

### Program Track 5 — COMMERCIAL TERMS (person-specific effective-dated rates)  ⭐ IN-SCOPE DETAIL
- **LEDGER SAYS:** "Assignment rate versions, effective-dated: pay · bill · currency · period · overtime · markup · margin · effective_from/to · change reason · approval provenance. **Sarah at $95 and Marcus at $88 on one requisition — impossible today.** Client contract / rate-card entity (`rate_card_id` is a stub pointing at nothing). Blocked by: Track 4." (`Ledger-v1_1:94-96`). Planning-Package §5 (`:288-306`): "ASSIGNMENT RATE VERSION ACTUAL, effective-dated NEW"; "Client contract / rate card [ABSENT — registered, Track 5 integration point]".
- **CURRENT SUBSTRATE (grounded):** `ContractAssignment` (`schema.prisma:234-280`) carries NO rate/pay/bill/currency/markup/margin/effective_from column — grep for `rate|bill|pay_|margin|effective_` in placement schema = ZERO. `libs/placement/prisma/schema.prisma:91` comment: "source of truth (rates/currency/markup are Track 5)." `rate_card_id` remains a bare stub: `libs/requisition/prisma/schema.prisma:264` "rate_card_id String? @db.Uuid // stub ref — no rate-card entity yet (§8 carry)." No rate-card model, no AssignmentRateVersion model anywhere.
- **STATUS:** **NOT-STARTED / REQUIRES-NEW-PRODUCT-WORK + REQUIRES-MIGRATION.** Ledger accurate (not stale).
- **CHANGE SURFACE:** new AssignmentRateVersion model + rate-card/client-contract entity · effective-dating (StoredPolicyVersion precedent) · approval provenance · migration · masking-interceptor extension · API/UI/Pact/events/tests. Blocked-by Track 4 = now satisfied.

### Program Track 6 — REVISIONS + EXTENSIONS  ⭐ IN-SCOPE DETAIL
- **LEDGER SAYS:** "Assignment revisions. **An extension is a revision, not a new assignment.** Amendment history. Blocked by: Track 4." (`Ledger-v1_1:98-100`). Planning-Package §3.3 (`:234-243`) proposed richer states incl. `EXTENSION_PENDING`, `TERMINATED_EARLY`, `CONVERTED_TO_PERMANENT`, `TRANSFERRED`.
- **CURRENT SUBSTRATE:** `ContractAssignmentState` enum = **only `ACTIVE` and `ENDED`** (`libs/placement/prisma/schema.prisma:198-207`). No revision/extension/amendment-history model. Track 4 comment (`:200-205`) explicitly ratifies binary semantics: "Attrition TYPE … is captured as an ending reason, not as distinct lifecycle states — the ratified capacity/guard semantic is binary (active vs ended)."
- **STATUS:** **NOT-STARTED / REQUIRES-NEW-PRODUCT-WORK.** ⚠ Planning-Package §3.3's proposed assignment states (EXTENSION_PENDING etc.) are **OBSOLETE/SUPERSEDED** by Track 4's ratified binary ACTIVE/ENDED — the T6 design basis needs re-derivation (revisions as separate amendment records vs re-expanded enum). REQUIRES-PO-RULING on model shape.
- **CHANGE SURFACE:** new AssignmentRevision/amendment-history model · effective-dating · API/UI/Pact/tests.

### Program Track 7 — PERMANENT PLACEMENT + GUARANTEE  ⭐ IN-SCOPE DETAIL
- **LEDGER SAYS:** "`PermanentPlacement`: STARTED → GUARANTEE_ACTIVE → GUARANTEE_SATISFIED, and FELL_OFF → REPLACEMENT_DUE | REFUND_DUE | PRORATED_CREDIT_DUE → REMEDY_COMPLETED. Operationally started day one; commercially exposed until guarantee expires. Blocked by: Track 3." (`Ledger-v1_1:102-104`; Planning-Package §3.4 `:245-253`).
- **CURRENT SUBSTRATE:** NO `PermanentPlacement` model anywhere (grep `PermanentPlacement|permanent_placement|GUARANTEE_ACTIVE` in `libs/*/prisma/*.prisma` = ZERO; string hits were false positives in consent/field-masking prose). Placement branches only to `ContractAssignment` today (Planning-Package §2.1 shows the intended fork to PermanentPlacement, unbuilt).
- **STATUS:** **NOT-STARTED / REQUIRES-NEW-PRODUCT-WORK + REQUIRES-MIGRATION.** Ledger accurate. Blocked-by Track 3 = satisfied.
- **CHANGE SURFACE:** new PermanentPlacement model + guarantee lifecycle + remedy states · commercial exposure fields · events/API/UI/Pact/tests.

### Program Track 8 — VMS INTEGRATION MODEL  ⭐ IN-SCOPE DETAIL
- **LEDGER SAYS:** "Canonical VMS model. **`source_system` is an unvalidated `String?`; the only closed set is an FE-only union of 7.** VMS columns are stubs — no connector populates them. Blocked by: Track 1." (`Ledger-v1_1:106-108`; Planning-Package §1.3 `:82`).
- **CURRENT SUBSTRATE:** `libs/requisition/prisma/schema.prisma:231` `source_system String? // manual | fieldglass | beeline | oracle | coupa | email | api` — still a bare unvalidated `String?` (no backend enum). `:230` comment: "the source_system stub is the input to a future VMS ingestion PR." Indexed `:339 @@index([tenant_id, source_system])`. No `VmsProvider`/`SourceSystem` enum on requisition (the `SourceSystem` enum in `libs/client-talent-restriction/prisma/schema.prisma:129` is a DIFFERENT, restriction-scoped enum — do not conflate). `libs/job-distribution` exists but is OUTBOUND requisition distribution (SRC-2 sourcing), NOT VMS ingestion.
- **STATUS:** **NOT-STARTED / REQUIRES-NEW-PRODUCT-WORK.** Ledger accurate. Blocked-by Track 1 = satisfied.
- **CHANGE SURFACE:** backend VMS provider enum/validation · canonical VMS model · connector(s) · API/events/tests. Named-trigger deferral: "first VMS-integrated client" (Planning-Package:385).

### Program Track 9 — REPORTING + OPERATIONAL VIEWS  ⭐ IN-SCOPE DETAIL
- **LEDGER SAYS:** "Fill rate · time-to-fill · fallthrough rate and reasons · assignment pipeline · margin. **Fallthrough analytics are only possible once Track 3 stops hard-deleting the evidence.** Blocked by: Track 4." (`Ledger-v1_1:110-112`).
- **CURRENT SUBSTRATE (grounded):** `libs/reporting`, `libs/export`, `libs/visibility` all EXIST with real surface — `libs/reporting/src/index.ts`: ReportingModule/ReportingController/DashboardController/ReportingService + views TenantCountsReportView, RequisitionStatusRollupView, PipelineStageRollupView, PlacementCountReportView, DashboardView. `libs/export`: ExportModule/Controller/Service + field-catalog + csv-stringifier. `libs/visibility`: resolver/interceptor/management-depth. **BUT the specific T9 analytics are ABSENT:** grep of `libs/reporting/src/lib/reporting.service.ts` for `fill|time.to.fill|fallthrough|margin` = ZERO matches. No fill-rate / time-to-fill / fallthrough-analytics / margin metric exists.
- **STATUS:** **PARTIALLY-BUILT.** Reporting INFRASTRUCTURE already built (counts/rollups/dashboard/export/visibility); the T9-named analytics (fill rate, time-to-fill, fallthrough rate+reasons, assignment pipeline, margin) NOT built. Ledger NOT stale (it names metrics that genuinely don't exist). Compounding TEST-INFRA-GAP: `libs/reporting|export|visibility` carry ZERO lib-local integration specs (MEMORY; Ledger v1.6:336) — enrolment alone is a no-op.
- **CHANGE SURFACE:** new metric queries in reporting.service · fallthrough analytics (depends on E3/E6 preserved evidence — satisfied) · margin (depends on Track 5 rates — NOT satisfied; margin analytics gated on T5) · lib-local integration coverage · API/UI/tests.

### Program Track 10 — CROSS-MODULE UX CONSISTENCY
- **LEDGER SAYS:** "Navigation and final polish **only**. UI ships inside every business track (PO ruling 9) — a track that ships backend without its UI has not shipped." (`Ledger-v1_1:114-116`; Planning-Package §7 `:354,363`).
- **CURRENT SUBSTRATE:** per-track UI shipping (Placements nav/board/detail merged #589 — first user-reachable placement surface; requisitions list rebuilt #503). No dedicated T10 consolidation PR yet.
- **STATUS:** **PARTIALLY-BUILT / ongoing** (by design — polish-only, last). NAMING/STABILIZATION-adjacent. MEMORY notes forward-reconciliation items deferred to Track 10 (e.g., D3a/cockpit-clamp expand affordances, Ledger-v1_1:177).
- **CHANGE SURFACE:** navigation consistency + final integration polish; no new domain surface.

---

## §14 — WHOLE-PROGRAM COMPLETION MATRIX

### CAPABILITY-COMPLETE (built + merged; capability discharged)
- Program **Track 0** reset/archive (built; NOT executed — exec withheld) · **Track 1** requisition lifecycle (RecruitingStatus 9-val, job_domain retired) · **Track 3** placement E1-a/b/c/d,E2,E3,E4,E6,E7 (core seams) · **Track 4** Inc1 (A1/B1/C/D/F) + B2 capacity cutover + assignment:read.
- Cross-program: **Identity model** (ADR-0016 ATS-as-Heart) ratified+slices · **Sourcing** SRC-1/2 (PR-4 gated) · **Auth-decoupling** ADR-0021 arc (only 5a+5b post-deploy proof open) · **ADR-0024 Policy Engine** · **Front-Door** PR-0/1/0b/2 (PR-3 cutover pending) · **Portal** P1–P4 · **Settings Rebuild** D1–D5 (Charter Step 2 CLOSED) · **Platform Console** INC-3.

### NAMING-CLEANUP-OPEN
- **Program Track 2** engagement→selection rename (directive filed, NOT-STARTED, deferred by §0). Entangled with submittal PG-schema tables — see contradiction C1.

### PRODUCT-UI-OPEN
- **Track 10** cross-module navigation polish (ongoing) · T4 `assignment:create/update` UI + live ops (DEFERRED) · T4 `REQUISITION_NO_OPENINGS` FE dead-handler cleanup (DEFERRED) · T4-E live E2E / ACTIVE→END fixture (unestablished, MEMORY).

### TEST-INFRA-GAP
- `libs/reporting|export|visibility` ZERO lib-local integration specs (enrolment = no-op) · **OpenAPI contract-drift route/handler axis** never checked (`openapi:drift-check` is `$ref`-integrity only; LIVE-but-UNDOCUMENTED: `/v1/pipelines`, `/v1/requisitions`, `POST /v1/placements/{id}/assignment/end`) — Ledger v1.6:56.

### DEPLOYMENT-NOT-YET-EXECUTED
- **DEPLOYMENT AUTHORITY WITHHELD** program-wide (Ledger v1.6:21) · T4-B2 migration→application rollout ORDER constraint (prod lacks ContractAssignment chain; app-before-migration = req-reads FAIL) · **S3 presigned fix (#576) fixed-not-deployed**, reverts to ACTIVE INCIDENT on named triggers (Ledger v1.6 §4) · auth 5a+5b post-deploy login proof · front-door PR-3 cutover · Astre prod provisioning (Charter Step 4) · image-provenance OCI label gap (Ledger v1.6:155).

### KNOWN-FOLLOW-UP (registered, separate PRs)
- E6 Class-B reads coverage (reporting/export/visibility) · E7 defect1 scheduled-end + error-code parity · nullable-column immutability hardening (`IS NOT DISTINCT FROM`) · **STARTED post-start-attrition** representation gap · downstream outbox retention · D-T0-ARCHIVE-PATH-1 restore gap (0 restore paths) · `error-messages.ts:91` 403 wording.

### REQUIRES-NEW-PRODUCT-WORK (remaining program tracks, unbuilt)
- **Track 5** commercial terms / rate versions / rate-card entity · **Track 6** assignment revisions+extensions · **Track 7** permanent placement + guarantee · **Track 8** VMS integration model · **Track 9** analytics half (fill rate/time-to-fill/fallthrough/margin — reporting infra exists, metrics don't).

---

## LEDGER-STALE / CAPABILITY-ALREADY-BUILT FINDINGS

1. **Track 2 "45+ exports" is STALE** (drift-class C). `Aramo-Track2-Directive-v1_0-LOCKED.md:16` and `Ledger-v1_1:56` assert "45+ symbols"; substrate @ ca09740 = **38 distinct symbols / 34 `export` statements** (`libs/engagement/src/index.ts`). Directive baseline was `744945c`; substrate moved. Divergence (iii).
2. **Track 2 "it blocks Track 3" already SELF-CORRECTED** in the directive itself (`:32-37`) and in `Ledger-v1_1:58`; Track 3 (`libs/placement`) is built and complete. Not a live contradiction — recorded so it is not re-raised.
3. **Track 9 reporting infrastructure ALREADY BUILT** (LEDGER-PARTIAL, not stale). `libs/reporting|export|visibility` exist with controllers/services/DTOs; but the T9-named analytics (fill rate/time-to-fill/fallthrough/margin) are absent from `reporting.service.ts`. Capability partly built, analytics genuinely unbuilt.
4. **Track 6 design basis OBSOLETE/SUPERSEDED** (drift-class B/C). Planning-Package §3.3 (`:234-243`) proposes ContractAssignment states EXTENSION_PENDING/TERMINATED_EARLY/CONVERTED_TO_PERMANENT/TRANSFERRED; Track 4 ratified binary `ACTIVE`/`ENDED` only (`libs/placement/prisma/schema.prisma:198-207`). The T6 spec's enum is retired by ratified substrate.
5. **Current Ledger (v1.6) does not carry Tracks 5–10 at all** — remaining-sequence text survives only in v1_1 PART 3 (all `[S]`, substrate-not-reconned). No §13-grade grounded entry exists for T5–T10 in the authoritative doc.

---

## VOCABULARY SURFACE (mandate item 4 — brushed by T8 source_system values + T9 metric naming)

`scripts/verify-vocabulary.sh` (@ origin/main) exemption/allowlist arrays inventoried explicitly (banned terms referenced by array name, never restated as bare literals per CLAUDE.md):
- `R7_ALLOWLIST` (`:36`) — Tier-1 sealed allowlist; `R7_ALLOWLIST_GLOB` (`:59`).
- `FRONTDOOR_LEGACY_ALLOWLIST` (`:77`) — sealed retired-front-door-term allowlist (ADR-0023).
- `TIER2_EXCLUDES` (`:94`) — Tier-2 path-exclude array; lockstep with `eslint.config.mjs` TIER2_EXCLUDES (`:153,393,427,437`). Comment `:92`: "Product source (apps/, libs/) is NEVER excluded."
- `TIER2_TERMS_REGEX` (`:477`) — defines the banned Tier-2 term set (referenced by source, not restated — see `scripts/verify-vocabulary.sh:477-485`). Self-excluded from its own scan (`:44`).
No T8/T9 substrate term inspected sits in a banned set; T8 `source_system` values (fieldglass/beeline/oracle/coupa) and T9 metric names are vocabulary-clean. NOTE: `Aramo-Requisition-Enterprise-Program-Planning-Package-v1_0.md:216` records the compliant `SUBMITTALS_CLOSED` form because the prior form is Tier-2-banned (see `scripts/verify-vocabulary.sh`); ADR-0024 A3 erratum (`:315`) corrected its own identifiers for the same reason.

## CONTRACT SURFACE (mandate item 5 — Track 2 §R5 touches Pact)
Not a provider-verification task in this segment, but recorded: consumer pacts live under `pact/consumers/ats-web/` (incl. `assignments.consumer.test.ts`, `activity`, `company`, `contact`, `consent`, etc.). Track 2's directive §R5 (`Aramo-Track2-Directive-v1_0-LOCKED.md:79`) requires any HTTP-path/Pact change registered in `pact/provider/src/verify-api.ts`. The two distinct numbers ("consumer count" vs "consumers verified by this provider") are a Track-4 provider-verification concern (MEMORY: auth-service-consumer verifies a separate provider) — flagged, not enumerated here as it is outside §13/§14 scope.

---

## DIVERGENCES (typed — FLAGGED, NOT RESOLVED)

**C1 (type i — conflict with tasking assumption) — Track 2 submittal-table schema entanglement.** `libs/submittal/prisma/schema.prisma:102` `TalentSubmittalRecord` and `:226` `TalentSubmittalEvent` declare `@@schema("engagement")` (`:170`, `:253`). Track 2 directive §4 (`:85`) PROHIBITS touching `libs/submittal`, yet §2.3 (`:62-63`) asks the `engagement`→`selection` PG-schema-rename cost. Renaming the `engagement` Postgres schema either drags submittal-owned tables into `selection` or orphans them in a defunct `engagement` schema. **CONFIRMS the tasking's warning "engagement PG schema physically contains submittal-owned tables."** REQUIRES-PO-RULING on schema-rename handling before Track 2 can lock. (Also confirms the tasking's 45+/mechanical/blocks-T3 warnings.)

**C2 (type iii — substrate moved since baseline) — Track 6 enum superseded.** Planning-Package §3.3 assignment lifecycle states are retired by Track 4's ratified binary `ACTIVE`/`ENDED`. Any Track 6 directive authored from the Planning-Package enum would contradict merged substrate. REQUIRES re-derivation + PO ruling (revision-as-record vs enum re-expansion).

**C3 (type iii — substrate moved / ledger-not-carried) — Tracks 5–10 absent from current ledger.** The authoritative Ledger v1.6 tracks only T1–T4; T5–T10 survive only in the superseded v1_1 as unreconned `[S]`. No grounded remaining-sequence entry exists for T5–T10 in the current authoritative doc. Ledger needs a v1.7 carry, or an explicit ruling that v1_1 PART 3 remains the T5–T10 authority.

**C4 (type ii — assumption unverifiable) — T9 "margin" analytics depends on unbuilt T5 rates.** Ledger-v1_1:110 lists "margin" as a Track 9 view, but margin requires person-specific pay/bill rates that are Track 5 (NOT-STARTED). T9 margin analytics is not buildable until T5 lands — a cross-track dependency the ledger's per-track "Blocked by: Track 4" line does not capture.

---

## CLOSE
- **Baseline commit audited:** `origin/main` = `ca0974090724b36b130f4d39ea5b1ef486d6adf4` (PR #589). Working tree detached `3a4a3a4` (#588); all authority reads via `git show origin/main:`.
- **NO MUTATION PERFORMED.** No file written to the repo, no branch/commit/push/checkout, no migration/DB write, no deploy. All inspection was read-only (`git show`, `git grep`, `ls`, `git rev-parse`). This segment is read-only recon evidence and performed no repository mutation.
