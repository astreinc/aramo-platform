-- Fix-Slice-2 (Canonicalization Re-Route, ADR-0016 D3/D5) — additive ingestion
-- column owned BY ingestion (per the schema-per-module rule: each schema owned
-- by exactly one Prisma module; canonicalization mirrors it as a follower,
-- drift-tripwire enforced).
--
-- resolved_subject_id (UUID, nullable) — the within-tenant L2 resolution anchor:
-- the talent_trust.ResolutionSubject id this arrival resolved to (verified-email
-- SubjectAnchor match, or a new subject). Replaces the husk pointer
-- (resolved_talent_id) as the canonicalize idempotency anchor + the poll gate.
-- DISTINCT from resolved_cluster_id (the cross-tenant identity_index cluster,
-- untouched by this slice, R1). Cross-schema reference is UUID-only without FK
-- (Architecture Section 7.3).
--
-- Additive-only. No existing column mutated; resolved_talent_id is preserved
-- (it retires with the husk in the final drop slice). resolved_cluster_id is
-- untouched.

-- AlterTable
ALTER TABLE "ingestion"."RawPayloadReference"
    ADD COLUMN "resolved_subject_id" UUID;
