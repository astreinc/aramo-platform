# Manual-Create Consent Policy — Directive DRAFT (PENDING RATIFICATION)

**Doc ID (draft):** `Aramo-Manual-Create-Consent-Policy-Directive-v0_1-DRAFT`
**Status:** DRAFT — authored by the Code Executor for PO + Lead/Architect ratification.
**NOT LOCKED. NOT AUTHORIZED FOR BUILD.** On ratification this is LOCKED to the
canonical OneDrive `Aramo/locked` location and assigned a real Doc ID; the built
code cites that Doc ID.

Related: `doc/backlog/add-talent-consent-capture.md` (the deferred consent-capture
surface this supersedes for the manual path); ADR-0032 party/role precedent for
how a PO product ruling + Lead ratification lands a moat change.

---

## 1. Context / problem

A manually-created Talent (`POST /v1/talent-records`) records **no** consent event
today. Every downstream consent-gated action (email/SMS communication via
`operation=communication → contacting`) is therefore **denied** — the recruiter
sees a (mislabelled) failure when trying to email a talent they just created.

The Add-Talent create screen previously exposed a consent selection; the PO removed
it, on the reasoning that **a recruiter ticking a checkbox in the create form is not
itself a lawful basis** — the recruiter has typically already obtained consent
**offline** before entering the record. The PO ruling: **a manually-created Talent
is treated as consented**, recorded as a recruiter attestation of prior offline
consent, rather than captured in-product at create time.

## 2. The contradiction this directive must resolve (why ratification is required)

The codebase **deliberately does not fabricate consent or a legal basis**:

- `libs/consent/.../manual-capture.service.ts` records
  `legal_basis: { basis: null, status: 'PENDING_COUNSEL' }` and comments that the
  capture MECHANISM is "NEVER a legal basis."
- `libs/contact/prisma/schema.prisma` (contact `preference`) comments: null "stores
  null (no fabricated grant)."

Auto-writing a `contacting: granted` event asserts a lawful basis the system holds
**no artifact** for. This directive **knowingly changes that stance for the manual
create path**, on the PO's business judgement that recruiter attestation of prior
offline consent is the operating basis. Because this is the **consent moat + a
legal-basis stance**, it requires **Lead/Architect ratification and a counsel note**,
not a bare PO nod. That is the reason this is filed as a DRAFT.

## 3. Rulings (proposed — for ratification)

- **R1 — Trigger (manual boundary only).** On the recruiter-initiated manual create
  `POST /v1/talent-records`, auto-record a consent grant. This directive does **NOT**
  change the import path (`createForImport` → governed by `SourceConsentService`) or
  the sourcing/ingestion path. Applies to a create where `consumer_type='recruiter'`.
  *(Open Q-A: should promotion of a `sourced` record also grant? Default: NO.)*

- **R2 — Provenance is truthful, not fabricated.** The grant is recorded with
  `captured_method = 'recruiter_capture'` (the existing closed-enum value nearest to
  "recruiter attests"), `captured_by_actor_id = authContext.sub` (the creating
  recruiter), a dedicated `consent_version` (e.g. `manual-create-attestation-v1`),
  and a `consent_text_snapshot` stating: *"Recruiter attested that consent was
  obtained offline prior to manual record creation."* We do **NOT** invent a
  `recruiter_attested` enum value (that is a closed-enum change requiring separate
  Architect approval); if the Architect prefers a distinct value, that is Q-B.

- **R3 — The full dependency chain is granted.** The `contacting` decision requires
  (Decision E / `SCOPE_DEPENDENCY_CHAIN`) that `profile_storage` and `matching` also
  be `granted`. The auto-grant therefore writes **three** events —
  `profile_storage`, `matching`, `contacting` — each with the R2 provenance. A lone
  `contacting` grant is insufficient (yields `INVALID_SCOPE_COMBINATION` 422).

- **R4 — Channel + staleness left open.** The `contacting` grant carries **no**
  `metadata.permitted_channels` (so all channels — email/SMS — are permitted). The
  12-month staleness window rides `occurred_at` unchanged.

- **R5 — Placement: composition-root orchestration.** `libs/talent-record` stays
  consent-free (its documented design intent). The auto-grant is orchestrated at the
  `apps/api` composition root (the same seam pattern as `consent-email-gate.adapter`),
  calling `ConsentService.grant(...)` (which atomically writes the event + audit +
  outbox + idempotency). No `libs/talent-record → @aramo/consent` nx edge is created.
  *(Open Q-C: there is no existing interceptor around `POST /v1/talent-records`; the
  seam is net-new — an application-layer orchestrator that runs post-create.)*

- **R6 — Auditability.** Because grants go through `ConsentService.grant`, every
  auto-grant emits a `ConsentAuditEvent` + outbox event; the attestation is fully
  traceable to the recruiter, timestamp, and version — the audit trail is honest
  about how the basis was asserted.

- **R7 — Reversibility.** Nothing here blocks a later revoke; the standard
  revoke/expire events continue to win under the most-restrictive model.

## 4. Open questions for ratification

- **Q-A:** Apply to `sourced`→promoted records, or manual-create only? (Default: manual only.)
- **Q-B:** `captured_method` = reuse `recruiter_capture`, or add a new
  `recruiter_attested` enum value (closed-enum change + OpenAPI + Architect sign-off)?
- **Q-C:** Post-create orchestration seam location + failure semantics (if the grant
  write fails, does the create still succeed? Default: create succeeds; grant failure
  is logged + retried via outbox, not a hard create failure — the record must not be
  lost because a consent side-write failed).
- **Q-D (counsel):** Is recruiter attestation of prior offline consent a sufficient
  lawful basis for the tenant's jurisdictions? This directive asserts it **as the
  operating basis per PO ruling**; counsel confirmation is requested but the
  attestation provenance (R2) is designed to be defensible either way.

## 5. Implementation plan (post-ratification only)

1. `apps/api` post-create orchestration: after a successful recruiter manual create,
   call `ConsentService.grant` three times (profile_storage, matching, contacting)
   with R2 provenance, idempotent on `(talent_record_id, scope, manual-create)`.
2. Tests: integration proof that a freshly manually-created talent passes the
   `operation=communication` gate (email allowed); that import/sourcing paths are
   unchanged; RED-first that the gate denied before the grant.
3. No migration, no returned-shape change (no `verify-api.ts` registration).
4. Backfill of pre-existing manually-created talents: a one-off, tenant-scoped
   data-migration OR left to organic re-consent — **decide at ratification** (the
   two local records were backfilled manually for testing under this same provenance).

## 6. Divergences carried from recon (grounding)

- D1-δ1: three-event chain required (not one) — folded into R3.
- D1-δ2: no `recruiter_attested` enum — folded into R2 / Q-B.
- D1-δ3: talent-record is consent-free; composition-root placement — folded into R5.
- D1-δ4: legal-basis fabrication tension vs. `PENDING_COUNSEL` design — the whole
  reason for §2 + Q-D; this directive resolves it **only** by explicit ratification.
