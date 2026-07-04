-- Fix-Slice-Final-Drop — retire the husk pointer. resolved_talent_id was the
-- per-tenant Core husk id the canonicalize path wrote; Fix-Slice-2 replaced it
-- with resolved_subject_id (the within-tenant L2 ResolutionSubject anchor +
-- idempotency/poll gate) and left resolved_talent_id NULL. With the husk
-- substrate now dropped, the column is removed.
--
-- Additive-removal, forward-only. resolved_subject_id + resolved_cluster_id are
-- untouched. Zero rows carry a non-null resolved_talent_id (Fix-Slice-2 stopped
-- writing it).

-- AlterTable
ALTER TABLE "ingestion"."RawPayloadReference"
    DROP COLUMN "resolved_talent_id";
