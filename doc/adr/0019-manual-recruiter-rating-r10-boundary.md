# ADR-0019: Manual Recruiter Rating and the R10 Boundary

- **Status:** **REJECTED** (PO-confirmed Lead ruling, 2026-06-16) — NOT ratified, NOT merged.
- **Date:** 2026-06-16
- **Context PR:** Requisition job-page rebuild to locked-mockup parity (recruiter-console)

## Rejection (PO-confirmed Lead ruling)

The proposal below is **rejected**. A per-talent rating — even framed as a
manual recruiter scorecard — is **out**. The ruling: **Aramo deliberately does
not let recruiters rate or ordinally sort talent. That refusal is a product
moat, not an oversight**, and it is exactly what R10's "no portal-forbidden
numeric/ordinal fields" protects on the ATS entities. Reframing it as
"recruiter-facing only" does not change that it introduces an ordinal judgment
surface the product intends never to exist.

What the recruiter's "this one matters" need is served by **existing
primitives, no new surface**:

- **Row-level triage** → the existing non-ordinal **`is_hot`** flag, surfaced
  as a per-row Hot toggle (a boolean mark the recruiter flips — not a 1–5
  scale). It may be *filtered* (the existing Talent "hot" facet) but is never a
  sort key and never aggregated into any average. R10-clean.
- **Qualitative read** → the **Log note / activity feed** already on this page
  (timestamped, threaded, room to write) — prose belongs there, not in a
  cramped table cell.

No `pipeline.rating` column, no migration, no `PATCH /…/rating`, no StarRating.
This record is retained (not deleted) so the decision and its reasoning are
discoverable; it is **not** a ratified ADR.

---

## (Rejected proposal — retained for the record)


## Context

The locked recruiter-console mockup (the "Confident Blue" job-detail prototype)
shows a per-talent **Rating** column (1–5 stars) on the requisition pipeline
table. Reproducing the mockup at full parity requires a backing field. The
Pipeline schema previously refused any such column, citing **R10**:

> "R10 — NO portal-forbidden numeric/ordinal fields. Pipeline carries a status
> label only; no portal-forbidden ranking columns."

A prior directive likewise removed a `RatingStars` UI element "(see §8 R10 and
§11 gap #1)" — i.e. for both R10-conservatism **and** the absence of a backing
field.

R10's actual text (Charter §8, `doc/03-refusal-layer.md`; corroborated across
the locked directive set) is a **Portal** boundary:

> "R10 forbids exposing tier or match output **to the talent-facing Portal** (Portal, not ATS,
> but the boundary holds). The ATS is the recruiter-facing system; the Portal is
> the talent-facing surface."
>
> "recruiter-facing fields only; tier or match output **NEVER to a talent-facing view**."

The R10-forbidden field set enumerated by the portal-refusal gates is **Aramo
Core automated judgment**: `internal_reasoning`, `entrustability_tier_raw`,
`examination_id`, `why_matched_sentence`, `strengths`, `gaps`, `risk_flags`,
`confidence_indicators`, and the ordinal-ranking / match-output fields, etc.

## Decision

Draw the line R10 already implies but the conservative schema comment had
collapsed:

1. **Aramo Core automated judgment** (tier, ranking, match output, examination output)
   remains forbidden on ATS entities and **must never** reach a talent-facing
   (Portal) surface. Unchanged. This is the load-bearing R10 boundary.

2. **A manual recruiter rating is permitted** on the Pipeline ATS entity. It is a
   **human assessment** — a scorecard primitive, exactly as Greenhouse
   (scorecards), Lever (interviewer feedback), Ashby, and SmartRecruiters ship
   it. It is categorically distinct from Core's machine judgment.

3. The manual rating is **recruiter-facing only**. It is enforced so by
   construction, not by runtime filter:
   - It is **not** in any Portal DTO (Portal DTOs are allowlist-shaped /
     `additionalProperties:false`; Pipeline is not a Portal entity).
   - It is **excluded from the A8-4 CSV export allowlist**
     (`libs/export/src/lib/field-catalog.ts` `PIPELINE_COLUMNS` — `rating` is
     deliberately omitted, with a do-not-add note).
   - It carries no Core semantics — it is the recruiter's own 1–5 mark.

## Consequences

- New column `pipeline.Pipeline.rating SMALLINT NULL`, CHECK `(rating IS NULL OR
  rating BETWEEN 1 AND 5)`. Nullable = unrated. Additive migration
  `20260616120000_add_rating_to_pipeline`.
- New route `PATCH /v1/pipelines/:id/rating`, gated by the existing seeded
  `pipeline:add-activity` scope (recruiter+; previously latent). No new scope,
  no RoleScope/seed/audit-count change.
- `PipelineView.rating` is added (recruiter-facing reads only).
- The portal-refusal negative-shape gates are unaffected (no Pipeline field is in
  a Portal response; `rating` is not in the forbidden Core-judgment token set).
- The export structural boundary is unaffected (allowlist excludes `rating`).

## Boundary tripwires (how a reviewer confirms R10 still holds)

- `rating` appears in **no** Portal DTO and **no** export field catalog.
- `rating` is a recruiter mark, never derived from / written by Core.
- If a future PR wants to surface any rating to talent via the Portal, that is a **new**
  R10 decision requiring its own ratification — this ADR does not authorize it.

## References

- Charter §8 Refusals (R10); `doc/03-refusal-layer.md`
- `libs/pipeline/prisma/schema.prisma` (the reframed R10 comment + `rating`)
- `libs/export/src/lib/field-catalog.ts` (`rating` deliberately excluded)
- ADR-0001 (`doc/adr/0001-pr1-precedent-decisions.md`) — ADR format / retroactive-precedent idiom
