// Closed subset of the locked 36-code error registry (API Contracts Phase 5).
// Drawn incrementally; adding a new code requires Architect approval per
// doc/02-claude-code-discipline.md Rule 4.
//
// This list MUST stay in sync with the ErrorCode enum in openapi/common.yaml.
// The CI gate `error-codes:check` (currently a placeholder) will enforce
// equality once it is wired in a later PR.
//
// INTERNAL_ERROR is the registry's catch-all for unexpected 5xx server
// failures (Phase 5 "System & Processing" category, aramo-API-contract.md
// line 1372). It is the default code emitted by AramoExceptionFilter for
// 5xx HttpExceptions and for any unhandled Error.
//
// PR-3.2 adds INVALID_SCOPE_COMBINATION (HTTP 422) for consent scope
// dependency violations on /consent/check (PR-4).
//
// PR-8.0a-Reground adds TENANT_SELECTION_REQUIRED (HTTP 409) for /callback
// when a user has >1 active membership, and REFRESH_TOKEN_INVALID (HTTP 401)
// for /refresh failures (cookie missing, token expired/revoked, consumer
// mismatch, reuse detected, rotation race). Total: 9 codes.
//
// M3 PR-8 adds INVALID_REQUEST (HTTP 400) for malformed match-list request
// input (job_id UUID, limit, cursor) and INSUFFICIENT_PERMISSIONS (HTTP
// 403) for per-route consumer_type checks on the recruiter-facing
// match-list endpoint. Both codes are named explicitly in the M3 PR-8
// directive §4.1 (matching the API Contracts error catalogue); Lead
// authority is the §2 Lead engineering basis. Total: 11 codes.
//
// M3 PR-9 adds NOT_FOUND (HTTP 404) for the portal self-profile endpoint
// when the talent has no per-tenant overlay (i.e., they exist as a Talent
// but are not associated with the JWT's tenant). M3 PR-9 directive §4.5
// authorizes the addition (matching the API Contracts error catalogue);
// Lead authority is the directive's §2 Ruling 3 (refusal verification —
// not-found vs. data leakage is the security-posture choice that
// PortalController makes). Total: 12 codes.
//
// M4 PR-2 adds SUBMITTAL_STRETCH_BLOCKED (HTTP 422) for the evidence-
// package builder's Stretch-tier refusal (R9 enforcement at the substrate
// layer per Plan v1.5 §M4 Track A item 4). Per Aramo-M4-PR-2-Directive-
// v1_0-LOCKED.md §4.3 the code registers at builder construction. The
// ErrorCode enum in openapi/common.yaml gets the matching value addition
// for tuple/yaml parity (the closed-list parity test in libs/common/src/
// tests/error-codes.spec.ts enforces this); no UnprocessableEntity
// response component is added at PR-2 — the consuming endpoint PR (F33
// submittal-create) adds that component when the endpoint emits the
// code. Lead authority is the directive's §2 Ruling 4 (Stretch-blocking
// lives in the builder). Total: 13 codes.
//
// M4 PR-3 adds JUSTIFICATION_REQUIRED (HTTP 422) for the future
// submittal-confirm endpoint (F34) enforcement of Worth Considering
// submittals (per Plan v1.5 §M4 Track B item 4 + Exit Criteria: "Worth
// Considering submittal requires justification text + failed criteria
// acknowledgment"). Per Aramo-M4-PR-3-Directive-v1_0-LOCKED.md §4.5 the
// code is pre-registered at PR-3 (the same pattern as
// SUBMITTAL_STRETCH_BLOCKED was pre-registered at PR-2) to avoid
// contention at the consuming PR. PR-3's create endpoint accepts
// `justification` + `failed_criterion_acknowledgments` as optional
// fields and persists them verbatim; it does NOT enforce. F34 enforces:
// missing on Worth Considering returns 422 JUSTIFICATION_REQUIRED. Lead
// authority is the directive's §2 Ruling 5. Total: 14 codes.
//
// M4 PR-4 adds three codes (parity-triple at the consuming PR per
// Aramo-M4-PR-4-Directive-v1_0-LOCKED.md §4.6):
//   - ATTESTATION_MISSING (HTTP 422) — submittal-confirm rejects when any
//     of the three recruiter attestations (talent_evidence_reviewed,
//     constraints_reviewed, submittal_risk_acknowledged) is not literally
//     true. Enforced manually in SubmittalController.confirmSubmittal
//     (step 4 per directive §4.3) rather than via @Equals(true) decorators
//     so the closed-list error vocabulary survives class-validator's
//     own VALIDATION_ERROR path.
//   - EXAMINATION_PINNED_OUTDATED (HTTP 409) — submittal-confirm refuses
//     when (a) the pinned examination row is gone, (b) its lifecycle_state
//     is no longer 'active', or (c) the latest examination for the
//     (tenant, talent, job) triple is a different row id. The recruiter
//     must refresh and re-pin to a current snapshot before confirm.
//   - SUBMITTAL_ALREADY_CONFLICTING wording in earlier drafts is replaced
//     by SUBMITTAL_ALREADY_CONFIRMED (HTTP 409) — submittal-confirm
//     refuses when the row is already in state='submitted'. The
//     column-scoped trigger permits only draft→submitted; confirm-on-
//     submitted is detected before the SQL UPDATE so the trigger is
//     never reached on the second call.
// Total: 17 codes.
//
// M4 PR-5 adds OVERRIDE_INVALID (HTTP 422) for the examination-override
// endpoint per Aramo-M4-PR-5-Directive-v1_0-LOCKED.md §4.7. The endpoint
// accepts override_type / target_field / justification; class-validator
// surfaces shape failures as VALIDATION_ERROR (400). OVERRIDE_INVALID is
// reserved for semantic refusals (e.g. invalid target_field for a given
// override_type) that future PRs may enforce. PR-5 registers the code at
// the consuming PR (the parity-triple precedent from M4 PR-4); no PR-5
// controller path emits it yet — same registration-ahead pattern as
// SUBMITTAL_STRETCH_BLOCKED at PR-2 and JUSTIFICATION_REQUIRED at PR-3.
// Total: 18 codes.
//
// M4 PR-7 adds REVOKE_NOT_ALLOWED (HTTP 422) for the submittal-revoke
// endpoint per Aramo-M4-PR-7-Directive-v1_0-LOCKED.md §4.6. The endpoint
// refuses with REVOKE_NOT_ALLOWED when the target submittal is not in
// state='submitted' — i.e. a draft (never confirmed) or already-revoked
// submittal. The 422 status pair mirrors OVERRIDE_INVALID's
// semantic-refusal posture; class-validator shape failures still surface
// as VALIDATION_ERROR (400). Total: 19 codes.
//
// M5 PR-2 adds SELECTION_EVENT_REF_NOT_FOUND (HTTP 422) for the
// evidence-package builder's cross-schema validator (Aramo-M5-PR-2-
// Directive-v1_0-LOCKED.md §4.8 + Ruling 7). When a BuildPackageInput
// carries selection_event_refs that include a UUID not present in the
// selection.TalentSelectionEvent table (or present but not visible
// in the input tenant per findByTenantAndId tenant-scoped lookup),
// buildPackage refuses with 422. The code is registered TS-first per
// M4 PR-2/3/4/5/7 register-ahead convention; the matching
// openapi/common.yaml ErrorCode enum entry is added in the same PR per
// Directive Amendment v1.1's parity-quad expansion (TS tuple + HTTP
// mapping + parity test + openapi/common.yaml). Total: 20 codes.
//
// M5 PR-3 adds two codes (parity-quad × 2 per Aramo-M5-PR-3-Directive-
// v1_0-LOCKED.md §4.5 + Ruling 8):
//   - SELECTION_REFERENCE_NOT_FOUND (HTTP 422) — SelectionRepository
//     .createSelection refuses when any of the 3 cross-schema validator
//     patterns fails: Pattern C (TalentRepository.findOverlayByTenant
//     returns null), Pattern A (JobDomainRepository.findRequisitionById
//     returns null or row.tenant_id mismatch), Pattern B (Examination
//     .findById returns null or row.tenant_id mismatch when
//     examination_id is provided). Three-pattern design per Amendment
//     v1.1 §2 (substrate-derived: TalentDto is tenant-agnostic so
//     overlay-existence is the tenant-visibility proxy; the other two
//     follow the M5 PR-2 evidence-builder app-layer tenant-check
//     precedent).
//   - SELECTION_STATE_INVALID (HTTP 422) — SelectionRepository
//     .transitionState refuses when canTransition(from, to) returns
//     false. Application-layer guard atop the M5 PR-1 column-scoped DB
//     trigger (defense-in-depth: the trigger would also reject, but the
//     application-layer guard returns a structured error before the SQL
//     UPDATE attempt).
// Total: 22 codes.
//
// M5 PR-6 adds two codes (parity-quad × 2 per Aramo-M5-PR-6-Directive-
// v1_0-LOCKED.md §4.8 + Rulings 1 + 6):
//   - AI_PROVIDER_UNAVAILABLE (HTTP 502) — SelectionController
//     .sendOutreach remaps AiDraftService INTERNAL_ERROR throws whose
//     context.details.kind is 'provider_unavailable' or
//     'provider_internal_error' (per the M5 PR-5 AnthropicProvider
//     error-translation table) to a stable HTTP-bearing code so the
//     recruiter ATS client can distinguish upstream LLM transport
//     failures from generic 5xx INTERNAL_ERROR.
//   - AI_RATE_LIMITED (HTTP 429) — SelectionController.sendOutreach
//     remaps AiDraftService INTERNAL_ERROR throws whose
//     context.details.kind is 'provider_rate_limited' (LLM rate-limit
//     response from the Anthropic adapter). 429 lets the client back
//     off; the underlying generic INTERNAL_ERROR catch-all would have
//     mapped to 500 instead.
// Total: 24 codes.
//
// M5 PR-8b2 adds SUBMITTAL_STATE_INVALID (HTTP 422) for
// SubmittalRepository.{markReady,submitToAts,confirmAts} +
// confirmSubmittal + revokeSubmittal canTransition guard. Application-
// layer guard atop the canonical 5-state DB trigger (defense-in-depth:
// the trigger would also reject, but the application-layer guard
// returns a structured error before the SQL UPDATE attempt). Mirrors
// the M5 PR-3 SELECTION_STATE_INVALID precedent verbatim at the
// submittal-side. Total: 25 codes.
//
// M5 PR-9b adds CONSENT_NOT_GRANTED_AT_SEND (HTTP 403) for
// SelectionController.sendOutreach Step 5.5 runtime consent-at-send
// enforcement (closes Plan v1.5 §M5 Track B item 3 + satisfies M5
// Exit Criteria "No outreach without runtime contacting consent").
// First consent-denial HTTP error code in the registry — the existing
// /v1/consent/check endpoint returns ConsentDecisionDto in a 200 body
// (no thrown denial), so PR-9b introduces the runtime-throw pattern.
// Single code per Ruling 7; the ConsentDecisionDto.reason_code field
// ('stale_consent' | 'scope_dependency_unmet' | 'channel_not_consented'
// | 'consent_state_unknown') is embedded in error.details.consent_decision
// for client-side fine-grained UX without growing the code registry.
// 'error' result-shape goes to INTERNAL_ERROR per Ruling 8 (substrate
// fault vs refusal). Total: 28 codes (PR-A1b added
// TENANT_CAPABILITY_NOT_ENTITLED for the EntitlementGuard refusal;
// PR-A5a adds INVALID_PIPELINE_TRANSITION for the pipeline
// state-machine refusal).
//
// PR-A5b-1 adds REQUISITION_NO_OPENINGS (HTTP 409) for the
// pipeline-transition-to-`placed` over-capacity refusal. When a
// placement transition fires against a requisition whose
// openings_available has already been exhausted (== 0), the cross-
// schema decrement is gated on `openings_available > 0`; an attempted
// over-decrement refuses the ENTIRE transition tx (Pipeline.status,
// PipelineStatusHistory, Activity, UsageEvent all roll back) with this
// code. 409 (Conflict) fits the semantic: the request is well-formed
// but conflicts with current resource state (the slot is taken). The
// Lead-reviewed alternatives — allow-and-go-negative-with-warning,
// allow-to-zero-floor — were rejected as data-integrity hazards:
// openings_available is a numeric invariant downstream dashboards /
// allocation algorithms depend on; a silent floor would hide the
// recruiter's data conflict and a negative would corrupt slot
// accounting. The recruiter resolves either by raising the
// requisition's `openings` count first or by placing the talent on a
// different requisition. Total: 29 codes.
//
// PR-A5b-2 adds TALENT_LINK_INVALID (HTTP 422) for the TalentRecord ↔
// Core-Talent linker's cross-schema validation refusal. Two failure
// modes share the code (distinguished by details.reason):
//   - 'core_talent_not_found' — the given core_talent_id does not
//     resolve to a row in `talent.Talent` (the Core identity does not
//     exist).
//   - 'tenant_overlay_missing' — the Core Talent exists, but no
//     TalentTenantOverlay exists for (talent_id, request.tenant_id);
//     the requesting tenant has no relationship to the identity, so
//     the link is rejected.
// 422 (Unprocessable) fits — the request is well-formed (the id is a
// valid UUID), but the referenced data is invalid for domain reasons.
// Mirrors the M5 PR-3 SELECTION_REFERENCE_NOT_FOUND (422) and M4
// PR-4 EXAMINATION_PINNED_OUTDATED precedents for cross-schema
// validator rejections. The linker is ASSOCIATE-ONLY: it never
// resolves identity (no findTalentByEmail surface) and never creates
// Core rows — this code is the refusal point when the caller's chosen
// id doesn't validate. Total: 30 codes.
//
// PR-A6 adds SAVED_LIST_ITEM_TYPE_MISMATCH (HTTP 422) for the saved-list
// homogeneity invariant: a SavedList's `item_type` (fixed at creation)
// constrains every entry's type. An add-entry request whose
// `item_type` differs from the parent list's `item_type` is rejected
// with this code. 422 (Unprocessable) fits — the request is
// well-formed but conflicts with the list's typed-polymorphism
// invariant. The calendar owner-or-admin predicate (the A3 shape)
// reuses NOT_FOUND (the A3 info-leak-closing precedent) rather than
// introducing a dedicated calendar code. Total: 31 codes.
//
// PR-A8-1 adds three codes for the import engine — the audited
// reversible batch + partial-commit model (parity-quad each per the
// M5 PR-2 precedent: TS tuple + HTTP map + openapi/common.yaml +
// parity test):
//   - IMPORT_THRESHOLD_EXCEEDED (HTTP 422) — the runImport batch's
//     failure_count exceeded the configured threshold; the entire
//     batch was rejected and ALL its rows rolled back (status:
//     'rejected'). The recruiter inspects details.failure_count /
//     details.row_count / details.threshold_pct, fixes the source
//     file, and re-imports. 422 (Unprocessable) fits: the request was
//     well-formed but the data quality failed the tenant's quality
//     gate. NOT a server-side fault — the engine's contract is to
//     refuse a too-dirty batch up-front rather than persist garbage.
//   - IMPORT_ALREADY_REVERTED (HTTP 409) — POST /v1/imports/:id/revert
//     refuses when the batch's status is already 'reverted' (or
//     'rejected'; rejected batches never persisted rows so there's
//     nothing to revert). 409 (Conflict) fits the
//     SUBMITTAL_ALREADY_CONFIRMED precedent: well-formed request,
//     conflict with current resource state.
//   - IMPORT_REVERT_WINDOW_EXPIRED (HTTP 409) — POST /v1/imports/:id/
//     revert refuses when the batch's created_at is older than the
//     configured revert window (default 7 days). Reversion is bounded
//     so a long-running import doesn't get yanked out from under
//     downstream consumers (selections, pipeline rows, talent links)
//     that may have accreted on the imported entities. The recruiter
//     who needs a late revert escalates to a manual delete.
// Total: 34 codes.
//
// T2-2a adds CANONICALIZATION_PAYLOAD_NOT_FOUND (HTTP 404) for the
// canonicalize service's RawPayloadReference lookup refusal. Mirrors the
// A3 not-found info-leak-closing precedent: cross-tenant access is
// ABSORBED into not-found (no enumeration of other-tenant payload ids).
// 404 fits the semantic — the payload either does not exist or is not
// visible to the calling tenant, indistinguishably. The
// 'core_talent_not_found' case (caller passed a core_talent_id that
// doesn't resolve in `talent.Talent`) reuses the existing NOT_FOUND code
// (HTTP 404) with details.reason='core_talent_not_found' per the
// Directive §5 "or reuse NOT_FOUND — confirm" option; this is the
// closest fit to the PR-A5b-2 TALENT_LINK_INVALID detail-reason discriminator
// pattern. Total: 35 codes.

