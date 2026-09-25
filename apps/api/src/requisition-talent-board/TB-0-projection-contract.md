# Requisition Talent Board — TB-0 projection contract (grounded @ main `69c9b5db`)

Directive: `Aramo-Requisition-Talent-Board-Directive-v1_0-LOCKED`. This is the read-only
grounding for the Board read composer. The Board is a PROJECTION over authoritative
domains — it owns presentation only, never lifecycle/policy/authz truth (§1).

## Column → authoritative domain → persisted state → command
| Display column | Domain | Persisted state(s) | Command (owner) |
|---|---|---|---|
| Pipeline / Contacted / Qualified | `libs/pipeline` `Pipeline.status` | `no_contact, contacted, talent_responded, qualifying, qualified` (+ terminal `not_in_consideration, completed`) | `PipelineRepository.applyAction` (CONTACT/MARK_RESPONDED/START_QUALIFICATION/QUALIFY/DISPOSITION) |
| Submitted to client | `libs/submittal` `TalentSubmittalRecord.state` | `submitted_to_ats` (+ created/handoff_draft/ready_for_review/confirmed/revoked) | `SubmitTalentToClientService.submitToClient` |
| Interviewing | `libs/client-selection` `ClientSelectionProcess.state` | `CLIENT_REVIEW, INTERVIEW` | ClientSelection transition (`client-selection:transition`) |
| **Selected (HANDOFF BOUNDARY §3.2)** | `libs/client-selection` | `SELECTED` (terminal) | ClientSelection transition; gates `POST /v1/offers` |
| Offer / Offer accepted | `libs/placement` (offer schema) `Offer.state` | `DRAFT, SENT, NEGOTIATION, ACCEPTED, DECLINED, EXPIRED, RESCINDED` | `POST /v1/offers` + transitions |
| Pre-Start / Ready to start / Started | `libs/placement` `PlacementProcess.state` | `PRE_START, BLOCKED, READY_TO_START, STARTED, NO_SHOW, FELL_THROUGH` | `POST /v1/placements/:id/requirements/:rid/transition` |
| Assignment | `libs/placement` `ContractAssignment.lifecycle_state` | `ACTIVE, ENDED` | `assignment:end` / `assignment:extend` |
| Closed | `PipelineDisposition` / `ClientSelection.DECLINED|WITHDRAWN` / `Offer.decline_reason` | canonical disposition enums (pipeline-disposition.ts) | owner terminal commands |

The Board projection carries **STATE ENUMS ONLY** (mirroring `talent-journey-read.service.ts`
R3) — no compensation/bill field is ever composed except at an explicitly-scoped boundary.

## Résumé version (§13/§31) — REUSE, no gap
- Working (pre-submit): `pipeline.TalentRequisitionResume` keyed `(tenant, talent_record_id, requisition_id)`; current = MAX(selected_at); `PipelineRepository.getCurrentRequisitionResume`. Write scope `pipeline:resume:set`.
- Submitted evidence (frozen): `submittal.TalentSubmittalRecord.resume_edition_id`, pinned once at `submitted_to_ats`; refusal `SUBMITTAL_RESUME_SELECTION_REQUIRED` — **no latest-résumé fallback**.
- Drawer: pre-submit shows the working selection (editable by recruiter, `pipeline:resume:set`); post-submit shows the frozen submitted version (locked).

## Client Submittal readiness (§7/§32) — NOT blocked on the Client-Scoped Business Policy program
- Landed on main: `libs/submittal-eligibility` `RequisitionSubmittalEligibilityReader.deriveByRequisitionIds(tenant, req_ids, now)` → tri-state `open|paused|closed` + reason (`deadline_passed|limit_reached|manual_hold|paused`), batched/SET-oriented, EXCLUDES per-talent restriction.
- Per-talent gates (restriction/engagement/RTR/document) exist only inside the submit `$transaction` (EngagementGateService, DocumentReadinessGate) via the pure `evaluateEligibility` port (v1).
- **V1 (TB-1..TB-3):** the Qualified "Ready to submit / Needs action" band uses the requisition-grain tri-state + the per-card recruiting facts already available (résumé selected, RTR status). **TB-4** re-grounds the FULL per-talent readiness against the landed Client Submittal Policy contract; do NOT duplicate policy logic (§7). No interim eligibility algorithm invented.

## Gap resolutions (no new data model — no Architect stop per §36)
- **Days-in-stage (G-A):** no `entered_at` column; derive from the latest `PipelineStatusHistory.changed_at` into the current status (append-only history). Deterministic; not fabricated from `updated_at` (§22).
- **Assigned recruiter (G-B):** requisition-grain `RequisitionAssignment.user_id` ("The assigned recruiter") is the authoritative relation (§14 "explicit relation"). NOT called "owner". Pipeline event `changed_by_id`/`created_by_id` is provenance only.
- **Submittal read scope (G-C):** no `submittal:read` scope exists; Board Submittal reads ride `pipeline:read` (as `talent-journey-read` does). No new scope (avoids D-SEED-SCOPES-1 ripple).
- **Financials (D-2 — prototype divergence):** there is NO bill-rate on `TalentSubmittalRecord`; bill/pay/margin live on `placement.AssignmentRateVersion` (post-start, `assignment:commercials:read`) and Offer pay on `Offer.compensation_*` (`offer:read:financial`, `maskOfferCompensation`). The Board shows financials ONLY where authoritative + scoped — never a fabricated bill on pipeline/submittal cards. The prototype's bill-on-submittal is prototype-only fixture data.

## Read-endpoint + composition shape (§19/§20)
GET-only apps/api composer modeled on `talent-journey-read.service.ts` but **per-requisition + batched over the talent set**: mirror `PipelineRepository.findCurrentStageForTalentIds` / `listByRequisitionsAndStatus` / `listForRequisitions` (SET/IN-list) + `RequisitionSubmittalEligibilityReader.deriveByRequisitionIds` — no per-row fan-out. Lives in `apps/api` (only layer allowed to compose all five scope:ats owners). Route `GET /v1/requisitions/:requisition_id/talent-board`, `@RequireScopes('pipeline:read')` + `@RequireCapability('ats')` + `@RequireSiteMatch()`. Covered by the `apps/api` integration root.

## Persona → scope lanes (§15 — existing scopes, NOT new roles)
- Recruiter: actionable pipeline/contacted/qualified (+ submitted read); downstream tracking read-only.
- Account Manager: submitted/interview/selected/offer/... actionable; incoming `qualified` read.
- Operations: pre-start actionable.
- Commercial approver / Finance: read-only whole pipeline; financials under `offer:read:financial` + `assignment:commercials:read`.
UI hiding is never the boundary — server authorization authoritative; masked financials are ABSENT (§16/§29).
