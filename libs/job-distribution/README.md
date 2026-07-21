# @aramo/job-distribution

The ATS-side distribution substrate: it posts a tenant's own requisitions
outbound to external channels (e.g. Indeed Job Sync). Governing directive:
`Aramo-SRC-2-Directive-v1_0-LOCKED.md` (R1–R4). Ships **inert** at SRC-2 PR-2 —
the schema and the allowlist payload builder only; the freshness sweep, the
channel connector, and the OAuth token service are PR-3/PR-4.

## Placement (R1) — why this is ATS-side, and the sourcing deployable is untouched

Distribution is **requisition-outbound**, not talent-inbound. It reads a tenant's
requisitions and pushes public postings to channels; it never reaches into the
talent graph. So it lives on the ATS side (`scope:ats`, may depend on
`scope:ats`/`scope:cip`/`scope:boundary`/`scope:shared`), reading `libs/requisition`,
composed in `apps/api`.

The ADR-0019 boundary is unaffected: the sourcing deployable and its
`sourcing_workspace` (the talent-inbound, per-tenant-credential territory) are not
touched by this lib and remain greenfield for SRC-3. Cross-schema references here
are UUID-only with no foreign keys.

Partner channel credentials are **platform-level** (Aramo-as-partner, the
transactional-mail precedent): one credential in env/secrets-path custody, the
tenant identified per-posting in the feed. This is distinct from the per-tenant
credential custody that governs talent pulls — that is SRC-3's territory and is
not represented here.

## Out of scope (R4) — the two Requisition tables

The sync feed keys on **`requisition.Requisition` only**. Its `updated_at` is
`@updatedAt`-maintained on every write path with no raw-SQL bypass, so an
`updated_at`-keyed change feed is sound.

There is a **second, unrelated** `Requisition` table in the `job_domain` schema
(the matching-domain concept): create-only, no compensation columns, no
`updated_at`. It is **explicitly out of scope** for distribution — the feed does
not read it, and a change feed keyed on `updated_at` would not see it. Do not
confuse the two.