export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'INVALID_TOKEN',
  'TENANT_ACCESS_DENIED',
  'VALIDATION_ERROR',
  'IDEMPOTENCY_KEY_CONFLICT',
  'INTERNAL_ERROR',
  'INVALID_SCOPE_COMBINATION',
  'TENANT_SELECTION_REQUIRED',
  'REFRESH_TOKEN_INVALID',
  'INVALID_REQUEST',
  'INSUFFICIENT_PERMISSIONS',
  'NOT_FOUND',
  'SUBMITTAL_STRETCH_BLOCKED',
  'JUSTIFICATION_REQUIRED',
  'ATTESTATION_MISSING',
  'EXAMINATION_PINNED_OUTDATED',
  'SUBMITTAL_ALREADY_CONFIRMED',
  'OVERRIDE_INVALID',  // M4 PR-5 — invalid override payload or non-overridable field
  'REVOKE_NOT_ALLOWED',  // M4 PR-7 / M5 PR-8b2 — submittal in terminal state (confirmed | revoked) cannot be revoked
  // T2-P3B — Selection workflow + Evidence error codes. The Selection-era
  // codes are fully superseded pre-GA: the two dead compat codes are removed
  // and the Evidence event-ref refusal is flipped to SELECTION_EVENT_REF_NOT_FOUND.
  'SELECTION_EVENT_REF_NOT_FOUND',  // Evidence cross-schema validator — selection_event_refs entry not found in tenant
  'SELECTION_REFERENCE_NOT_FOUND',  // createSelection cross-schema validator (Pattern A/B/C)
  'SELECTION_STATE_INVALID',  // transitionState canTransition guard failed
  'AI_PROVIDER_UNAVAILABLE',  // M5 PR-6 — outreach sendOutreach LLM transport / vendor-internal failure
  'AI_RATE_LIMITED',  // M5 PR-6 — outreach sendOutreach LLM rate-limit response
  'SUBMITTAL_STATE_INVALID',  // M5 PR-8b2 — submittal canTransition guard failed (mainline + sibling-revoke)
  'CONSENT_NOT_GRANTED_AT_SEND',  // M5 PR-9b — outreach-send runtime consent-at-send refusal (Plan v1.5 §M5 Track B item 3 closure)
  'TENANT_CAPABILITY_NOT_ENTITLED',  // PR-A1b — EntitlementGuard refusal when the tenant lacks the @RequireCapability the route demands (distinct from scope-axis INSUFFICIENT_PERMISSIONS per Ruling 1)
  'INVALID_PIPELINE_TRANSITION',  // PR-A5a — pipeline state-machine canTransition guard rejected an illegal status change; the load-bearing refusal of A5a (mirrors SUBMITTAL_STATE_INVALID / SELECTION_STATE_INVALID at the ATS-domain layer)
  'REQUISITION_NO_OPENINGS',  // RESERVED, no longer emitted — T4-B2 §7 retired the pipeline-transition over-capacity refusal (pipeline no longer decrements capacity; stored openings_available dropped in §6; over-capacity is now a representable DERIVED state, not a 409). Kept in the registry for compatibility (still referenced by the ats-web pipeline error-message map).
  'TALENT_LINK_INVALID',  // PR-A5b-2 — TalentRecord-to-Core-Talent linker cross-schema validator refusal; details.reason ∈ {'core_talent_not_found','tenant_overlay_missing'} (the keystone's ASSOCIATE-NOT-RESOLVE refusal point)
  'SAVED_LIST_ITEM_TYPE_MISMATCH',  // PR-A6 — saved-list add-entry homogeneity-invariant refusal: entry's item_type differs from parent SavedList.item_type (the typed-polymorphism A4-shape integrity check at the list-side)
  'IMPORT_THRESHOLD_EXCEEDED',  // PR-A8-1 — import batch's failure_count exceeded the configured threshold; the entire batch was rejected (no rows persisted) — the recruiter inspects details.{failure_count,row_count,threshold_pct}, fixes, re-imports
  'IMPORT_ALREADY_REVERTED',  // PR-A8-1 — POST /v1/imports/:id/revert refused: batch already in terminal state (reverted | rejected) — re-revert is a no-op rejection (the SUBMITTAL_ALREADY_CONFIRMED 409 precedent)
  'IMPORT_REVERT_WINDOW_EXPIRED',  // PR-A8-1 — POST /v1/imports/:id/revert refused: batch.created_at is older than the configured window (default 7 days) — reversion is bounded so downstream consumers don't get yanked out from under
  'CANONICALIZATION_PAYLOAD_NOT_FOUND',  // T2-2a — canonicalize() RawPayloadReference lookup refusal; cross-tenant ABSORBED into not-found (no enumeration of other-tenant payload ids — A3 info-leak-closing precedent)
  'OBJECT_STORAGE_UPLOAD_FAILED',  // A8-3a — presigned-URL generation OR upstream S3 PUT/GET failure at the ObjectStorageService boundary. HTTP 502 (upstream-dependency error class). Distinct from INTERNAL_ERROR so the recruiter UI can render an actionable "try again" vs. a generic 500.
  'PRESIGNED_URL_EXPIRED',  // A8-3a — pre-signed URL used after expires_at. HTTP 410 (Gone — the resource representation referenced by the signed URL is no longer available). Surfaced when downstream code or audit re-presents a stored URL past its TTL; the canonical PII-floor refusal at the URL-bearer-token boundary.
  'TENANT_ALREADY_EXISTS',  // AUTHZ-2 — provisioning refusal: a Tenant with the requested name already exists (case-insensitive uniqueness over name). HTTP 409. Idempotent re-provision is rejected at the platform-tier boundary (Lead ruling 2 — same-name → 409, not silently aliased).
  'COGNITO_PROVISION_FAILED',  // AUTHZ-2 — Cognito AdminCreateUser upstream failure (Pattern A; the load-bearing external integration). HTTP 502. Distinct from INTERNAL_ERROR so the platform-admin UI can surface "Cognito unavailable, retry" vs. a generic 500. Mirrors OBJECT_STORAGE_UPLOAD_FAILED at the IdP boundary.
  'INVITATION_ALREADY_EXISTS',  // AUTHZ-2 — re-invite refusal for the (email, tenant_id) pair when the User already holds a membership in the tenant with the same role set. HTTP 409. AdminGetUser is the idempotency check; Cognito is NOT re-created. The two same-tenant-different-roles / new-tenant / drift cases (Ruling 8) do NOT raise this — they reconcile.
  'MANAGEMENT_CYCLE_REJECTED',  // AUTHZ-D4a — set-management-edge refusal: the proposed (manager_user_id, report_user_id) edge would create a cycle in the management graph (e.g. A manages B; attempting B manages A, or the transitive A→B→C; attempting C→A). The cycle check walks upward from report_user_id; if manager_user_id appears in the ancestor set, the edge is rejected. HTTP 409 (mirrors SUBMITTAL_ALREADY_CONFIRMED / IMPORT_ALREADY_REVERTED for state-conflict refusals).
  'TALENT_RECORD_SUPERSEDED',  // TR-2a-B3a (DDR-3 §3) — outreach-send refusal: the selection's TalentRecord was superseded by a late-merge reconcile (record_status='superseded'); the surviving record speaks for the human, so the husk is non-operational. HTTP 422 (a state-invalid refusal — mirrors SELECTION_STATE_INVALID). Writer-less in B3a; the B3b reconcile writer produces the state.
  // TR-6 B2 (DDR D5 + PC Exit Accounting §5.1) — advisory-resolution domain refusal codes.
  // These REPLACE the AramoExceptionFilter status-collapse (409→IDEMPOTENCY_KEY_CONFLICT,
  // 400→VALIDATION_ERROR) on the advisory surface ONLY: the semantically-false generic
  // codes the PC-4b interactions pinned are corrected here (the exit accounting's
  // coordinated-by-design fix). Names derived from the actual refusals in
  // subject-resolution.service. The filter itself is untouched (other domains keep theirs).
  'ADVISORY_NOT_PENDING',  // 409 — approve/dismiss on an advisory not in PENDING_REVIEW (already MERGED/DISMISSED/REVERSED — cannot re-resolve).
  'ADVISORY_NOT_MERGED',  // 409 — reverse on an advisory not in MERGED status (nothing to un-merge).
  'ADVISORY_NO_MERGED_SUBJECT',  // 409 — reverse on a MERGED advisory whose merged_subject_id is absent (defensive; a MERGED advisory always records its pair).
  'MERGE_SUBJECT_NOT_ACTIVE',  // 409 — approve merge whose surviving/merged subject is not ACTIVE (already merged elsewhere; the R5 double-merge guard).
  'CONTRADICTION_OVERRIDE_REQUIRED',  // 400 — approve a has_contradiction advisory without override_acknowledged=true + a justification (R3 / F34 accountability).
  'REVERSAL_JUSTIFICATION_REQUIRED',  // 400 — reverse without a justification (R4 — a merge reversal is high-consequence, never silent).
  // TR-3 B2 (DDR §2.1) — the email-verification REQUEST consent gate. Fires when the
  // contacting/email consent check returns denied OR error/empty-ledger (the ruled
  // divergence from the selection send-gate, which maps empty-ledger to 500): a
  // voluntary enhancement fails CLOSED on unknown consent state. HTTP 403. (The
  // CONFIRM path is oracle-resistant and reuses the generic NOT_FOUND 404 for every
  // invalid/expired/consumed/revoked/rate-limited case — no verification-revealing code.)
  'VERIFICATION_CONSENT_REQUIRED',
  // TR-4 B1 (DDR §2.2) — the canonical claim-shape write gate. Evidence claiming a
  // REGISTERED assertion_type (EMPLOYMENT / SKILL / the IDENTITY contact shapes)
  // whose assertion_payload does not conform to that type's canonical contract is
  // refused at the write path. HTTP 422. Registering a type is the deliberate act
  // that buys comparability; UNregistered types stay @IsObject passthrough (the
  // OPEN-6 admission-open posture — admission open, registration = shape commitment).
  'CLAIM_SHAPE_INVALID',
  // TR-4 B3 (§3.3) — the resolve-contradiction endpoint's operational refusal:
  // resolveContradiction was called on an EvidenceRecord whose current_status is
  // not CONTRADICTED (a resolve is meaningful only against a standing
  // contradiction). HTTP 422.
  'EVIDENCE_NOT_CONTRADICTED',
  // Platform-Console Increment-2 PR-1 — tenant lifecycle mint-gate denials
  // (tenant-consumer session mint only; platform-consumer mints unaffected).
  'TENANT_SUSPENDED',  // 403 — a SUSPENDED tenant (reversible). New sessions refused; existing expire on the 15-min access TTL.
  'TENANT_CLOSED',  // 403 — a CLOSED tenant (terminal; disposition per counsel-gated retention).
  // TR-12 B1 (DDR §4) — the caseworker's dismiss-proposal refusal: dismissProposal
  // was called on a VerificationProposal not in OPEN status (already ACTED or
  // DISMISSED — a terminal proposal cannot be re-dismissed). HTTP 409 (the
  // state-conflict class — mirrors ADVISORY_NOT_PENDING at the proposal surface).
  'PROPOSAL_NOT_OPEN',
  // TR-15 B1 (DDR §2) — the dispute machinery's operational refusals.
  // EVIDENCE_NOT_DISPUTABLE: dispute() on a record that is neither VALID (the
  // only disputable status) nor already DISPUTED (a repeat is a no-op, not a
  // refusal) — e.g. STALE / CONTRADICTED / REVOKED / SUPERSEDED. HTTP 422.
  'EVIDENCE_NOT_DISPUTABLE',
  // EVIDENCE_NOT_DISPUTED: resolveDispute() on a record whose current_status is
  // not DISPUTED (a resolve is meaningful only against a standing dispute —
  // mirrors EVIDENCE_NOT_CONTRADICTED at the DISPUTED axis). HTTP 422.
  'EVIDENCE_NOT_DISPUTED',
  // DISPUTE_OUTCOME_INVALID: resolveDispute() outcome is neither 'upheld' nor
  // 'rejected' (the lenient DTO admits any string; the service is the gate).
  // HTTP 422.
  'DISPUTE_OUTCOME_INVALID',
  // Portal P3a — respond/act on a candidate PortalDispute that is no longer in a
  // non-terminal state (RESOLVED_* / WITHDRAWN); a closed dispute takes no
  // further talent statement. HTTP 422.
  'PORTAL_DISPUTE_NOT_OPEN',
  // Portal P3b — the single reinvestigation extension (+15d) was already taken.
  // HTTP 422.
  'PORTAL_DISPUTE_EXTENSION_USED',
  // ADR-0024 PR-3 — the requisition-lifecycle policy engine refused a governed
  // command (REQUISITION_TALENT · ADD). HTTP 403. The response carries the
  // policy reason_code ONLY; rule_id / policy_version / engine internals are
  // never leaked to the client. Distinct from the scope-axis
  // INSUFFICIENT_PERMISSIONS (authorization) — this is a business-policy
  // refusal that runs AFTER authorization.
  'POLICY_DENIED',
  // Charter §4 Amendment — Activity Redaction. ACTIVITY_NOT_REDACTABLE (HTTP
  // 422): redact refused because the activity is not a note (R3 — system
  // activity records what happened and is never redactable; mirrors
  // SUBMITTAL_STATE_INVALID). ACTIVITY_ALREADY_REDACTED (HTTP 409): the row is
  // already redacted and redaction is single-shot/irreversible (R5; mirrors
  // SUBMITTAL_ALREADY_CONFIRMED / IMPORT_ALREADY_REVERTED).
  'ACTIVITY_NOT_REDACTABLE',
  'ACTIVITY_ALREADY_REDACTED',
  // Track 1 T1-b (ruling R2) — optimistic-concurrency stale-write refusal on
  // requisition.Requisition. The PATCH (or any versioned update) supplied an
  // expected `version` that no longer matches the stored row: someone else
  // changed it since the caller read it. HTTP 409. A DISTINCT registered code,
  // never a generic 409 and never silent last-write-wins — the caller must be
  // able to tell "someone else changed this" from "your request was malformed"
  // (VALIDATION_ERROR) or "not found" (NOT_FOUND). Mirrors the state-conflict
  // 409 family (SUBMITTAL_ALREADY_CONFIRMED / IMPORT_ALREADY_REVERTED). ADDITIVE
  // this PR: fires ONLY when a caller opts in by supplying a version.
  'REQUISITION_VERSION_CONFLICT',
  // Track 1 T1-e (§2.3 / ruling R9) — a status-changing PATCH targeting a
  // subsystem-GATED RecruitingStatus (draft | pending_approval | archived) is
  // refused SERVER-SIDE, not by hiding the option in the UI. HTTP 422: the
  // request is well-formed but the target status's subsystem does not exist
  // yet. A DISTINCT registered code, never a generic 400 (VALIDATION_ERROR):
  // the recruiter must be able to learn the status EXISTS in the value space
  // but is not reachable today — details.status names the refused value.
  // Distinct also from POLICY_DENIED (a governed-transition refusal that runs
  // the policy engine); the gated set is unreachable by construction, so no
  // package rule expresses reaching it.
  'REQUISITION_STATUS_GATED',
  // Track 3 / E7 (ADR-0027) — ClientTalentRestriction refusals. R10-narrow,
  // client-scoped, never portable.
  // RESTRICTION_INVALID (422): a single refusal covering ALL
  // creation-validation cases (missing/invalid external asserter — R1's
  // asserted_by_type/source_system/source_reference; an ungoverned
  // source_reference / close_source_reference — free text rejected; an
  // unregistered restriction_type — the R10 closed-registry tripwire; and an
  // inconsistent effective window — scheduled_end_at not after effective_from
  // at create, or at close effective_to before effective_from / after a
  // scheduled end / closing an already naturally-expired restriction).
  // details.reason names the specific case. Per-field codes were REJECTED:
  // four parity surfaces each for no caller gain (PO ruling).
  'RESTRICTION_INVALID',
  // RESTRICTION_ALREADY_CLOSED (409): a close was attempted on a restriction
  // whose effective_to is already set. Closure provenance is written ONCE and
  // is immutable (E7 R4/R4b); a second close (or a trigger-rejected non-close
  // mutation) is a CONFLICT — distinct 409 caller semantics from the 422
  // validation refusal, never a silent last-write-wins.
  'RESTRICTION_ALREADY_CLOSED',
  // Track 3 / E1-a (PlacementProcess spine) — two distinct lifecycle refusals,
  // kept as TWO codes (not one + details.reason) because they differ on BOTH
  // axes the split-rule tests: HTTP status AND caller remedy — the same reason
  // RESTRICTION_INVALID (422) and RESTRICTION_ALREADY_CLOSED (409) stayed two.
  // PLACEMENT_STATE_INVALID (422): an illegal PlacementProcess state transition
  // — the from-state has no such outgoing edge (e.g. the prohibited
  // OFFER_ACCEPTED → READY_TO_START), or a non-state column mutation. Caller
  // remedy: correct the requested transition. Mirrors SUBMITTAL_STATE_INVALID /
  // SELECTION_STATE_INVALID (422). details.reason carries from_state/to_state.
  'PLACEMENT_STATE_INVALID',
  // PLACEMENT_ALREADY_LIVE (409): a second PlacementProcess was attempted for a
  // (tenant_id, submittal_id) that already has a LIVE attempt (any non-terminal
  // state, STARTED included as ENGAGED). A CONFLICT, not a validation error —
  // submittal_id is deliberately non-unique, so this is enforced by the BEFORE
  // INSERT guard, not a uniqueness constraint.
  'PLACEMENT_ALREADY_LIVE',
  // Track 3 / E2 (Pre-Start Requirement) — TWO codes, split on the E7 rule:
  // one validation code + one distinct fail-closed conflict a caller branches on.
  // PRE_START_REQUIREMENT_INVALID (422): every domain validation refusal on a
  // requirement or a definition set. details.reason discriminates:
  // requirement_type_invalid | status_move_invalid | waiver_justification_required
  // | definition_entry_invalid | definition_set_not_draft. Generic shape/missing-
  // field failures stay class-validator 400 VALIDATION_ERROR (the examination split).
  'PRE_START_REQUIREMENT_INVALID',
  // PRE_START_NOT_READY (409): the fail-closed PRE_START → READY_TO_START refusal
  // — a different OUTCOME, not a bad request. details.reason discriminates:
  // materialization_absent (no snapshot yet — subsumes missing definition set) |
  // blocking_unresolved (a blocking requirement is pending/failed). The one code
  // a caller must be able to branch on to decide whether to wait or act.
  'PRE_START_NOT_READY',
  // Track 3 / E3 (Placement Fallthrough Reason Registry) — ONE reason-validation
  // refusal covering every governed terminal/fallthrough reason-evidence case,
  // discriminated by details.reason (the E7 RESTRICTION_INVALID precedent — per-
  // field codes were REJECTED for no caller gain). HTTP 422: the request is well-
  // formed but the reason evidence is invalid for the requested transition.
  // details.reason ∈ {
  //   reason_required           — a governed terminal target with no reason code;
  //   reason_unknown            — a code not in the canonical registry (a label is
  //                               never accepted as a code);
  //   reason_retired            — a code whose registry status is not active;
  //   reason_wrong_target       — a known code not allowed for this target state;
  //   detail_required           — REQUIRED-detail reason with absent/whitespace text;
  //   detail_prohibited         — PROHIBITED-detail reason supplied with detail text;
  //   detail_too_long           — normalised detail exceeds the registry maximum;
  //   reason_on_non_governed_target — reason input supplied for a non-governed edge.
  // }
  // Reason CODE is mandatory for every governed transition; reason DETAIL is
  // governed by that code's detail policy. Authorization (placement:terminate) is
  // enforced BEFORE this at the controller, so a recruiter lacking terminate is
  // refused 403 regardless of a valid reason.
  'PLACEMENT_REASON_INVALID',
  // Track 3 / E4 (Replacement Authorization) — ONE replacement-linkage refusal,
  // discriminated by details.reason (the E7 RESTRICTION_INVALID / E3 precedent —
  // per-field codes rejected). HTTP 422: the request is well-formed but the named
  // predecessor is not a valid one to replace. details.reason ∈ {
  //   predecessor_not_found     — no predecessor in this tenant+requisition with
  //                               that id (cross-tenant and cross-requisition both
  //                               fold here — least-visibility);
  //   predecessor_not_terminal  — the predecessor exists but is not in a pre-start
  //                               TERMINAL state (DUPLICATE_GUARD_INACTIVE).
  // }
  // Authorization (placement:create AND placement:replace, a conjunction) is
  // enforced BEFORE this at the controller, so a caller lacking placement:replace
  // is refused 403 regardless of predecessor validity.
  'PLACEMENT_REPLACEMENT_INVALID',
  // Track 4 / T4-A1 — a transition to STARTED refused because the caller supplied
  // no assignment org context (company_id). The STARTED edge materialises the
  // authoritative ContractAssignment, whose FORWARD provenance requires a company
  // snapshot (a DB CHECK). HTTP 422: the request is well-formed but cannot start
  // without the org snapshot. The snapshot is caller-supplied (§4 — placement
  // performs no cross-schema requisition read), so this is a boundary validation,
  // surfaced cleanly rather than as a raw check_violation rollback.
  'PLACEMENT_START_CONTEXT_REQUIRED',
  // Track 5 / T5-P1 — a FORWARD transition to STARTED was refused because the
  // required actual commercial terms (commercial_terms: pay/bill/currency/period)
  // were absent. HTTP 422: a started assignment must never exist without its
  // initial Assignment Rate Version (Amendment A1). Atomic refusal — ZERO
  // mutation. Mirrors PLACEMENT_START_CONTEXT_REQUIRED at the commercial layer.
  'PLACEMENT_START_COMMERCIAL_TERMS_REQUIRED',
  'PIPELINE_EPISODE_ALREADY_LIVE',  // Track 3 E6 — pipeline create refused: a LIVE episode already exists for (tenant, talent_record_id, requisition_id). Q-2 one-live invariant. HTTP 409. This is BOTH the deterministic application-guard refusal (the controller path returns it to the caller) AND the exact-name translation of a race-floor `Pipeline_live_episode_key` partial-index violation (§4.1 — never a generic P2002/23505 catch). The sourcing path catches THIS SAME code and returns an idempotent no-op. Mirrors PLACEMENT_ALREADY_LIVE at the pipeline-episode layer.
  'PIPELINE_RECONCILE_LIVE_CONFLICT',  // Track 3 E6 (A4, §5.2) — record reconciliation refused PRE-FLIGHT: the surviving and merged talent records BOTH hold a LIVE pipeline episode for the same requisition, so repointing would put two live episodes on one triple (Q-2 violation). HTTP 409. The refusal is ATOMIC — it runs before any sweep step, so NO domain and NO record is mutated; details.requisition_ids enumerates the conflicting requisitions for explicit human resolution. Distinct from PIPELINE_EPISODE_ALREADY_LIVE (a single-write refusal) — this is a merge-time refusal.
  'REQUISITION_EXTERNAL_IDENTITY_CONFLICT',  // Track 8 T8-P1 — a requisition write refused: another requisition already holds this external identity (tenant_id, source_system, external_req_id). HTTP 409. The canonical external identity is unique per tenant when BOTH provenance fields are present. This is the exact-name translation of a `Requisition_external_identity_key` partial-unique-index violation (T8-P1 migration) — NEVER a generic P2002/23505 catch. It is the T8-P1 REJECT contract; idempotent re-import resolution is a T8-P2 ingestion-engine concern, not this code. Mirrors PIPELINE_EPISODE_ALREADY_LIVE at the requisition-identity layer.
  'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT',  // Track 6 T6-B2 — a post-start commercial revision refused: the requested effective instant collides with an existing AssignmentRateVersion window for (tenant_id, contract_assignment_id). HTTP 409. ONE code for both DB arbitrations, distinguished by details.reason: `window_overlap` (btree_gist `AssignmentRateVersion_no_window_overlap_excl` 23P01) or `duplicate_effective_from` (`AssignmentRateVersion_tenant_assignment_effective_key` 23505 — fires even against a CANCELLED row, since the unique key is non-partial). Exact-name translation of the constraint violation — NEVER a generic P2002/23505/23P01 catch. Mirrors PIPELINE_EPISODE_ALREADY_LIVE / REQUISITION_EXTERNAL_IDENTITY_CONFLICT at the commercial-window layer.
  // Track 7 / T7-P1 — the PermanentPlacement guarantee family. Six P1 codes,
  // appended (order preserved — the ordered-parity surfaces read positionally).
  // Falloff/remedy errors are T7-P2 and are deliberately NOT added here.
  // PERMANENT_PLACEMENT_NOT_FOUND (404): a guarantee read/transition addressed a
  // placement with no PermanentPlacement in this tenant. Mirrors NOT_FOUND at the
  // permanent-aggregate layer (a coherent absence on a read returns { permanent: null }
  // instead; this is the mutation-path not-found).
  'PERMANENT_PLACEMENT_NOT_FOUND',
  // PERMANENT_PLACEMENT_STATE_INVALID (422): an illegal guarantee-lifecycle
  // transition — the from-state has no such outgoing edge in the typed registry
  // (P1: only GUARANTEE_ACTIVE -> GUARANTEE_SATISFIED). Mirrors PLACEMENT_STATE_INVALID.
  'PERMANENT_PLACEMENT_STATE_INVALID',
  // PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID (422): the guarantee window is
  // invalid or its precondition is unmet. details.reason ∈ { start_date_invalid |
  // duration_not_positive_integer | end_not_after_start | guarantee_window_not_elapsed }.
  // The first three are activation-time (STARTED); the last is a premature satisfy
  // (satisfaction is allowed only on/after the guarantee end date, §5/§127).
  'PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID',
  // PERMANENT_PLACEMENT_TERMS_REQUIRED (422): a PERMANENT start with absent or
  // ambiguous governed guarantee terms. details.reason ∈ { guarantee_terms_required |
  // terms_source_required | remedy_policy_invalid }. Mirrors
  // PLACEMENT_START_COMMERCIAL_TERMS_REQUIRED at the guarantee layer (a permanent
  // placement must never activate without a determinate guarantee snapshot).
  'PERMANENT_PLACEMENT_TERMS_REQUIRED',
  // PERMANENT_PLACEMENT_EXPOSURE_INVALID (422): the governed guarantee exposure is
  // invalid. details.reason ∈ { exposure_amount_invalid | exposure_currency_invalid }.
  // Exposure is a governed INPUT on the direct-permanent path (no rate version is
  // minted — §3.2), so it is validated at the guarantee write boundary, not derived.
  'PERMANENT_PLACEMENT_EXPOSURE_INVALID',
  // PERMANENT_PLACEMENT_ALREADY_EXISTS (409): a PermanentPlacement already exists
  // for this originating PlacementProcess (the (tenant_id, placement_process_id)
  // unique key — the idempotency + branch-exclusivity floor). Exact-name translation
  // of a `PermanentPlacement_tenant_process_key` violation — NEVER a generic P2002
  // catch. The normal replay of a start is already refused earlier as an illegal
  // PlacementProcess edge; this is the race-floor conflict. Mirrors PLACEMENT_ALREADY_LIVE.
  'PERMANENT_PLACEMENT_ALREADY_EXISTS',
  // Track 7 / T7-P2 — the falloff + remedy family (appended in order — the ordered-parity
  // surfaces read positionally). Reuses P1 NOT_FOUND (404) + STATE_INVALID (422).
  // PERMANENT_PLACEMENT_FALLOFF_WINDOW_INVALID (422): the falloff effective date is not a
  // valid calendar date in the half-open guarantee window [start, end). details.reason ∈
  // { effective_date_invalid | effective_date_before_start | effective_date_on_or_after_end }.
  'PERMANENT_PLACEMENT_FALLOFF_WINDOW_INVALID',
  // PERMANENT_PLACEMENT_FALLOFF_REASON_INVALID (422): the falloff reason is not one of the
  // seven governed permanent-falloff codes (closed T7 registry, exact-match, no OTHER).
  'PERMANENT_PLACEMENT_FALLOFF_REASON_INVALID',
  // PERMANENT_PLACEMENT_REMEDY_INVALID (422): the remedy policy is unprovable from the
  // snapshot OR the remedy completion evidence is invalid. details.reason discriminates
  // (remedy_policy_invalid | replacement_placement_process_id_required | replacement_not_found
  // | replacement_wrong_requisition | replacement_not_permanent | replacement_not_started
  // | external_reference_required | ...). The E7/E3 one-code + details.reason precedent.
  'PERMANENT_PLACEMENT_REMEDY_INVALID',
  // PERMANENT_PLACEMENT_REMEDY_ALREADY_COMPLETED (409): a completion was attempted on a
  // remedy already resolved (completion facts are write-once). Mirrors PERMANENT_PLACEMENT_ALREADY_EXISTS.
  'PERMANENT_PLACEMENT_REMEDY_ALREADY_COMPLETED',
  // CONNECTOR_CONFIGURATION_INVALID (409): a connector connection management op
  // conflicts with the connection's current state — e.g. enabling a connection
  // with no configured credential, or an illegal lifecycle transition. T8-CONNECTOR-A;
  // narrowly scoped, deterministic, non-secret (directive §18).
  'CONNECTOR_CONFIGURATION_INVALID',
  // Track 7 / T7-P3 — the reusable guarantee-term-versioning family (appended in order — the
  // ordered-parity surfaces read positionally). Reuses P1 GUARANTEE_WINDOW_INVALID (422, bad
  // duration/policy) + EXPOSURE_INVALID (422, bad exposure/currency).
  // PERMANENT_PLACEMENT_TERMS_NOT_FOUND (404): no guarantee-term version is effective for the
  // requisition at the given as_of date, or there is no open version to revise.
  'PERMANENT_PLACEMENT_TERMS_NOT_FOUND',
  // PERMANENT_PLACEMENT_TERMS_WINDOW_INVALID (422): the effective window is invalid — bad
  // effective_from, a backdated revision, or a revision not after the current version's start.
  'PERMANENT_PLACEMENT_TERMS_WINDOW_INVALID',
  // PERMANENT_PLACEMENT_TERMS_OVERLAP (409): the effective window overlaps an existing version
  // for the (tenant, requisition) — the DB daterange EXCLUDE / effective_from unique floor.
  'PERMANENT_PLACEMENT_TERMS_OVERLAP',
  // PERMANENT_PLACEMENT_TERMS_AMBIGUOUS (500): more than one version resolves as effective for
  // the same as_of date — impossible under the EXCLUDE, so a fail-closed internal invariant.
  'PERMANENT_PLACEMENT_TERMS_AMBIGUOUS',
  // PERMANENT_PLACEMENT_TERMS_IMMUTABLE (409): a forbidden historical mutation of an
  // append-only guarantee-term version (only a governed effective_to first-close is allowed).
  'PERMANENT_PLACEMENT_TERMS_IMMUTABLE',
  // Lane L8-B1 — SubmittalEligibility gate refusals (all HTTP 409). The client
  // submittal window is a business-state gate, not a validation error.
  // SUBMITTALS_CLOSED (409): the submittal window is CLOSED/PAUSED (manual override, or a client/VMS close).
  'SUBMITTALS_CLOSED',
  // SUBMITTAL_WINDOW_PASSED (409): the submittal_deadline has passed.
  'SUBMITTAL_WINDOW_PASSED',
  // SUBMITTAL_LIMIT_REACHED (409): the supplier submittal slot limit is exhausted.
  'SUBMITTAL_LIMIT_REACHED',
  // TALENT_RESTRICTED_AT_CLIENT (409): an active ClientTalentRestriction bars this Talent at this client.
  'TALENT_RESTRICTED_AT_CLIENT',
  // L8-B1 Amendment A1 — Submittal↔Pipeline authority-chain refusals (HTTP 409).
  // PIPELINE_SUBMIT_REQUIRES_SUBMITTAL (409): a bare pipeline qualifying→submitted is refused;
  // pipeline `submitted` is a mirror reachable only through the submit-to-ats command.
  'PIPELINE_SUBMIT_REQUIRES_SUBMITTAL',
  // SUBMITTAL_PIPELINE_LINK_INVALID (409): the submittal has no valid linked LIVE pipeline
  // episode to mirror (pipeline_id null, or the linked episode is not live / cannot transition).
  'SUBMITTAL_PIPELINE_LINK_INVALID',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
