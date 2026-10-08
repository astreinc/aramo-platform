# Governance backlog — Talent Intake Draft retention + abandoned-résumé deletion

Status: OPEN — requires a ratified product/privacy ruling before implementation.
Raised by: Durable Async Résumé-First Talent Intake directive (§20).

## What

`TalentIntakeDraft` is a durable, pre-Talent PII artifact: it holds a recruiter's
uploaded résumé object (in `aramo-prod-resumes-use1`), the governed extraction
result, and persisted recruiter review values — before any `TalentRecord` exists.
Unpromoted drafts (and their stored résumé objects) currently persist
indefinitely by design, so "leave and come back days later" works.

They must NOT live forever by accident. A retention + deletion policy is required.

## Why this is a backlog item, not an implemented default

No retention duration is invented here. The directive explicitly forbids a
casually-hardcoded expiry. The correct duration and deletion semantics are a
governed product/privacy decision (consistent with the résumé privacy/redaction
authority and the ADR-0015 delete-cascade), not an engineering guess.

## What the implementation already provides (so this is purely a policy gap)

- The lifecycle enum already carries the terminal states a retention sweep would
  use: `TalentIntakeDraft.review_status` includes `ABANDONED` (and `EXPIRED` can
  be added when governed). No schema change is expected to introduce them.
- `TalentIntakeDraft` has the timestamps a sweep needs: `created_at`,
  `updated_at`, `last_opened_at`, `promoted_at`.
- Promoted drafts already leave the active recovery surface (server-filtered).

## What a future ratified policy must decide + wire

1. The retention window for an **unpromoted** draft (from `created_at` /
   `last_opened_at`), governed per the privacy policy — configurable, not a bare
   literal.
2. The state transition on expiry (e.g. `READY/PARTIAL/FAILED → EXPIRED` /
   `ABANDONED`) and whether the recruiter is notified.
3. Object + evidence cleanup on expiry: delete the stored résumé object and any
   extraction child, following the existing deletion/erasure policy and the
   keyspace-class registration (the three-keyspace rule — subject → erasure
   inventory; record → + reconcile; cluster → purge + tripwire).
4. A scheduled sweep (a new `SCHEDULES` tick, mirroring the existing intake
   worker/relay ticks) that is silent without Redis (CI/local) and gated on the
   configured retention policy.

## Non-goals

Do NOT silently auto-delete production artifacts before a policy is ratified.
Until then, unpromoted drafts persist (the recovery guarantee is intentional).
